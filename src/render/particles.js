// @ts-check
/**
 * GPU particle ring buffer (PLAN.md §4.3). Capacity CONFIG.PARTICLE_CAPACITY. Particles are written
 * once into a CPU staging array at spawn; each frame only the newly written range is uploaded with
 * bufferSubData (two calls when the ring wraps). Nothing is simulated on the CPU.
 */
import { CONFIG } from '../config.js';
import { createProgram, createQuadBuffer } from './gl.js';
import { PARTICLES_VS, PARTICLES_FS } from './shaders/particles.js';

const CAP = CONFIG.PARTICLE_CAPACITY;
const STRIDE = 12;
const BIN_COUNT = 256;

export function createParticles() {
  /** @type {import('./gl.js').Program | null} */
  let prog = null;
  /** @type {WebGLVertexArrayObject | null} */
  let vao = null;
  /** @type {WebGLBuffer | null} */
  let buf = null;
  const data = new Float32Array(CAP * STRIDE);
  let head = 0;          // next slot to write
  let pendingStart = 0;  // first slot not yet uploaded
  let pending = 0;       // slots written since the last upload
  let fullUpload = true;
  let used = 0;          // highest slot count ever written since clear (draw range)
  /** World y subtracted from particle positions (keeps float32 precision near the play area). */
  let originY = 0;
  // Live-count estimate: spawns binned per frame.
  const binTime = new Float64Array(BIN_COUNT);
  const binCount = new Float32Array(BIN_COUNT);
  const binLife = new Float32Array(BIN_COUNT);
  let bin = 0;
  let binNow = -1;
  // Warm-up: slot 0 is borrowed for one live particle, then restored.
  const saved = new Float32Array(STRIDE);
  const P = new Float64Array(STRIDE);
  let savedUsed = 0;

  const self = {
    get originY() { return originY; },
    get used() { return used; },

    /** @param {import('./gl.js').Gfx} gfx */
    init(gfx) {
      const gl = gfx.gl;
      prog = createProgram(gl, PARTICLES_VS, PARTICLES_FS, 'particles',
        ['uTime', 'uCam', 'uScale', 'uPx'], ['aCorner', 'aP', 'aQ', 'aC']);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      createQuadBuffer(gl);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
      for (let a = 0; a < 3; a++) {
        gl.enableVertexAttribArray(1 + a);
        gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, STRIDE * 4, a * 16);
        gl.vertexAttribDivisor(1 + a, 1);
      }
      gl.bindVertexArray(null);
      fullUpload = true;
    },

    /**
     * Kill every particle and rebase the origin (new run). No GL reallocation.
     * @param {number} newOriginY
     */
    clear(newOriginY) {
      data.fill(0);
      head = 0; pendingStart = 0; pending = 0; used = 0;
      fullUpload = true;
      originY = newOriginY;
      binCount.fill(0);
    },

    /**
     * Spawn staging (doubles, so world coordinates keep full precision until the origin is
     * subtracted): x, y, vx, vy, birth (effect clock), life, size (reference px, diameter),
     * drag (1/s), r, g, b, stretch (0 = round, >0 elongated along velocity). Callers fill it and
     * call commit(), so hot loops never pass doubles as call arguments.
     */
    P,

    /** Write the particle staged in P into the ring. */
    commit() {
      const o = head * STRIDE;
      data[o] = P[0]; data[o + 1] = P[1] - originY; data[o + 2] = P[2]; data[o + 3] = P[3];
      data[o + 4] = P[4]; data[o + 5] = P[5]; data[o + 6] = P[6]; data[o + 7] = P[7];
      data[o + 8] = P[8]; data[o + 9] = P[9]; data[o + 10] = P[10]; data[o + 11] = P[11];
      if (pending === 0) pendingStart = head;
      if (pending < CAP) pending++;
      head = head + 1 === CAP ? 0 : head + 1;
      if (used < CAP) used++;
      if (binTime[bin] === binNow) {
        binCount[bin]++;
        if (P[5] > binLife[bin]) binLife[bin] = P[5];
      }
    },

    /**
     * Hidden warm-up frame: make slot 0 a live particle at (x, y) so the draw runs the full
     * vertex + fragment path. Call unwarm() after the frame. Boot / context restore only.
     * @param {number} x @param {number} y @param {number} now
     */
    warm(x, y, now) {
      for (let k = 0; k < STRIDE; k++) saved[k] = data[k];
      savedUsed = used;
      data[0] = x; data[1] = y - originY; data[2] = 10; data[3] = 0;
      data[4] = now; data[5] = 1; data[6] = 8; data[7] = 1;
      data[8] = 1; data[9] = 1; data[10] = 1; data[11] = 1;
      if (used < 1) used = 1;
      fullUpload = true;
    },

    unwarm() {
      for (let k = 0; k < STRIDE; k++) data[k] = saved[k];
      used = savedUsed;
      fullUpload = true;
    },

    /** Start a new frame's spawn bin. @param {number} now effect clock */
    beginFrame(now) {
      bin = (bin + 1) % BIN_COUNT;
      binTime[bin] = now; binCount[bin] = 0; binLife[bin] = 0;
      binNow = now;
    },

    /** Approximate live particle count. @param {number} now */
    live(now) {
      let n = 0;
      for (let i = 0; i < BIN_COUNT; i++) if (binCount[i] > 0 && now - binTime[i] < binLife[i]) n += binCount[i];
      return n < CAP ? n : CAP;
    },

    /** Upload newly written slots: one bufferSubData, or two when the ring wrapped. @param {WebGL2RenderingContext} gl */
    upload(gl) {
      if (!fullUpload && pending === 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      if (fullUpload || pending >= CAP) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, CAP * STRIDE);
      } else {
        const end = pendingStart + pending;
        if (end <= CAP) {
          gl.bufferSubData(gl.ARRAY_BUFFER, pendingStart * STRIDE * 4, data, pendingStart * STRIDE, pending * STRIDE);
        } else {
          gl.bufferSubData(gl.ARRAY_BUFFER, pendingStart * STRIDE * 4, data, pendingStart * STRIDE, (CAP - pendingStart) * STRIDE);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, (end - CAP) * STRIDE);
        }
      }
      fullUpload = false;
      pending = 0;
    },

    /**
     * @param {import('./gl.js').Gfx} gfx
     * @param {number} time effect clock
     * @param {number} camX @param {number} camY view centre (world)
     * @param {number} sx @param {number} sy world→clip
     * @param {number} pxX @param {number} pxY reference px → clip
     * @param {number} forceCount >0 during warm-up
     */
    draw(gfx, time, camX, camY, sx, sy, pxX, pxY, forceCount) {
      const n = forceCount > 0 ? forceCount : used;
      if (!prog || n === 0) return;
      const gl = gfx.gl;
      self.upload(gl);
      gl.useProgram(prog.prog);
      gl.uniform1f(prog.u.uTime, time);
      gl.uniform2f(prog.u.uCam, camX, camY - originY);
      gl.uniform2f(prog.u.uScale, sx, sy);
      gl.uniform2f(prog.u.uPx, pxX, pxY);
      gl.enable(gl.BLEND);
      gl.blendFunc(gfx.src, gl.ONE);
      gl.bindVertexArray(vao);
      gfx.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    },
  };
  return self;
}
