// @ts-check
/**
 * Moons, drifting planets, black holes, binary pairs (PLAN.md §2.5). Pure. Owned by stream A.
 *
 * Every moving body's position is a pure function of world.time (contracts.js motion params), so
 * the sim is deterministic AND any future position can be predicted exactly: the aim line uses
 * `posAt` to check a release against where moons and drifting / binary planets WILL be when the
 * comet gets there, and the generator uses `envelopeOf` (the whole region a body sweeps) for
 * conservative solvability checks. No allocation: inputs and outputs go through the module-level
 * typed arrays below (a double passed to or returned from a function V8 does not inline is boxed).
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { TAU } from '../core/math.js';

/** Black-hole pull (aliases of config.js, read once). */
const BH_G = CONFIG.BLACKHOLE_G, BH_MAX = CONFIG.BLACKHOLE_MAX_ACCEL;

/** Body flags whose position changes with time (moons move too: check `type`). */
export const MOVING_FLAGS = BODY_FLAG.DRIFTING | BODY_FLAG.BINARY;

/** blackHoleAccelAt input: BHQ[0], BHQ[1] = the position to evaluate. */
export const BHQ = new Float64Array(2);

/** posAt input: MT[0] = absolute world time. */
export const MT = new Float64Array(1);
/** posAt output: MP[0], MP[1] = centre at time MT[0]. */
export const MP = new Float64Array(2);
/**
 * envelopeOf output: the body's centre sweeps the segment (ENV[0], ENV[1]) → (ENV[2], ENV[3])
 * thickened by ENV[4] (static: a point; drifting: a horizontal segment; binary: its orbit circle
 * as a point with reach m0; moon: its parent's envelope with reach + m0).
 */
export const ENV = new Float64Array(5);

/**
 * Binary partner of slot i (the other member of its pair), or -1: not a binary member, or the
 * partner has been recycled (freeing a member clears its partner's `parent`).
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
export function partnerOf(b, i) {
  if (b.type[i] !== BODY.PLANET || !(b.flags[i] & BODY_FLAG.BINARY)) return -1;
  const p = b.parent[i];
  return p >= 0 && p !== i && b.alive[p] === 1 && b.type[p] === BODY.PLANET && b.parent[p] === i ? p : -1;
}

/** maxSpeedOf output: VS[0] = the most a body can move per second. */
export const VS = new Float64Array(1);

/** Non-moon speed bound into VS[0]. @param {import('../contracts.js').Bodies} b @param {number} i */
function baseSpeedBound(b, i) {
  const f = b.flags[i];
  if (f & BODY_FLAG.BINARY) VS[0] = Math.abs(b.m1[i]) * b.m0[i];
  else if (f & BODY_FLAG.DRIFTING) VS[0] = b.m2[i] > 0 ? Math.abs(b.m1[i]) * TAU / b.m2[i] : 0;
  else VS[0] = 0;
}

/**
 * Upper bound on body i's speed (units/s) into VS[0]: |ω| m0 around a binary circle, the peak of
 * a drift, a moon's own |ω| m0 plus its parent's. Static bodies: 0.
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
export function maxSpeedOf(b, i) {
  if (b.type[i] !== BODY.MOON) { baseSpeedBound(b, i); return; }
  const p = b.parent[i];
  if (p >= 0 && b.alive[p]) baseSpeedBound(b, p); else VS[0] = 0;
  VS[0] += Math.abs(b.m1[i]) * b.m0[i];
}

/** @param {import('../contracts.js').Bodies} b @param {number} i */
export function isMoving(b, i) {
  return b.type[i] === BODY.MOON || (b.flags[i] & MOVING_FLAGS) !== 0;
}

/** Non-moon centre at time MT[0] into MP. @param {import('../contracts.js').Bodies} b @param {number} i */
function baseAt(b, i) {
  const f = b.flags[i], t = MT[0];
  if (f & BODY_FLAG.BINARY) {
    const th = b.m2[i] + b.m1[i] * t;
    MP[0] = b.m3[i] + b.m0[i] * Math.cos(th);
    MP[1] = b.m4[i] + b.m0[i] * Math.sin(th);
  } else if (f & BODY_FLAG.DRIFTING) {
    MP[0] = b.m0[i] + b.m1[i] * Math.sin(TAU * t / b.m2[i] + b.m3[i]);
    MP[1] = b.y[i];
  } else {
    MP[0] = b.x[i]; MP[1] = b.y[i];
  }
}

/**
 * Centre of body i at absolute time MT[0], written to MP. Static bodies return their current
 * position. A moon whose parent is gone stays where it is.
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
export function posAt(b, i) {
  if (b.type[i] !== BODY.MOON) { baseAt(b, i); return; }
  const p = b.parent[i];
  if (p < 0 || !b.alive[p]) { MP[0] = b.x[i]; MP[1] = b.y[i]; return; }
  baseAt(b, p);
  const th = b.m2[i] + b.m1[i] * MT[0];
  MP[0] += b.m0[i] * Math.cos(th);
  MP[1] += b.m0[i] * Math.sin(th);
}

/** Non-moon motion envelope into ENV. @param {import('../contracts.js').Bodies} b @param {number} i */
function baseEnvelope(b, i) {
  const f = b.flags[i];
  if (f & BODY_FLAG.BINARY) {
    ENV[0] = ENV[2] = b.m3[i]; ENV[1] = ENV[3] = b.m4[i]; ENV[4] = b.m0[i];
  } else if (f & BODY_FLAG.DRIFTING) {
    const a = Math.abs(b.m1[i]);
    ENV[0] = b.m0[i] - a; ENV[2] = b.m0[i] + a; ENV[1] = ENV[3] = b.y[i]; ENV[4] = 0;
  } else {
    ENV[0] = ENV[2] = b.x[i]; ENV[1] = ENV[3] = b.y[i]; ENV[4] = 0;
  }
}

/**
 * Region swept by body i's centre over all time, into ENV (segment + reach). Add the body's own
 * radius (or ring) to get the region the body or its ring can ever cover.
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
export function envelopeOf(b, i) {
  if (b.type[i] !== BODY.MOON) { baseEnvelope(b, i); return; }
  const p = b.parent[i];
  if (p < 0 || !b.alive[p]) { ENV[0] = ENV[2] = b.x[i]; ENV[1] = ENV[3] = b.y[i]; ENV[4] = 0; return; }
  baseEnvelope(b, p);
  ENV[4] += b.m0[i];
}

/**
 * Move every body whose position is a function of time. Called once per step, after the previous
 * positions were stored.
 * @param {import('../contracts.js').WorldT} world
 */
export function updateBodyMotion(world) {
  const b = world.bodies, n = b.count;
  MT[0] = world.time;
  for (let i = 0; i < n; i++) {
    if (!b.alive[i] || !isMoving(b, i)) continue;
    posAt(b, i);
    b.x[i] = MP[0]; b.y[i] = MP[1];
  }
}

/**
 * Put a freshly written moving body at its position for the current world time, with the
 * previous position equal (so the renderer does not interpolate from a stale slot).
 * @param {import('../contracts.js').WorldT} world @param {number} i
 */
export function placeMotion(world, i) {
  const b = world.bodies;
  MT[0] = world.time;
  posAt(b, i);
  b.x[i] = b.px[i] = MP[0]; b.y[i] = b.py[i] = MP[1];
}

/**
 * Black-hole acceleration on a free comet; writes into out[0], out[1]. accel = G / r², clamped,
 * only inside each hole's influence radius (rc).
 * @param {import('../contracts.js').WorldT} world @param {Float64Array} out
 */
export function blackHoleAccel(world, out) {
  BHQ[0] = world.comet.x; BHQ[1] = world.comet.y;
  blackHoleAccelAt(world, out);
}

/**
 * Black-hole acceleration at the point (BHQ[0], BHQ[1]) into out[0], out[1]. The one formula both
 * free flight and the aim forecast use, so the forecast of a bent path is bit-exact.
 * @param {import('../contracts.js').WorldT} world @param {Float64Array} out
 */
export function blackHoleAccelAt(world, out) {
  const b = world.bodies, n = b.count;
  const cx = BHQ[0], cy = BHQ[1];
  let ax = 0, ay = 0;
  for (let i = 0; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.BLACKHOLE) continue;
    const dx = b.x[i] - cx, dy = b.y[i] - cy;
    const d2 = dx * dx + dy * dy;
    const rc = b.rc[i];
    if (d2 > rc * rc || d2 < 1) continue;
    const d = Math.sqrt(d2);
    const g = BH_G / d2;
    const a = g < BH_MAX ? g : BH_MAX;
    ax += (dx / d) * a;
    ay += (dy / d) * a;
  }
  out[0] = ax; out[1] = ay;
}
