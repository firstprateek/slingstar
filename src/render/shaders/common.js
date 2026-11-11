// @ts-check
/**
 * Shared GLSL chunks. Every hash is integer based (uint, PCG), never fract(sin(x)), so results are
 * identical across GPUs (PLAN.md §4.4).
 */

/** Header for every shader stage: GLSL ES 3.00 with highp everywhere. */
export const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Integer hashes and value / gradient noise. */
export const HASH = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// 24-bit uniform float in [0,1).
float u2f(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
uint hash2(ivec2 c, uint s) { return pcg(uint(c.x) ^ pcg(uint(c.y) ^ pcg(s))); }
uint hash3(ivec3 c, uint s) { return pcg(uint(c.x) ^ pcg(uint(c.y) ^ pcg(uint(c.z) ^ s))); }

// 3D value noise in [0,1].
float vnoise3(vec3 p, uint s) {
  vec3 i = floor(p);
  vec3 f = p - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  ivec3 c = ivec3(i);
  float a = u2f(hash3(c, s));
  float b = u2f(hash3(c + ivec3(1, 0, 0), s));
  float cc = u2f(hash3(c + ivec3(0, 1, 0), s));
  float d = u2f(hash3(c + ivec3(1, 1, 0), s));
  float e = u2f(hash3(c + ivec3(0, 0, 1), s));
  float f2 = u2f(hash3(c + ivec3(1, 0, 1), s));
  float g = u2f(hash3(c + ivec3(0, 1, 1), s));
  float h = u2f(hash3(c + ivec3(1, 1, 1), s));
  return mix(mix(mix(a, b, u.x), mix(cc, d, u.x), u.y), mix(mix(e, f2, u.x), mix(g, h, u.x), u.y), u.z);
}

// 2D value noise in [0,1].
float vnoise2(vec2 p, uint s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = u2f(hash2(c, s));
  float b = u2f(hash2(c + ivec2(1, 0), s));
  float cc = u2f(hash2(c + ivec2(0, 1), s));
  float d = u2f(hash2(c + ivec2(1, 1), s));
  return mix(mix(a, b, u.x), mix(cc, d, u.x), u.y);
}
`;

/** Full-screen triangle vertex shader (no attributes; uses gl_VertexID). */
export const FULLSCREEN_VS = `${HEADER}
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;
