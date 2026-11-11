// @ts-check
/** Background shaders: the once-per-zone nebula bake and the per-frame full-screen background. */
import { HEADER, HASH } from './common.js';

/**
 * Tileable nebula densities baked into a 512² RGBA8 texture once per zone.
 * R = cloud A density, G = cloud B density, B = dust lanes, A = bright filaments.
 * All noise is periodic on the texture so it tiles seamlessly; domain warping by a periodic field
 * keeps it periodic.
 */
export const NEBULA_BAKE_FS = `${HEADER}${HASH}
uniform uint uSeed;
uniform float uSize;
out vec4 outColor;

const int PER = 4;

vec2 grad(ivec2 c, uint s) {
  float a = u2f(hash2(c, s)) * 6.2831853;
  return vec2(cos(a), sin(a));
}
ivec2 wrapc(ivec2 c, int per) { return ((c % per) + per) % per; }

// Periodic gradient noise, roughly in [-0.7, 0.7].
float gnoise(vec2 p, int per, uint s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = dot(grad(wrapc(c, per), s), f);
  float n10 = dot(grad(wrapc(c + ivec2(1, 0), per), s), f - vec2(1.0, 0.0));
  float n01 = dot(grad(wrapc(c + ivec2(0, 1), per), s), f - vec2(0.0, 1.0));
  float n11 = dot(grad(wrapc(c + ivec2(1, 1), per), s), f - vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

float fbm(vec2 p, uint s, int oct) {
  float sum = 0.0, amp = 0.5;
  int per = PER;
  vec2 q = p;
  for (int o = 0; o < 7; o++) {
    if (o >= oct) break;
    sum += amp * gnoise(q, per, s + uint(o) * 101u);
    q *= 2.0; per *= 2; amp *= 0.5;
  }
  return sum;
}

float ridged(vec2 p, uint s, int oct) {
  float sum = 0.0, amp = 0.5;
  int per = PER;
  vec2 q = p;
  for (int o = 0; o < 7; o++) {
    if (o >= oct) break;
    float n = 1.0 - abs(gnoise(q, per, s + uint(o) * 131u) * 1.6);
    sum += amp * n * n;
    q *= 2.0; per *= 2; amp *= 0.5;
  }
  return sum;
}

void main() {
  vec2 p = gl_FragCoord.xy / uSize * float(PER);
  uint s = uSeed;
  vec2 q = vec2(fbm(p, s + 11u, 4), fbm(p + vec2(1.7, 9.2), s + 23u, 4));
  vec2 r = vec2(fbm(p + 2.2 * q + vec2(8.3, 2.8), s + 37u, 5), fbm(p + 2.2 * q + vec2(1.2, 5.1), s + 41u, 5));
  float a = fbm(p + 1.9 * r, s + 53u, 6);
  float b = fbm(p + 1.4 * r.yx + vec2(3.1, 7.7), s + 67u, 6);
  float dA = smoothstep(-0.12, 0.55, a + 0.08);
  float dB = smoothstep(-0.05, 0.6, b + 0.15 * q.x);
  float lanes = ridged(p * 1.0 + 1.4 * r, s + 79u, 5);
  float dust = smoothstep(0.62, 0.95, lanes) * smoothstep(0.05, 0.5, dA + dB);
  float fil = pow(clamp(ridged(p + 3.0 * q, s + 97u, 5), 0.0, 1.0), 5.0) * (dA * 0.8 + dB * 0.5);
  outColor = vec4(dA, dB, dust, clamp(fil * 1.6, 0.0, 1.0));
}
`;

/**
 * Per-frame background: nebula (two cross-faded baked textures, scrolled with parallax),
 * three parallax star layers from an integer hash, and the glowing side walls.
 * Parallax offsets arrive already wrapped (modulo, in JS doubles).
 */
export const BACKGROUND_FS = `${HEADER}${HASH}
in vec2 vUV;
out vec4 outColor;

uniform vec2 uRes;        // backing pixels
uniform vec2 uView;       // visible world size (units)
uniform vec2 uBase;       // (1000, 1000 * aspect): view size at zoom 1
uniform float uZoom;
uniform float uCamX;      // view centre x (absolute, with shake)
uniform vec2 uStar0;      // wrapped star-layer offsets (layer units)
uniform vec2 uStar1;
uniform vec2 uStar2;
uniform vec4 uNeb;        // xy: main nebula uv offset (wrapped 0..1), zw: macro uv offset
uniform float uNebTile;   // nebula tile size, layer units
uniform float uFade;      // 0 = previous zone, 1 = current zone
uniform sampler2D uTexPrev;
uniform sampler2D uTexCur;
uniform vec3 uPal[8];     // bg, nebA, nebB, accent (previous), then the same for current. Linear.
uniform float uTime;
uniform vec4 uWall;       // x: left flash, y: right flash, z: wall y offset (wrapped 0..1024), w: unused

vec3 nebula(vec4 n, float macro, vec3 bg, vec3 a, vec3 b, vec3 acc) {
  float da = n.r * n.r, db = n.g * n.g;
  vec3 c = bg * 1.4;
  c += a * da * (2.4 * macro);
  c += b * db * (2.1 * macro);
  // Hot, thin emission filaments where the clouds are dense.
  c += mix(b, acc, 0.45) * n.a * (0.55 * macro);
  // Dark dust lanes give it depth.
  c *= 1.0 - 0.72 * n.b;
  return c;
}

vec3 stars(vec2 pos, float cell, uint seed, float density, float radiusPx, float bright, float unitsPerPx, float dust) {
  vec2 g = pos / cell;
  ivec2 c = ivec2(floor(g));
  vec2 f = g - floor(g);
  uint h = hash2(c, seed);
  if (u2f(h) > density) return vec3(0.0);
  uint h2 = pcg(h), h3 = pcg(h2), h4 = pcg(h3), h5 = pcg(h4);
  vec2 sp = vec2(0.22) + 0.56 * vec2(u2f(h2), u2f(h3));
  vec2 d = (f - sp) * cell / unitsPerPx;    // pixels
  float r2 = dot(d, d);
  float mag = u2f(h4);
  mag = mag * mag * mag;
  float rad = radiusPx * (0.55 + 0.9 * mag);
  float core = exp(-r2 / (rad * rad));
  // Halo with compact support inside the cell, so no cell edge ever shows.
  float hr = sqrt(r2) / (0.2 * cell / unitsPerPx);
  float hk = max(1.0 - hr, 0.0);
  float halo = mag * 0.22 * hk * hk * exp(-sqrt(r2) / (rad * 3.0));
  float ph = u2f(h5) * 6.2831853;
  float tw = 0.62 + 0.38 * sin(uTime * (1.3 + 3.1 * u2f(pcg(h5))) + ph);
  float temp = u2f(pcg(h5 ^ 0x9e37u));
  vec3 col = temp < 0.33 ? vec3(0.65, 0.78, 1.0) : temp < 0.8 ? vec3(1.0, 0.97, 0.92) : vec3(1.0, 0.78, 0.55);
  return col * (core + halo) * bright * (0.25 + 1.6 * mag) * tw * (1.0 - 0.75 * dust);
}

void main() {
  vec2 rel = vUV - 0.5;
  float pxScale = uRes.x / 780.0;  // star sizes are designed at 780 backing px across

  // ---- nebula (parallax 0.1)
  vec2 lpN = rel * uBase * (1.0 + (uZoom - 1.0) * 0.1);
  vec2 uvN = lpN / uNebTile + uNeb.xy;
  vec2 uvM = lpN / (uNebTile * 2.7) + uNeb.zw;
  vec4 nCur = texture(uTexCur, uvN);
  float mCur = 0.45 + 0.95 * texture(uTexCur, uvM).g;
  vec3 col = nebula(nCur, mCur, uPal[4], uPal[5], uPal[6], uPal[7]);
  float dust = nCur.b;
  if (uFade < 1.0) {
    vec4 nPrev = texture(uTexPrev, uvN);
    float mPrev = 0.45 + 0.95 * texture(uTexPrev, uvM).g;
    vec3 prev = nebula(nPrev, mPrev, uPal[0], uPal[1], uPal[2], uPal[3]);
    float t = smoothstep(0.0, 1.0, uFade);
    col = mix(prev, col, t);
    dust = mix(nPrev.b, dust, t);
  }

  // ---- stars: far, mid, near
  float upx0 = uBase.x * (1.0 + (uZoom - 1.0) * 0.06) / uRes.x;
  float upx1 = uBase.x * (1.0 + (uZoom - 1.0) * 0.16) / uRes.x;
  float upx2 = uBase.x * (1.0 + (uZoom - 1.0) * 0.38) / uRes.x;
  col += stars(rel * uBase * (1.0 + (uZoom - 1.0) * 0.06) + uStar0, 22.0, 17u, 0.55, 0.75 * pxScale, 0.55, upx0, dust);
  col += stars(rel * uBase * (1.0 + (uZoom - 1.0) * 0.16) + uStar1, 52.0, 29u, 0.38, 1.0 * pxScale, 0.9, upx1, dust * 0.7);
  col += stars(rel * uBase * (1.0 + (uZoom - 1.0) * 0.38) + uStar2, 150.0, 43u, 0.42, 1.35 * pxScale, 1.8, upx2, 0.0);

  // ---- side walls at x = 0 and x = 1000
  vec2 w = rel * uView;
  float wx = uCamX + w.x;
  float wy = uWall.z + w.y;
  vec3 acc = mix(uPal[3], uPal[7], smoothstep(0.0, 1.0, uFade));
  float upx = uView.x / uRes.x;
  float dl = wx, dr = 1000.0 - wx;
  float stream = 0.72 + 0.28 * sin(wy * 0.0797670 - uTime * 5.0) * sin(wy * 0.0184078 + uTime * 1.7);
  float wl = 0.0;
  for (int s = 0; s < 2; s++) {
    float d = s == 0 ? dl : dr;
    float flash = s == 0 ? uWall.x : uWall.y;
    float dd = abs(d);   // glow falls off on both sides (the view can slide past a wall)
    float line = exp(-dd / max(2.2 * upx, 1.5));
    float glow = exp(-dd / 12.0) * 0.5 + exp(-dd / 55.0) * 0.08;
    wl += (line * 1.4 + glow * stream) * (1.0 + 3.5 * flash) + flash * exp(-dd / 220.0) * 0.6;
  }
  if (dl < 0.0 || dr < 0.0) col *= 0.4;   // outside the field: dimmer space, wall line stays bright
  col += acc * wl * 1.2 + vec3(wl * 0.08);

  outColor = vec4(col, 1.0);
}
`;
