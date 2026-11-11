// @ts-check
/**
 * Small WebGL2 helpers (PLAN.md §4). Everything here runs at setup / context restore / resize only,
 * except the Gfx draw wrappers, which are allocation-free and count draw calls for RenderStats.
 */

/**
 * @typedef {Object} Gfx  The GL context plus a draw-call counter. Passes draw only through it.
 * @property {WebGL2RenderingContext} gl
 * @property {number} drawCalls
 * @property {(mode: number, first: number, count: number) => void} drawArrays
 * @property {(mode: number, first: number, count: number, instances: number) => void} drawArraysInstanced
 * @property {number[]} att0   Preallocated [COLOR_ATTACHMENT0] for invalidateFramebuffer.
 * @property {WebGLVertexArrayObject | null} emptyVao  Bound for attribute-less full-screen draws.
 * @property {number} sceneScale  Scene values are stored × this (1 for RGBA16F; < 1 in the RGBA8
 *   fallback so HDR highlights keep headroom above 1). Post multiplies back by 1 / sceneScale.
 * @property {number} src  Source blend factor every scene pass uses: ONE, or CONSTANT_COLOR (with
 *   blendColor = sceneScale) when the scene is scaled. Destination factors stay per pass.
 */

/** @param {WebGL2RenderingContext} gl @returns {Gfx} */
export function createGfx(gl) {
  /** @type {Gfx} */
  const gfx = {
    gl,
    drawCalls: 0,
    drawArrays(mode, first, count) { gfx.drawCalls++; gl.drawArrays(mode, first, count); },
    drawArraysInstanced(mode, first, count, instances) {
      gfx.drawCalls++; gl.drawArraysInstanced(mode, first, count, instances);
    },
    att0: [gl.COLOR_ATTACHMENT0],
    emptyVao: null,
    sceneScale: 1,
    src: gl.ONE,
  };
  return gfx;
}

/** Re-create the shared objects of a Gfx after a context restore. @param {Gfx} gfx */
export function initGfx(gfx) {
  gfx.emptyVao = gfx.gl.createVertexArray();
}

/**
 * @param {WebGL2RenderingContext} gl @param {number} type @param {string} src @param {string} name
 */
function compileShader(gl, type, src, name) {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`createShader failed (${name})`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}`);
  }
  return sh;
}

/**
 * @typedef {Object} Program
 * @property {WebGLProgram} prog
 * @property {Record<string, WebGLUniformLocation | null>} u   Uniform locations, looked up once.
 */

/**
 * Compile and link a program and look up its uniforms (setup only).
 * @param {WebGL2RenderingContext} gl
 * @param {string} vs @param {string} fs @param {string} name
 * @param {string[]} uniforms
 * @param {string[]} [attribs]  Attribute names bound to locations 0..n-1 in order.
 * @returns {Program}
 */
export function createProgram(gl, vs, fs, name, uniforms, attribs = []) {
  const v = compileShader(gl, gl.VERTEX_SHADER, vs, name);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs, name);
  const prog = gl.createProgram();
  if (!prog) throw new Error(`createProgram failed (${name})`);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  for (let i = 0; i < attribs.length; i++) gl.bindAttribLocation(prog, i, attribs[i]);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`${name} link: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  /** @type {Record<string, WebGLUniformLocation | null>} */
  const u = {};
  for (const n of uniforms) u[n] = gl.getUniformLocation(prog, n);
  return { prog, u };
}

/**
 * @typedef {Object} Target  An offscreen colour target (texture + framebuffer).
 * @property {WebGLFramebuffer | null} fb
 * @property {WebGLTexture | null} tex
 * @property {number} w
 * @property {number} h
 */

/**
 * Create a colour render target. Returns null if the framebuffer is incomplete.
 * @param {WebGL2RenderingContext} gl @param {number} w @param {number} h
 * @param {boolean} half  RGBA16F when true, else RGBA8.
 * @param {number} [wrap]
 * @param {number} [format]  Explicit internal format (e.g. SRGB8_ALPHA8); overrides `half`.
 * @returns {Target | null}
 */
export function createTarget(gl, w, h, half, wrap = gl.CLAMP_TO_EDGE, format = 0) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format || (half ? gl.RGBA16F : gl.RGBA8), w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) {
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    return null;
  }
  return { fb, tex, w, h };
}

/** @param {WebGL2RenderingContext} gl @param {Target | null} t */
export function deleteTarget(gl, t) {
  if (!t) return;
  gl.deleteFramebuffer(t.fb);
  gl.deleteTexture(t.tex);
}

/**
 * Bind a target, set the viewport and clear it (tile GPUs: no load of old contents).
 * @param {WebGL2RenderingContext} gl @param {Target} t
 * @param {number} r @param {number} g @param {number} b
 */
export function beginTarget(gl, t, r, g, b) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  gl.viewport(0, 0, t.w, t.h);
  gl.clearColor(r, g, b, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/**
 * Tell a tile GPU the target's contents are no longer needed this frame.
 * @param {Gfx} gfx @param {Target} t
 */
export function invalidateTarget(gfx, t) {
  const gl = gfx.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
  gl.invalidateFramebuffer(gl.FRAMEBUFFER, gfx.att0);
}

/**
 * Unit quad corners (-1..1) as a 4-vertex triangle strip, for instanced sprites.
 * @param {WebGL2RenderingContext} gl
 */
export function createQuadBuffer(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  return buf;
}

/** sRGB hex '#rrggbb' → linear RGB written into out at offset (setup only). */
export function hexToLinear(/** @type {string} */ hex, /** @type {Float32Array} */ out, /** @type {number} */ off) {
  const n = parseInt(hex.slice(1), 16);
  out[off] = Math.pow(((n >> 16) & 255) / 255, 2.2);
  out[off + 1] = Math.pow(((n >> 8) & 255) / 255, 2.2);
  out[off + 2] = Math.pow((n & 255) / 255, 2.2);
}
