// @ts-check
/**
 * Bodies: one instanced draw. Each quad is shaded by type: lit procedural sphere (planet / moon)
 * with limb light, atmosphere rim and optional ring; capture ring band; drifting planets trail a
 * soft streaked wake; moons are dark rock with a pulsing warning rim and a fading orbit trace;
 * black hole (dark core, photon ring, lensed arc, swirling accretion disk, faint influence edge;
 * the starfield lensing itself happens in the background pass); binary pairs share a faint orbit
 * with arcs trailing each partner and a tether through the barycentre; drifting planets show a
 * faint track of their sideways range.
 * Output is premultiplied alpha (blend ONE, ONE_MINUS_SRC_ALPHA); glows use alpha 0 (additive).
 * Every branch is bounded by its quad (the instance extent), never full screen.
 */
import { HEADER, HASH } from './common.js';

/** Render-local instance types (planet/moon/black hole match BODY.*). */
export const BTYPE = Object.freeze({ PLANET: 0, MOON: 1, BLACKHOLE: 2, ORBIT_PATH: 3, MOON_TRACE: 4, DRIFT_TRACK: 5 });

export const BODIES_VS = `${HEADER}
in vec2 aCorner;
in vec4 aA;     // rel x, rel y, r, rc   (world units, relative to the view centre)
in vec4 aB;     // extent x, highlight, pulse, extent y (0 = square)
in vec4 aC;     // per-type extras (see BTYPE users in bodies.js)
in uvec4 aI;    // seed, type, flags, palette
uniform vec2 uScale;
out vec2 vLocal;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out uvec4 vI;
void main() {
  vec2 local = aCorner * vec2(aB.x, aB.w > 0.0 ? aB.w : aB.x);
  vLocal = local;
  vA = aA; vB = aB; vC = aC; vI = aI;
  gl_Position = vec4((aA.xy + local) * uScale, 0.0, 1.0);
}
`;

export const BODIES_FS = `${HEADER}${HASH}
in vec2 vLocal;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in uvec4 vI;
out vec4 outColor;

uniform vec3 uPalA[5];
uniform vec3 uPalB[5];
uniform vec3 uPalC[5];
uniform vec3 uAccent;     // current zone accent (aim highlight)
uniform float uTime;
uniform float uUpp;       // world units per backing pixel

const vec3 LIGHT = vec3(-0.5241, 0.6499, 0.5503);   // normalize(-0.5, 0.62, 0.525)
const vec2 LIGHT2 = vec2(-0.6277, 0.7784);

vec4 over(vec4 top, vec4 bot) { return top + bot * (1.0 - top.a); }

vec3 hueOf(vec3 c) { float m = max(max(c.r, c.g), max(c.b, 1e-4)); return c / m; }
vec3 hueShift(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a), sa = sin(a);
  return max(c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca), 0.0);
}
float rnd(uint seed, uint salt) { return u2f(pcg(seed ^ salt)); }

void planetPalette(uint seed, int pal, out vec3 c1, out vec3 c2, out vec3 c3, out vec3 atmo) {
  vec3 A = hueOf(uPalA[pal]), B = hueOf(uPalB[pal]), C = hueOf(uPalC[pal]);
  float h1 = rnd(seed, 0x1234u), h2 = rnd(seed, 0x5678u), h3 = rnd(seed, 0x9abcu);
  vec3 base = hueShift(mix(A, B, h1), (h2 - 0.5) * 1.3);
  base = hueOf(base + 0.04);
  c1 = mix(base, vec3(1.0), 0.22) * 0.70;
  c2 = hueOf(hueShift(base, (h3 < 0.5 ? -1.0 : 1.0) * (0.35 + 0.5 * h3))) * 0.30;
  c3 = mix(mix(C, base, 0.35), vec3(1.0), 0.45) * 0.8;
  atmo = hueOf(mix(C, base, 0.25 + 0.3 * h3));
}

// ---------------------------------------------------------------- planet
vec4 shadePlanet(vec2 p, float r, uint seed, int pal, bool ringed) {
  vec3 c1, c2, c3, atmo;
  planetPalette(seed, pal, c1, c2, c3, atmo);
  float d = length(p);
  float q = d / r;
  vec4 res = vec4(0.0);
  vec2 dir = p / max(d, 1e-3);
  float facing = 0.3 + 0.7 * smoothstep(-0.6, 1.0, dot(dir, LIGHT2));

  // Outer atmosphere glow (additive), strongest on the lit limb.
  if (q > 0.97) {
    float hgt = max(d - r, 0.0) / r;
    float fall = max(1.0 - hgt / 0.58, 0.0);
    float g = (exp(-hgt * 14.0) * 1.1 + exp(-hgt * 4.0) * 0.22) * fall * fall;
    res.rgb += atmo * g * facing * 1.25;
  }

  // Rings: back half under the planet, front half over it.
  vec4 ringBack = vec4(0.0), ringFront = vec4(0.0);
  if (ringed) {
    float tilt = (rnd(seed, 0x55u) - 0.5) * 0.8;
    float incl = 0.2 + 0.16 * rnd(seed, 0x66u);
    float ct = cos(tilt), st = sin(tilt);
    vec2 rq = vec2(ct * p.x + st * p.y, -st * p.x + ct * p.y) / r;
    rq.y /= incl;
    float rd = length(rq);
    float inner = 1.32, outer = 2.05;
    float m = smoothstep(inner, inner + 0.05, rd) * smoothstep(outer, outer - 0.06, rd);
    if (m > 0.0) {
      float ph = rnd(seed, 0x67u) * 6.28;
      float bands = 0.5 + 0.5 * sin(rd * 41.0 + ph) * (0.6 + 0.4 * sin(rd * 13.0 + ph));
      float gap = smoothstep(0.015, 0.05, abs(rd - 1.74));
      // Shadow of the planet across the back of the ring (light from upper left).
      float shadow = 1.0;
      if (rq.y > 0.0) shadow = 0.35 + 0.65 * smoothstep(0.9, 1.15, length(p / r + LIGHT2 * 0.35));
      float a = m * gap * (0.3 + 0.55 * bands);
      vec3 col = mix(c1, c3, 0.55 + 0.3 * bands) * 1.25 * shadow;
      vec4 layer = vec4(col * a, a * 0.9);
      if (rq.y > 0.0) ringBack = layer; else ringFront = layer;
    }
  }
  res = over(ringBack, res);

  if (q < 1.0) {
    vec3 n = vec3(p / r, sqrt(max(1.0 - q * q, 0.0)));
    float tilt = (rnd(seed, 0x77u) - 0.5) * 0.9;
    float spin = uTime * (0.04 + 0.1 * rnd(seed, 0x99u)) + rnd(seed, 0x31u) * 6.28;
    float ct = cos(tilt), st = sin(tilt);
    vec3 m = vec3(ct * n.x - st * n.y, st * n.x + ct * n.y, n.z);
    float cs = cos(spin), ss = sin(spin);
    m = vec3(cs * m.x + ss * m.z, m.y, -ss * m.x + cs * m.z);
    uint style = pcg(seed ^ 0xabcu) % 3u;
    vec3 alb;
    float spec = 0.0;
    if (style == 0u) {
      // Gas giant: warped latitude bands and a storm.
      float warp = vnoise3(m * 2.6 + 7.0, seed) * 1.6 + vnoise3(m * 7.0, seed + 5u) * 0.45;
      float lat = m.y * (4.0 + 4.0 * rnd(seed, 0x11u)) + warp;
      float band = 0.5 + 0.5 * sin(lat * 3.14159);
      float band2 = 0.5 + 0.5 * sin(lat * 8.3 + 1.0);
      alb = mix(c2 * 1.4, c1, band);
      alb = mix(alb, c3, smoothstep(0.6, 1.0, band2) * 0.3);
      vec3 sc = normalize(vec3(0.3, (rnd(seed, 0x21u) - 0.5) * 0.9, 0.9));
      float storm = smoothstep(0.22, 0.0, length((m - sc) * vec3(1.0, 1.9, 1.0)));
      alb = mix(alb, c3 * 1.05, storm * 0.85);
    } else if (style == 1u) {
      // Terrestrial: ocean, continents, drifting clouds.
      float h = vnoise3(m * 2.1, seed) * 0.58 + vnoise3(m * 4.6, seed + 3u) * 0.3 + vnoise3(m * 9.0, seed + 7u) * 0.12;
      float fine = vnoise3(m * 16.0, seed + 17u);
      float land = smoothstep(0.47, 0.55, h);
      vec3 ocean = mix(c2 * 0.8, atmo * 0.2, 0.35) * (0.8 + 0.4 * smoothstep(0.3, 0.5, h));
      vec3 ground = mix(c1 * 0.85, c1 * 0.55 + c2 * 0.6, smoothstep(0.55, 0.7, h)) * (0.85 + 0.3 * fine);
      ground = mix(ground, c3, smoothstep(0.74, 0.82, h) * 0.6);
      alb = mix(ocean, ground, land);
      spec = (1.0 - land) * 0.55;
      float cl = vnoise3(m * 3.2 + vec3(uTime * 0.03, 0.0, 0.0), seed + 11u) * 0.65 + vnoise3(m * 7.0, seed + 13u) * 0.35;
      float cloud = smoothstep(0.52, 0.8, cl);
      alb = mix(alb, vec3(0.85), cloud * 0.6);
      spec *= 1.0 - cloud;
    } else {
      // Ice / rock: mottled with ridges.
      float h = vnoise3(m * 2.8, seed) * 0.52 + vnoise3(m * 6.5, seed + 3u) * 0.3 + vnoise3(m * 13.0, seed + 9u) * 0.18;
      float ridge = 1.0 - abs(h * 2.0 - 1.0);
      alb = mix(c1 * 0.8, mix(c1, c3, 0.6), smoothstep(0.3, 0.8, h));
      alb = mix(alb, c2 * 1.2, pow(ridge, 6.0) * 0.55);
      alb *= 0.85 + 0.3 * vnoise3(m * 22.0, seed + 21u);
    }
    float ndl = dot(n, LIGHT);
    float diff = smoothstep(-0.18, 1.0, ndl);
    vec3 col = alb * (diff * 1.25 + 0.03) + atmo * 0.012;
    vec3 hv = normalize(LIGHT + vec3(0.0, 0.0, 1.0));
    col += spec * pow(max(dot(n, hv), 0.0), 36.0) * 1.4;
    // Lit limb: Fresnel rim in the atmosphere colour, HDR so bloom picks it up.
    float fres = pow(1.0 - n.z, 2.2);
    col += atmo * fres * (0.12 + 1.8 * smoothstep(-0.4, 0.7, ndl));
    float aa = 1.0 - smoothstep(r - 1.6 * uUpp, r + 0.2 * uUpp, d);
    res = over(vec4(col, 1.0) * aa, res);
  }
  res = over(ringFront, res);
  return res;
}

// ---------------------------------------------------------------- capture ring
vec3 captureRing(vec2 p, float r, float rc, float hi, float pulse, vec3 idle) {
  float d = length(p);
  float dr = d - rc;
  float w = max(2.4, 1.3 * uUpp);
  float line = exp(-dr * dr / (w * w));
  float glow = exp(-abs(dr) / 14.0) * 0.26;
  float inner = (dr < 0.0 && d > r) ? exp(dr / 60.0) * 0.05 : 0.0;
  float ang = atan(p.y, p.x);
  float dash = 0.72 + 0.28 * sin(ang * 28.0 - uTime * 0.9);
  vec3 col = mix(idle * 0.42, uAccent * 2.4, hi);
  float k = (line * dash + glow + inner * (1.0 + 1.2 * hi)) * (1.0 + pulse * 2.2);
  float pr = rc + (1.0 - pulse) * 110.0;
  float ripple = exp(-(d - pr) * (d - pr) / 49.0) * pulse * 1.8;
  return col * k + mix(idle, uAccent, 0.4 + 0.6 * hi) * ripple * 1.6;
}

// ---------------------------------------------------------------- moon
// Lethal: the same warning red in every zone (nudged slightly toward the zone accent).
vec3 hazardColor(int pal) { return mix(vec3(1.0, 0.16, 0.08), hueOf(uPalC[pal]), 0.12); }

vec4 shadeMoon(vec2 p, float r, uint seed, int pal) {
  float d = length(p);
  float q = d / r;
  vec3 hazard = hazardColor(pal);
  float beat = 0.72 + 0.28 * sin(uTime * 4.4 + rnd(seed, 0x3du) * 6.28);
  vec4 res = vec4(0.0);
  if (q > 0.97) {
    // Tight hot rim plus a thin danger halo ring just outside the surface.
    float hgt = max(d - r, 0.0) / r;
    float halo = exp(-hgt * 7.0) * 0.75 + exp(-hgt * 2.2) * 0.1;
    float band = exp(-(hgt - 0.42) * (hgt - 0.42) / 0.006) * 0.32;
    res.rgb += hazard * (halo + band) * beat;
  }
  if (q < 1.0) {
    vec3 n = vec3(p / r, sqrt(max(1.0 - q * q, 0.0)));
    float spin = uTime * 0.5 + rnd(seed, 0x2du) * 6.28;
    float cs = cos(spin), ss = sin(spin);
    vec3 m = vec3(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);
    float h = vnoise3(m * 3.0, seed) * 0.6 + vnoise3(m * 7.5, seed + 3u) * 0.4;
    float crater = smoothstep(0.6, 0.68, vnoise3(m * 5.0, seed + 9u));
    // Dark basalt with faint glowing fissures: reads as rock, not as a catchable planet.
    vec3 alb = mix(vec3(0.045, 0.04, 0.045), vec3(0.17, 0.15, 0.15), h) * (1.0 - crater * 0.5);
    float ndl = dot(n, LIGHT);
    vec3 col = alb * (smoothstep(-0.15, 1.0, ndl) * 1.3 + 0.02);
    float fis = 1.0 - abs(vnoise3(m * 4.2, seed + 21u) * 2.0 - 1.0);
    col += hazard * pow(fis, 14.0) * 0.9 * beat;
    col += hazard * pow(1.0 - n.z, 2.2) * (0.5 + 1.6 * beat);
    float aa = 1.0 - smoothstep(r - 1.5 * uUpp, r + 0.2 * uUpp, d);
    res = over(vec4(col, 1.0) * aa, res);
  }
  return res;
}

// Moon orbit trace: faint red circle, brightest just behind the moon and fading around the orbit.
// r = orbit radius, aux.x = moon angle, aux.y = direction (+1 ccw / -1 cw), aux.z = moon radius.
vec3 moonTrace(vec2 p, float r, vec4 aux, int pal) {
  float d = length(p);
  float dr = d - r;
  float w = max(1.6, 1.1 * uUpp);
  float line = exp(-dr * dr / (w * w));
  if (line < 0.004) return vec3(0.0);
  float ang = atan(p.y, p.x);
  // Angle travelled since the moon passed this point (0 just behind it, 2π a full lap ago).
  float behind = mod((aux.x - ang) * aux.y, 6.2831853);
  float tail = exp(-behind * 1.15);
  float dash = step(0.0, sin(ang * r * 0.16));
  return hazardColor(pal) * line * (tail * 0.95 + 0.07 * dash);
}

// ---------------------------------------------------------------- black hole
vec4 shadeBlackHole(vec2 p, float r, float rc, uint seed, int pal) {
  vec3 acc = hueOf(uPalC[pal]);
  vec3 hot = vec3(1.0, 0.78, 0.5);
  float d = length(p);
  float rs = r;
  vec4 res = vec4(0.0);

  // Influence zone: dims the sky toward the core, faint spiral and a soft edge.
  float dark = smoothstep(rs * 3.6, rs * 1.0, d) * 0.85;
  res = vec4(0.0, 0.0, 0.0, dark);
  if (d < rc + 25.0) {
    float ang = atan(p.y, p.x);
    float sp = sin(ang * 3.0 + log(max(d, 1.0)) * 7.0 - uTime * 1.8);
    float fall = smoothstep(rc, rs * 2.5, d) * smoothstep(rs * 1.4, rs * 3.5, d);
    // Influence edge: NOT a capture ring (it cannot be caught). Rings of dust motes appear at the
    // edge and spiral inward, plus a very soft boundary haze.
    float infall = 0.0;
    float nd = floor(rc * 6.2831853 / 46.0);
    for (int k = 0; k < 3; k++) {
      float ph = fract(uTime * 0.2 + float(k) / 3.0);
      float rr = rc - ph * 110.0;
      float cell = (ang + ph * 1.4 + float(k) * 0.7) / 6.2831853 * nd;
      float arc = (fract(cell) - 0.5) * (6.2831853 * rr / nd);
      float rad = d - rr;
      infall += exp(-(arc * arc + rad * rad) / 6.0) * sin(ph * 3.14159);
    }
    float haze = exp(-abs(d - rc) / 26.0) * (d < rc ? 1.0 : 0.4);
    res.rgb += acc * (infall * 0.4 + max(sp, 0.0) * fall * 0.09 + haze * 0.07);
  }

  // Accretion disk in a tilted plane.
  float tilt = (rnd(seed, 0x44u) - 0.5) * 0.5;
  float ct = cos(tilt), st = sin(tilt);
  vec2 dq = vec2(ct * p.x + st * p.y, -st * p.x + ct * p.y) / rs;
  dq.y /= 0.26;
  float rd = length(dq);
  vec4 diskBack = vec4(0.0), diskFront = vec4(0.0);
  float dm = smoothstep(1.3, 1.65, rd) * smoothstep(4.4, 2.3, rd);
  if (dm > 0.0) {
    float om = uTime * 2.6 / (rd * rd);
    float co = cos(om), so = sin(om);
    vec2 rot = vec2(co * dq.x - so * dq.y, so * dq.x + co * dq.y);
    float n = vnoise2(rot * 2.2, seed) * 0.6 + vnoise2(rot * 5.5, seed + 7u) * 0.4;
    float streak = 0.25 + 1.1 * n * n;
    float dop = 1.0 - 0.6 * dq.x / rd;
    vec3 col = mix(mix(hot, acc, 0.25) * 1.7, acc * 0.7, smoothstep(1.5, 3.4, rd));
    vec3 e = col * dm * streak * dop;
    float a = dm * 0.55;
    if (dq.y > 0.0) diskBack = vec4(e, a * 0.0); else diskFront = vec4(e, a * 0.25);
  }
  res = over(diskBack, res);

  // Lensed image of the far side: a bright arc hugging the shadow, strongest top and bottom.
  float dn = d / rs;
  float vert = abs(p.y) / max(d, 1e-3);
  float lq = (dn - 1.2) / 0.16;
  float lens = exp(-lq * lq) * (0.35 + 1.1 * vert * vert);
  res.rgb += mix(hot, acc, 0.5) * lens * 0.9;

  // Event horizon (shadow) and photon ring.
  float core = 1.0 - smoothstep(rs - 1.5 * uUpp, rs + 0.5 * uUpp, d);
  res = over(vec4(0.0, 0.0, 0.0, core), res);
  float rq2 = (dn - 1.04) / 0.04;
  float ring = exp(-rq2 * rq2);
  res.rgb += mix(hot, vec3(1.0), 0.5) * ring * 2.0;

  res = over(diskFront, res);
  return res;
}

// ---------------------------------------------------------------- drifting planet wake
// Faint horizontal streaks trailing the planet, opposite its motion. v = signed x speed (units/s).
vec3 driftWake(vec2 p, float r, float v, vec3 atmo) {
  float sp = abs(v);
  if (sp < 1.0) return vec3(0.0);
  float s = -p.x * sign(v);                // distance behind the centre
  if (s <= 0.0 || abs(p.y) > r * 1.05) return vec3(0.0);
  float k = clamp(sp / 230.0, 0.0, 1.0);    // 230 ≈ peak drift speed (2π·150 / 4 s)
  float yn = p.y / r;
  float profile = sqrt(max(1.0 - yn * yn, 0.0));
  float edge = max(s - r * profile, 0.0);  // starts at the limb, not the centre
  // ~9 streaks across the disc, each with its own length and brightness.
  float row = floor((yn + 1.0) * 4.5);
  float fy = fract((yn + 1.0) * 4.5) - 0.5;
  float hl = u2f(pcg(uint(row) * 7919u + 13u));
  float len = r * (0.18 + 0.75 * hl) * (0.35 + 0.65 * k);
  float fall = exp(-edge / len) * smoothstep(0.0, 5.0, edge);
  float thin = exp(-fy * fy * 22.0);
  return atmo * fall * profile * (0.25 + 0.75 * thin) * (0.5 + 0.5 * hl) * k * 0.3;
}

// ---------------------------------------------------------------- drift track
// Thin dotted line across the planet's sideways range with soft end caps. aux.y = amplitude.
vec3 driftTrack(vec2 p, vec4 aux, vec3 col) {
  float amp = aux.y;
  float ax = abs(p.x);
  float w = max(1.4, 1.0 * uUpp);
  float line = exp(-p.y * p.y / (w * w)) * step(ax, amp) * step(0.0, sin(p.x * 0.33));
  float cap = exp(-(ax - amp) * (ax - amp) / (w * w * 2.0)) * smoothstep(13.0, 3.0, abs(p.y));
  return col * (line * 0.11 + cap * 0.3);
}

// ---------------------------------------------------------------- binary shared orbit
// r = orbit radius; aux.x = angle of the first partner, aux.y / aux.z = partner radii,
// aux.w = direction (+1 ccw / -1 cw). Faint circle, arcs trailing each partner, and a dashed
// tether through the barycentre with a small centre mark.
vec3 binaryOrbit(vec2 p, float r, vec4 aux, vec3 col) {
  float d = length(p);
  float dr = d - r;
  float w = max(1.8, 1.1 * uUpp);
  float ang = atan(p.y, p.x);
  float line = exp(-dr * dr / (w * w));
  float b0 = mod((aux.x - ang) * aux.w, 3.14159265);   // both partners: period π
  float tail = exp(-b0 * 1.3);
  float k = line * (0.1 + 0.9 * tail);
  vec2 u = vec2(cos(aux.x), sin(aux.x));
  float along = dot(p, u);
  float across = abs(p.x * u.y - p.y * u.x);
  float inSeg = step(-(r - aux.z - 8.0), along) * step(along, r - aux.y - 8.0);
  float teth = exp(-across * across / (w * w)) * inSeg * step(0.0, sin(along * 0.25 - uTime * 2.0));
  k += teth * 0.12;
  k += exp(-d * d / 30.0) * 0.5 + exp(-(d - 9.0) * (d - 9.0) / 3.0) * 0.18;
  return col * k;
}

void main() {
  vec2 p = vLocal;
  float r = vA.z, rc = vA.w;
  float hi = vB.y, pulse = vB.z;
  vec4 aux = vC;
  uint seed = vI.x, type = vI.y, flags = vI.z;
  int pal = int(vI.w);
  vec4 res = vec4(0.0);
  if (type == 0u) {
    vec3 c1, c2, c3, atmo;
    planetPalette(seed, pal, c1, c2, c3, atmo);
    vec3 idle = mix(atmo, vec3(1.0), 0.35);
    res.rgb = captureRing(p, r, rc, hi, pulse, idle);
    if (aux.x != 0.0) res.rgb += driftWake(p, r, aux.x, mix(atmo, vec3(1.0), 0.3));
    float d2 = dot(p, p);
    float reach = r * ((flags & 1u) != 0u ? 2.1 : 1.6);
    if (d2 < reach * reach) res = over(shadePlanet(p, r, seed, pal, (flags & 1u) != 0u), res);
  } else if (type == 1u) {
    res = shadeMoon(p, r, seed, pal);
  } else if (type == 2u) {
    res = shadeBlackHole(p, r, rc, seed, pal);
  } else if (type == 3u) {
    res.rgb = binaryOrbit(p, r, aux, mix(hueOf(uPalC[pal]), vec3(1.0), 0.3) * 0.55);
  } else if (type == 4u) {
    res.rgb = moonTrace(p, r, aux, pal);
  } else {
    vec3 c1, c2, c3, atmo;
    planetPalette(seed, pal, c1, c2, c3, atmo);
    res.rgb = driftTrack(p, aux, mix(atmo, vec3(1.0), 0.4));
    outColor = res;
    return;
  }
  // Fade to zero before the quad edge so no glow term is ever cut off by the quad.
  float ext = vB.x;
  res *= 1.0 - smoothstep(ext - 15.0, ext, length(p));
  outColor = res;
}
`;
