// @ts-check
/**
 * Background pass (PLAN.md §4.2): one full-screen triangle with three parallax star layers from an
 * integer hash, a nebula baked into a tileable 512² texture (on the GPU) and cross-faded on zone
 * change, and the glowing side walls. Parallax offsets are wrapped with a modulo in JS doubles
 * before upload.
 *
 * Phase 4: there are only five palettes, so each palette's nebula is baked once and kept (5
 * textures, ~1.4 MB each with mips). The current and previous palettes bake at once on boot /
 * context restore; the others bake in the background one 128-row strip per frame (next zone
 * first), so a zone change finds its nebula ready and the cross-fade (CONFIG.NEBULA_CROSSFADE_S)
 * starts on the same frame. Each strip is cleared (inside its scissor) before it is drawn.
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
  'uNebTile', 'uFade', 'uTexPrev', 'uTexCur', 'uPal', 'uTime', 'uWall', 'uHoles', 'uHoleCount'];
/** A zone-change bake is spread over this many frames (row strips via scissor) to avoid a hitch. */
const BAKE_STRIPS = 4;
const STRIP_H = NEB_SIZE / BAKE_STRIPS;

export function createBackground() {
  /** @type {import('./gl.js').Program | null} */
  let prog = null;
  /** @type {import('./gl.js').Program | null} */
  let bakeProg = null;
  const NPAL = ZONES.length;
  /** One nebula texture per palette, and the next strip each still has to bake (BAKE_STRIPS = done). */
  /** @type {(WebGLTexture | null)[]} */
  const tex = [];
  for (let i = 0; i < NPAL; i++) tex.push(null);
  const texRow = new Int32Array(NPAL).fill(BAKE_STRIPS);
  /** @type {WebGLFramebuffer | null} */
  let bakeFb = null;
  let curPal = 0;
  let prevPal = 0;
  let fade = 1;
  let bakeAll = true;      // finish the current / previous bakes in one go (boot, restore, instant switch)
  const pal = new Float32Array(24);
  const bg = new Float32Array(3);
  let flashL = 0, flashR = 0;

  /**
   * Bake rows [row0, row1) strips of palette i's texture.
   * @param {import('./gl.js').Gfx} gfx @param {number} i @param {number} row0 @param {number} row1
   */
  function bakeRows(gfx, i, row0, row1) {
    const gl = gfx.gl;
    if (!bakeProg) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, bakeFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex[i], 0);
    gl.viewport(0, 0, NEB_SIZE, NEB_SIZE);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, row0 * STRIP_H, NEB_SIZE, (row1 - row0) * STRIP_H);
    // PLAN §4.4: clear the target at the start of its pass (here: the strip about to be drawn).
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(bakeProg.prog);
    gl.uniform1ui(bakeProg.u.uSeed, (0x51a7 + i * 7919) >>> 0);
    gl.uniform1f(bakeProg.u.uSize, NEB_SIZE);
    gl.bindVertexArray(gfx.emptyVao);
    gfx.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    texRow[i] = row1;
    if (row1 >= BAKE_STRIPS) {
      gl.bindTexture(gl.TEXTURE_2D, tex[i]);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  const self = {
    /** Linear background colour of the current zone (for clears). */
    bg,
    /** (Re)create every GL resource. After a context restore every nebula is re-baked (current and
     * previous palette at once), so a cross-fade in progress carries on. @param {import('./gl.js').Gfx} gfx */
    init(gfx) {
      const gl = gfx.gl;
      prog = createProgram(gl, FULLSCREEN_VS, BACKGROUND_FS, 'background', UNIFORMS);
      bakeProg = createProgram(gl, FULLSCREEN_VS, NEBULA_BAKE_FS, 'nebulaBake', ['uSeed', 'uSize']);
      for (let i = 0; i < NPAL; i++) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, NEB_LEVELS, gl.RGBA8, NEB_SIZE, NEB_SIZE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        tex[i] = t;
        texRow[i] = 0;
      }
      bakeFb = gl.createFramebuffer();
      bakeAll = true;
    },

    /** Switch to a zone's palette; cross-fades unless `instant`. @param {number} palIdx @param {boolean} instant */
    setPalette(palIdx, instant) {
      if (palIdx !== curPal) {
        prevPal = curPal;
        curPal = palIdx;
        fade = instant ? 1 : 0;
      }
      if (instant) {
        fade = 1;
        if (texRow[curPal] < BAKE_STRIPS) bakeAll = true;
      }
    },

    get palette() { return curPal; },
    get fade() { return fade; },
    get prevPalette() { return prevPal; },
    /** True while any nebula bake is still in progress. */
    get baking() { for (let i = 0; i < NPAL; i++) if (texRow[i] < BAKE_STRIPS) return true; return false; },
    /** True when palette i's nebula is fully baked (debug / tests). @param {number} i */
    baked(i) { return texRow[i] >= BAKE_STRIPS; },

    /** @param {number} side -1 left, +1 right */
    flash(side) { if (side < 0) flashL = 1; else flashR = 1; },
    resetFx() { flashL = 0; flashR = 0; },

    /**
     * Advance pending nebula bakes. The current and previous palettes come first: all at once after
     * boot / restore / an instant switch, otherwise one strip per frame. Then the other palettes
     * bake one strip per frame, starting with the next zone's. Must run outside the scene pass.
     * @param {import('./gl.js').Gfx} gfx
     */
    bakeIfNeeded(gfx) {
      if (!bakeProg) return;
      for (let k = 0; k < 2; k++) {
        const i = k === 0 ? curPal : prevPal;
        if (texRow[i] >= BAKE_STRIPS) continue;
        if (bakeAll) { bakeRows(gfx, i, texRow[i], BAKE_STRIPS); continue; }
        bakeRows(gfx, i, texRow[i], texRow[i] + 1);
        return;
      }
      bakeAll = false;
      for (let k = 1; k < NPAL; k++) {
        const i = (curPal + k) % NPAL;
        if (texRow[i] < BAKE_STRIPS) { bakeRows(gfx, i, texRow[i], texRow[i] + 1); return; }
      }
    },

    /**
     * Draw into the currently bound scene target.
     * @param {import('./gl.js').Gfx} gfx
     * @param {import('./camera.js').Camera} cam
     * @param {number} w @param {number} h backing size
     * @param {number} time renderer clock
     * @param {number} dt real seconds
     * @param {Float32Array} holes black holes for lensing (rel x, rel y, core r, influence r)
     * @param {number} holeCount
     */
    draw(gfx, cam, w, h, time, dt, holes, holeCount) {
      if (!prog) return;
      const gl = gfx.gl;
      const u = prog.u;
      // The fade starts once the new nebula is fully baked (normally it already is: see bakeIfNeeded).
      if (fade < 1 && texRow[curPal] >= BAKE_STRIPS) fade = Math.min(1, fade + dt / CONFIG.NEBULA_CROSSFADE_S);
      flashL *= Math.exp(-dt * 5);
      flashR *= Math.exp(-dt * 5);
      const vy = cam.y + cam.shakeY;
      const vx = cam.x - CONFIG.FIELD_WIDTH / 2 + cam.shakeX;   // parallax offset from the field centre
      for (let i = 0; i < 12; i++) {
        pal[i] = PALETTE[prevPal * 12 + i];
        pal[12 + i] = PALETTE[curPal * 12 + i];
      }
      gl.useProgram(prog.prog);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uView, cam.viewW, cam.viewH);
      gl.uniform2f(u.uBase, CONFIG.FIELD_WIDTH, CONFIG.FIELD_WIDTH * (h / w));
      gl.uniform1f(u.uZoom, cam.zoom);
      gl.uniform1f(u.uCamX, cam.x + cam.shakeX);
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
      gl.uniform4fv(u.uHoles, holes);
      gl.uniform1i(u.uHoleCount, holeCount);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex[prevPal]);
      gl.uniform1i(u.uTexPrev, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex[curPal]);
      gl.uniform1i(u.uTexCur, 1);
      gl.activeTexture(gl.TEXTURE0);
      if (gfx.sceneScale !== 1) {
        // Opaque pass, scaled into the 8-bit scene range.
        gl.enable(gl.BLEND);
        gl.blendFunc(gfx.src, gl.ZERO);
      } else {
        gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(gfx.emptyVao);
      gfx.drawArrays(gl.TRIANGLES, 0, 3);
      bg[0] = PALETTE[curPal * 12]; bg[1] = PALETTE[curPal * 12 + 1]; bg[2] = PALETTE[curPal * 12 + 2];
    },
  };
  return self;
}
