// @ts-check
/** Post shaders: bloom bright-pass, dual-filter down/up sampling, final composite. */
import { HEADER, HASH } from './common.js';

export const BRIGHT_FS = `${HEADER}
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;     // source texel size
uniform vec2 uThresh;    // threshold, soft knee
void main() {
  vec3 c = texture(uTex, vUV + vec2(-uTexel.x, -uTexel.y)).rgb
         + texture(uTex, vUV + vec2(uTexel.x, -uTexel.y)).rgb
         + texture(uTex, vUV + vec2(-uTexel.x, uTexel.y)).rgb
         + texture(uTex, vUV + vec2(uTexel.x, uTexel.y)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float th = uThresh.x, kn = uThresh.y;
  float soft = clamp(br - th + kn, 0.0, 2.0 * kn);
  soft = soft * soft / (4.0 * kn + 1e-4);
  float w = max(soft, br - th) / max(br, 1e-4);
  outColor = vec4(min(c * w, vec3(48.0)), 1.0);
}
`;

export const DOWN_FS = `${HEADER}
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uTex, vUV).rgb * 4.0;
  s += texture(uTex, vUV - h).rgb;
  s += texture(uTex, vUV + h).rgb;
  s += texture(uTex, vUV + vec2(h.x, -h.y)).rgb;
  s += texture(uTex, vUV - vec2(h.x, -h.y)).rgb;
  outColor = vec4(s * 0.125, 1.0);
}
`;

export const UP_FS = `${HEADER}
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uK;
void main() {
  vec2 h = uTexel;
  vec3 s = texture(uTex, vUV + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(uTex, vUV + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUV + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(uTex, vUV + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uTex, vUV + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(uTex, vUV + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uTex, vUV + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(uTex, vUV + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4(s * (uK / 12.0), 1.0);
}
`;

export const COMPOSITE_FS = `${HEADER}${HASH}
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomK;
uniform float uExposure;
uniform float uCA;        // chromatic aberration strength (0 = off)
uniform float uDim;       // 0..1 game-over dim
uniform float uFlash;     // full-screen white flash (death), 0..1
uniform vec2 uRes;

vec3 tonemap(vec3 x) {
  // Linear below the knee (keeps the dark palette true), smooth exponential shoulder above it;
  // very bright sources bleed toward white.
  float m = max(x.r, max(x.g, x.b));
  x += max(m - 1.2, 0.0) * 0.18;
  const float K = 0.62;
  vec3 over = max(x - K, 0.0);
  vec3 comp = K + (1.0 - K) * (1.0 - exp(-over / (1.0 - K)));
  return mix(x, comp, step(K, x));
}

void main() {
  vec2 uv = vUV;
  vec2 dc = uv - 0.5;
  vec3 col;
  if (uCA > 0.0) {
    vec2 o = dc * uCA;
    col.r = texture(uScene, uv - o).r;
    col.g = texture(uScene, uv).g;
    col.b = texture(uScene, uv + o).b;
  } else {
    col = texture(uScene, uv).rgb;
  }
  col += texture(uBloom, uv).rgb * uBloomK;
  col *= uExposure;
  col += vec3(uFlash);
  col = tonemap(col);
  // Vignette and a darker band under the HUD at the top.
  float v = smoothstep(0.95, 0.25, length(dc * vec2(1.15, 1.0)));
  col *= mix(0.62, 1.0, v);
  col *= 1.0 - 0.3 * smoothstep(0.86, 1.0, uv.y);
  if (uDim > 0.0) {
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(l), 0.5 * uDim) * (1.0 - 0.45 * uDim);
  }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  // Dither (integer hash) against banding in the dark gradients.
  uvec2 p = uvec2(gl_FragCoord.xy);
  float n = u2f(pcg(p.x ^ pcg(p.y))) - 0.5;
  col += n / 255.0;
  outColor = vec4(col, 1.0);
}
`;
