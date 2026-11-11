// @ts-check
/** Small allocation-free math helpers shared by sim and render. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** @param {number} a @param {number} b @param {number} t */
export const lerp = (a, b, t) => a + (b - a) * t;
/** Wrap an angle to (-π, π]. @param {number} a */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Smoothstep 0..1. @param {number} e0 @param {number} e1 @param {number} x */
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
/**
 * Distance along a ray (ox,oy)+t(dx,dy) (unit d) to where it first enters a circle (cx,cy,r).
 * Returns -1 if it misses or the circle is behind; 0 if the origin is inside.
 * @param {number} ox @param {number} oy @param {number} dx @param {number} dy
 * @param {number} cx @param {number} cy @param {number} r
 */
export function rayCircle(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx, fy = oy - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const b = fx * dx + fy * dy;
  if (b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b - Math.sqrt(disc);
}
/**
 * Closest distance from point (cx,cy) to segment (ox,oy)+t(dx,dy), t in [0,len] (unit d).
 * @param {number} ox @param {number} oy @param {number} dx @param {number} dy @param {number} len
 * @param {number} cx @param {number} cy
 */
export function segmentPointDistance(ox, oy, dx, dy, len, cx, cy) {
  let t = (cx - ox) * dx + (cy - oy) * dy;
  t = clamp(t, 0, len);
  const px = ox + dx * t - cx, py = oy + dy * t - cy;
  return Math.sqrt(px * px + py * py);
}
/**
 * Out-param scratch for the allocation-free helpers below. Read it immediately after the call.
 * (A double returned from a function V8 does not inline is boxed as a heap number; these helpers
 * return booleans instead and pass the number through this array, so hot loops allocate nothing.)
 */
export const OUT = new Float64Array(2);
/**
 * rayCircle without a double return: true if the ray (unit d) reaches the circle, with the entry
 * distance in OUT[0] (0 when the origin is inside).
 * @param {number} ox @param {number} oy @param {number} dx @param {number} dy
 * @param {number} cx @param {number} cy @param {number} r
 */
export function rayCircleHit(ox, oy, dx, dy, cx, cy, r) {
  const fx = ox - cx, fy = oy - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) { OUT[0] = 0; return true; }
  const b = fx * dx + fy * dy;
  if (b > 0) return false;
  const disc = b * b - c;
  if (disc < 0) return false;
  OUT[0] = -b - Math.sqrt(disc);
  return true;
}
/**
 * True if segment (ox,oy)+t(dx,dy), t in [0,len] (unit d), passes strictly within r of (cx,cy).
 * @param {number} ox @param {number} oy @param {number} dx @param {number} dy @param {number} len
 * @param {number} cx @param {number} cy @param {number} r
 */
export function segmentWithin(ox, oy, dx, dy, len, cx, cy, r) {
  let t = (cx - ox) * dx + (cy - oy) * dy;
  t = t < 0 ? 0 : t > len ? len : t;
  const px = ox + dx * t - cx, py = oy + dy * t - cy;
  return px * px + py * py < r * r;
}
/** Parse '#rrggbb' to [r,g,b] 0..1 (sRGB). Allocates: call at setup only. @param {string} hex */
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
