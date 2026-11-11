// @ts-check
/**
 * Level generation (PLAN.md §2.4–2.6): seeded (mulberry32), chunked ahead of the comet, recycles
 * bodies and motes below the collapse front, enforces the solvability rule. Pure and
 * allocation-free after creation. Owned by stream A.
 *
 * Path planets are placed one at a time. Each placement is re-rolled (up to SOLVE_MAX_TRIES)
 * until it keeps the body spacing rules and every recent consecutive path pair still has a clear
 * release window (both orbit directions, since the player's direction depends on the approach;
 * on the mid-band orbit the rule names and on the outer orbit where armed holds latch).
 * After that a deterministic plain fallback is used. Moons, side planets, black holes and stardust
 * are added afterwards and validated the same way.
 *
 * Zone elements (one new per zone, earlier ones keep appearing; zone 6+ mixes and ramps):
 *   zone 2 moons (on path planets), 3 drifting path planets, 4 black holes beside a segment,
 *   5 binary pairs (both members carry the same pathIndex: catching either one advances the path).
 * Two moving path planets (drifting / binary) never follow each other, so every pair has at most
 * one moving end.
 *
 * Solvability with motion (honest, not "at time 0"):
 *   - A moving end of a pair is checked at SOLVE_*_PHASES positions spread over its whole motion
 *     (drift positions across ±amplitude; binary angles around the full circle, partner opposite).
 *     The window must hold at EVERY phase, so whenever the player arrives there is a window. For a
 *     moving target, the frozen phase is where it will be when the comet arrives (the aim line
 *     predicts exactly that at play time). For a binary target, entering either member's ring
 *     first counts (both are the next path planet); from a binary, both members need a window.
 *   - Any other moving body is an obstacle over its whole motion envelope (a drifting planet's
 *     ring swept across its track, a binary member's ring swept around its circle).
 *   - Moons keep SOLVE_CLEARANCE from every solving ray by construction, over their whole orbit
 *     (so their motion cannot matter): another planet's moons sit inside its ring, which rays avoid
 *     entirely; B's moon lane is kept SOLVE_CLEARANCE inside the depth a solving ray reaches into
 *     B's ring; on the planet being left the lane is a floor — the "mid-band" orbit used for the
 *     window is the middle of the band from SOLVE_CLEARANCE above the moons' outer edge up to Rc
 *     (tangent rays never come nearer the centre than their orbit radius); below that the orbit
 *     runs into the moons.
 *   - Black holes: rays may not enter the influence radius (the straight-line window would be a lie
 *     there), and no planet's ring may overlap an influence radius. A rolled black hole that finds
 *     no room beside its segment carries over to the next segments (BLACKHOLE_CARRY).
 *
 * Cost: a placement runs many window checks (phases × members × orbits × directions). Each scan
 * collects its obstacles once (prepObstacles: only bodies that can come near a ray from A to B)
 * and, when only a pass/fail answer is needed, stops at the first wide-enough window, starting
 * near the tangent that points at B. Neither changes any result; together they keep the worst
 * step under ~2 ms on a desktop (was ~13 ms).
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { createRng, hash32 } from '../core/rng.js';
import { rayCircleHit, OUT, TAU } from '../core/math.js';
import { zoneOfPathIndex, captureBand, solveWindowDeg, pathSpacingMax } from './scoring.js';
import { envelopeOf, placeMotion, ENV, MOVING_FLAGS } from './hazards.js';

/** @typedef {import('../contracts.js').WorldT} WorldT */
/** @typedef {import('../contracts.js').Bodies} Bodies */

// ---------------------------------------------------------------- module-local tuning
// Tuning values are aliases of config.js; the rest are generator-internal mechanics.
/** A solving ray must reach this far inside B's ring (not just graze its edge). */
const SOLVE_RING_MARGIN = CONFIG.SOLVE_RING_MARGIN;
/**
 * Besides the mid-band orbit the rule names, the window is also required on the outer orbit
 * (this far inside A's ring edge), because armed holds — and the bot — latch at the ring edge.
 */
const SOLVE_OUTER_INSET = CONFIG.SOLVE_OUTER_INSET;
/** Half-width of the x range for B relative to A, as a fraction of the spacing (keeps dy >= 0.53 s). */
const PATH_DX_FRACTION = CONFIG.PATH_DX_FRACTION;
/** Minimum gap between a body's surface and any other planet's capture ring. */
const BODY_GAP = CONFIG.BODY_GAP;
/** Chance of a non-path side planet beside each path segment. */
const SIDE_PLANET_CHANCE = CONFIG.SIDE_PLANET_CHANCE;
const SIDE_R_MIN = CONFIG.SIDE_R_MIN;
const SIDE_R_MAX = CONFIG.SIDE_R_MAX;
const SIDE_TRIES = 4;
/** Chance of a stardust line along each path segment. */
const MOTE_LINE_CHANCE = CONFIG.MOTE_LINE_CHANCE;
/** First mote sits this far along the release ray. */
const MOTE_START = CONFIG.MOTE_START;
/** Motes are kept this far inside the walls. */
const MOTE_WALL_INSET = 20;
/** Bodies whose ring top is this far below the front are recycled. */
const RECYCLE_BELOW = CONFIG.RECYCLE_BELOW;
/** Consecutive path pairs re-validated whenever a body is placed. */
const RECHECK_PAIRS = 3;
/** Ring buffer of recent path slots (must exceed RECHECK_PAIRS + 1). */
const RECENT = 16;
/** Fallback: B is placed this far from A, this fraction of the way toward the field centre. */
const FALLBACK_SPACING = CONFIG.FALLBACK_SPACING;
const FALLBACK_TOWARD_CENTER = 0.6;
const FALLBACK_R = CONFIG.FALLBACK_R;
/**
 * Comet-centre clearance kept from a moon's surface by every solving ray: SOLVE_CLEARANCE (or the
 * comet radius + MOON_SAFE_GAP if that is larger). Tangent rays from an orbit of radius ρ never come
 * nearer the centre than ρ, so a solve orbit at least this far above the moon lane keeps it; and the
 * moon lane is kept this far inside B's ring (past the point a solving ray reaches), see addMoons.
 */
const MOON_CLEAR = CONFIG.SOLVE_CLEARANCE > CONFIG.COMET_RADIUS + CONFIG.MOON_SAFE_GAP
  ? CONFIG.SOLVE_CLEARANCE : CONFIG.COMET_RADIUS + CONFIG.MOON_SAFE_GAP;
/** Placements per update() call (spreads work; reset fills the whole lookahead at once). */
const PLACEMENTS_PER_UPDATE = 2;

const KIND_PLAIN = 0, KIND_DRIFT = 1, KIND_BINARY = 2;

// ---------------------------------------------------------------- scratch (allocated once)
const N = CONFIG.SOLVE_RAY_SAMPLES;
const COS = new Float64Array(N);
const SIN = new Float64Array(N);
for (let i = 0; i < N; i++) { COS[i] = Math.cos((TAU * i) / N); SIN[i] = Math.sin((TAU * i) / N); }
const OK = new Uint8Array(N);
/** WIN[0] = widest window (deg), WIN[1] = its centre angle (rad), WIN[2] = minimum over a pair check. */
const WIN = new Float64Array(3);
/** RAYG[0..3] = ray origin x, y and unit direction x, y for rayOk. Doubles go through memory
 * because computed doubles passed as call arguments to a non-inlined function are boxed. */
const RAYG = new Float64Array(4);
/** PL[0..3] = x, y, r, rc for writePlanet (same reason). */
const PL = new Float64Array(4);
/** SEG[0..3], SEG[4..7] = two segments' endpoints, SEG[8] = distance for segsWithin. */
const SEG = new Float64Array(9);
/** Phase overrides: OVR[i] = 1 while slot i sits at a sampled phase (it is then a point, not an envelope). */
const OVR = new Uint8Array(CONFIG.MAX_BODIES);
/** Saved positions of up to two overridden slots. */
const SAVE = new Float64Array(4);
/** Obstacles of the current window scan (prepObstacles): count, binary partner of B, per obstacle
 * a moving flag and 5 doubles (centre segment x0, y0, x1, y1 and clearance radius). */
const OBS_N = new Int32Array(1);
const OBS_B2 = new Int32Array(1);
const OBSM = new Uint8Array(CONFIG.MAX_BODIES);
const OBSD = new Float64Array(CONFIG.MAX_BODIES * 5);
/** Solve-orbit radius out-param. */
const RHO = new Float64Array(1);
/** Scale for rng.u30() → [0, 1). The generator uses u30 (a Smi) so random draws never box. */
const U30 = 1 / 1073741824;

/** Binary partner of slot i, or -1. @param {Bodies} b @param {number} i */
function partnerOf(b, i) {
  if (!(b.flags[i] & BODY_FLAG.BINARY)) return -1;
  const p = b.parent[i];
  return p >= 0 && b.alive[p] && b.type[p] === BODY.PLANET ? p : -1;
}

/** Is slot i a moving planet (drifting or binary)? @param {Bodies} b @param {number} i */
function movingPlanet(b, i) {
  return b.type[i] === BODY.PLANET && (b.flags[i] & MOVING_FLAGS) !== 0;
}

/** Squared distance from point (px,py) to segment (ax,ay)+t(dx,dy), t in [0,1]. */
function ptSeg2(/** @type {number} */ px, /** @type {number} */ py, /** @type {number} */ ax, /** @type {number} */ ay, /** @type {number} */ dx, /** @type {number} */ dy) {
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/** Do segments SEG[0..3] and SEG[4..7] come strictly within SEG[8] of each other? */
function segsWithin() {
  const ax = SEG[0], ay = SEG[1], d1x = SEG[2] - ax, d1y = SEG[3] - ay;
  const cx = SEG[4], cy = SEG[5], d2x = SEG[6] - cx, d2y = SEG[7] - cy;
  const r2 = SEG[8] * SEG[8];
  const den = d1x * d2y - d1y * d2x;
  if (den !== 0) {
    const t = ((cx - ax) * d2y - (cy - ay) * d2x) / den, u = ((cx - ax) * d1y - (cy - ay) * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
  }
  return ptSeg2(cx, cy, ax, ay, d1x, d1y) < r2 || ptSeg2(cx + d2x, cy + d2y, ax, ay, d1x, d1y) < r2 ||
    ptSeg2(ax, ay, cx, cy, d2x, d2y) < r2 || ptSeg2(ax + d1x, ay + d1y, cx, cy, d2x, d2y) < r2;
}

/**
 * Radius of the orbit on A that the window is measured on, into RHO[0]: the outer orbit (Rc minus
 * SOLVE_OUTER_INSET), or the middle of the orbitable band — the band above A's moon lane if it has
 * moons (the lane is a floor: an orbit decaying into it meets the moon).
 * @param {Bodies} b @param {number} a @param {number} outer
 */
function solveRadius(b, a, outer) {
  if (outer) { RHO[0] = b.rc[a] - SOLVE_OUTER_INSET; return; }
  let lo = b.r[a];
  for (let k = 0, n = b.count; k < n; k++) {
    if (!b.alive[k] || b.type[k] !== BODY.MOON || b.parent[k] !== a) continue;
    const top = b.m0[k] + b.r[k] + MOON_CLEAR;
    if (top > lo) lo = top;
  }
  RHO[0] = (lo + b.rc[a]) * 0.5;
}

/**
 * Collect the obstacles for one window scan from A (slot a) toward B (slot bi): every live body
 * except A, B (and B's binary partner) and moons, that could come within clearance of a ray from
 * A's ring to B's ring. Each gets its clearance radius `need` (SOLVE_CLEARANCE from its surface,
 * or its whole capture ring / influence radius, whichever is larger) and the segment its centre
 * sweeps (a point if static or at a sampled phase; its motion envelope otherwise, see envelopeOf).
 * Done once per scan instead of once per ray.
 * @param {WorldT} w @param {number} a @param {number} bi
 */
function prepObstacles(w, a, bi) {
  const b = w.bodies;
  const b2 = partnerOf(b, bi);
  OBS_B2[0] = b2;
  const ax = b.x[a], ay = b.y[a];
  // Every solving ray lies within this distance of A's centre (it starts inside A's ring and ends
  // inside B's, or its partner's).
  let far = Math.sqrt((b.x[bi] - ax) * (b.x[bi] - ax) + (b.y[bi] - ay) * (b.y[bi] - ay)) + b.rc[bi];
  if (b2 >= 0) {
    const f2 = Math.sqrt((b.x[b2] - ax) * (b.x[b2] - ax) + (b.y[b2] - ay) * (b.y[b2] - ay)) + b.rc[b2];
    if (f2 > far) far = f2;
  }
  far += 2 * b.rc[a];
  const clr = CONFIG.SOLVE_CLEARANCE;
  let n = 0;
  for (let k = 0, c = b.count; k < c; k++) {
    if (!b.alive[k] || k === a || k === bi || k === b2 || b.type[k] === BODY.MOON) continue;
    let need = b.r[k] + clr;
    if (b.rc[k] > need) need = b.rc[k];
    const o = n * 5;
    if ((b.flags[k] & MOVING_FLAGS) !== 0 && !OVR[k]) {
      envelopeOf(b, k);
      OBSD[o] = ENV[0]; OBSD[o + 1] = ENV[1]; OBSD[o + 2] = ENV[2]; OBSD[o + 3] = ENV[3];
      OBSD[o + 4] = need + ENV[4];
      OBSM[n] = 1;
    } else {
      OBSD[o] = OBSD[o + 2] = b.x[k]; OBSD[o + 1] = OBSD[o + 3] = b.y[k]; OBSD[o + 4] = need;
      OBSM[n] = 0;
    }
    const reach = far + OBSD[o + 4];
    if (ptSeg2(ax, ay, OBSD[o], OBSD[o + 1], OBSD[o + 2] - OBSD[o], OBSD[o + 3] - OBSD[o + 1]) >= reach * reach) continue;
    n++;
  }
  OBS_N[0] = n;
}

/**
 * Is the straight ray RAYG (origin, unit direction) a fair release onto B (slot bi, or its binary
 * partner if that ring comes first)? It must enter the target's ring SOLVE_RING_MARGIN deep, stay
 * inside the walls until then, and keep clear of every obstacle prepObstacles collected: no
 * nearer than SOLVE_CLEARANCE to a surface, never inside another capture ring or influence
 * radius; moving bodies not at a sampled phase over their whole motion envelope. Moons are not
 * obstacles: the generator keeps them SOLVE_CLEARANCE away from every solving ray by construction
 * (see the header and addMoons).
 * @param {WorldT} w @param {number} bi
 */
function rayOk(w, bi) {
  const b = w.bodies;
  const px = RAYG[0], py = RAYG[1], dx = RAYG[2], dy = RAYG[3];
  const b2 = OBS_B2[0];
  let tgt = bi;
  if (b2 >= 0) {
    // The member whose ring edge comes first is the one an armed hold latches.
    let e1 = Infinity, e2 = Infinity;
    if (rayCircleHit(px, py, dx, dy, b.x[bi], b.y[bi], b.rc[bi])) e1 = OUT[0];
    if (rayCircleHit(px, py, dx, dy, b.x[b2], b.y[b2], b.rc[b2])) e2 = OUT[0];
    if (e2 < e1) tgt = b2;
  }
  // Entry into the target's (slightly shrunk) ring, inlined ray-circle.
  const fx = px - b.x[tgt], fy = py - b.y[tgt], rB = b.rc[tgt] - SOLVE_RING_MARGIN;
  const cc = fx * fx + fy * fy - rB * rB;
  if (cc <= 0) return false; // starts inside B's ring: not a release from A
  const fd = fx * dx + fy * dy;
  if (fd > 0) return false;
  const disc = fd * fd - cc;
  if (disc < 0) return false;
  const tB = -fd - Math.sqrt(disc);
  const W = CONFIG.FIELD_WIDTH - CONFIG.WALL_MARGIN, L = CONFIG.WALL_MARGIN;
  if (dx < 0) { if (px <= L || (px - L) / -dx < tB) return false; }
  else if (dx > 0) { if (px >= W || (W - px) / dx < tB) return false; }
  for (let j = 0, n = OBS_N[0]; j < n; j++) {
    const o = j * 5, need = OBSD[o + 4];
    if (OBSM[j]) {
      SEG[0] = px; SEG[1] = py; SEG[2] = px + dx * tB; SEG[3] = py + dy * tB;
      SEG[4] = OBSD[o]; SEG[5] = OBSD[o + 1]; SEG[6] = OBSD[o + 2]; SEG[7] = OBSD[o + 3]; SEG[8] = need;
      if (segsWithin()) return false;
      continue;
    }
    // Segment-point distance, inlined: a helper call V8 does not inline boxes its double args.
    const ex = OBSD[o] - px, ey = OBSD[o + 1] - py;
    let t = ex * dx + ey * dy;
    if (t < -need || t > tB + need) continue;
    t = t < 0 ? 0 : t > tB ? tB : t;
    const qx = dx * t - ex, qy = dy * t - ey;
    if (qx * qx + qy * qy < need * need) return false;
  }
  return true;
}

/**
 * Widest contiguous release window for orbit direction `dir` (+1 CCW, -1 CW) on A's mid-band
 * orbit (outer = 0) or outer orbit (outer = 1), at the bodies' current (or phase-overridden)
 * positions. Writes WIN: width in degrees (conservative: (samples - 1) × step) and centre angle.
 *
 * With `need` > 0 (consecutive clear samples required) the scan stops as soon as it has found that
 * many, and WIN[0] is then only a lower bound (>= the required width). It starts a quarter turn
 * before the orbit position whose tangent points straight at B, so a window is usually found
 * within the first ~150 of N samples; generation (many checks per placement) relies on this.
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} dir @param {number} outer
 * @param {number} need
 */
function scanWindow(w, a, bi, dir, outer, need) {
  const b = w.bodies, ax = b.x[a], ay = b.y[a];
  solveRadius(b, a, outer);
  prepObstacles(w, a, bi);
  const rho = RHO[0];
  if (need > 0) {
    let phi = Math.atan2(b.y[bi] - ay, b.x[bi] - ax) - dir * Math.PI * 0.5 - Math.PI * 0.5;
    phi = (phi % TAU + TAU) % TAU;
    let i = Math.floor((phi / TAU) * N) % N;
    let run = 0, runStart = 0, prefix = -1;
    for (let k = 0; k < N; k++, i = i + 1 === N ? 0 : i + 1) {
      const c = COS[i], s = SIN[i];
      RAYG[0] = ax + rho * c; RAYG[1] = ay + rho * s; RAYG[2] = -s * dir; RAYG[3] = c * dir;
      if (rayOk(w, bi)) {
        if (run === 0) runStart = i;
        run++;
        if (run >= need) break;
      } else {
        if (prefix < 0) prefix = run;
        run = 0;
      }
    }
    // A window that wraps from the end of the scan into its start.
    if (run < need && prefix > 0 && run + prefix >= need) run += prefix;
    const step = 360 / N;
    WIN[0] = run >= N ? 360 : run > 0 ? (run - 1) * step : 0;
    WIN[1] = (TAU * ((runStart + (run >> 1)) % N)) / N;
    return;
  }
  for (let i = 0; i < N; i++) {
    const c = COS[i], s = SIN[i];
    RAYG[0] = ax + rho * c; RAYG[1] = ay + rho * s; RAYG[2] = -s * dir; RAYG[3] = c * dir;
    OK[i] = rayOk(w, bi) ? 1 : 0;
  }
  let best = 0, bestStart = 0, run = 0, runStart = 0;
  for (let i = 0; i < 2 * N; i++) {
    if (OK[i % N]) {
      if (run === 0) runStart = i;
      run++;
      if (run > best) { best = run; bestStart = runStart; }
      if (run >= N) break;
    } else run = 0;
  }
  const step = 360 / N;
  WIN[0] = best >= N ? 360 : best > 0 ? (best - 1) * step : 0;
  WIN[1] = (TAU * ((bestStart + (best >> 1)) % N)) / N;
}

/** Number of phases sampled for slot i (1 if it does not move). @param {Bodies} b @param {number} i */
function phaseCount(b, i) {
  if (b.type[i] !== BODY.PLANET) return 1;
  if (b.flags[i] & BODY_FLAG.BINARY) return CONFIG.SOLVE_BINARY_PHASES;
  if (b.flags[i] & BODY_FLAG.DRIFTING) return CONFIG.SOLVE_DRIFT_PHASES;
  return 1;
}

/**
 * Put moving slot i (and its binary partner) at phase k of K: drift positions evenly across the
 * track, binary angles evenly around the circle. Marks them in OVR.
 * @param {Bodies} b @param {number} i @param {number} k @param {number} K
 */
function setPhase(b, i, k, K) {
  OVR[i] = 1;
  if (b.flags[i] & BODY_FLAG.BINARY) {
    const th = b.m2[i] + (TAU * k) / K;
    const c = Math.cos(th), s = Math.sin(th);
    b.x[i] = b.m3[i] + b.m0[i] * c; b.y[i] = b.m4[i] + b.m0[i] * s;
    const p = partnerOf(b, i);
    if (p >= 0) { OVR[p] = 1; b.x[p] = b.m3[p] - b.m0[p] * c; b.y[p] = b.m4[p] - b.m0[p] * s; }
  } else {
    b.x[i] = b.m0[i] + b.m1[i] * (K > 1 ? -1 + (2 * k) / (K - 1) : 0);
  }
}

/** Save slot i's (and partner's) position before phase sampling. @param {Bodies} b @param {number} i */
function savePos(b, i) {
  SAVE[0] = b.x[i]; SAVE[1] = b.y[i];
  const p = partnerOf(b, i);
  if (p >= 0) { SAVE[2] = b.x[p]; SAVE[3] = b.y[p]; }
}

/** Restore what savePos saved and clear the overrides. @param {Bodies} b @param {number} i */
function restorePos(b, i) {
  b.x[i] = SAVE[0]; b.y[i] = SAVE[1]; OVR[i] = 0;
  const p = partnerOf(b, i);
  if (p >= 0) { b.x[p] = SAVE[2]; b.y[p] = SAVE[3]; OVR[p] = 0; }
}

/**
 * The full solvability check of pair A→B: over every sampled phase of the moving end (if any),
 * from every member of A (both if A is a binary), both orbit directions, on the mid-band orbit
 * and (if `outer`) the outer orbit. Returns false as soon as one is below `req`. With req = 0
 * every window is measured in full and WIN[2] = the narrowest (degrees); with req > 0 the scans
 * stop once a wide-enough window is found, so WIN[2] is only a lower bound.
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} req @param {number} outer
 */
function pairCheck(w, a, bi, req, outer) {
  const b = w.bodies;
  // At most one end moves (the generator never puts two moving path planets in a row).
  const mover = movingPlanet(b, a) ? a : movingPlanet(b, bi) ? bi : -1;
  const K = mover >= 0 ? phaseCount(b, mover) : 1;
  const a2 = partnerOf(b, a);
  let ok = true;
  // Consecutive clear samples that make a window of at least `req` degrees ((n - 1) × step >= req).
  const need = req > 0 ? Math.ceil(req / (360 / N) - 1e-9) + 1 : 0;
  WIN[2] = 360;
  if (mover >= 0) savePos(b, mover);
  for (let k = 0; k < K && ok; k++) {
    if (mover >= 0) setPhase(b, mover, k, K);
    for (let m = 0; m < 2 && ok; m++) {
      const am = m === 0 ? a : a2;
      if (am < 0) continue;
      for (let o = 0; o <= outer && ok; o++) {
        for (let dir = -1; dir <= 1 && ok; dir += 2) {
          scanWindow(w, am, bi, dir, o, need);
          if (WIN[0] < WIN[2]) WIN[2] = WIN[0];
          if (WIN[0] < req) ok = false;
        }
      }
    }
  }
  if (mover >= 0) restorePos(b, mover);
  return ok;
}

/**
 * Solvability check for a consecutive path pair A→B (slot indices; for a binary either member).
 * Returns the narrowest clear release window in degrees on the mid-band orbit over both orbit
 * directions, every sampled phase of a moving end and both members of a binary A (0 if none).
 * @param {WorldT} world @param {number} a @param {number} b
 * @returns {number}
 */
export function releaseWindowDeg(world, a, b) {
  pairCheck(world, a, b, 0, 0);
  return WIN[2];
}

/**
 * @typedef {Object} Generator
 * @property {(seed: number) => void} reset   Clear bodies and motes, place the home planet (slot 0).
 * @property {(maxPlacements?: number) => void} update  Recycle below the front; generate ahead of the comet.
 * @property {boolean} enabled               false = never generate beyond the home planet (tests).
 * @property {number} pathCount              Next path index to be placed.
 * @property {(pathIndex: number) => number} slotOfPath  Live slot of a recent path planet, or -1.
 * @property {number} rerolls                Path placements re-rolled since reset (diagnostics).
 * @property {number} fallbacks              Path placements that needed the safe fallback (diagnostics).
 */

/**
 * @param {WorldT} world
 * @param {{ enabled?: boolean }} [opts]
 * @returns {Generator}
 */
export function createGenerator(world, opts = {}) {
  const rng = createRng(1);
  const recentSlot = new Int32Array(RECENT).fill(-1);
  const recentId = new Uint32Array(RECENT);
  let nextId = 1;
  let lineId = 0;
  let topY = 0;
  /** Black holes rolled but not yet placed (see placePath). */
  let bhPending = 0;

  /** @type {Generator} */
  const gen = {
    reset, update, enabled: opts.enabled !== false, pathCount: 0, slotOfPath, rerolls: 0, fallbacks: 0,
  };

  /** Uniform [0, 1). */
  const rnd = () => rng.u30() * U30;

  /** @param {number} p */
  function slotOfPath(p) {
    if (p < 0 || p >= gen.pathCount || p < gen.pathCount - RECENT) return -1;
    const s = recentSlot[p % RECENT];
    const b = world.bodies;
    return s >= 0 && b.alive[s] && b.id[s] === recentId[p % RECENT] ? s : -1;
  }

  function allocBody() {
    const b = world.bodies;
    for (let i = 0; i < CONFIG.MAX_BODIES; i++) {
      if (!b.alive[i]) {
        if (i + 1 > b.count) b.count = i + 1;
        return i;
      }
    }
    return -1;
  }

  /**
   * Free slot i. Its moons go with it; a binary partner stays (it keeps circling) but forgets it.
   * @param {number} i
   */
  function freeBody(i) {
    const b = world.bodies;
    b.alive[i] = 0;
    for (let k = 0; k < b.count; k++) {
      if (!b.alive[k] || b.parent[k] !== i) continue;
      if (b.type[k] === BODY.MOON) b.alive[k] = 0;
      else b.parent[k] = -1;
    }
    while (b.count > 0 && !b.alive[b.count - 1]) b.count--;
  }

  /** @param {number} i */
  function freeMote(i) {
    const m = world.motes;
    m.alive[i] = 0;
    while (m.count > 0 && !m.alive[m.count - 1]) m.count--;
  }

  /**
   * Write a plain planet (x, y, r, rc from PL) into slot i (alive). Previous positions match so
   * the renderer does not interpolate from a stale slot.
   * @param {number} i @param {number} pathIndex @param {number} zone @param {number} flags @param {number} seed
   */
  function writePlanet(i, pathIndex, zone, flags, seed) {
    const b = world.bodies;
    const x = PL[0], y = PL[1], r = PL[2], rc = PL[3];
    b.alive[i] = 1; b.type[i] = BODY.PLANET; b.flags[i] = flags;
    b.x[i] = b.px[i] = x; b.y[i] = b.py[i] = y;
    b.r[i] = r; b.rc[i] = rc; b.seed[i] = seed; b.zone[i] = zone;
    b.pathIndex[i] = pathIndex; b.parent[i] = -1;
    b.m0[i] = 0; b.m1[i] = 0; b.m2[i] = 0; b.m3[i] = 0; b.m4[i] = 0;
  }

  /** Give slot i a fresh id once its placement is final. @param {number} i */
  function commitId(i) {
    world.bodies.id[i] = nextId++;
  }

  /** Remove motes that body i can ever overlap (its whole motion envelope). @param {number} i */
  function clearMotesAround(i) {
    const b = world.bodies, m = world.motes;
    envelopeOf(b, i);
    const rr = b.r[i] + ENV[4] + CONFIG.MOTE_RADIUS;
    const ax = ENV[0], ay = ENV[1], dx = ENV[2] - ENV[0], dy = ENV[3] - ENV[1];
    for (let k = 0; k < m.count; k++) {
      if (!m.alive[k]) continue;
      if (ptSeg2(m.x[k], m.y[k], ax, ay, dx, dy) < rr * rr) freeMote(k);
    }
  }

  /** Can a mote at (PL[0], PL[1]) stay clear of every body's motion envelope? */
  function moteClear() {
    const b = world.bodies;
    for (let k = 0, n = b.count; k < n; k++) {
      if (!b.alive[k] || b.type[k] === BODY.MOON) continue;
      envelopeOf(b, k);
      const rr = b.r[k] + ENV[4] + CONFIG.MOTE_RADIUS;
      if (ptSeg2(PL[0], PL[1], ENV[0], ENV[1], ENV[2] - ENV[0], ENV[3] - ENV[1]) < rr * rr) return false;
    }
    return true;
  }

  /**
   * Body i keeps its surface out of every other ring and vice versa, over both bodies' whole
   * motion; a black hole's influence radius also stays BODY_GAP clear of every ring (an orbit there
   * could never release cleanly). Moons live inside their parent's ring and are not checked.
   * @param {number} i
   */
  function spacingOk(i) {
    const b = world.bodies;
    const ip = partnerOf(b, i);
    const iBh = b.type[i] === BODY.BLACKHOLE;
    envelopeOf(b, i);
    const x0 = ENV[0], y0 = ENV[1], x1 = ENV[2], y1 = ENV[3], ri = ENV[4];
    for (let k = 0, n = b.count; k < n; k++) {
      if (k === i || k === ip || !b.alive[k] || b.type[k] === BODY.MOON) continue;
      let need;
      if (iBh || b.type[k] === BODY.BLACKHOLE) need = b.rc[i] + b.rc[k];
      else {
        need = b.rc[i] + b.r[k];
        const n2 = b.rc[k] + b.r[i];
        if (n2 > need) need = n2;
      }
      need += BODY_GAP;
      envelopeOf(b, k);
      SEG[0] = x0; SEG[1] = y0; SEG[2] = x1; SEG[3] = y1;
      SEG[4] = ENV[0]; SEG[5] = ENV[1]; SEG[6] = ENV[2]; SEG[7] = ENV[3];
      SEG[8] = need + ri + ENV[4];
      if (segsWithin()) return false;
    }
    return true;
  }

  /**
   * Every consecutive path pair ending at `last` and the RECHECK_PAIRS - 1 before it still has its
   * required window. Pairs whose start has been recycled are skipped.
   * @param {number} last
   */
  function pairsOk(last) {
    const b = world.bodies;
    for (let p = last; p >= 1 && p > last - RECHECK_PAIRS; p--) {
      const sa = slotOfPathRaw(p - 1), sb = slotOfPathRaw(p);
      if (sa < 0 || sb < 0) continue;
      if (!pairCheck(world, sa, sb, solveWindowDeg(b.zone[sb]), 1)) return false;
    }
    return true;
  }

  /** Like slotOfPath but also sees the planet currently being placed (pathCount not yet bumped). @param {number} p */
  function slotOfPathRaw(p) {
    if (p !== gen.pathCount) return slotOfPath(p);
    const s = recentSlot[p % RECENT];
    return s >= 0 && world.bodies.alive[s] ? s : -1;
  }

  /** Kill side planets and black holes near height y (fallback). @param {number} y */
  function clearSidePlanets(y) {
    const b = world.bodies;
    for (let k = 0; k < b.count; k++) {
      if (b.alive[k] && b.pathIndex[k] < 0 && b.type[k] !== BODY.MOON && Math.abs(b.y[k] - y) < 2000) freeBody(k);
    }
  }

  /**
   * Chance of an element in zone z: 0 before the zone that introduces it, `intro` there, then
   * `later`, ramping by HAZARD_RAMP_PER_ZONE per zone after zone 5 up to HAZARD_RATE_MAX.
   * Writes into PL[0] (doubles through memory). @param {number} z @param {number} introZone
   * @param {number} intro @param {number} later
   */
  function rate(z, introZone, intro, later) {
    if (z < introZone) PL[0] = 0;
    else if (z === introZone) PL[0] = intro;
    else {
      let r = later + (z > 5 ? CONFIG.HAZARD_RAMP_PER_ZONE * (z - 5) : 0);
      if (r > CONFIG.HAZARD_RATE_MAX) r = CONFIG.HAZARD_RATE_MAX;
      PL[0] = r;
    }
  }

  /** Is the roll u (in PL[1]) under the zone's rate for an element? */
  function rollUnder(/** @type {number} */ z, /** @type {number} */ introZone, /** @type {number} */ intro, /** @type {number} */ later) {
    rate(z, introZone, intro, later);
    return PL[1] < PL[0];
  }

  /** Moving kind for a new path planet in zone z (rolled only when movers exist there). @param {number} z */
  function rollMover(z) {
    if (z < 3) return KIND_PLAIN;
    rate(z, 5, CONFIG.HAZARD_BINARY_INTRO, CONFIG.HAZARD_BINARY_LATER);
    const pB = PL[0];
    rate(z, 3, CONFIG.HAZARD_DRIFT_INTRO, CONFIG.HAZARD_DRIFT_LATER);
    const pD = PL[0];
    const u = rnd();
    return u < pB ? KIND_BINARY : u < pB + pD ? KIND_DRIFT : KIND_PLAIN;
  }

  /** Place the next path planet above the previous one. Returns false if the pool is full. */
  function placePath() {
    const p = gen.pathCount;
    const a = slotOfPathRaw(p - 1);
    if (a < 0) return false;
    const slot = allocBody();
    if (slot < 0) return false;
    const b = world.bodies;
    const z = zoneOfPathIndex(p);
    const band = captureBand(z), smax = pathSpacingMax(z);
    // A's reference centre and how far its centre strays from it (binary circle / drift track).
    const aBin = (b.flags[a] & BODY_FLAG.BINARY) !== 0, aDrift = !aBin && (b.flags[a] & BODY_FLAG.DRIFTING) !== 0;
    const acx = aBin ? b.m3[a] : aDrift ? b.m0[a] : b.x[a];
    const acy = aBin ? b.m4[a] : b.y[a];
    const aReach = aBin ? b.m0[a] : aDrift ? Math.abs(b.m1[a]) : 0;
    const flags = rnd() < CONFIG.RINGED_FRACTION ? BODY_FLAG.RINGED : 0;
    const seed = hash32(rng.u30());
    // The zone's moving element for this planet; never two moving path planets in a row.
    let kind = aBin || aDrift ? KIND_PLAIN : rollMover(z);
    recentSlot[p % RECENT] = slot;
    let partner = -1, placed = false, by = 0;
    for (let t = 0; t < CONFIG.SOLVE_MAX_TRIES && !placed; t++) {
      if (t === CONFIG.HAZARD_PLAIN_AFTER_TRIES) kind = KIND_PLAIN;
      if (partner >= 0) { freeBody(partner); partner = -1; }
      if (kind === KIND_BINARY) { partner = allocBody(); if (partner < 0) kind = KIND_PLAIN; }
      const rMax = kind === KIND_BINARY ? CONFIG.BINARY_R_MAX : CONFIG.PLANET_R_MAX;
      const r = CONFIG.PLANET_R_MIN + (rMax - CONFIG.PLANET_R_MIN) * rnd();
      let reach = 0, r2 = 0, half = 0;
      if (kind === KIND_BINARY) {
        r2 = CONFIG.PLANET_R_MIN + (CONFIG.BINARY_R_MAX - CONFIG.PLANET_R_MIN) * rnd();
        let sepMin = (r > r2 ? r : r2) + (r < r2 ? r : r2) + band + BODY_GAP;
        if (sepMin < CONFIG.BINARY_SEPARATION_MIN) sepMin = CONFIG.BINARY_SEPARATION_MIN;
        const sep = sepMin < CONFIG.BINARY_SEPARATION_MAX
          ? sepMin + (CONFIG.BINARY_SEPARATION_MAX - sepMin) * rnd() : sepMin;
        half = sep * 0.5;
        reach = half;
      } else if (kind === KIND_DRIFT) reach = CONFIG.DRIFT_AMPLITUDE;
      // Centre-to-centre spacing stays inside [PATH_SPACING_MIN, smax] at every moment.
      const sLo = CONFIG.PATH_SPACING_MIN + aReach + reach, sHi = smax - aReach - reach;
      const s = sLo + (sHi > sLo ? (sHi - sLo) * rnd() : 0);
      let lo = acx - PATH_DX_FRACTION * s, hi = acx + PATH_DX_FRACTION * s;
      const xMin = CONFIG.PLANET_X_MIN + (kind === KIND_PLAIN ? 0 : reach);
      const xMax = CONFIG.PLANET_X_MAX - (kind === KIND_PLAIN ? 0 : reach);
      if (lo < xMin) lo = xMin;
      if (hi > xMax) hi = xMax;
      const u = rnd();
      if (lo > hi || sHi < sLo) { gen.rerolls++; continue; }
      const x = lo + (hi - lo) * u, dx = x - acx;
      by = acy + Math.sqrt(s * s - dx * dx);
      PL[0] = x; PL[1] = by; PL[2] = r; PL[3] = r + band;
      if (kind === KIND_DRIFT) {
        writePlanet(slot, p, z, flags | BODY_FLAG.DRIFTING, seed);
        b.m0[slot] = x;
        b.m1[slot] = rnd() < 0.5 ? -CONFIG.DRIFT_AMPLITUDE : CONFIG.DRIFT_AMPLITUDE;
        b.m2[slot] = CONFIG.DRIFT_PERIOD_MIN + (CONFIG.DRIFT_PERIOD_MAX - CONFIG.DRIFT_PERIOD_MIN) * rnd();
        b.m3[slot] = TAU * rnd();
        placeMotion(world, slot);
      } else if (kind === KIND_BINARY) {
        writePlanet(slot, p, z, flags | BODY_FLAG.BINARY, seed);
        PL[0] = x; PL[1] = by; PL[2] = r2; PL[3] = r2 + band;
        writePlanet(partner, p, z, BODY_FLAG.BINARY | (seed & 1 ? BODY_FLAG.RINGED : 0), hash32(seed ^ 0x2545f491));
        const w = (rnd() < 0.5 ? -1 : 1) * CONFIG.BINARY_ANGULAR_SPEED;
        const th = TAU * rnd();
        b.m0[slot] = b.m0[partner] = half;
        b.m1[slot] = b.m1[partner] = w;
        b.m2[slot] = th; b.m2[partner] = th + Math.PI;
        b.m3[slot] = b.m3[partner] = x;
        b.m4[slot] = b.m4[partner] = by;
        b.parent[slot] = partner; b.parent[partner] = slot;
        placeMotion(world, slot); placeMotion(world, partner);
      } else writePlanet(slot, p, z, flags, seed);
      placed = spacingOk(slot) && (partner < 0 || spacingOk(partner)) && pairsOk(p);
      if (!placed) gen.rerolls++;
    }
    if (!placed) {
      gen.fallbacks++;
      if (partner >= 0) { freeBody(partner); partner = -1; }
      kind = KIND_PLAIN;
    }
    for (let t = 0; t < 2 && !placed; t++) {
      // Plain safe placement: straight-ish up, toward the centre, medium planet.
      const x = acx + (CONFIG.FIELD_WIDTH * 0.5 - acx) * FALLBACK_TOWARD_CENTER, dx = x - acx;
      const s = FALLBACK_SPACING + aReach;
      by = acy + Math.sqrt(s * s - dx * dx);
      PL[0] = x; PL[1] = by; PL[2] = FALLBACK_R; PL[3] = FALLBACK_R + band;
      writePlanet(slot, p, z, flags, seed);
      placed = spacingOk(slot) && pairsOk(p);
      if (!placed) clearSidePlanets(acy);
    }
    commitId(slot);
    if (partner >= 0) commitId(partner);
    recentId[p % RECENT] = b.id[slot];
    clearMotesAround(slot);
    if (partner >= 0) clearMotesAround(partner);
    gen.pathCount = p + 1;
    topY = by;
    PL[1] = rnd();
    if (kind !== KIND_BINARY && rollUnder(z, 2, CONFIG.HAZARD_MOON_INTRO, CONFIG.HAZARD_MOON_LATER)) addMoons(slot, z);
    if (rnd() < SIDE_PLANET_CHANCE) placeSidePlanet(a, slot, z);
    PL[1] = rnd();
    // A black hole that was rolled but found no room beside its segment carries over to the next
    // segments (at most BLACKHOLE_CARRY pending), so the zone's rate is met where space allows.
    if (rollUnder(z, 4, CONFIG.HAZARD_BLACKHOLE_INTRO, CONFIG.HAZARD_BLACKHOLE_LATER) && bhPending < CONFIG.BLACKHOLE_CARRY) bhPending++;
    if (z < 4) bhPending = 0;
    if (bhPending > 0 && placeBlackHole(a, slot, z)) bhPending--;
    if (rnd() < MOTE_LINE_CHANCE) placeMoteLine(a, slot);
    return true;
  }

  /**
   * Moons circling path planet `pl` inside its capture band (contracts.js MOON params): one, or in
   * zone 6+ sometimes two on the same lane in opposite phase. They are added after the planet's
   * pairs were validated: they never block a solving ray (see rayOk) and only lift the solve orbit
   * of the pair that starts here, which is checked when the next planet is placed.
   * @param {number} pl @param {number} z
   */
  function addMoons(pl, z) {
    const b = world.bodies;
    const count = z >= 6 && rnd() < CONFIG.HAZARD_MOON_SECOND ? 2 : 1;
    // MOON_ORBIT_BAND_FRACTION of the band, but never so high that a solving ray (which reaches
    // SOLVE_RING_MARGIN inside this ring) would pass within MOON_CLEAR of the moon.
    let lane = b.r[pl] + (b.rc[pl] - b.r[pl]) * CONFIG.MOON_ORBIT_BAND_FRACTION;
    const laneMax = b.rc[pl] - SOLVE_RING_MARGIN - MOON_CLEAR - CONFIG.MOON_RADIUS_MAX;
    if (lane > laneMax) lane = laneMax;
    const span = CONFIG.MOON_ANGULAR_SPEED_MAX - CONFIG.MOON_ANGULAR_SPEED_MIN;
    const w = (rnd() < 0.5 ? -1 : 1) * (CONFIG.MOON_ANGULAR_SPEED_MIN + span * rnd());
    const ph = TAU * rnd();
    for (let k = 0; k < count; k++) {
      const m = allocBody();
      if (m < 0) return;
      const r = CONFIG.MOON_RADIUS_MIN + (CONFIG.MOON_RADIUS_MAX - CONFIG.MOON_RADIUS_MIN) * rnd();
      PL[0] = b.x[pl]; PL[1] = b.y[pl]; PL[2] = r; PL[3] = 0;
      writePlanet(m, -1, z, 0, hash32(rng.u30()));
      b.type[m] = BODY.MOON;
      b.parent[m] = pl;
      b.m0[m] = lane; b.m1[m] = w; b.m2[m] = ph + Math.PI * k;
      placeMotion(world, m);
      commitId(m);
    }
  }

  /**
   * A non-path planet beside segment A→B, on the far side of the field from the segment. Kept only
   * if it leaves every recent path pair solvable.
   * @param {number} a @param {number} bs @param {number} z
   */
  function placeSidePlanet(a, bs, z) {
    const b = world.bodies;
    const slot = allocBody();
    if (slot < 0) return;
    const midX = (b.x[a] + b.x[bs]) * 0.5;
    const band = captureBand(z);
    const flags = rnd() < CONFIG.RINGED_FRACTION ? BODY_FLAG.RINGED : 0;
    const seed = hash32(rng.u30());
    const W = CONFIG.FIELD_WIDTH;
    for (let t = 0; t < SIDE_TRIES; t++) {
      const r = SIDE_R_MIN + (SIDE_R_MAX - SIDE_R_MIN) * rnd();
      const y = b.y[a] + (b.y[bs] - b.y[a]) * (0.2 + 0.6 * rnd());
      const x = midX < W * 0.5
        ? W * 0.65 + (CONFIG.PLANET_X_MAX - W * 0.65) * rnd()
        : CONFIG.PLANET_X_MIN + (W * 0.35 - CONFIG.PLANET_X_MIN) * rnd();
      PL[0] = x; PL[1] = y; PL[2] = r; PL[3] = r + band;
      writePlanet(slot, -1, z, flags, seed);
      if (spacingOk(slot) && pairsOk(gen.pathCount - 1)) {
        commitId(slot);
        clearMotesAround(slot);
        return;
      }
    }
    freeBody(slot);
  }

  /**
   * A black hole beside segment A→B (zone 4+), on the side of the field away from the segment.
   * Kept only if its influence radius stays clear of every ring and every recent pair keeps its
   * window; otherwise the segment simply has none. Returns whether it placed one.
   * @param {number} a @param {number} bs @param {number} z
   */
  function placeBlackHole(a, bs, z) {
    const b = world.bodies;
    const slot = allocBody();
    if (slot < 0) return false;
    const midX = (b.x[a] + b.x[bs]) * 0.5;
    const W = CONFIG.FIELD_WIDTH;
    const seed = hash32(rng.u30());
    for (let t = 0; t < CONFIG.BLACKHOLE_TRIES; t++) {
      const y = b.y[a] + (b.y[bs] - b.y[a]) * (0.1 + 0.8 * rnd());
      const u = rnd();
      // Most tries on the side of the field away from the segment; every third anywhere.
      const x = t % 3 === 2
        ? CONFIG.BLACKHOLE_X_MIN + (CONFIG.BLACKHOLE_X_MAX - CONFIG.BLACKHOLE_X_MIN) * u
        : midX < W * 0.5
          ? W * 0.52 + (CONFIG.BLACKHOLE_X_MAX - W * 0.52) * u
          : CONFIG.BLACKHOLE_X_MIN + (W * 0.48 - CONFIG.BLACKHOLE_X_MIN) * u;
      PL[0] = x; PL[1] = y; PL[2] = CONFIG.BLACKHOLE_CORE_RADIUS; PL[3] = CONFIG.BLACKHOLE_INFLUENCE_RADIUS;
      writePlanet(slot, -1, z, 0, seed);
      b.type[slot] = BODY.BLACKHOLE;
      if (spacingOk(slot) && pairsOk(gen.pathCount - 1)) {
        commitId(slot);
        clearMotesAround(slot);
        return true;
      }
    }
    freeBody(slot);
    return false;
  }

  /** Mote at (PL[0], PL[1]). @param {number} i @param {number} line @param {number} order */
  function writeMote(i, line, order) {
    const m = world.motes;
    m.alive[i] = 1; m.x[i] = PL[0]; m.y[i] = PL[1]; m.line[i] = line; m.order[i] = order;
  }

  function allocMote() {
    const m = world.motes;
    for (let i = 0; i < CONFIG.MAX_MOTES; i++) {
      if (!m.alive[i]) {
        if (i + 1 > m.count) m.count = i + 1;
        return i;
      }
    }
    return -1;
  }

  /**
   * A short line of motes along the centre ray of a release window A→B (random orbit direction),
   * at the bodies' current positions. Motes any body could ever overlap are skipped.
   * @param {number} a @param {number} bs
   */
  function placeMoteLine(a, bs) {
    const b = world.bodies;
    const dir = rnd() < 0.5 ? 1 : -1;
    const span = CONFIG.MOTES_PER_LINE_MAX - CONFIG.MOTES_PER_LINE_MIN + 1;
    const want = CONFIG.MOTES_PER_LINE_MIN + Math.floor(rnd() * span);
    scanWindow(world, a, bs, dir, 0, 0);
    const rho = RHO[0];
    if (WIN[0] <= 0) return;
    const phi = WIN[1], c = Math.cos(phi), s = Math.sin(phi);
    const px = b.x[a] + rho * c, py = b.y[a] + rho * s, dx = -s * dir, dy = c * dir;
    if (!rayCircleHit(px, py, dx, dy, b.x[bs], b.y[bs], b.rc[bs])) return;
    const tB = OUT[0];
    const sp = CONFIG.MOTE_SPACING;
    const avail = tB - MOTE_START;
    if (tB <= 0 || avail < sp * 2) return;
    let n = Math.floor(avail / sp) + 1;
    if (n > want) n = want;
    const t0 = MOTE_START + (avail - (n - 1) * sp) * 0.5;
    const line = lineId;
    lineId = (lineId + 1) & 0xffff;
    let order = 0;
    for (let k = 0; k < n; k++) {
      const x = px + dx * (t0 + k * sp), y = py + dy * (t0 + k * sp);
      if (x < MOTE_WALL_INSET || x > CONFIG.FIELD_WIDTH - MOTE_WALL_INSET) continue;
      PL[0] = x; PL[1] = y;
      if (!moteClear()) continue;
      const i = allocMote();
      if (i < 0) return;
      writeMote(i, line, order++);
    }
  }

  /** @param {number} seed */
  function reset(seed) {
    rng.setState(hash32((seed >>> 0) ^ 0x51f15e5));
    nextId = 1;
    lineId = 0;
    bhPending = 0;
    const b = world.bodies, m = world.motes;
    b.alive.fill(0); b.count = 0;
    m.alive.fill(0); m.count = 0;
    recentSlot.fill(-1);
    OVR.fill(0);
    gen.pathCount = 0; gen.rerolls = 0; gen.fallbacks = 0;
    const slot = allocBody();
    const r = CONFIG.HOME_R;
    PL[0] = CONFIG.HOME_X; PL[1] = CONFIG.HOME_Y; PL[2] = r; PL[3] = r + captureBand(1);
    writePlanet(slot, 0, 1, BODY_FLAG.HOME, hash32(seed >>> 0));
    commitId(slot);
    recentSlot[0] = slot;
    recentId[0] = b.id[slot];
    gen.pathCount = 1;
    topY = CONFIG.HOME_Y;
  }

  /** @param {number} [maxPlacements] */
  function update(maxPlacements = PLACEMENTS_PER_UPDATE) {
    const b = world.bodies, m = world.motes;
    const limit = world.front.y - RECYCLE_BELOW;
    for (let i = 0; i < b.count; i++) {
      if (!b.alive[i]) continue;
      const top = b.y[i] + (b.rc[i] > b.r[i] ? b.rc[i] : b.r[i]);
      if (top < limit) freeBody(i);
    }
    for (let i = 0; i < m.count; i++) if (m.alive[i] && m.y[i] < limit) freeMote(i);
    if (!gen.enabled) return;
    let y = world.comet.y;
    if (world.score.maxHeight > y) y = world.score.maxHeight;
    const target = y + CONFIG.GENERATE_AHEAD;
    for (let k = 0; k < maxPlacements && topY < target; k++) if (!placePath()) break;
  }

  return gen;
}
