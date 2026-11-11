// @ts-check
/**
 * Background pass (PLAN.md §4.2): one full-screen triangle with three parallax star layers from an
 * integer hash, a nebula baked once per zone into a tileable 512² texture (on the GPU) and
 * cross-faded on zone change, and the glowing side walls. Parallax offsets are wrapped with a
 * modulo in JS doubles before upload.
 */
import { CONFIG, ZONES } from '../config.js';
import { createProgram, hexToLinear } from './gl.js';
import { FULLSCREEN_VS } from './shaders/common.js';
import { BACKGROUND_FS, NEBULA_BAKE_FS } from './shaders/background.js';

/** Linear palettes, 12 floats per zone: bg, nebA, nebB, accent. Built once at module load. */
export const PALETTE = new Float32Array(ZONES.length * 12);
for (let z = 0; z < ZONES.length; z++) {
  hexToLinear(ZONES[z].bg, PALETTE, z * 12);
  hexToLinear(ZONES[z].nebulaA, PALETTE, z * 12 + 3);
  hexToLinear(ZONES[z].nebulaB, PALETTE, z * 12 + 6);
  hexToLinear(ZONES[z].accent, PALETTE, z * 12 + 9);
}

/** Palette index (0..4) for a 1-based zone number. @param {number} zone */
export const paletteIndex = (zone) => ((((zone | 0) - 1) % ZONES.length) + ZONES.length) % ZONES.length;

const STAR_CELL = [22, 52, 150];
const STAR_PARALLAX = [0.06, 0.16, 0.38];
const NEB_PARALLAX = 0.1;
const NEB_TILE = 1900;
const NEB_SIZE = CONFIG.NEBULA_TEXTURE_SIZE;
const NEB_LEVELS = Math.log2(NEB_SIZE) + 1;

/** @param {number} a @param {number} p */
const wrap = (a, p) => ((a % p) + p) % p;

const UNIFORMS = ['uRes', 'uView', 'uBase', 'uZoom', 'uCamX', 'uStar0', 'uStar1', 'uStar2', 'uNeb',
  'uNebTile', 'uFade', 'uTexPrev', 'uTexCur', 'uPal', 'uTime', 'uWall'];

export function createBackground() {
  /** @type {import('./gl.js').Program | null} */
  let prog = null;
  /** @type {import('./gl.js').Program | null} */
  let bakeProg = null;
  /** @type {(WebGLTexture | null)[]} */
  const tex = [null, null];
  /** @type {WebGLFramebuffer | null} */
  let bakeFb = null;
  let cur = 0;             // index into tex of the current zone's nebula
  let curPal = 0;
  let prevPal = 0;
  let fade = 1;
  let pendingBake = true;  // bake curPal into tex[cur] before the next draw
  const pal = new Float32Array(24);
  const bg = new Float32Array(3);
  let flashL = 0, flashR = 0;

  const self = {
    /** Linear background colour of the current zone (for clears). */
    bg,
    /** (Re)create every GL resource. @param {import('./gl.js').Gfx} gfx */
    init(gfx) {
      const gl = gfx.gl;
      prog = createProgram(gl, FULLSCREEN_VS, BACKGROUND_FS, 'background', UNIFORMS);
      bakeProg = createProgram(gl, FULLSCREEN_VS, NEBULA_BAKE_FS, 'nebulaBake', ['uSeed', 'uSize']);
      for (let i = 0; i < 2; i++) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, NEB_LEVELS, gl.RGBA8, NEB_SIZE, NEB_SIZE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        tex[i] = t;
      }
      bakeFb = gl.createFramebuffer();
      // After a context restore both textures are blank: rebake current, skip the fade.
      fade = 1;
      pendingBake = true;
    },

    /** Switch to a zone's palette; cross-fades unless `instant`. @param {number} palIdx @param {boolean} instant */
    setPalette(palIdx, instant) {
      if (palIdx === curPal && !pendingBake) return;
      if (palIdx !== curPal) {
        prevPal = curPal;
        curPal = palIdx;
        cur = 1 - cur;
        fade = instant ? 1 : 0;
      }
      pendingBake = true;
    },

    get palette() { return curPal; },
    get fade() { return fade; },
    get prevPalette() { return prevPal; },

    /** @param {number} side -1 left, +1 right */
    flash(side) { if (side < 0) flashL = 1; else flashR = 1; },
    resetFx() { flashL = 0; flashR = 0; },

    /**
     * Bake the pending nebula if any. Must run outside the scene pass (binds its own target).
     * @param {import('./gl.js').Gfx} gfx
     */
    bakeIfNeeded(gfx) {
      if (!pendingBake || !bakeProg) return;
      const gl = gfx.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[cur], 0);
      gl.viewport(0, 0, NEB_SIZE, NEB_SIZE);
      gl.disable(gl.BLEND);
      gl.useProgram(bakeProg.prog);
      gl.uniform1ui(bakeProg.u.uSeed, (0x51a7 + curPal * 7919) >>> 0);
      gl.uniform1f(bakeProg.u.uSize, NEB_SIZE);
      gl.bindVertexArray(gfx.emptyVao);
      gfx.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.generateMipmap(gl.TEXTURE_2D);
      pendingBake = false;
    },

    /**
     * Draw into the currently bound scene target.
     * @param {import('./gl.js').Gfx} gfx
     * @param {import('./camera.js').Camera} cam
     * @param {number} w @param {number} h backing size
     * @param {number} time renderer clock
     * @param {number} dt real seconds
     */
    draw(gfx, cam, w, h, time, dt) {
      if (!prog) return;
      const gl = gfx.gl;
      const u = prog.u;
      if (fade < 1) fade = Math.min(1, fade + dt / CONFIG.ZONE_CROSSFADE_S);
      flashL *= Math.exp(-dt * 5);
      flashR *= Math.exp(-dt * 5);
      const vy = cam.y + cam.shakeY;
      const vx = cam.shakeX;
      for (let i = 0; i < 12; i++) {
        pal[i] = PALETTE[prevPal * 12 + i];
        pal[12 + i] = PALETTE[curPal * 12 + i];
      }
      gl.useProgram(prog.prog);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uView, cam.viewW, cam.viewH);
      gl.uniform2f(u.uBase, CONFIG.FIELD_WIDTH, CONFIG.FIELD_WIDTH * (h / w));
      gl.uniform1f(u.uZoom, cam.zoom);
      gl.uniform1f(u.uCamX, cam.x + vx);
      gl.uniform2f(u.uStar0, vx * STAR_PARALLAX[0] + 11, wrap(vy * STAR_PARALLAX[0], STAR_CELL[0] * 1024));
      gl.uniform2f(u.uStar1, vx * STAR_PARALLAX[1] + 37, wrap(vy * STAR_PARALLAX[1], STAR_CELL[1] * 1024));
      gl.uniform2f(u.uStar2, vx * STAR_PARALLAX[2] + 73, wrap(vy * STAR_PARALLAX[2], STAR_CELL[2] * 1024));
      gl.uniform4f(u.uNeb,
        0.17 + vx * NEB_PARALLAX / NEB_TILE, wrap(vy * NEB_PARALLAX / NEB_TILE, 1),
        0.41, wrap(vy * NEB_PARALLAX / (NEB_TILE * 2.7), 1));
      gl.uniform1f(u.uNebTile, NEB_TILE);
      gl.uniform1f(u.uFade, fade);
      gl.uniform3fv(u.uPal, pal);
      gl.uniform1f(u.uTime, time % 3600);
      gl.uniform4f(u.uWall, flashL, flashR, wrap(vy, 1024), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex[1 - cur]);
      gl.uniform1i(u.uTexPrev, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.uniform1i(u.uTexCur, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(gfx.emptyVao);
      gfx.drawArrays(gl.TRIANGLES, 0, 3);
      bg[0] = PALETTE[curPal * 12]; bg[1] = PALETTE[curPal * 12 + 1]; bg[2] = PALETTE[curPal * 12 + 2];
    },
  };
  return self;
}
