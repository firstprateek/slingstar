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
     * Write one particle. World coordinates; `birth` on the renderer's effect clock.
     * @param {number} x @param {number} y @param {number} vx @param {number} vy
     * @param {number} birth @param {number} life @param {number} size reference px (diameter)
     * @param {number} drag 1/s @param {number} r @param {number} g @param {number} b
     * @param {number} stretch 0 = round, >0 elongated along velocity
     */
    spawn(x, y, vx, vy, birth, life, size, drag, r, g, b, stretch) {
      const o = head * STRIDE;
      data[o] = x; data[o + 1] = y - originY; data[o + 2] = vx; data[o + 3] = vy;
      data[o + 4] = birth; data[o + 5] = life; data[o + 6] = size; data[o + 7] = drag;
      data[o + 8] = r; data[o + 9] = g; data[o + 10] = b; data[o + 11] = stretch;
      if (pending === 0) pendingStart = head;
      if (pending < CAP) pending++;
      head = head + 1 === CAP ? 0 : head + 1;
      if (used < CAP) used++;
      if (binTime[bin] === binNow) {
        binCount[bin]++;
        if (life > binLife[bin]) binLife[bin] = life;
      }
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
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(vao);
      gfx.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    },
  };
  return self;
}
