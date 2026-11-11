// @ts-check
/**
 * Bodies pass (PLAN.md §4.2): one instanced draw for planets (with capture rings), moons, black
 * holes and binary orbit paths. Instance data is rebuilt per frame into preallocated typed arrays
 * (positions relative to the view centre, computed in doubles), then uploaded with bufferSubData.
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { createProgram, createQuadBuffer } from './gl.js';
import { BODIES_VS, BODIES_FS, BTYPE } from './shaders/bodies.js';
import { PALETTE, paletteIndex } from './background.js';

const MAX_INST = CONFIG.MAX_BODIES + 32;
const FSTRIDE = 8;  // floats per instance
const USTRIDE = 4;  // uints per instance
const UNIFORMS = ['uScale', 'uPalA', 'uPalB', 'uPalC', 'uAccent', 'uTime', 'uUpp'];

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

  /**
   * @param {number} relX @param {number} relY @param {number} r @param {number} rc @param {number} extent
   * @param {number} hi @param {number} pu @param {number} seed @param {number} type @param {number} flags @param {number} pal
   */
  function push(relX, relY, r, rc, extent, hi, pu, seed, type, flags, pal) {
    if (count >= MAX_INST) return;
    const f = count * FSTRIDE, u = count * USTRIDE;
    fdata[f] = relX; fdata[f + 1] = relY; fdata[f + 2] = r; fdata[f + 3] = rc;
    fdata[f + 4] = extent; fdata[f + 5] = hi; fdata[f + 6] = pu; fdata[f + 7] = 0;
    udata[u] = seed; udata[u + 1] = type; udata[u + 2] = flags; udata[u + 3] = pal;
    count++;
  }

  return {
    /** @param {import('./gl.js').Gfx} gfx */
    init(gfx) {
      const gl = gfx.gl;
      prog = createProgram(gl, BODIES_VS, BODIES_FS, 'bodies', UNIFORMS, ['aCorner', 'aA', 'aB', 'aI']);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      createQuadBuffer(gl);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      fbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fbuf);
      gl.bufferData(gl.ARRAY_BUFFER, fdata.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FSTRIDE * 4, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FSTRIDE * 4, 16);
      gl.vertexAttribDivisor(2, 1);
      ubuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, ubuf);
      gl.bufferData(gl.ARRAY_BUFFER, udata.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, USTRIDE * 4, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);
    },

    /** Latch / perfect ring pulse. @param {number} slot */
    pulse(slot) {
      if (slot >= 0 && slot < pulse.length) pulse[slot] = 1;
    },

    reset() { highlight.fill(0); pulse.fill(0); slotId.fill(0); },

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
      const kh = 1 - Math.exp(-dt * 12);
      const n = b.count < CONFIG.MAX_BODIES ? b.count : CONFIG.MAX_BODIES;
      for (let i = 0; i < n; i++) {
        if (slotId[i] !== b.id[i]) { slotId[i] = b.id[i]; highlight[i] = 0; pulse[i] = 0; }
        const target = b.alive[i] && aim.active && aim.clear && aim.target === i ? 1 : 0;
        highlight[i] += (target - highlight[i]) * kh;
        pulse[i] = pulse[i] > 0 ? Math.max(0, pulse[i] - dt / 0.7) : 0;
      }
      // Pass order = draw order: binary paths, black holes, planets, moons.
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < n; i++) {
          if (!b.alive[i]) continue;
          const type = b.type[i];
          const flags = b.flags[i];
          const pal = paletteIndex(b.zone[i] || 1);
          if (pass === 0) {
            if (!(flags & BODY_FLAG.BINARY) || type !== BODY.PLANET) continue;
            const partner = b.parent[i];
            if (partner >= 0 && partner < i) continue;  // one path per pair
            const rr = b.m0[i];
            const relY = b.m4[i] - vy;
            if (Math.abs(relY) > halfH + rr + 20) continue;
            push(b.m3[i] - vx, relY, rr, 0, rr + 10, 0, 0, b.seed[i], BTYPE.ORBIT_PATH, 0, pal);
            continue;
          }
          const want = pass === 1 ? BODY.BLACKHOLE : pass === 2 ? BODY.PLANET : BODY.MOON;
          if (type !== want) continue;
          const x = b.px[i] + (b.x[i] - b.px[i]) * alpha;
          const y = b.py[i] + (b.y[i] - b.py[i]) * alpha;
          const r = b.r[i], rc = b.rc[i];
          let extent;
          if (type === BODY.PLANET) {
            extent = rc + (pulse[i] > 0 ? 125 : 45);
            if (flags & BODY_FLAG.RINGED) extent = Math.max(extent, r * 2.15);
          } else if (type === BODY.MOON) {
            extent = r * 2.4;
          } else {
            extent = Math.max(rc + 30, r * 5.2);
          }
          const relY = y - vy;
          if (Math.abs(relY) > halfH + extent) continue;
          push(x - vx, relY, r, rc, extent, highlight[i], pulse[i], b.seed[i], type, flags, pal);
        }
      }
    },

    /**
     * @param {import('./gl.js').Gfx} gfx
     * @param {number} sx @param {number} sy  world→clip scale
     * @param {number} accentPal  palette index for the aim highlight colour
     * @param {number} time @param {number} upp  world units per pixel
     * @param {number} forceCount  >0 during warm-up
     */
    draw(gfx, sx, sy, accentPal, time, upp, forceCount) {
      const c = forceCount > 0 ? forceCount : count;
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
      gl.uniform3f(u.uAccent, palC[accentPal * 3], palC[accentPal * 3 + 1], palC[accentPal * 3 + 2]);
      gl.uniform1f(u.uTime, time % 3600);
      gl.uniform1f(u.uUpp, upp);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vao);
      gfx.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c);
      gl.bindVertexArray(null);
    },

    get count() { return count; },
  };
}
