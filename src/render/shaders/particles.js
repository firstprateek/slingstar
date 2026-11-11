// @ts-check
/**
 * Stateless GPU particles (PLAN.md §4.3). Each particle is written once at spawn; the vertex shader
 * derives its current position, size and colour from uTime - birth. Dead particles collapse to a
 * single off-screen point (zero area, no fill). Additive blending.
 */
import { HEADER } from './common.js';

export const PARTICLES_VS = `${HEADER}
in vec2 aCorner;
in vec4 aP;   // spawn x, y (relative to the particle origin), vx, vy
in vec4 aQ;   // birth, life, size (reference px, diameter), drag (1/s)
in vec4 aC;   // r, g, b (HDR), stretch
uniform float uTime;
uniform vec2 uCam;     // view centre relative to the particle origin
uniform vec2 uScale;   // world → clip
uniform vec2 uPx;      // reference px → clip
out vec2 vUV;
out vec3 vCol;
void main() {
  float age = uTime - aQ.x;
  if (age < 0.0 || age >= aQ.y) {
    gl_Position = vec4(-4.0, -4.0, 0.0, 1.0);
    vUV = vec2(0.0);
    vCol = vec3(0.0);
    return;
  }
  float t = age / aQ.y;
  float drag = aQ.w;
  float e = exp(-drag * age);
  float k = drag > 0.0 ? (1.0 - e) / drag : age;
  vec2 pos = aP.xy + aP.zw * k - uCam;
  vec2 vel = aP.zw * e;
  float size = 0.5 * aQ.z * (1.0 - 0.7 * t);
  float fade = 1.0 - t;
  fade *= fade;
  vec2 off = aCorner * size;
  float sp = length(vel);
  if (aC.w > 0.0 && sp > 1.0) {
    vec2 ax = vel / sp;
    float L = 1.0 + aC.w * sp * 0.004;
    off = (ax * aCorner.x * L + vec2(-ax.y, ax.x) * aCorner.y) * size;
  }
  gl_Position = vec4(pos * uScale + off * uPx, 0.0, 1.0);
  vUV = aCorner;
  vCol = aC.rgb * fade;
}
`;

export const PARTICLES_FS = `${HEADER}
in vec2 vUV;
in vec3 vCol;
out vec4 outColor;
void main() {
  float d2 = dot(vUV, vUV);
  float a = max(1.0 - d2, 0.0);
  a *= a;
  outColor = vec4(vCol * a, 0.0);
}
`;
