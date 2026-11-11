// @ts-check
/**
 * Bodies pass (PLAN.md §4.2): one instanced draw for planets (with capture rings and drift wakes),
 * moons (with orbit traces), black holes, binary shared orbits and drift tracks. Instance data is rebuilt per frame into preallocated typed arrays
 * (positions relative to the view centre, computed in doubles), then uploaded with bufferSubData.
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { createProgram, createQuadBuffer } from './gl.js';
import { BODIES_VS, BODIES_FS, BTYPE } from './shaders/bodies.js';
import { PALETTE, paletteIndex } from './background.js';

const MAX_INST = CONFIG.MAX_BODIES * 2 + 16;
const FSTRIDE = 12; // floats per instance: aA, aB, aC
const USTRIDE = 4;  // uints per instance
const UNIFORMS = ['uScale', 'uPalA', 'uPalB', 'uPalC', 'uAccent', 'uTime', 'uUpp'];
/** Black holes passed to the background pass for starfield lensing (vec4 each). */
export const MAX_LENS = 4;
const TAU = Math.PI * 2;

const palA = new Float32Array(15), palB = new Float32Array(15), palC = new Float32Array(15);
for (let z = 0; z < 5; z++) {
  for (let k = 0; k < 3; k++) {
    palA[z * 3 + k] = PALETTE[z * 12 + 3 + k];
    palB[z * 3 + k] = PALETTE[z * 12 + 6 + k];
    palC[z * 3 + k] = PALETTE[z * 12 + 9 + k];
  }
}

export function createBodiesPass() {
  /** @type {import('./gl.js').Program | null} */
  let prog = null;
  /** @type {WebGLVertexArrayObject | null} */
  let vao = null;
  /** @type {WebGLBuffer | null} */
  let fbuf = null;
  /** @type {WebGLBuffer | null} */
  let ubuf = null;
  const fdata = new Float32Array(MAX_INST * FSTRIDE);
  const udata = new Uint32Array(MAX_INST * USTRIDE);
  let count = 0;
  // Per-slot effect state (keyed by body id so recycled slots start fresh).
  const slotId = new Uint32Array(CONFIG.MAX_BODIES);
  const highlight = new Float32Array(CONFIG.MAX_BODIES);
  const pulse = new Float32Array(CONFIG.MAX_BODIES);
  // Interpolated positions this frame (absolute world, doubles).
  const ix = new Float64Array(CONFIG.MAX_BODIES);
  const iy = new Float64Array(CONFIG.MAX_BODIES);
  /** Visible black holes for the background lensing: rel x, rel y, core r, influence r. */
  const lens = new Float32Array(MAX_LENS * 4);
  let lensCount = 0;

  /**
   * Instance staging: F = rel x, rel y, r, rc, extent x, highlight, pulse, extent y, aux ×4;
   * U = seed, type, flags, palette. Filled by the caller, then commit() appends one instance
   * (hot loops never pass doubles as call arguments).
   */
  const F = new Float64Array(FSTRIDE);
  const U = new Uint32Array(USTRIDE);
  function commit() {
    if (count >= MAX_INST) return;
    const f = count * FSTRIDE, u = count * USTRIDE;
    for (let k = 0; k < FSTRIDE; k++) fdata[f + k] = F[k];
    udata[u] = U[0]; udata[u + 1] = U[1]; udata[u + 2] = U[2]; udata[u + 3] = U[3];
    count++;
  }

  return {
    lens,
    get lensCount() { return lensCount; },

    /** @param {import('./gl.js').Gfx} gfx */
    init(gfx) {
      const gl = gfx.gl;
      prog = createProgram(gl, BODIES_VS, BODIES_FS, 'bodies', UNIFORMS, ['aCorner', 'aA', 'aB', 'aC', 'aI']);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      createQuadBuffer(gl);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      fbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fbuf);
      gl.bufferData(gl.ARRAY_BUFFER, fdata.byteLength, gl.DYNAMIC_DRAW);
      for (let a = 0; a < 3; a++) {
        gl.enableVertexAttribArray(1 + a);
        gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, FSTRIDE * 4, a * 16);
        gl.vertexAttribDivisor(1 + a, 1);
      }
      ubuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ubuf);
      gl.bufferData(gl.ARRAY_BUFFER, udata.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_INT, USTRIDE * 4, 0);
      gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);
    },

    /** Latch / perfect ring pulse. @param {number} slot */
    pulse(slot) {
      if (slot >= 0 && slot < pulse.length) pulse[slot] = 1;
    },

    reset() { highlight.fill(0); pulse.fill(0); slotId.fill(0); count = 0; lensCount = 0; },

    /**
     * Warm-up content: one instance of every type and branch (planet with ring, wake and pulse,
     * moon, moon trace, black hole, binary orbit, drift track) plus one lensing hole, all near the
     * view centre. Used only by the hidden warm-up frame.
     */
    warm() {
      count = 0;
      F[0] = 0; F[1] = 0; F[2] = 90; F[3] = 260; F[4] = 300; F[5] = 1; F[6] = 0.5; F[7] = 0;
      F[8] = 120; F[9] = 0; F[10] = 0; F[11] = 0; U[0] = 0x1234567; U[1] = BTYPE.PLANET;
      U[2] = BODY_FLAG.RINGED; U[3] = 0;
      commit();
      F[0] = 150; F[1] = 0; F[2] = 18; F[3] = 0; F[4] = 44; F[5] = 0; F[6] = 0; F[7] = 0; F[8] = 0;
      F[9] = 0; F[10] = 0; F[11] = 0; U[0] = 0x2345678; U[1] = BTYPE.MOON; U[2] = 0; U[3] = 1;
      commit();
      F[0] = 0; F[1] = 0; F[2] = 150; F[3] = 0; F[4] = 162; F[5] = 0; F[6] = 0; F[7] = 0;
      F[8] = 0.5; F[9] = 1; F[10] = 18; F[11] = 0; U[0] = 0x2345678; U[1] = BTYPE.MOON_TRACE;
      U[2] = 0; U[3] = 1;
      commit();
      F[0] = -200; F[1] = 300; F[2] = 34; F[3] = 300; F[4] = 330; F[5] = 0; F[6] = 0; F[7] = 0;
      F[8] = 0; F[9] = 0; F[10] = 0; F[11] = 0; U[0] = 0x3456789; U[1] = BTYPE.BLACKHOLE; U[2] = 0;
      U[3] = 3;
      commit();
      F[0] = 0; F[1] = -300; F[2] = 190; F[3] = 0; F[4] = 200; F[5] = 0; F[6] = 0; F[7] = 0;
      F[8] = 0.3; F[9] = 60; F[10] = 70; F[11] = 1; U[0] = 0x456789a; U[1] = BTYPE.ORBIT_PATH;
      U[2] = 0; U[3] = 4;
      commit();
      F[0] = 0; F[1] = 0; F[2] = 90; F[3] = 0; F[4] = 170; F[5] = 0; F[6] = 0; F[7] = 16; F[8] = 40;
      F[9] = 150; F[10] = 0; F[11] = 0; U[0] = 0x1234567; U[1] = BTYPE.DRIFT_TRACK; U[2] = 0;
      U[3] = 2;
      commit();
      lens[0] = -200; lens[1] = 300; lens[2] = 34; lens[3] = 300;
      lensCount = 1;
    },

    /**
     * Build the instance list from the world (allocation-free).
     * @param {import('../contracts.js').WorldT} world
     * @param {number} alpha
     * @param {number} vx  view centre x
     * @param {number} vy  view centre y
     * @param {number} halfH  half the visible height (world units)
     * @param {number} dt
     */
    build(world, alpha, vx, vy, halfH, dt) {
      const b = world.bodies;
      const aim = world.aim;
      count = 0;
      lensCount = 0;
      const kh = 1 - Math.exp(-dt * 12);
      const n = b.count < CONFIG.MAX_BODIES ? b.count : CONFIG.MAX_BODIES;
      const t = world.time;
      for (let i = 0; i < n; i++) {
        if (slotId[i] !== b.id[i]) { slotId[i] = b.id[i]; highlight[i] = 0; pulse[i] = 0; }
        const target = b.alive[i] && aim.active && aim.clear && aim.target === i ? 1 : 0;
        highlight[i] += (target - highlight[i]) * kh;
        pulse[i] = pulse[i] > 0 ? Math.max(0, pulse[i] - dt / 0.7) : 0;
        ix[i] = b.px[i] + (b.x[i] - b.px[i]) * alpha;
        iy[i] = b.py[i] + (b.y[i] - b.py[i]) * alpha;
      }
      // Pass order = draw order: orbit hints (binary orbits, moon traces, drift tracks),
      // black holes, planets, moons.
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < n; i++) {
          if (!b.alive[i]) continue;
          const type = b.type[i];
          const flags = b.flags[i];
          const pal = paletteIndex(b.zone[i] || 1);
          if (pass === 0) {
            if (type === BODY.PLANET && (flags & BODY_FLAG.BINARY)) {
              const partner = b.parent[i];
              if (partner >= 0 && partner < i && b.alive[partner]) continue;  // one orbit per pair
              const rr = b.m0[i];
              const relY = b.m4[i] - vy;
              if (rr <= 0 || Math.abs(relY) > halfH + rr + 20) continue;
              const ang = Math.atan2(iy[i] - b.m4[i], ix[i] - b.m3[i]);
              const rp = partner >= 0 && b.alive[partner] ? b.r[partner] : 0;
              F[0] = b.m3[i] - vx; F[1] = relY; F[2] = rr; F[3] = 0; F[4] = rr + 14; F[5] = 0;
              F[6] = 0; F[7] = 0; F[8] = ang; F[9] = b.r[i]; F[10] = rp;
              F[11] = b.m1[i] < 0 ? -1 : 1; U[0] = b.seed[i]; U[1] = BTYPE.ORBIT_PATH; U[2] = 0;
              U[3] = pal;
              commit();
            } else if (type === BODY.MOON) {
              const p = b.parent[i];
              if (p < 0 || p >= n || !b.alive[p]) continue;
              const rr = b.m0[i];
              const relY = iy[p] - vy;
              if (rr <= 0 || Math.abs(relY) > halfH + rr + 20) continue;
              const ang = Math.atan2(iy[i] - iy[p], ix[i] - ix[p]);
              F[0] = ix[p] - vx; F[1] = relY; F[2] = rr; F[3] = 0; F[4] = rr + 12; F[5] = 0;
              F[6] = 0; F[7] = 0; F[8] = ang; F[9] = b.m1[i] < 0 ? -1 : 1; F[10] = b.r[i];
              F[11] = 0; U[0] = b.seed[i]; U[1] = BTYPE.MOON_TRACE; U[2] = 0; U[3] = pal;
              commit();
            } else if (type === BODY.PLANET && (flags & BODY_FLAG.DRIFTING) && !(flags & BODY_FLAG.BINARY)) {
              const amp = Math.abs(b.m1[i]);
              const relY = iy[i] - vy;
              if (amp <= 0 || Math.abs(relY) > halfH + 20) continue;
              F[0] = b.m0[i] - vx; F[1] = relY; F[2] = b.r[i]; F[3] = 0; F[4] = amp + 16; F[5] = 0;
              F[6] = 0; F[7] = 16; F[8] = ix[i] - b.m0[i]; F[9] = amp; F[10] = 0; F[11] = 0;
              U[0] = b.seed[i]; U[1] = BTYPE.DRIFT_TRACK; U[2] = 0; U[3] = pal;
              commit();
            }
            continue;
          }
          const want = pass === 1 ? BODY.BLACKHOLE : pass === 2 ? BODY.PLANET : BODY.MOON;
          if (type !== want) continue;
          const x = ix[i], y = iy[i];
          const r = b.r[i], rc = b.rc[i];
          let extent;
          let a0 = 0;
          if (type === BODY.PLANET) {
            extent = rc + (pulse[i] > 0 ? 125 : 45);
            if (flags & BODY_FLAG.RINGED) extent = Math.max(extent, r * 2.15);
            if ((flags & BODY_FLAG.DRIFTING) && !(flags & BODY_FLAG.BINARY) && b.m2[i] > 0) {
              // Signed sideways speed (units/s) from the drift law x = m0 + m1 sin(2π t / m2 + m3).
              a0 = b.m1[i] * (TAU / b.m2[i]) * Math.cos(TAU * t / b.m2[i] + b.m3[i]);
              if (a0 === 0) a0 = 1e-3;
            }
          } else if (type === BODY.MOON) {
            extent = r * 2.4;
          } else {
            extent = Math.max(rc + 30, r * 5.2);
          }
          const relY = y - vy;
          if (Math.abs(relY) > halfH + extent) continue;
          if (type === BODY.BLACKHOLE && lensCount < MAX_LENS) {
            const o = lensCount * 4;
            lens[o] = x - vx; lens[o + 1] = relY; lens[o + 2] = r; lens[o + 3] = rc;
            lensCount++;
          }
          F[0] = x - vx; F[1] = relY; F[2] = r; F[3] = rc; F[4] = extent; F[5] = highlight[i];
          F[6] = pulse[i]; F[7] = 0; F[8] = a0; F[9] = 0; F[10] = 0; F[11] = 0; U[0] = b.seed[i];
          U[1] = type; U[2] = flags; U[3] = pal;
          commit();
        }
      }
    },

    /**
     * @param {import('./gl.js').Gfx} gfx
     * @param {number} sx @param {number} sy  world→clip scale
     * @param {Float32Array} accent  linear rgb of the (cross-faded) accent for the aim highlight
     * @param {number} time @param {number} upp  world units per pixel
     */
    draw(gfx, sx, sy, accent, time, upp) {
      const c = count;
      if (!prog || c === 0) return;
      const gl = gfx.gl;
      const u = prog.u;
      gl.bindBuffer(gl.ARRAY_BUFFER, fbuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fdata, 0, c * FSTRIDE);
      gl.bindBuffer(gl.ARRAY_BUFFER, ubuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, udata, 0, c * USTRIDE);
      gl.useProgram(prog.prog);
      gl.uniform2f(u.uScale, sx, sy);
      gl.uniform3fv(u.uPalA, palA);
      gl.uniform3fv(u.uPalB, palB);
      gl.uniform3fv(u.uPalC, palC);
      gl.uniform3f(u.uAccent, accent[0], accent[1], accent[2]);
      gl.uniform1f(u.uTime, time % 3600);
      gl.uniform1f(u.uUpp, upp);
      gl.enable(gl.BLEND);
      gl.blendFunc(gfx.src, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);
      gfx.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c);
      gl.bindVertexArray(null);
    },

    get count() { return count; },
  };
}
