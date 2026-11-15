// @ts-check
/**
 * Effects passes: the collapse front, the comet trail ribbon, and one instanced draw of additive
 * glow sprites (aim-line dots, stardust motes, ring pulses and the HDR comet head).
 * All per-frame data goes into preallocated typed arrays.
 */
import { CONFIG } from '../config.js';
import { COMET } from '../contracts.js';
import { createProgram, createQuadBuffer } from './gl.js';
import {
  SPRITES_VS, SPRITES_FS, TRAIL_VS, TRAIL_FS, FRONT_VS, FRONT_FS, SHAPE, FRONT_NOISE_SIZE, FRONT_NOISE_CELLS,
} from './shaders/fx.js';

const MAX_SPRITES = 384;
const SSTRIDE = 12;
const TRAIL_POINTS = 160;
const PULSES = 16;
const FRONT_GLOW_ABOVE = 760;
/** Ring-pulse quads reach this many ring widths past the ring (must match SPRITES_FS shape 3). */
const RING_REACH = 8;

/** PCG integer hash (same as the GLSL `pcg`). @param {number} v */
function pcg(v) {
  const st = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((st >>> ((st >>> 28) + 4)) ^ st) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/**
 * Bake the front's tileable value noise once (module load): FRONT_NOISE_CELLS lattice cells with
 * integer-hashed values and smoothstep interpolation, periodic on the tile. R8.
 */
const FRONT_NOISE = (() => {
  const N = FRONT_NOISE_SIZE, C = FRONT_NOISE_CELLS, per = N / C;
  const lat = new Float32Array(C * C);
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) lat[y * C + x] = (pcg(x ^ pcg(y ^ pcg(0x5f3))) >>> 8) / 16777216;
  const out = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    const gy = (y + 0.5) / per, iy = Math.floor(gy), fy = gy - iy, uy = fy * fy * (3 - 2 * fy);
    const y0 = iy % C, y1 = (iy + 1) % C;
    for (let x = 0; x < N; x++) {
      const gx = (x + 0.5) / per, ix = Math.floor(gx), fx = gx - ix, ux = fx * fx * (3 - 2 * fx);
      const x0 = ix % C, x1 = (ix + 1) % C;
      const a = lat[y0 * C + x0], b = lat[y0 * C + x1], c = lat[y1 * C + x0], d = lat[y1 * C + x1];
      const v = (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
      out[y * N + x] = Math.round(v * 255);
    }
  }
  return out;
})();

export function createFx() {
  /** @type {import('./gl.js').Program | null} */
  let spriteProg = null;
  /** @type {import('./gl.js').Program | null} */
  let trailProg = null;
  /** @type {import('./gl.js').Program | null} */
  let frontProg = null;
  /** @type {WebGLVertexArrayObject | null} */
  let spriteVao = null;
  /** @type {WebGLBuffer | null} */
  let spriteBuf = null;
  /** @type {WebGLVertexArrayObject | null} */
  let trailVao = null;
  /** @type {WebGLBuffer | null} */
  let trailBuf = null;
  /** @type {WebGLTexture | null} */
  let noiseTex = null;

  const sprites = new Float32Array(MAX_SPRITES * SSTRIDE);
  let spriteCount = 0;

  // Trail history ring (world positions + effect-clock time).
  const histX = new Float64Array(TRAIL_POINTS);
  const histY = new Float64Array(TRAIL_POINTS);
  const histT = new Float64Array(TRAIL_POINTS);
  let histHead = 0;
  let histLen = 0;
  const trailVerts = new Float32Array(TRAIL_POINTS * 2 * 4);
  let trailCount = 0;  // vertices
  const trailColor = new Float32Array(3);

  // Ring pulses: x, y, birth, duration, max radius, r, g, b.
  const pulse = new Float64Array(PULSES * 8);
  let pulseNext = 0;

  /**
   * Sprite staging: rel x, rel y, half x, half y, cos, sin, shape, param, r, g, b, intensity.
   * Filled by the caller, then commitSprite() appends it (no doubles passed as call arguments).
   */
  const S = new Float64Array(SSTRIDE);
  function commitSprite() {
    if (spriteCount >= MAX_SPRITES) return;
    const o = spriteCount * SSTRIDE;
    for (let k = 0; k < SSTRIDE; k++) sprites[o + k] = S[k];
    spriteCount++;
  }

  const self = {
    trailColor,

    /** @param {import('./gl.js').Gfx} gfx */
    init(gfx) {
      const gl = gfx.gl;
      spriteProg = createProgram(gl, SPRITES_VS, SPRITES_FS, 'sprites', ['uScale'], ['aCorner', 'aA', 'aB', 'aC']);
      trailProg = createProgram(gl, TRAIL_VS, TRAIL_FS, 'trail', ['uScale', 'uColor'], ['aV']);
      frontProg = createProgram(gl, FRONT_VS, FRONT_FS, 'front',
        ['uRect', 'uRes', 'uView', 'uFrontRel', 'uCamX', 'uAcc', 'uTime', 'uGlowTop', 'uNoise']);
      noiseTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FRONT_NOISE_SIZE, FRONT_NOISE_SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, FRONT_NOISE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.bindTexture(gl.TEXTURE_2D, null);

      spriteVao = gl.createVertexArray();
      gl.bindVertexArray(spriteVao);
      createQuadBuffer(gl);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      spriteBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
      gl.bufferData(gl.ARRAY_BUFFER, sprites.byteLength, gl.DYNAMIC_DRAW);
      for (let a = 0; a < 3; a++) {
        gl.enableVertexAttribArray(1 + a);
        gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, SSTRIDE * 4, a * 16);
        gl.vertexAttribDivisor(1 + a, 1);
      }
      trailVao = gl.createVertexArray();
      gl.bindVertexArray(trailVao);
      trailBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf);
      gl.bufferData(gl.ARRAY_BUFFER, trailVerts.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(null);
    },

    /** Warm-up content: one sprite of every shape and a short trail strip near the view centre. */
    warm() {
      spriteCount = 0;
      for (let k = 0; k < 5; k++) {
        S[0] = k * 40 - 80; S[1] = 0; S[2] = 24; S[3] = 24; S[4] = 1; S[5] = 0; S[6] = k; S[7] = 0.5;
        S[8] = 1; S[9] = 1; S[10] = 1; S[11] = 1;
        commitSprite();
      }
      for (let k = 0; k < 4; k++) {
        const o = k * 4;
        trailVerts[o] = (k & 1) ? 10 : -10; trailVerts[o + 1] = (k >> 1) * 40;
        trailVerts[o + 2] = (k & 1) ? 1 : -1; trailVerts[o + 3] = (k >> 1) * 0.5;
      }
      trailCount = 4;
    },

    reset() {
      histLen = 0; histHead = 0;
      for (let i = 0; i < PULSES; i++) pulse[i * 8 + 3] = 0;
    },

    /**
     * Start an expanding ring pulse.
     * @param {number} x @param {number} y @param {number} now @param {number} dur @param {number} maxR
     * @param {number} r @param {number} g @param {number} b
     */
    addPulse(x, y, now, dur, maxR, r, g, b) {
      const o = pulseNext * 8;
      pulse[o] = x; pulse[o + 1] = y; pulse[o + 2] = now; pulse[o + 3] = dur; pulse[o + 4] = maxR;
      pulse[o + 5] = r; pulse[o + 6] = g; pulse[o + 7] = b;
      pulseNext = (pulseNext + 1) % PULSES;
    },

    /** Record the comet position for the trail. @param {number} x @param {number} y @param {number} now */
    record(x, y, now) {
      histX[histHead] = x; histY[histHead] = y; histT[histHead] = now;
      histHead = (histHead + 1) % TRAIL_POINTS;
      if (histLen < TRAIL_POINTS) histLen++;
    },

    /**
     * Build the trail strip (newest → oldest, within `tailLen` seconds) relative to the view.
     * @param {number} vx @param {number} vy view centre @param {number} now @param {number} tailLen seconds
     * @param {number} halfW half width at the head (world units)
     */
    buildTrail(vx, vy, now, tailLen, halfW) {
      trailCount = 0;
      if (histLen < 2) return;
      let n = 0;
      for (let k = 0; k < histLen; k++) {
        const i = (histHead - 1 - k + TRAIL_POINTS * 2) % TRAIL_POINTS;
        if (now - histT[i] > tailLen) break;
        n++;
      }
      if (n < 2) return;
      for (let k = 0; k < n; k++) {
        const i = (histHead - 1 - k + TRAIL_POINTS * 2) % TRAIL_POINTS;
        const ia = (histHead - 1 - (k > 0 ? k - 1 : 0) + TRAIL_POINTS * 2) % TRAIL_POINTS;
        const ib = (histHead - 1 - (k < n - 1 ? k + 1 : n - 1) + TRAIL_POINTS * 2) % TRAIL_POINTS;
        let tx = histX[ia] - histX[ib], ty = histY[ia] - histY[ib];
        const tl = Math.sqrt(tx * tx + ty * ty);
        if (tl > 1e-6) { tx /= tl; ty /= tl; } else { tx = 0; ty = 1; }
        const t = Math.min(1, (now - histT[i]) / tailLen);
        const w = halfW * (1 - 0.8 * t);
        const px = histX[i] - vx, py = histY[i] - vy;
        const o = trailCount * 4;
        trailVerts[o] = px - ty * w; trailVerts[o + 1] = py + tx * w; trailVerts[o + 2] = -1; trailVerts[o + 3] = t;
        trailVerts[o + 4] = px + ty * w; trailVerts[o + 5] = py - tx * w; trailVerts[o + 6] = 1; trailVerts[o + 7] = t;
        trailCount += 2;
      }
    },

    /**
     * Build the sprite list: aim dots, motes, pulses, comet head.
     * @param {import('../contracts.js').WorldT} world
     * @param {import('./camera.js').Camera} cam
     * @param {number} vx @param {number} vy view centre
     * @param {number} now effect clock @param {number} time ambient clock
     * @param {Float32Array} accent linear rgb of the current accent
     * @param {Float32Array} tier linear HDR rgb of the comet's current colour
     */
    buildSprites(world, cam, vx, vy, now, time, accent, tier) {
      spriteCount = 0;
      const halfH = cam.viewH * 0.5 + 40;
      // Aim line dots.
      const aim = world.aim;
      if (aim.active && world.comet.state === COMET.ORBIT) {
        const sp = CONFIG.AIM_DOT_SPACING;
        const march = (time * 70) % sp;
        const clear = aim.clear;
        const r = clear ? accent[0] * 2.2 : 0.62, g = clear ? accent[1] * 2.2 : 0.66, b = clear ? accent[2] * 2.2 : 0.75;
        const ox = cam.cometX - vx, oy = cam.cometY - vy;
        // Dots walk the forecast path (aim.points: offsets from the comet, bent through black-hole
        // influence; 2 vertices when straight). Without a path, the straight tangent.
        const pts = aim.points;
        const np = pts && aim.pointCount >= 2 ? aim.pointCount : 0;
        let j = 0, segS = 0, segL = 0, ax = 0, ay = 0, ux = aim.dx, uy = aim.dy;
        if (np) {
          ax = pts[0]; ay = pts[1];
          const ex = pts[2] - ax, ey = pts[3] - ay;
          segL = Math.sqrt(ex * ex + ey * ey);
          if (segL > 1e-6) { ux = ex / segL; uy = ey / segL; }
        }
        for (let s = sp + march; s < aim.length; s += sp) {
          if (np) {
            while (s > segS + segL && j + 2 < np) {
              segS += segL; j++;
              ax = pts[j * 2]; ay = pts[j * 2 + 1];
              const ex = pts[j * 2 + 2] - ax, ey = pts[j * 2 + 3] - ay;
              segL = Math.sqrt(ex * ex + ey * ey);
              if (segL > 1e-6) { ux = ex / segL; uy = ey / segL; }
            }
          }
          const f = s / aim.length;
          const k = (1 - f * f * 0.85) * (s < 50 ? (s - 20) / 30 : 1);
          if (k <= 0) continue;
          const sz = clear ? 15 : 13;
          const along = s - segS;
          S[0] = ox + ax + ux * along; S[1] = oy + ay + uy * along; S[2] = sz; S[3] = sz; S[4] = 1; S[5] = 0;
          S[6] = SHAPE.DOT; S[7] = 0; S[8] = r; S[9] = g; S[10] = b; S[11] = k;
          commitSprite();
        }
      }
      // Stardust motes.
      const m = world.motes;
      for (let i = 0; i < m.count; i++) {
        if (!m.alive[i]) continue;
        const ry = m.y[i] - vy;
        if (ry > halfH || ry < -halfH) continue;
        const ph = (i * 2.399) % 6.283;
        const tw = 0.5 + 0.5 * Math.sin(time * 4.1 + ph);
        const rot = time * 0.7 + ph;
        S[0] = m.x[i] - vx; S[1] = ry; S[2] = 24; S[3] = 24; S[4] = Math.cos(rot);
        S[5] = Math.sin(rot); S[6] = SHAPE.MOTE; S[7] = tw; S[8] = 1.0 + accent[0] * 0.5;
        S[9] = 0.86 + accent[1] * 0.4; S[10] = 0.55 + accent[2] * 0.4; S[11] = 1.2;
        commitSprite();
      }
      // Ring pulses.
      for (let p = 0; p < PULSES; p++) {
        const o = p * 8;
        const dur = pulse[o + 3];
        if (dur <= 0) continue;
        const age = now - pulse[o + 2];
        if (age < 0 || age > dur) { if (age > dur) pulse[o + 3] = 0; continue; }
        const t = age / dur;
        const e = 1 - (1 - t) * (1 - t) * (1 - t);
        const R = pulse[o + 4];
        const fadeK = (1 - t) * (1 - t) * 1.6;
        // Quad = current ring radius + RING_REACH ring widths (beyond that the glow is < 2e-4),
        // not the final radius from birth. The shader applies the same factor.
        const rt = e * 0.96 + 0.02;
        const reach = rt + RING_REACH * (0.014 + 0.03 * rt);
        const Q = R * (reach < 1 ? reach : 1);
        S[0] = pulse[o] - vx; S[1] = pulse[o + 1] - vy; S[2] = Q; S[3] = Q; S[4] = 1; S[5] = 0;
        S[6] = SHAPE.RING; S[7] = rt; S[8] = pulse[o + 5]; S[9] = pulse[o + 6];
        S[10] = pulse[o + 7]; S[11] = fadeK;
        commitSprite();
      }
      // Comet head.
      const c = world.comet;
      if (c.state !== COMET.DEAD) {
        const sp = c.speed;
        // Smaller after braces (size 1 → 0.5 shows at 70%).
        const hy = 30 * (0.4 + 0.6 * c.size);
        const asp = 1 + Math.min(sp, 2400) * 0.00055;
        const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
        S[0] = cam.cometX - vx; S[1] = cam.cometY - vy; S[2] = hy * asp; S[3] = hy; S[4] = ch;
        S[5] = sh; S[6] = SHAPE.HEAD; S[7] = asp; S[8] = tier[0]; S[9] = tier[1]; S[10] = tier[2];
        S[11] = 1;
        commitSprite();
        // Wide soft halo for presence.
        S[0] = cam.cometX - vx; S[1] = cam.cometY - vy; S[2] = 3 * hy; S[3] = 3 * hy; S[4] = 1; S[5] = 0;
        S[6] = SHAPE.GLOW; S[7] = 0; S[8] = tier[0]; S[9] = tier[1]; S[10] = tier[2]; S[11] = 0.22;
        commitSprite();
      }
    },

    /**
     * Draw the collapse front if it is on screen.
     * @param {import('./gl.js').Gfx} gfx
     * @param {number} frontRel front y minus view centre y
     * @param {import('./camera.js').Camera} cam
     * @param {number} w @param {number} h backing size
     * @param {Float32Array} accent
     * @param {number} time
     * @param {boolean} force warm-up
     */
    drawFront(gfx, frontRel, cam, w, h, accent, time, force) {
      if (!frontProg) return;
      const top = (frontRel + FRONT_GLOW_ABOVE) * cam.sy;
      if (top < -1 && !force) return;
      const gl = gfx.gl;
      const u = frontProg.u;
      gl.useProgram(frontProg.prog);
      gl.uniform2f(u.uRect, -1, top > 1 ? 1 : top < -1 ? -0.99 : top);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uView, cam.viewW, cam.viewH);
      gl.uniform1f(u.uFrontRel, frontRel);
      gl.uniform1f(u.uCamX, cam.x + cam.shakeX);
      gl.uniform3f(u.uAcc, accent[0], accent[1], accent[2]);
      gl.uniform1f(u.uTime, time % 3600);
      gl.uniform1f(u.uGlowTop, FRONT_GLOW_ABOVE - 40);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.uniform1i(u.uNoise, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gfx.src, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(gfx.emptyVao);
      gfx.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },

    /** @param {import('./gl.js').Gfx} gfx @param {number} sx @param {number} sy @param {boolean} force */
    drawTrail(gfx, sx, sy, force) {
      if (!trailProg) return;
      const n = force && trailCount < 4 ? 4 : trailCount;
      if (n < 4) return;
      const gl = gfx.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, trailBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, trailVerts, 0, n * 4);
      gl.useProgram(trailProg.prog);
      gl.uniform2f(trailProg.u.uScale, sx, sy);
      gl.uniform3f(trailProg.u.uColor, trailColor[0], trailColor[1], trailColor[2]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gfx.src, gl.ONE);
      gl.bindVertexArray(trailVao);
      gfx.drawArrays(gl.TRIANGLE_STRIP, 0, n);
      gl.bindVertexArray(null);
    },

    /** @param {import('./gl.js').Gfx} gfx @param {number} sx @param {number} sy @param {boolean} force */
    drawSprites(gfx, sx, sy, force) {
      if (!spriteProg) return;
      const n = force && spriteCount === 0 ? 1 : spriteCount;
      if (n === 0) return;
      const gl = gfx.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sprites, 0, n * SSTRIDE);
      gl.useProgram(spriteProg.prog);
      gl.uniform2f(spriteProg.u.uScale, sx, sy);
      gl.enable(gl.BLEND);
      gl.blendFunc(gfx.src, gl.ONE);
      gl.bindVertexArray(spriteVao);
      gfx.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    },
  };
  return self;
}
