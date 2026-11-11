// @ts-check
/**
 * Offscreen targets and post-processing (PLAN.md §4.2): the scene target (RGBA16F when
 * EXT_color_buffer_half_float / EXT_color_buffer_float allow it, else RGBA8), bloom (bright-pass to
 * 1/2, downsample to 1/4, 1/8, 1/16, upsample and add back up), and the composite to the screen
 * (tone map, vignette, chromatic aberration, gamma). Every target is cleared when its pass starts
 * and invalidated when the frame no longer needs it.
 *
 * 8-bit fallback (no float colour buffers): targets are SRGB8_ALPHA8 (perceptual storage, so the
 * dark palette does not band; blending still happens in linear) and every scene pass writes its
 * values × LDR_SCALE through a CONSTANT_COLOR blend factor, so highlights keep 1 / LDR_SCALE of
 * headroom instead of clamping at 1 before bloom. Bloom and composite scale back up.
 */
import { createProgram, createTarget, deleteTarget, beginTarget, invalidateTarget } from './gl.js';
import { FULLSCREEN_VS } from './shaders/common.js';
import { BRIGHT_FS, DOWN_FS, UP_FS, COMPOSITE_FS } from './shaders/post.js';

const LEVELS = 4;  // 1/2, 1/4, 1/8, 1/16
/** Scene and bloom values are stored × this in the 8-bit fallback (headroom up to 4.0). */
export const LDR_SCALE = 0.25;

export function createPost() {
  /** @type {import('./gl.js').Program | null} */ let bright = null;
  /** @type {import('./gl.js').Program | null} */ let down = null;
  /** @type {import('./gl.js').Program | null} */ let up = null;
  /** @type {import('./gl.js').Program | null} */ let comp = null;
  /** @type {import('./gl.js').Target | null} */ let scene = null;
  /** @type {(import('./gl.js').Target | null)[]} */
  const bloom = [null, null, null, null];
  let half = false;   // RGBA16F targets in use
  let canHalf = false;
  let forceLdr = false;
  let ldrFormat = 0;  // SRGB8_ALPHA8 when renderable, else RGBA8
  let w = 0, h = 0;

  const self = {
    get halfFloat() { return half; },
    get scene() { return scene; },

    /**
     * @param {import('./gl.js').Gfx} gfx
     * @param {boolean} [noHalf] force the 8-bit fallback (testing)
     */
    init(gfx, noHalf) {
      const gl = gfx.gl;
      forceLdr = !!noHalf;
      canHalf = !forceLdr && !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
      ldrFormat = 0;
      bright = createProgram(gl, FULLSCREEN_VS, BRIGHT_FS, 'bloomBright', ['uTex', 'uTexel', 'uThresh', 'uIO']);
      down = createProgram(gl, FULLSCREEN_VS, DOWN_FS, 'bloomDown', ['uTex', 'uTexel']);
      up = createProgram(gl, FULLSCREEN_VS, UP_FS, 'bloomUp', ['uTex', 'uTexel', 'uK']);
      comp = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite',
        ['uScene', 'uBloom', 'uBloomK', 'uExposure', 'uCA', 'uDim', 'uFlash', 'uRes']);
      scene = null;
      for (let i = 0; i < LEVELS; i++) bloom[i] = null;
      w = 0; h = 0;
    },

    /**
     * (Re)allocate targets for a backing size. Only on resize / render-scale change.
     * @param {import('./gl.js').Gfx} gfx @param {number} width @param {number} height
     */
    resize(gfx, width, height) {
      if (width === w && height === h && scene) return;
      const gl = gfx.gl;
      deleteTarget(gl, scene);
      for (let i = 0; i < LEVELS; i++) deleteTarget(gl, bloom[i]);
      w = width; h = height;
      half = canHalf;
      scene = half ? createTarget(gl, w, h, true) : null;
      if (!scene) {
        half = false;
        if (!ldrFormat) {
          // Probe once whether sRGB targets are renderable here.
          const probe = createTarget(gl, 4, 4, false, gl.CLAMP_TO_EDGE, gl.SRGB8_ALPHA8);
          ldrFormat = probe ? gl.SRGB8_ALPHA8 : gl.RGBA8;
          deleteTarget(gl, probe);
        }
        scene = createTarget(gl, w, h, false, gl.CLAMP_TO_EDGE, ldrFormat);
      }
      let bw = w, bh = h;
      for (let i = 0; i < LEVELS; i++) {
        bw = Math.max(1, Math.ceil(bw / 2)); bh = Math.max(1, Math.ceil(bh / 2));
        bloom[i] = createTarget(gl, bw, bh, half, gl.CLAMP_TO_EDGE, half ? 0 : ldrFormat);
      }
      // Scene range scaling for every scene pass (blend state is global; nothing else sets blendColor).
      const k = half ? 1 : LDR_SCALE;
      gfx.sceneScale = k;
      gfx.src = half ? gl.ONE : gl.CONSTANT_COLOR;
      gl.blendColor(k, k, k, k);
    },

    /** Internal format name of the scene target (debug / stats). */
    get format() { return half ? 'RGBA16F' : ldrFormat === 35907 ? 'SRGB8_ALPHA8' : 'RGBA8'; },

    /** Bind and clear the scene target. @param {import('./gl.js').Gfx} gfx @param {Float32Array} bg */
    beginScene(gfx, bg) {
      if (!scene) return;
      const k = gfx.sceneScale;
      beginTarget(gfx.gl, scene, bg[0] * k, bg[1] * k, bg[2] * k);
    },

    /**
     * Bloom chain + composite to the default framebuffer.
     * @param {import('./gl.js').Gfx} gfx
     * @param {number} ca chromatic aberration (0 = off)
     * @param {number} dim game-over dim 0..1
     * @param {number} flash white flash 0..1
     */
    finish(gfx, ca, dim, flash) {
      if (!scene || !bright || !down || !up || !comp) return;
      const gl = gfx.gl;
      gl.disable(gl.BLEND);
      gl.bindVertexArray(gfx.emptyVao);
      gl.activeTexture(gl.TEXTURE0);

      // Bright pass: scene → 1/2.
      const b0 = /** @type {import('./gl.js').Target} */ (bloom[0]);
      beginTarget(gl, b0, 0, 0, 0);
      gl.useProgram(bright.prog);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.uniform1i(bright.u.uTex, 0);
      gl.uniform2f(bright.u.uTexel, 1 / scene.w, 1 / scene.h);
      gl.uniform2f(bright.u.uThresh, 0.85, 0.45);
      gl.uniform2f(bright.u.uIO, 1 / gfx.sceneScale, gfx.sceneScale);
      gfx.drawArrays(gl.TRIANGLES, 0, 3);

      // Downsample 1/2 → 1/4 → 1/8 → 1/16.
      gl.useProgram(down.prog);
      gl.uniform1i(down.u.uTex, 0);
      for (let i = 1; i < LEVELS; i++) {
        const src = /** @type {import('./gl.js').Target} */ (bloom[i - 1]);
        const dst = /** @type {import('./gl.js').Target} */ (bloom[i]);
        beginTarget(gl, dst, 0, 0, 0);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(down.u.uTexel, 1 / src.w, 1 / src.h);
        gfx.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // Upsample and add: 1/16 → 1/8 → 1/4 → 1/2.
      gl.useProgram(up.prog);
      gl.uniform1i(up.u.uTex, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = LEVELS - 1; i > 0; i--) {
        const src = /** @type {import('./gl.js').Target} */ (bloom[i]);
        const dst = /** @type {import('./gl.js').Target} */ (bloom[i - 1]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(up.u.uTexel, 0.5 / src.w, 0.5 / src.h);
        gl.uniform1f(up.u.uK, i === LEVELS - 1 ? 1.1 : 1.0);
        gfx.drawArrays(gl.TRIANGLES, 0, 3);
        invalidateTarget(gfx, src);
      }
      gl.disable(gl.BLEND);

      // Composite to the screen.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(comp.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, scene.tex);
      gl.uniform1i(comp.u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, b0.tex);
      gl.uniform1i(comp.u.uBloom, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(comp.u.uBloomK, 0.9 / gfx.sceneScale);
      gl.uniform1f(comp.u.uExposure, 1.0 / gfx.sceneScale);
      gl.uniform1f(comp.u.uCA, ca);
      gl.uniform1f(comp.u.uDim, dim);
      gl.uniform1f(comp.u.uFlash, flash);
      gl.uniform2f(comp.u.uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gfx.drawArrays(gl.TRIANGLES, 0, 3);

      invalidateTarget(gfx, b0);
      invalidateTarget(gfx, scene);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
  };
  return self;
}
