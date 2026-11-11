// @ts-check
/** Effect shaders: instanced glow sprites (aim dots, motes, comet head, ring pulses), the comet
 * trail ribbon, and the collapse front. */
import { HEADER } from './common.js';

/** Sprite shapes (aB.z). */
export const SHAPE = Object.freeze({ DOT: 0, MOTE: 1, HEAD: 2, RING: 3, GLOW: 4 });

export const SPRITES_VS = `${HEADER}
in vec2 aCorner;
in vec4 aA;   // rel x, rel y, half width, half height (world units)
in vec4 aB;   // cos, sin (rotation), shape, param
in vec4 aC;   // r, g, b (HDR), extra
uniform vec2 uScale;
out vec2 vUV;
flat out vec4 vB;
flat out vec4 vC;
void main() {
  vec2 l = aCorner * aA.zw;
  vec2 rp = vec2(aB.x * l.x - aB.y * l.y, aB.y * l.x + aB.x * l.y);
  vUV = aCorner;
  vB = aB; vC = aC;
  gl_Position = vec4((aA.xy + rp) * uScale, 0.0, 1.0);
}
`;

export const SPRITES_FS = `${HEADER}
in vec2 vUV;
flat in vec4 vB;
flat in vec4 vC;
out vec4 outColor;
void main() {
  int shape = int(vB.z + 0.5);
  vec2 uv = vUV;
  float d = length(uv);
  vec3 col = vC.rgb;
  float k = 0.0;
  if (shape == 0) {
    k = (1.0 - smoothstep(0.26, 0.4, d)) * 1.0 + exp(-d * d * 7.0) * 0.35;
  } else if (shape == 1) {
    float tw = vB.w;
    k = exp(-d * d * 30.0) * 2.0 + exp(-d * 4.5) * 0.3;
    float fl = exp(-abs(uv.x) * 22.0) * exp(-abs(uv.y) * 3.2) + exp(-abs(uv.y) * 22.0) * exp(-abs(uv.x) * 3.2);
    k += fl * 0.9 * tw;
    k *= 0.7 + 0.3 * tw;
  } else if (shape == 2) {
    // Comet head: aspect in vB.w (quad is stretched along velocity); round white-hot core + halo.
    vec2 p = vec2(uv.x * vB.w, uv.y);
    float core = exp(-dot(p, p) * 22.0);
    float inner = exp(-dot(p, p) * 5.0);
    float halo = exp(-d * 3.2);
    col = vec3(1.0) * core * 7.0 + vC.rgb * (inner * 2.4 + halo * 0.9);
    k = 1.0;
  } else if (shape == 3) {
    // Ring pulse. The quad is sized to the ring's current radius plus 8 ring widths (fx.js
    // RING_REACH), so uv is rescaled to units of the final radius here.
    float t = vB.w;
    float w = 0.014 + 0.03 * t;
    float dr = d * min(1.0, t + 8.0 * w);
    float x = dr - t;
    k = exp(-x * x / (w * w)) + exp(-x * x / (w * w * 9.0)) * 0.18;
    k *= 1.0 - smoothstep(0.9, 1.0, dr);
  } else {
    k = exp(-d * d * 3.5) * (1.0 - smoothstep(0.8, 1.0, d));
  }
  outColor = vec4(col * k * vC.a, 0.0);
}
`;

export const TRAIL_VS = `${HEADER}
in vec4 aV;   // rel x, rel y, side (-1..1), t (0 head .. 1 tail end)
uniform vec2 uScale;
out float vSide;
out float vT;
void main() {
  vSide = aV.z;
  vT = aV.w;
  gl_Position = vec4(aV.xy * uScale, 0.0, 1.0);
}
`;

export const TRAIL_FS = `${HEADER}
in float vSide;
in float vT;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float a = vSide * vSide;
  float prof = exp(-a * 3.2);
  float head = 1.0 - vT;
  vec3 col = uColor * prof * pow(head, 1.4) * 1.7 + vec3(1.0) * exp(-a * 14.0) * pow(head, 2.6) * 2.4;
  outColor = vec4(col, 0.0);
}
`;

/** Collapse front: covers from the bottom of the screen up to a little above the front line. */
export const FRONT_VS = `${HEADER}
uniform vec2 uRect;   // clip y bottom, clip y top
void main() {
  float x = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  float y = (gl_VertexID & 2) == 0 ? uRect.x : uRect.y;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

/**
 * Tileable value-noise texture for the front (Phase 4: no per-pixel hashing). FRONT_NOISE_CELLS
 * lattice cells across, FRONT_NOISE_SIZE texels, baked once on the CPU (fx.js). Sampling it at
 * p / FRONT_NOISE_CELLS gives the same smooth [0,1] value noise as vnoise2(p), one tap each.
 */
export const FRONT_NOISE_SIZE = 256;
export const FRONT_NOISE_CELLS = 16;

export const FRONT_FS = `${HEADER}
uniform vec2 uRes;
uniform vec2 uView;
uniform float uFrontRel;  // front y minus view centre y (world units)
uniform float uCamX;
uniform vec3 uAcc;
uniform float uTime;
uniform float uGlowTop;  // the quad ends this far above the front
uniform sampler2D uNoise;
out vec4 outColor;
// Value noise in lattice units; each salt reads the tile at its own offset.
float tn(vec2 p, vec2 salt) { return texture(uNoise, p * ${(1 / FRONT_NOISE_CELLS).toFixed(6)} + salt).r; }
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float wy = (uv.y - 0.5) * uView.y;
  float wx = uCamX + (uv.x - 0.5) * uView.x;
  float h = wy - uFrontRel;
  float n = tn(vec2(wx * 0.011, uTime * 1.3), vec2(0.13, 0.71)) * 0.65 + tn(vec2(wx * 0.034, uTime * 2.9), vec2(0.58, 0.29)) * 0.35;
  float edge = h - (n - 0.5) * 60.0;
  vec3 hot = mix(uAcc, vec3(1.0, 0.95, 0.88), 0.6);
  float above = max(edge, 0.0);
  float tend = tn(vec2(wx * 0.018, h * 0.005 - uTime * 0.8), vec2(0.37, 0.07));
  float glow = (exp(-above / 170.0) * 0.4 + exp(-above / 34.0) * 0.6) * (0.6 + 0.8 * tend);
  glow *= 1.0 - smoothstep(uGlowTop * 0.7, uGlowTop, above);
  float line = exp(-edge * edge / 30.0) * 2.4;
  vec3 col = uAcc * glow * 1.3 + hot * line;
  float a = 0.0;
  if (edge < 0.0) {
    float depth = -edge;
    float body = 1.0 - exp(-depth / 30.0);
    float t2 = tn(vec2(wx * 0.007, h * 0.004 + uTime * 0.35), vec2(0.83, 0.46));
    float t3 = tn(vec2(wx * 0.02, h * 0.012 + uTime * 0.9), vec2(0.21, 0.92));
    vec3 inner = uAcc * (0.22 + 0.42 * t2 + 0.2 * t3) + hot * exp(-depth / 24.0) * 0.5;
    a = body * 0.86;
    col = col * (1.0 - body) + inner * body;
  }
  outColor = vec4(col, a);
}
`;
