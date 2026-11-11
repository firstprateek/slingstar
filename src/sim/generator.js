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
 * A window must be wide enough in degrees (the zone's rule) AND in time (Phase 4): at least
 * SOLVE_WINDOW_MIN_S at the speed the player can have on A (scoring.solveWindowSpeed), on the orbit
 * being checked — angular speed rises with the zone's base speed, so a degree rule alone collapses
 * to a frame or two late in a run.
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
 *   - Binary pairs are two real planets (Phase 4) circling a shared centre, opposite each other,
 *     with one pathIndex. Within the pair being left or aimed at, rings are not obstacles, bodies
 *     are: a ray onto a binary B keeps SOLVE_CLEARANCE from both of B's bodies; a ray from one
 *     member of a binary A may cross its partner's ring (not progress: the aim line looks past it
 *     and a lit release flies through it) but keeps SOLVE_CLEARANCE from the partner's body, swept
 *     over the flight time as the pair turns (prepObstacles).
 *   - Any other moving body is an obstacle over its whole motion envelope (a drifting planet's
 *     ring swept across its track, a binary member's ring swept around its circle).
 *   - Moons keep SOLVE_CLEARANCE from every solving ray by construction, over their whole orbit
 *     (so their motion cannot matter): another planet's moons sit inside its ring, which rays avoid
 *     entirely; B's moon lane is kept SOLVE_CLEARANCE inside the depth a solving ray reaches into
 *     B's ring; on the planet being left the lane is a floor — the "mid-band" orbit used for the
 *     window is the middle of the band from SOLVE_CLEARANCE above the moons' outer edge up to Rc
 *     (tangent rays never come nearer the centre than their orbit radius); below that the orbit
 *     runs into the moons.
 *   - A moon's whole lane also stays MOON_CLEAR outside every OTHER planet's capture ring (over
 *     both bodies' motion), so no orbit the player can latch elsewhere ever meets it (Phase 4).
 *   - Black holes: rays may not enter the influence radius (the straight-line window would be a lie
 *     there), and no planet's ring may overlap an influence radius. A rolled black hole that finds
 *     no room beside its segment carries over to the next segments (BLACKHOLE_CARRY).
 *   - Side planets can be caught (the aim line lights them), so each one keeps its own onward
 *     window to the path planet that ends its segment, re-checked like a path pair (Phase 4).
 *
 * Cost: a placement runs many window checks (phases × members × orbits × directions × rays). Each
 * scan collects its obstacles once (prepObstacles) and, when only a pass/fail answer is needed,
 * stops at the first wide-enough window, starting near the tangent that points at B.
 * Work budget (Phase 4): placement is a resumable job. world.step calls update() every step and the
 * job advances by at most GEN_STEP_BUDGET work units (one unit ≈ one ray-obstacle test), pausing
 * mid-scan if need be and resuming next step exactly where it stopped. The budget is counted in
 * work, never in wall time, so generation stays deterministic (same seed + input → same world).
 * Nothing is half-visible in between: a moving body is only ever moved to a sampled phase inside one
 * update() call and is back at its true position before it returns; the planet being placed sits
 * thousands of units above the comet (GENERATE_AHEAD), beyond the aim range and the screen, and a
 * rejected try leaves the world at once. If the course ahead runs short the budget ramps up
 * (GEN_CATCHUP_*), and below GEN_URGENT_AHEAD it is lifted for that step.
 * update(n) with an explicit count (world reset, tests) runs unbudgeted, as before.
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { createRng, hash32 } from '../core/rng.js';
import { rayCircleHit, OUT, TAU } from '../core/math.js';
import { zoneOfPathIndex, captureBand, solveWindowReqDeg, solveWindowSpeed, pathSpacingMax, baseSpeedForZone } from './scoring.js';
import { envelopeOf, placeMotion, partnerOf, ENV, MOVING_FLAGS } from './hazards.js';

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
/** Ring buffer of recent side planets whose onward pair is re-validated (a few per RECHECK_PAIRS segments). */
const SIDE_RECENT = 8;
/** Pairs one check can cover: the recent path pairs, recent side planets' onward pairs, one new side pair. */
const MAX_CHECK = RECHECK_PAIRS + SIDE_RECENT + 1;
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
/** Placement aims for this multiple of the required window (obstacles and walls take some of it). */
const WINDOW_SHAPE_MARGIN = CONFIG.SOLVE_WINDOW_SHAPE_MARGIN;
/** Work units per generator step (update() without a count). @type {number} */
const STEP_BUDGET = CONFIG.GEN_STEP_BUDGET;
/** Work units charged per ray that misses B's ring (cheap), and per ray that reaches the obstacle
 * test (plus one per obstacle). Calibrated so a unit is roughly constant in time. */
const RAY_MISS_COST = 1, RAY_COST = 2;
/** Extra work units per moving obstacle (a segment-to-segment test instead of segment-to-point). */
const MOVING_OBS_COST = 6;
/** Extra work units per ray for a binary A's partner (partnerBlocks: a few arcs and capsule spans). */
const PARTNER_COST = 16;
/** partnerBlocks refines its contact window at most this many times. */
const PARTNER_REFINE = 6;
/** Work units charged per scan (re)start (orbit radius, phase placement), per obstacle list built
 * and per spacing check (measured against the ray cost on a desktop). */
const SCAN_COST = 350, PREP_COST = 800, SPACING_COST = 300;

const KIND_PLAIN = 0, KIND_DRIFT = 1, KIND_BINARY = 2;

// Placement job states (see runJob).
const ST_IDLE = 0, ST_PATH_TRY = 1, ST_PATH_CHECK = 2, ST_FB_TRY = 3, ST_FB_CHECK = 4, ST_PATH_COMMIT = 5;
const ST_SIDE_TRY = 6, ST_SIDE_CHECK = 7, ST_BH_ROLL = 8, ST_BH_TRY = 9, ST_BH_CHECK = 10;
const ST_MOTE_ROLL = 11, ST_MOTE_SCAN = 12;

// ---------------------------------------------------------------- scratch (allocated once)
const N = CONFIG.SOLVE_RAY_SAMPLES;
const COS = new Float64Array(N);
const SIN = new Float64Array(N);
for (let i = 0; i < N; i++) { COS[i] = Math.cos((TAU * i) / N); SIN[i] = Math.sin((TAU * i) / N); }
const OK = new Uint8Array(N);
/** WIN[0] = widest window (deg), WIN[1] = its centre angle (rad), WIN[2] = minimum over a pair
 * measurement (deg), WIN[3] = minimum over a pair measurement in time (s), WIN[4] = a binary A's
 * longest partner eclipse in a pair measurement (s). */
const WIN = new Float64Array(5);
/** RAYG[0..3] = ray origin x, y and unit direction x, y for rayOk. Doubles go through memory
 * because computed doubles passed as call arguments to a non-inlined function are boxed. */
const RAYG = new Float64Array(4);
/** PL[0..3] = x, y, r, rc for writePlanet (same reason). */
const PL = new Float64Array(4);
/** SEG[0..3], SEG[4..7] = two segments' endpoints, SEG[8] = distance for segsWithin. */
const SEG = new Float64Array(9);
/** Phase overrides: OVR[i] = 1 while slot i sits at a sampled phase (it is then a point, not an envelope).
 * Only ever set inside one update() / measurement call (never across world steps). */
const OVR = new Uint8Array(CONFIG.MAX_BODIES);
/** Saved positions of up to two overridden slots. */
const SAVE = new Float64Array(4);
/** Obstacles of the current window scan (prepObstacles): count, binary partner of B, per obstacle
 * a moving flag and 5 doubles (centre segment x0, y0, x1, y1 and clearance radius). */
const OBS_N = new Int32Array(1);
/** How many of them are moving (swept segments: a dearer test). */
const OBS_NM = new Int32Array(1);
const OBS_B2 = new Int32Array(1);
/**
 * A binary A's partner, tested by rayOk on its own (prepObstacles): PART[0] = its slot or -1.
 * PARTD: [0, 1] pair centre, [2] orbit radius R, [3] angle now, [4] signed angular speed ω,
 * [5] clearance (its radius + SOLVE_CLEARANCE), [6] slowest and [7] fastest comet speed,
 * [8] its own speed ωR, [9, 10] its position now.
 */
const PART = new Int32Array(1);
const PARTD = new Float64Array(11);
/** Partner-eclipse bookkeeping for a binary A (checkRun / measurePair), per member × orbit ×
 * direction combo: the current run of blocked phases, the leading run (from phase 0) and whether
 * that leading run is still open. */
const ECUR = new Int32Array(16), ELEAD = new Int32Array(16), EOPEN = new Uint8Array(16);
/** Longest run seen by eclipseMark since the last eclipseReset. Two sets (base 0: the generator's
 * own check, which can pause between steps; base 8: measurePair). */
const EMAX = new Int32Array(2);
const E_CHECK = 0, E_MEASURE = 8;

/**
 * Partner eclipse (Phase 4). From one member of a binary A, its partner swings through the line to
 * B once a turn and hides B from that member for a while (for one orbit direction, ~30–60° of the
 * pair's turn): no window can exist then, whatever B's placement. The rule for a binary A is
 * therefore: at every sampled phase a window as for any pair, except during such an eclipse, and
 * every eclipse passes within BINARY_MAX_WAIT_S at the pair's angular speed (a run of L blocked
 * phases is shorter than L + 1 phase steps). The aim line is dark meanwhile and lights as the
 * partner moves on, so a player on that member waits at most that long (plus the usual part of a lap).
 * Most blocked phases a run may have for binary slot a sampled at K phases.
 * @param {Bodies} b @param {number} a @param {number} K
 */
function eclipseMaxRun(b, a, K) {
  const om = b.m1[a] < 0 ? -b.m1[a] : b.m1[a];
  return Math.floor((CONFIG.BINARY_MAX_WAIT_S * om * K) / TAU + 1e-9) - 1;
}

/** @param {number} base E_CHECK or E_MEASURE */
function eclipseReset(base) {
  for (let c = base; c < base + 8; c++) { ECUR[c] = 0; ELEAD[c] = 0; EOPEN[c] = 1; }
  EMAX[base >> 3] = 0;
}

/**
 * Record whether combo c (member × orbit × direction, 0..7) is blocked at the next phase; returns
 * its current run. @param {number} base @param {number} c @param {number} blocked
 */
function eclipseMark(base, c, blocked) {
  const i = base + c;
  if (blocked) {
    ECUR[i]++;
    if (EOPEN[i]) ELEAD[i]++;
    if (ECUR[i] > EMAX[base >> 3]) EMAX[base >> 3] = ECUR[i];
  } else { ECUR[i] = 0; EOPEN[i] = 0; }
  return ECUR[i];
}

/** After the last phase: the longest run, joining each combo's last run to its first (the turn
 * wraps). @param {number} base */
function eclipseLongest(base) {
  let m = EMAX[base >> 3];
  for (let i = base; i < base + 8; i++) {
    const r = EOPEN[i] ? ECUR[i] : ECUR[i] + ELEAD[i];
    if (r > m) m = r;
  }
  return m;
}
const OBSM = new Uint8Array(CONFIG.MAX_BODIES);
const OBSD = new Float64Array(CONFIG.MAX_BODIES * 5);
/** Solve-orbit radius out-param. */
const RHO = new Float64Array(1);
/** spacingForWindow out-param. */
const SPW = new Float64Array(1);
/** MIN_ENTRY[0] = shortest distance along a solving ray before it may enter B's ring (0 = any).
 * Set by each caller before a scan: non-zero only for a side planet's onward pair (see checkRun). */
const MIN_ENTRY = new Float64Array(1);
/** RAYX[0] = 1 if the last rayOk call got as far as the obstacle test (for the work budget). */
const RAYX = new Uint8Array(1);
/** Work budget left in the current update() call (generator work units; Infinity = unbudgeted). */
const BUD = new Float64Array(1);
/** Scan state for synchronous scans (scanWindow). Layout: see scanPart. */
const SYNC_SCAN = new Int32Array(6);
/** Scale for rng.u30() → [0, 1). The generator uses u30 (a Smi) so random draws never box. */
const U30 = 1 / 1073741824;

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
 * Time rule shaping (Phase 4): the largest centre distance D at which a ring of radius rB still
 * spans `ang` radians of tangent rays from an orbit of radius rho, ignoring obstacles, into SPW[0].
 * The tangent line at orbit angle φ passes |D cos(φ - θ) - rho| from the ring's centre, so the
 * window is acos((rho - rB) / D) - acos((rho + rB) / D), which shrinks as D grows (bisection).
 * Placement uses it to keep B near enough that the exact scan usually passes on the first try.
 * @param {number} rho @param {number} rB @param {number} ang
 */
function spacingForWindow(rho, rB, ang) {
  const c1 = rho - rB, c2 = rho + rB;
  let lo = c2, hi = 6000;
  if (Math.acos(c1 / hi) - Math.acos(c2 / hi) >= ang) { SPW[0] = hi; return; }
  if (Math.acos(c1 / lo) - Math.acos(c2 / lo) < ang) { SPW[0] = lo; return; }
  for (let k = 0; k < 24; k++) {
    const d = (lo + hi) * 0.5;
    if (Math.acos(c1 / d) - Math.acos(c2 / d) >= ang) lo = d; else hi = d;
  }
  SPW[0] = lo;
}

/**
 * Collect the obstacles for one window scan from A (slot a) toward B (slot bi): every live body
 * except A and moons that could come within clearance of a ray from A's ring to B's ring. Each
 * gets its clearance radius `need` (SOLVE_CLEARANCE from its surface, or its whole capture ring /
 * influence radius, whichever is larger) and the segment its centre sweeps (a point if static or
 * at a sampled phase; its motion envelope otherwise, see envelopeOf).
 * Binary pairs (Phase 4, both members are real bodies): rings of the pair being left or aimed at
 * are not obstacles, only their BODIES are (SOLVE_CLEARANCE from the surface):
 *   - B and B's partner (either member's ring is the goal, see rayOk) at their positions;
 *   - A's partner, where it can be while the comet passes it (PART, tested per ray in rayOk): the
 *     comet leaves A's orbit at the sampled phase and the pair keeps turning while it flies, at any
 *     speed from the zone's base speed to its cap after a slingshot boost. Its ring is not progress
 *     and is not a target: world.js looks past it (the aim line), and a press on the straight flight
 *     after a lit release does not latch it.
 * Done once per scan (or scan resumption) instead of once per ray.
 * @param {WorldT} w @param {number} a @param {number} bi
 */
function prepObstacles(w, a, bi) {
  const b = w.bodies;
  const b2 = partnerOf(b, bi);
  const a2 = partnerOf(b, a);
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
  PART[0] = -1;
  if (a2 >= 0) {
    const vmin = baseSpeedForZone(b.zone[bi]);
    PART[0] = a2;
    PARTD[0] = b.m3[a2]; PARTD[1] = b.m4[a2]; PARTD[2] = b.m0[a2];
    PARTD[3] = Math.atan2(b.y[a2] - b.m4[a2], b.x[a2] - b.m3[a2]); PARTD[4] = b.m1[a2];
    PARTD[5] = b.r[a2] + clr; PARTD[6] = vmin;
    PARTD[7] = solveWindowSpeed(b.zone[bi]) * CONFIG.BLACKHOLE_SPEED_BOOST;
    PARTD[8] = Math.abs(b.m1[a2]) * b.m0[a2];
    PARTD[9] = b.x[a2]; PARTD[10] = b.y[a2];
  }
  let n = 0, nm = 0;
  for (let k = 0, c = b.count; k < c; k++) {
    if (!b.alive[k] || k === a || b.type[k] === BODY.MOON) continue;
    const o = n * 5;
    if (k === bi || k === b2) {
      // A plain B: its ring is the goal and its body lies inside it. A binary B: both bodies.
      if (b2 < 0) continue;
      OBSD[o] = OBSD[o + 2] = b.x[k]; OBSD[o + 1] = OBSD[o + 3] = b.y[k]; OBSD[o + 4] = b.r[k] + clr;
      OBSM[n] = 0;
    } else if (k === a2) {
      continue; // rayOk tests it on its own, per ray, as it turns during the flight (PART)
    } else {
      let need = b.r[k] + clr;
      if (b.rc[k] > need) need = b.rc[k];
      if ((b.flags[k] & MOVING_FLAGS) !== 0 && !OVR[k]) {
        envelopeOf(b, k);
        OBSD[o] = ENV[0]; OBSD[o + 1] = ENV[1]; OBSD[o + 2] = ENV[2]; OBSD[o + 3] = ENV[3];
        OBSD[o + 4] = need + ENV[4];
        OBSM[n] = 1;
      } else {
        OBSD[o] = OBSD[o + 2] = b.x[k]; OBSD[o + 1] = OBSD[o + 3] = b.y[k]; OBSD[o + 4] = need;
        OBSM[n] = 0;
      }
    }
    const reach = far + OBSD[o + 4];
    if (ptSeg2(ax, ay, OBSD[o], OBSD[o + 1], OBSD[o + 2] - OBSD[o], OBSD[o + 3] - OBSD[o + 1]) >= reach * reach) continue;
    nm += OBSM[n];
    n++;
  }
  OBS_N[0] = n; OBS_NM[0] = nm;
}

/**
 * Is the straight ray RAYG (origin, unit direction) a fair release onto B (slot bi, or its binary
 * partner if that ring comes first)? It must enter the target's ring SOLVE_RING_MARGIN deep, stay
 * inside the walls until then, and keep clear of every obstacle prepObstacles collected: no
 * nearer than SOLVE_CLEARANCE to a surface, never inside another capture ring or influence
 * radius (except the rings of a binary A's partner and of B's members: their bodies only);
 * moving bodies not at a sampled phase over their whole motion envelope. Moons are not
 * obstacles: the generator keeps them SOLVE_CLEARANCE away from every solving ray by construction
 * (see the header and addMoons).
 * @param {WorldT} w @param {number} bi
 */
function rayOk(w, bi) {
  const b = w.bodies;
  const px = RAYG[0], py = RAYG[1], dx = RAYG[2], dy = RAYG[3];
  const b2 = OBS_B2[0];
  RAYX[0] = 0;
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
  if (MIN_ENTRY[0] > 0) {
    // world.js times the entry into B's full ring (rc), which comes before the shrunk one.
    const rF = b.rc[tgt], cF = fx * fx + fy * fy - rF * rF;
    if (cF <= 0 || -fd - Math.sqrt(fd * fd - cF) < MIN_ENTRY[0]) return false;
  }
  RAYX[0] = 1;
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
  if (PART[0] >= 0) { CAP[11] = tB; if (partnerBlocks()) return false; }
  return true;
}

/** capsuleSpan in/out: CAP[0..3] ray origin and unit direction, CAP[4..7] segment ends, CAP[8]
 * radius; out CAP[9], CAP[10] = the span of ray distances within the radius of the segment
 * (CAP[9] > CAP[10] if none). CAP[11] = partnerBlocks' input (doubles go through memory). */
const CAP = new Float64Array(12);

/** The ray-capsule span (CAP). Distance to a segment is convex along a line, so the span is one
 * interval: the hull of the spans for the two end circles and the slab beside the segment. */
function capsuleSpan() {
  const px = CAP[0], py = CAP[1], dx = CAP[2], dy = CAP[3], rr = CAP[8];
  let lo = Infinity, hi = -Infinity;
  for (let e = 0; e < 2; e++) {
    const fx = px - CAP[4 + 2 * e], fy = py - CAP[5 + 2 * e];
    const fd = fx * dx + fy * dy, disc = fd * fd - (fx * fx + fy * fy - rr * rr);
    if (disc >= 0) {
      const q = Math.sqrt(disc);
      if (-fd - q < lo) lo = -fd - q;
      if (-fd + q > hi) hi = -fd + q;
    }
  }
  let ex = CAP[6] - CAP[4], ey = CAP[7] - CAP[5];
  const L = Math.sqrt(ex * ex + ey * ey);
  if (L > 1e-9) {
    ex /= L; ey /= L;
    const gx = px - CAP[4], gy = py - CAP[5];
    // along(s) = a0 + a1 s in [0, L]; across(s) = c0 + c1 s in (-rr, rr).
    const a0 = gx * ex + gy * ey, a1 = dx * ex + dy * ey;
    const c0 = gy * ex - gx * ey, c1 = dy * ex - dx * ey;
    let s0 = -Infinity, s1 = Infinity;
    if (a1 > 1e-12) { const u = -a0 / a1, v = (L - a0) / a1; if (u > s0) s0 = u; if (v < s1) s1 = v; }
    else if (a1 < -1e-12) { const u = (L - a0) / a1, v = -a0 / a1; if (u > s0) s0 = u; if (v < s1) s1 = v; }
    else if (a0 < 0 || a0 > L) s1 = -Infinity;
    if (c1 > 1e-12) { const u = (-rr - c0) / c1, v = (rr - c0) / c1; if (u > s0) s0 = u; if (v < s1) s1 = v; }
    else if (c1 < -1e-12) { const u = (rr - c0) / c1, v = (-rr - c0) / c1; if (u > s0) s0 = u; if (v < s1) s1 = v; }
    else if (c0 <= -rr || c0 >= rr) s1 = -Infinity;
    if (s0 <= s1) { if (s0 < lo) lo = s0; if (s1 > hi) hi = s1; }
  }
  CAP[9] = lo; CAP[10] = hi;
}

/**
 * Does a binary A's partner (PART / PARTD) come within its clearance of the ray RAYG, between the
 * release and the entry into B's ring at distance CAP[11]? The pair keeps turning while the comet flies,
 * at any speed v in [vmin, vmax]: the comet is at s = v t. Start from the times the comet can be
 * near the partner's circle at all, then repeatedly take the arc the partner sweeps in that time
 * (within its sagitta of the chord: a capsule), the stretch of ray near that capsule, and the times
 * the comet can be on that stretch — every step keeps every real contact, and the window shrinks
 * until it is empty (clear) or stops shrinking (blocked, conservatively). The ray ends at CAP[11].
 */
function partnerBlocks() {
  const tB = CAP[11];
  const px = RAYG[0], py = RAYG[1], dx = RAYG[2], dy = RAYG[3];
  const cx = PARTD[0], cy = PARTD[1], R = PARTD[2], need = PARTD[5];
  const vmin = PARTD[6], vmax = PARTD[7], wr = PARTD[8], om = PARTD[4];
  const gx = px - cx, gy = py - cy, gd = gx * dx + gy * dy, reach = R + need;
  const gdisc = gd * gd - (gx * gx + gy * gy - reach * reach);
  if (gdisc <= 0) return false;
  const gsq = Math.sqrt(gdisc);
  let sa = -gd - gsq, sb = -gd + gsq;
  if (sa < 0) sa = 0;
  if (sb > tB) sb = tB;
  if (sa > sb) return false;
  // The partner moves at most ωR t from where it is now (Q0, D0 from the ray origin), so contact
  // needs |s - D0| < need + ωR t.
  const qx0 = PARTD[9] - px, qy0 = PARTD[10] - py, D0 = Math.sqrt(qx0 * qx0 + qy0 * qy0);
  let tlo = sa / vmax, thi = sb / vmin;
  const t1 = (D0 - need) / (vmax + wr);
  if (t1 > tlo) tlo = t1;
  if (vmin > wr) { const t2 = (D0 + need) / (vmin - wr); if (t2 < thi) thi = t2; }
  CAP[0] = px; CAP[1] = py; CAP[2] = dx; CAP[3] = dy;
  for (let it = 0; it < PARTNER_REFINE; it++) {
    if (tlo > thi) return false;
    const phi = (om < 0 ? -om : om) * (thi - tlo);
    if (phi >= Math.PI * 0.5) return true; // (not at the tuned speeds) be conservative
    const a0 = PARTD[3] + om * tlo, a1 = PARTD[3] + om * thi;
    CAP[4] = cx + R * Math.cos(a0); CAP[5] = cy + R * Math.sin(a0);
    CAP[6] = cx + R * Math.cos(a1); CAP[7] = cy + R * Math.sin(a1);
    CAP[8] = need + R * (1 - Math.cos(phi * 0.5));
    capsuleSpan();
    let s0 = CAP[9], s1 = CAP[10];
    if (s0 < sa) s0 = sa;
    if (s1 > sb) s1 = sb;
    if (s0 > s1) return false;
    const nlo = s0 / vmax, nhi = s1 / vmin;
    if (nlo <= tlo && nhi >= thi) return true; // no longer shrinking
    if (nlo > tlo) tlo = nlo;
    if (nhi < thi) thi = nhi;
    sa = s0; sb = s1;
  }
  return tlo <= thi;
}

/**
 * Resumable window scan for orbit direction `dir` (+1 CCW, -1 CW) on A's mid-band orbit
 * (outer = 0) or outer orbit (outer = 1), at the bodies' current (or phase-overridden) positions.
 * Charges BUD per ray and returns false, keeping its progress in S, when the budget runs out;
 * call again with the same arguments (and the same phase overrides) to continue. Returns true when
 * finished: WIN[0] = width in degrees (conservative: (samples - 1) × step), WIN[1] = centre angle,
 * and S is reset for the next scan.
 *
 * With `need` > 0 (consecutive clear samples required) the scan stops as soon as it has found that
 * many, and WIN[0] is then only a lower bound (>= the required width). It starts a quarter turn
 * before the orbit position whose tangent points straight at B, so a window is usually found
 * within the first ~150 of N samples; generation (many checks per placement) relies on this.
 * With need = 0 it tests every sample (into `ok`) and reports the widest window.
 *
 * S layout: [0] rays done, [1] next sample index, [2] current run, [3] run start, [4] leading run
 * (-1 until the first blocked sample), [5] 1 once started.
 * With prep = 0 the obstacle list from the previous call is reused: only valid within one
 * update() call for the same A, B and phase (it depends on neither the orbit nor the direction).
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} dir @param {number} outer
 * @param {number} need @param {Int32Array} S @param {Uint8Array} ok @param {number} prep
 */
function scanPart(w, a, bi, dir, outer, need, S, ok, prep) {
  const b = w.bodies, ax = b.x[a], ay = b.y[a];
  solveRadius(b, a, outer);
  if (prep) { prepObstacles(w, a, bi); BUD[0] -= PREP_COST; }
  BUD[0] -= SCAN_COST;
  const rho = RHO[0], cost = RAY_COST + OBS_N[0] + MOVING_OBS_COST * OBS_NM[0] + (PART[0] >= 0 ? PARTNER_COST : 0);
  const step = 360 / N;
  if (need > 0) {
    let k = S[0], i = S[1], run = S[2], runStart = S[3], prefix = S[4];
    if (!S[5]) {
      let phi = Math.atan2(b.y[bi] - ay, b.x[bi] - ax) - dir * Math.PI * 0.5 - Math.PI * 0.5;
      phi = (phi % TAU + TAU) % TAU;
      i = Math.floor((phi / TAU) * N) % N;
      k = 0; run = 0; runStart = 0; prefix = -1;
      S[5] = 1;
    }
    while (k < N) {
      if (BUD[0] <= 0) { S[0] = k; S[1] = i; S[2] = run; S[3] = runStart; S[4] = prefix; return false; }
      const c = COS[i], s = SIN[i];
      RAYG[0] = ax + rho * c; RAYG[1] = ay + rho * s; RAYG[2] = -s * dir; RAYG[3] = c * dir;
      k++;
      const hit = rayOk(w, bi);
      BUD[0] -= RAYX[0] ? cost : RAY_MISS_COST;
      if (hit) {
        if (run === 0) runStart = i;
        run++;
        if (run >= need) break;
      } else {
        if (prefix < 0) prefix = run;
        run = 0;
      }
      i = i + 1 === N ? 0 : i + 1;
    }
    // A window that wraps from the end of the scan into its start.
    if (run < need && prefix > 0 && run + prefix >= need) run += prefix;
    WIN[0] = run >= N ? 360 : run > 0 ? (run - 1) * step : 0;
    WIN[1] = (TAU * ((runStart + (run >> 1)) % N)) / N;
    S[5] = 0;
    return true;
  }
  let i = S[5] ? S[1] : 0;
  S[5] = 1;
  for (; i < N; i++) {
    if (BUD[0] <= 0) { S[1] = i; return false; }
    const c = COS[i], s = SIN[i];
    RAYG[0] = ax + rho * c; RAYG[1] = ay + rho * s; RAYG[2] = -s * dir; RAYG[3] = c * dir;
    ok[i] = rayOk(w, bi) ? 1 : 0;
    BUD[0] -= RAYX[0] ? cost : RAY_MISS_COST;
  }
  let best = 0, bestStart = 0, run = 0, runStart = 0;
  for (let j = 0; j < 2 * N; j++) {
    if (ok[j % N]) {
      if (run === 0) runStart = j;
      run++;
      if (run > best) { best = run; bestStart = runStart; }
      if (run >= N) break;
    } else run = 0;
  }
  WIN[0] = best >= N ? 360 : best > 0 ? (best - 1) * step : 0;
  WIN[1] = (TAU * ((bestStart + (best >> 1)) % N)) / N;
  S[5] = 0;
  return true;
}

/**
 * Whole window scan in one go (no budget): see scanPart.
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} dir @param {number} outer
 * @param {number} need
 */
function scanWindow(w, a, bi, dir, outer, need) {
  const saved = BUD[0];
  BUD[0] = Infinity;
  SYNC_SCAN[5] = 0;
  scanPart(w, a, bi, dir, outer, need, SYNC_SCAN, OK, 1);
  BUD[0] = saved;
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
 * MIN_ENTRY for pair A→B (Phase 4): from a side planet the ray must enter B's ring no sooner than
 * AIM_MIN_ENTRY_S after the release at the fastest speed the comet can carry (the speed cap after a
 * black-hole boost), or the aim line would never light it (world.js lights an early entry only in
 * special cases) and the side planet would be a dead end. Path pairs keep 0: their spacing is at
 * least PATH_SPACING_MIN. @param {Bodies} b @param {number} a @param {number} bi
 */
function setMinEntry(b, a, bi) {
  MIN_ENTRY[0] = b.pathIndex[a] < 0
    ? CONFIG.AIM_MIN_ENTRY_S * solveWindowSpeed(b.zone[bi]) * CONFIG.BLACKHOLE_SPEED_BOOST : 0;
}

/**
 * Measure pair A→B in full (no budget): over every sampled phase of the moving end (if any), from
 * every member of A (both if A is a binary), both orbit directions, on the mid-band orbit and (if
 * `outer`) the outer orbit. WIN[2] = the narrowest window (degrees), WIN[3] = the narrowest in time
 * (seconds) at the speed the time rule assumes on A (scoring.solveWindowSpeed for B's zone).
 * For a binary A, phases inside an allowed partner eclipse are left out (see eclipseMaxRun) and
 * WIN[4] = its longest eclipse in seconds; an eclipse longer than allowed counts with its windows.
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} outer
 */
function measurePair(w, a, bi, outer) {
  const b = w.bodies;
  // At most one end moves (the generator never puts two moving path planets in a row).
  const mover = movingPlanet(b, a) ? a : movingPlanet(b, bi) ? bi : -1;
  const K = mover >= 0 ? phaseCount(b, mover) : 1;
  const a2 = partnerOf(b, a);
  const v = solveWindowSpeed(b.zone[bi]);
  const binA = mover === a && a2 >= 0;
  let minDeg = 360, minS = Infinity, eDeg = 360, eS = Infinity;
  eclipseReset(E_MEASURE);
  setMinEntry(b, a, bi);
  if (mover >= 0) savePos(b, mover);
  for (let k = 0; k < K; k++) {
    if (mover >= 0) setPhase(b, mover, k, K);
    for (let m = 0; m < 2; m++) {
      const am = m === 0 ? a : a2;
      if (am < 0) continue;
      for (let o = 0; o <= outer; o++) {
        for (let dir = -1; dir <= 1; dir += 2) {
          scanWindow(w, am, bi, dir, o, 0);
          const sec = (WIN[0] * Math.PI / 180) * RHO[0] / v;
          if (binA) {
            // Windows under the rule's requirement count as a partner eclipse (see eclipseMaxRun).
            const blocked = WIN[0] < solveWindowReqDeg(b.zone[bi], RHO[0]);
            eclipseMark(E_MEASURE, (m * 2 + o) * 2 + (dir > 0 ? 1 : 0), blocked ? 1 : 0);
            if (blocked) {
              if (WIN[0] < eDeg) eDeg = WIN[0];
              if (sec < eS) eS = sec;
              continue;
            }
          }
          if (WIN[0] < minDeg) minDeg = WIN[0];
          if (sec < minS) minS = sec;
        }
      }
    }
  }
  if (mover >= 0) restorePos(b, mover);
  MIN_ENTRY[0] = 0;
  WIN[4] = 0;
  if (binA) {
    const run = eclipseLongest(E_MEASURE);
    if (run > 0) WIN[4] = ((run + 1) * TAU / K) / (b.m1[a] < 0 ? -b.m1[a] : b.m1[a]);
    // An eclipse longer than the rule allows is a failure: report its windows.
    if (run > eclipseMaxRun(b, a, K)) {
      if (eDeg < minDeg) minDeg = eDeg;
      if (eS < minS) minS = eS;
    }
  }
  WIN[2] = minDeg; WIN[3] = minS;
}

/**
 * Solvability check for a consecutive path pair A→B (slot indices; for a binary either member).
 * Returns the narrowest clear release window in degrees on the mid-band orbit over both orbit
 * directions, every sampled phase of a moving end and both members of a binary A (0 if none).
 * @param {WorldT} world @param {number} a @param {number} b
 * @returns {number}
 */
export function releaseWindowDeg(world, a, b) {
  measurePair(world, a, b, 0);
  return WIN[2];
}

/**
 * Time rule (Phase 4): the narrowest clear release window for A→B in SECONDS, over the mid-band and
 * outer orbits, both directions, every sampled phase and both members of a binary A, at the speed
 * the rule assumes on A (scoring.solveWindowSpeed of B's zone). Also works for a side planet A.
 * @param {WorldT} world @param {number} a @param {number} b
 * @returns {number}
 */
export function releaseWindowSeconds(world, a, b) {
  measurePair(world, a, b, 1);
  return WIN[3];
}

/**
 * Binary A (Phase 4): the longest partner eclipse for A→B in seconds (see eclipseMaxRun), over the
 * mid-band and outer orbits, both directions and both members; 0 if A is not a binary or its
 * partner never hides B. At most CONFIG.BINARY_MAX_WAIT_S on every generated course.
 * @param {WorldT} world @param {number} a @param {number} b
 * @returns {number}
 */
export function releaseWaitSeconds(world, a, b) {
  measurePair(world, a, b, 1);
  return WIN[4];
}

/**
 * @typedef {Object} Generator
 * @property {(seed: number) => void} reset   Clear bodies and motes, place the home planet (slot 0).
 * @property {(maxPlacements?: number) => void} update  Recycle below the front; generate ahead of the
 *   comet. Without a count: at most GEN_STEP_BUDGET work units (call every step). With a count: up to
 *   that many whole placements, unbudgeted.
 * @property {boolean} enabled               false = never generate beyond the home planet (tests).
 * @property {number} pathCount              Next path index to be placed.
 * @property {(pathIndex: number) => number} slotOfPath  Live slot of a recent path planet, or -1.
 * @property {(pathIndex: number) => number} sideOf  Live side planet whose onward target is that path index, or -1.
 * @property {boolean} busy                  A placement is in progress (paused until the next update).
 * @property {number} rerolls                Path placements re-rolled since reset (diagnostics).
 * @property {number} fallbacks              Path placements that needed the safe fallback (diagnostics).
 * @property {number} urgent                 Steps that lifted the budget because the course ran short (diagnostics).
 * @property {number} work                   Work units the last budgeted update() used (-1 if unbudgeted; diagnostics).
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
  /** Recent side planets: slot, id and the path index of their onward target. */
  const sideSlot = new Int32Array(SIDE_RECENT).fill(-1);
  const sideId = new Uint32Array(SIDE_RECENT);
  const sideTarget = new Int32Array(SIDE_RECENT);
  let sideHead = 0;
  let nextId = 1;
  let lineId = 0;
  let topY = 0;
  /** Black holes rolled but not yet placed (see ST_BH_ROLL). */
  let bhPending = 0;

  // ---- the placement job (resumable; see runJob). Integers live in Smi lets, doubles in JD.
  let st = ST_IDLE;
  /** Path index being placed, A's slot, the new slot, its binary partner, zone, kind, try, flags. */
  let jp = 0, ja = -1, jslot = -1, jpartner = -1, jz = 1, jkind = KIND_PLAIN, jt = 0, jflags = 0;
  /** Side planet / black hole slot being placed, mote line direction and length. */
  let xslot = -1, xflags = 0, mdir = 1, mwant = 0;
  /** Seeds (uint32, kept out of Smi range): [0] path planet, [1] side planet / black hole. */
  const JSEED = new Uint32Array(2);
  /** Job doubles: band, A's reference centre x, y, A's reach, B's y, the segment's mid x. */
  const JD = new Float64Array(9);
  const J_BAND = 0, J_ACX = 1, J_ACY = 2, J_AREACH = 3, J_BY = 4, J_MIDX = 5, J_RHOA = 6, J_ANGA = 7, J_ANG0 = 8;
  // ---- the window check the job is running: pairs, progress, scan state.
  const PA = new Int32Array(MAX_CHECK), PB = new Int32Array(MAX_CHECK);
  /** [0] pair count, [1] pair, [2] phase, [3] member, [4] orbit, [5] direction (0 = CW, 1 = CCW). */
  const CK = new Int32Array(6);
  const CSCAN = new Int32Array(6);
  /** 1 while the obstacle list in scratch belongs to the check's current pair, phase and member
   * (cleared on every update() call: other users may rebuild it in between). */
  let prepped = 0;
  /** Per-sample results of the mote line's full scan (kept across steps). */
  const MOK = new Uint8Array(N);
  const MSCAN = new Int32Array(6);
  /** Uncommitted bodies of a paused job, hidden (alive = 0) between update() calls. */
  const HID = new Int32Array(3);
  let nHidden = 0;

  /** @type {Generator} */
  const gen = {
    reset, update, enabled: opts.enabled !== false, pathCount: 0, slotOfPath, sideOf, busy: false,
    rerolls: 0, fallbacks: 0, urgent: 0, work: 0,
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

  /** @param {number} p */
  function sideOf(p) {
    const b = world.bodies;
    for (let k = 0; k < SIDE_RECENT; k++) {
      const s = sideSlot[k];
      if (s >= 0 && sideTarget[k] === p && b.alive[s] && b.id[s] === sideId[k]) return s;
    }
    return -1;
  }

  /** First free slot other than `skip` (-1: none to skip). @param {number} skip */
  function allocBody(skip) {
    const b = world.bodies;
    for (let i = 0; i < CONFIG.MAX_BODIES; i++) {
      if (!b.alive[i] && i !== skip) {
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
   * Write a plain planet (x, y, r, rc from PL) into slot i (alive, and inside bodies.count: a slot
   * hidden between tries may have dropped out of it). Previous positions match so the renderer
   * does not interpolate from a stale slot.
   * @param {number} i @param {number} pathIndex @param {number} zone @param {number} flags @param {number} seed
   */
  function writePlanet(i, pathIndex, zone, flags, seed) {
    const b = world.bodies;
    const x = PL[0], y = PL[1], r = PL[2], rc = PL[3];
    if (i + 1 > b.count) b.count = i + 1;
    b.alive[i] = 1; b.type[i] = BODY.PLANET; b.flags[i] = flags;
    b.x[i] = b.px[i] = x; b.y[i] = b.py[i] = y;
    b.r[i] = r; b.rc[i] = rc; b.seed[i] = seed; b.zone[i] = zone;
    b.pathIndex[i] = pathIndex; b.parent[i] = -1;
    b.m0[i] = 0; b.m1[i] = 0; b.m2[i] = 0; b.m3[i] = 0; b.m4[i] = 0;
  }

  /** Give slot i a fresh id once its placement is final. @param {number} i */
  function commitId(i) {
    const b = world.bodies;
    b.id[i] = nextId++;
    if (i + 1 > b.count) b.count = i + 1;
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
   * could never release cleanly). A planet's ring also stays MOON_CLEAR clear of every other
   * planet's moon lane (Phase 4: an orbit there would cross the moon). Moons themselves live inside
   * their parent's ring and are checked from the planet side.
   * @param {number} i
   */
  function spacingOk(i) {
    const b = world.bodies;
    BUD[0] -= SPACING_COST;
    const ip = partnerOf(b, i);
    const iBh = b.type[i] === BODY.BLACKHOLE;
    envelopeOf(b, i);
    const x0 = ENV[0], y0 = ENV[1], x1 = ENV[2], y1 = ENV[3], ri = ENV[4];
    for (let k = 0, n = b.count; k < n; k++) {
      if (k === i || k === ip || !b.alive[k]) continue;
      let need;
      if (b.type[k] === BODY.MOON) {
        if (iBh || b.parent[k] === i) continue;
        // envelopeOf(moon) = its parent's envelope, reach + lane radius.
        need = b.rc[i] + b.r[k] + MOON_CLEAR;
      } else if (iBh || b.type[k] === BODY.BLACKHOLE) need = b.rc[i] + b.rc[k] + BODY_GAP;
      else {
        need = b.rc[i] + b.r[k];
        const n2 = b.rc[k] + b.r[i];
        if (n2 > need) need = n2;
        need += BODY_GAP;
      }
      envelopeOf(b, k);
      SEG[0] = x0; SEG[1] = y0; SEG[2] = x1; SEG[3] = y1;
      SEG[4] = ENV[0]; SEG[5] = ENV[1]; SEG[6] = ENV[2]; SEG[7] = ENV[3];
      SEG[8] = need + ri + ENV[4];
      if (segsWithin()) return false;
    }
    return true;
  }

  /** Like slotOfPath but also sees the planet currently being placed (pathCount not yet bumped). @param {number} p */
  function slotOfPathRaw(p) {
    if (p !== gen.pathCount) return slotOfPath(p);
    const s = recentSlot[p % RECENT];
    return s >= 0 && world.bodies.alive[s] ? s : -1;
  }

  /**
   * Start a window check of every consecutive path pair ending at `last` and the
   * RECHECK_PAIRS - 1 before it (pairs whose start has been recycled are skipped), plus the onward
   * pair of every recent side planet aimed at one of those path planets, plus (if s >= 0) the new
   * side planet s → path planet `last`. Run it with checkRun.
   * @param {number} last @param {number} s
   */
  function beginCheck(last, s) {
    let n = 0;
    for (let p = last; p >= 1 && p > last - RECHECK_PAIRS; p--) {
      const sa = slotOfPathRaw(p - 1), sb = slotOfPathRaw(p);
      if (sa < 0 || sb < 0) continue;
      PA[n] = sa; PB[n] = sb; n++;
    }
    const b = world.bodies;
    for (let k = 0; k < SIDE_RECENT; k++) {
      const sl = sideSlot[k], t = sideTarget[k];
      if (sl < 0 || t > last || t <= last - RECHECK_PAIRS || !b.alive[sl] || b.id[sl] !== sideId[k]) continue;
      const sb = slotOfPathRaw(t);
      if (sb < 0) continue;
      PA[n] = sl; PB[n] = sb; n++;
    }
    if (s >= 0) {
      const sb = slotOfPathRaw(last);
      if (sb >= 0) { PA[n] = s; PB[n] = sb; n++; }
    }
    CK[0] = n; CK[1] = 0; CK[2] = 0; CK[3] = 0; CK[4] = 0; CK[5] = 0;
    CSCAN[5] = 0;
    prepped = 0;
    eclipseReset(E_CHECK);
  }

  /**
   * Advance the check started by beginCheck within the budget. Every pair needs, over every
   * sampled phase of its moving end, from every member of A, on the mid-band and outer orbits and
   * in both directions, a window of at least scoring.solveWindowReqDeg (zone of B, that orbit's
   * radius) — for a binary A, outside short partner eclipses (eclipseMaxRun). Returns 1 (all
   * pass), 0 (one failed: stops at once) or -1 (budget spent; call again).
   */
  function checkRun() {
    const b = world.bodies;
    while (CK[1] < CK[0]) {
      const sa = PA[CK[1]], sb = PB[CK[1]];
      if (!b.alive[sa] || !b.alive[sb]) { CK[1]++; CK[2] = 0; CK[3] = 0; CK[4] = 0; CK[5] = 0; CSCAN[5] = 0; prepped = 0; eclipseReset(E_CHECK); continue; }
      // At most one end moves (the generator never puts two moving path planets in a row).
      const mover = movingPlanet(b, sa) ? sa : movingPlanet(b, sb) ? sb : -1;
      const K = mover >= 0 ? phaseCount(b, mover) : 1;
      const am = CK[3] === 0 ? sa : partnerOf(b, sa);
      const binA = mover === sa && partnerOf(b, sa) >= 0;
      if (am >= 0) {
        if (mover >= 0) { savePos(b, mover); setPhase(b, mover, CK[2], K); }
        solveRadius(b, am, CK[4]);
        setMinEntry(b, sa, sb);
        const req = solveWindowReqDeg(b.zone[sb], RHO[0]);
        // Consecutive clear samples that make a window of at least req degrees ((n - 1) × step >= req).
        const need = Math.ceil(req / (360 / N) - 1e-9) + 1;
        const done = scanPart(world, am, sb, CK[5] ? 1 : -1, CK[4], need, CSCAN, OK, prepped ? 0 : 1);
        MIN_ENTRY[0] = 0;
        prepped = 1;
        if (mover >= 0) restorePos(b, mover);
        if (!done) return -1;
        if (binA) {
          // A binary A may have short partner eclipses (eclipseMaxRun); anything else fails at once.
          if (eclipseMark(E_CHECK, (CK[3] * 2 + CK[4]) * 2 + CK[5], WIN[0] < req ? 1 : 0) > eclipseMaxRun(b, sa, K)) return 0;
        } else if (WIN[0] < req) return 0;
      }
      // Next: direction, then orbit, then member, then phase, then pair.
      if (++CK[5] > 1) {
        CK[5] = 0;
        if (++CK[4] > 1) {
          CK[4] = 0;
          prepped = 0;
          if (++CK[3] > 1) {
            CK[3] = 0;
            if (++CK[2] >= K) {
              if (binA && eclipseLongest(E_CHECK) > eclipseMaxRun(b, sa, K)) return 0;
              eclipseReset(E_CHECK);
              CK[2] = 0; CK[1]++;
            }
          }
        }
      }
      if (BUD[0] <= 0) return -1;
    }
    return 1;
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

  /** Start placing the next path planet above the previous one. Returns false if it cannot (pool full). */
  function startPath() {
    const p = gen.pathCount;
    const a = slotOfPathRaw(p - 1);
    if (a < 0) return false;
    const slot = allocBody(-1);
    if (slot < 0) return false;
    const b = world.bodies;
    const z = zoneOfPathIndex(p);
    // A's reference centre and how far its centre strays from it (binary circle / drift track).
    const aBin = (b.flags[a] & BODY_FLAG.BINARY) !== 0, aDrift = !aBin && (b.flags[a] & BODY_FLAG.DRIFTING) !== 0;
    JD[J_BAND] = captureBand(z);
    JD[J_ACX] = aBin ? b.m3[a] : aDrift ? b.m0[a] : b.x[a];
    JD[J_ACY] = aBin ? b.m4[a] : b.y[a];
    JD[J_AREACH] = aBin ? b.m0[a] : aDrift ? Math.abs(b.m1[a]) : 0;
    // Window B must span from A's mid-band orbit (the narrower of the two checked), with margin.
    solveRadius(b, a, 0);
    JD[J_RHOA] = RHO[0];
    JD[J_ANG0] = solveWindowReqDeg(z, RHO[0]) * (Math.PI / 180);
    JD[J_ANGA] = JD[J_ANG0] * WINDOW_SHAPE_MARGIN;
    jflags = rnd() < CONFIG.RINGED_FRACTION ? BODY_FLAG.RINGED : 0;
    JSEED[0] = hash32(rng.u30());
    // The zone's moving element for this planet; never two moving path planets in a row.
    jkind = aBin || aDrift ? KIND_PLAIN : rollMover(z);
    recentSlot[p % RECENT] = slot;
    jp = p; ja = a; jslot = slot; jpartner = -1; jz = z; jt = 0; JD[J_BY] = 0;
    st = ST_PATH_TRY;
    gen.busy = true;
    return true;
  }

  /**
   * One try at the path planet (rolls its size, kind, spacing and position and writes it).
   * Returns true if it keeps the spacing rules (its windows are then checked), false to re-roll.
   */
  function pathTry() {
    const b = world.bodies, slot = jslot, z = jz, band = JD[J_BAND];
    const acx = JD[J_ACX], acy = JD[J_ACY], aReach = JD[J_AREACH];
    if (jt === CONFIG.HAZARD_PLAIN_AFTER_TRIES) jkind = KIND_PLAIN;
    if (jpartner >= 0) { freeBody(jpartner); jpartner = -1; }
    if (jkind === KIND_BINARY) {
      // The new slot is not alive yet (a try writes it below): skip it, or the "pair" would be one
      // planet circling an empty centre (Phase 4: every binary used to be its own partner).
      jpartner = allocBody(slot);
      if (jpartner < 0) jkind = KIND_PLAIN;
    }
    const kind = jkind, partner = jpartner;
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
    // Centre-to-centre spacing stays inside [PATH_SPACING_MIN, smax] at every moment, and (time
    // rule) near enough that B's ring spans the required window from A even at the far end of the
    // motion (spacingForWindow, for the smaller member of a binary). A try that cannot meet it at
    // all, even at the minimum spacing, is re-rolled before any window scan.
    const rBody = kind === KIND_BINARY && r2 < r ? r2 : r;
    const sLo = CONFIG.PATH_SPACING_MIN + aReach + reach;
    let sHi = pathSpacingMax(z) - aReach - reach;
    spacingForWindow(JD[J_RHOA], rBody + band - SOLVE_RING_MARGIN, JD[J_ANGA]);
    const sWin = SPW[0] - aReach - reach;
    if (sWin < sHi) sHi = sWin > sLo ? sWin : sLo;
    if (sWin < sLo) {
      spacingForWindow(JD[J_RHOA], rBody + band - SOLVE_RING_MARGIN, JD[J_ANG0]);
      if (SPW[0] - aReach - reach < sLo) return false;
    }
    if (kind !== KIND_PLAIN) {
      // A moving B must leave its own onward pair feasible: the next planet sits at least
      // PATH_SPACING_MIN + reach away and B's motion adds up to `reach` more.
      const zn = zoneOfPathIndex(jp + 1), rhoB = rBody + band * 0.5;
      spacingForWindow(rhoB, CONFIG.PLANET_R_MAX + captureBand(zn) - SOLVE_RING_MARGIN,
        solveWindowReqDeg(zn, rhoB) * (Math.PI / 180) * WINDOW_SHAPE_MARGIN);
      if (SPW[0] < CONFIG.PATH_SPACING_MIN + 2 * reach) return false;
    }
    const s = sLo + (sHi > sLo ? (sHi - sLo) * rnd() : 0);
    let lo = acx - PATH_DX_FRACTION * s, hi = acx + PATH_DX_FRACTION * s;
    const xMin = CONFIG.PLANET_X_MIN + (kind === KIND_PLAIN ? 0 : reach);
    const xMax = CONFIG.PLANET_X_MAX - (kind === KIND_PLAIN ? 0 : reach);
    if (lo < xMin) lo = xMin;
    if (hi > xMax) hi = xMax;
    const u = rnd();
    if (lo > hi || sHi < sLo) return false;
    const x = lo + (hi - lo) * u, dx = x - acx;
    const by = acy + Math.sqrt(s * s - dx * dx);
    JD[J_BY] = by;
    PL[0] = x; PL[1] = by; PL[2] = r; PL[3] = r + band;
    const seed = JSEED[0];
    if (kind === KIND_DRIFT) {
      writePlanet(slot, jp, z, jflags | BODY_FLAG.DRIFTING, seed);
      b.m0[slot] = x;
      b.m1[slot] = rnd() < 0.5 ? -CONFIG.DRIFT_AMPLITUDE : CONFIG.DRIFT_AMPLITUDE;
      b.m2[slot] = CONFIG.DRIFT_PERIOD_MIN + (CONFIG.DRIFT_PERIOD_MAX - CONFIG.DRIFT_PERIOD_MIN) * rnd();
      b.m3[slot] = TAU * rnd();
      placeMotion(world, slot);
    } else if (kind === KIND_BINARY) {
      writePlanet(slot, jp, z, jflags | BODY_FLAG.BINARY, seed);
      PL[0] = x; PL[1] = by; PL[2] = r2; PL[3] = r2 + band;
      writePlanet(partner, jp, z, BODY_FLAG.BINARY | (seed & 1 ? BODY_FLAG.RINGED : 0), hash32(seed ^ 0x2545f491));
      const w = (rnd() < 0.5 ? -1 : 1) * CONFIG.BINARY_ANGULAR_SPEED;
      const th = TAU * rnd();
      b.m0[slot] = b.m0[partner] = half;
      b.m1[slot] = b.m1[partner] = w;
      b.m2[slot] = th; b.m2[partner] = th + Math.PI;
      b.m3[slot] = b.m3[partner] = x;
      b.m4[slot] = b.m4[partner] = by;
      b.parent[slot] = partner; b.parent[partner] = slot;
      placeMotion(world, slot); placeMotion(world, partner);
    } else writePlanet(slot, jp, z, jflags, seed);
    return spacingOk(slot) && (partner < 0 || spacingOk(partner));
  }

  /** The plain safe placement: straight-ish up, toward the centre, medium planet. Returns spacingOk. */
  function fallbackTry() {
    const acx = JD[J_ACX], acy = JD[J_ACY];
    const x = acx + (CONFIG.FIELD_WIDTH * 0.5 - acx) * FALLBACK_TOWARD_CENTER, dx = x - acx;
    // FALLBACK_SPACING and FALLBACK_R, or nearer and bigger if the time rule needs it (never under
    // PATH_SPACING_MIN at any moment, never over PLANET_R_MAX).
    const aReach = JD[J_AREACH], band = JD[J_BAND];
    let r = FALLBACK_R;
    for (;;) {
      spacingForWindow(JD[J_RHOA], r + band - SOLVE_RING_MARGIN, JD[J_ANGA]);
      if (SPW[0] - aReach >= CONFIG.PATH_SPACING_MIN || r + 10 > CONFIG.PLANET_R_MAX) break;
      r += 10;
    }
    let sf = SPW[0] - aReach < FALLBACK_SPACING ? SPW[0] - aReach : FALLBACK_SPACING;
    if (sf < CONFIG.PATH_SPACING_MIN) sf = CONFIG.PATH_SPACING_MIN;
    const s = sf + aReach;
    const by = acy + Math.sqrt(s * s - dx * dx);
    JD[J_BY] = by;
    PL[0] = x; PL[1] = by; PL[2] = r; PL[3] = r + band;
    writePlanet(jslot, jp, jz, jflags, JSEED[0]);
    return spacingOk(jslot);
  }

  /** The path planet is final: commit it and add its moons. */
  function commitPath() {
    const b = world.bodies, slot = jslot, partner = jpartner;
    commitId(slot);
    if (partner >= 0) commitId(partner);
    // A moving planet may have sat hidden for some steps: put it where it is now (prev = current).
    if (b.flags[slot] & MOVING_FLAGS) { placeMotion(world, slot); if (partner >= 0 && partner !== slot) placeMotion(world, partner); }
    recentId[jp % RECENT] = b.id[slot];
    clearMotesAround(slot);
    if (partner >= 0) clearMotesAround(partner);
    gen.pathCount = jp + 1;
    topY = JD[J_BY];
    PL[1] = rnd();
    if (jkind !== KIND_BINARY && rollUnder(jz, 2, CONFIG.HAZARD_MOON_INTRO, CONFIG.HAZARD_MOON_LATER)) addMoons(slot, jz);
  }

  /**
   * Moons circling path planet `pl` inside its capture band (contracts.js MOON params): one, or in
   * zone 6+ sometimes two on the same lane in opposite phase. They are added after the planet's
   * pairs were validated: they never block a solving ray (see rayOk) and only lift the solve orbit
   * of the pair that starts here, which is checked when the next planet is placed. A lane that
   * would come within MOON_CLEAR of another planet's capture ring (over both bodies' motion) is
   * not used: the planet gets no moon (Phase 4; later planets keep clear of it in spacingOk).
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
    if (!laneClear(pl, lane)) return;
    for (let k = 0; k < count; k++) {
      const m = allocBody(-1);
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
   * Does a moon lane of radius `lane` around planet pl (over pl's whole motion, moon radius up to
   * MOON_RADIUS_MAX) stay MOON_CLEAR outside every other planet's capture ring (over its motion)?
   * @param {number} pl @param {number} lane
   */
  function laneClear(pl, lane) {
    const b = world.bodies;
    envelopeOf(b, pl);
    const x0 = ENV[0], y0 = ENV[1], x1 = ENV[2], y1 = ENV[3], rp = ENV[4];
    for (let k = 0, n = b.count; k < n; k++) {
      if (k === pl || !b.alive[k] || b.type[k] !== BODY.PLANET) continue;
      envelopeOf(b, k);
      SEG[0] = x0; SEG[1] = y0; SEG[2] = x1; SEG[3] = y1;
      SEG[4] = ENV[0]; SEG[5] = ENV[1]; SEG[6] = ENV[2]; SEG[7] = ENV[3];
      SEG[8] = b.rc[k] + lane + CONFIG.MOON_RADIUS_MAX + MOON_CLEAR + rp + ENV[4];
      if (segsWithin()) return false;
    }
    return true;
  }

  /** Remember side planet s, whose onward target is path index t. @param {number} s @param {number} t */
  function addSide(s, t) {
    sideSlot[sideHead] = s; sideId[sideHead] = world.bodies.id[s]; sideTarget[sideHead] = t;
    sideHead = (sideHead + 1) % SIDE_RECENT;
  }

  /**
   * One try at a non-path side planet beside segment A→B, on the far side of the field from the
   * segment. Returns spacingOk (it is kept only if every recent pair, and its own onward pair to
   * B, keeps its window).
   */
  function sideTry() {
    const b = world.bodies, a = ja, bs = jslot;
    const W = CONFIG.FIELD_WIDTH;
    const r = SIDE_R_MIN + (SIDE_R_MAX - SIDE_R_MIN) * rnd();
    const y = b.y[a] + (b.y[bs] - b.y[a]) * (0.2 + 0.6 * rnd());
    const x = JD[J_MIDX] < W * 0.5
      ? W * 0.65 + (CONFIG.PLANET_X_MAX - W * 0.65) * rnd()
      : CONFIG.PLANET_X_MIN + (W * 0.35 - CONFIG.PLANET_X_MIN) * rnd();
    PL[0] = x; PL[1] = y; PL[2] = r; PL[3] = r + captureBand(jz);
    writePlanet(xslot, -1, jz, xflags, JSEED[1]);
    return spacingOk(xslot);
  }

  /**
   * One try at a black hole beside segment A→B (zone 4+), on the side of the field away from the
   * segment (every third try anywhere). Returns spacingOk (it is kept only if every recent pair
   * keeps its window).
   */
  function bhTry() {
    const b = world.bodies, a = ja, bs = jslot;
    const W = CONFIG.FIELD_WIDTH;
    const y = b.y[a] + (b.y[bs] - b.y[a]) * (0.1 + 0.8 * rnd());
    const u = rnd();
    const midX = JD[J_MIDX];
    const x = jt % 3 === 2
      ? CONFIG.BLACKHOLE_X_MIN + (CONFIG.BLACKHOLE_X_MAX - CONFIG.BLACKHOLE_X_MIN) * u
      : midX < W * 0.5
        ? W * 0.52 + (CONFIG.BLACKHOLE_X_MAX - W * 0.52) * u
        : CONFIG.BLACKHOLE_X_MIN + (W * 0.48 - CONFIG.BLACKHOLE_X_MIN) * u;
    PL[0] = x; PL[1] = y; PL[2] = CONFIG.BLACKHOLE_CORE_RADIUS; PL[3] = CONFIG.BLACKHOLE_INFLUENCE_RADIUS;
    writePlanet(xslot, -1, jz, 0, JSEED[1]);
    b.type[xslot] = BODY.BLACKHOLE;
    return spacingOk(xslot);
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
   * A short line of motes along the centre ray of the widest release window A→B found by the
   * mote scan (WIN, direction mdir), at the bodies' current positions. Motes any body could ever
   * overlap are skipped.
   */
  function placeMoteLine() {
    const b = world.bodies, a = ja, bs = jslot, dir = mdir;
    solveRadius(b, a, 0);
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
    if (n > mwant) n = mwant;
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

  /**
   * Advance the placement job within the budget. Path planet: tries (roll, spacing, window check)
   * → plain fallback → commit with moons; then a side planet (maybe), a black hole (maybe), a mote
   * line (maybe). The rolls happen in a fixed order, so a seed gives the same course however the
   * work is split across steps. Returns true when the whole placement is done, false when the
   * budget ran out first (call again next step).
   */
  function runJob() {
    const b = world.bodies;
    for (;;) {
      if (BUD[0] <= 0) return false;
      switch (st) {
        case ST_PATH_TRY:
          if (jt >= CONFIG.SOLVE_MAX_TRIES) {
            gen.fallbacks++;
            if (jpartner >= 0) { freeBody(jpartner); jpartner = -1; }
            jkind = KIND_PLAIN; jt = 0; st = ST_FB_TRY;
          } else if (pathTry()) { beginCheck(jp, -1); st = ST_PATH_CHECK; }
          else { hideTry(jslot); gen.rerolls++; jt++; }
          break;
        case ST_PATH_CHECK: {
          const r = checkRun();
          if (r < 0) return false;
          if (r > 0) st = ST_PATH_COMMIT;
          else { hideTry(jslot); gen.rerolls++; jt++; st = ST_PATH_TRY; }
          break;
        }
        case ST_FB_TRY:
          if (jt >= 2) st = ST_PATH_COMMIT; // last resort: keep the plain placement as it is
          else if (fallbackTry()) { beginCheck(jp, -1); st = ST_FB_CHECK; }
          else { clearSidePlanets(JD[J_ACY]); jt++; }
          break;
        case ST_FB_CHECK: {
          const r = checkRun();
          if (r < 0) return false;
          if (r > 0) st = ST_PATH_COMMIT;
          else { clearSidePlanets(JD[J_ACY]); jt++; st = ST_FB_TRY; }
          break;
        }
        case ST_PATH_COMMIT:
          BUD[0] -= SPACING_COST;
          commitPath();
          st = ST_BH_ROLL;
          if (rnd() < SIDE_PLANET_CHANCE) {
            xslot = allocBody(-1);
            if (xslot >= 0) {
              JD[J_MIDX] = (b.x[ja] + b.x[jslot]) * 0.5;
              xflags = rnd() < CONFIG.RINGED_FRACTION ? BODY_FLAG.RINGED : 0;
              JSEED[1] = hash32(rng.u30());
              jt = 0;
              st = ST_SIDE_TRY;
            }
          }
          break;
        case ST_SIDE_TRY:
          if (jt >= SIDE_TRIES) { freeBody(xslot); st = ST_BH_ROLL; break; }
          jt++;
          if (sideTry()) { beginCheck(jp, xslot); st = ST_SIDE_CHECK; }
          else hideTry(xslot);
          break;
        case ST_SIDE_CHECK: {
          const r = checkRun();
          if (r < 0) return false;
          if (r > 0) {
            commitId(xslot);
            clearMotesAround(xslot);
            addSide(xslot, jp);
            st = ST_BH_ROLL;
          } else { hideTry(xslot); st = ST_SIDE_TRY; }
          break;
        }
        case ST_BH_ROLL:
          PL[1] = rnd();
          // A black hole that was rolled but found no room beside its segment carries over to the
          // next segments (at most BLACKHOLE_CARRY pending), so the zone's rate is met where space allows.
          if (rollUnder(jz, 4, CONFIG.HAZARD_BLACKHOLE_INTRO, CONFIG.HAZARD_BLACKHOLE_LATER) && bhPending < CONFIG.BLACKHOLE_CARRY) bhPending++;
          if (jz < 4) bhPending = 0;
          st = ST_MOTE_ROLL;
          if (bhPending > 0) {
            xslot = allocBody(-1);
            if (xslot >= 0) {
              JD[J_MIDX] = (b.x[ja] + b.x[jslot]) * 0.5;
              JSEED[1] = hash32(rng.u30());
              jt = 0;
              st = ST_BH_TRY;
            }
          }
          break;
        case ST_BH_TRY:
          if (jt >= CONFIG.BLACKHOLE_TRIES) { freeBody(xslot); st = ST_MOTE_ROLL; break; }
          if (bhTry()) { beginCheck(jp, -1); st = ST_BH_CHECK; }
          else hideTry(xslot);
          jt++;
          break;
        case ST_BH_CHECK: {
          const r = checkRun();
          if (r < 0) return false;
          if (r > 0) {
            commitId(xslot);
            clearMotesAround(xslot);
            bhPending--;
            st = ST_MOTE_ROLL;
          } else { hideTry(xslot); st = ST_BH_TRY; }
          break;
        }
        case ST_MOTE_ROLL:
          if (rnd() < MOTE_LINE_CHANCE) {
            mdir = rnd() < 0.5 ? 1 : -1;
            const span = CONFIG.MOTES_PER_LINE_MAX - CONFIG.MOTES_PER_LINE_MIN + 1;
            mwant = CONFIG.MOTES_PER_LINE_MIN + Math.floor(rnd() * span);
            MSCAN[5] = 0;
            st = ST_MOTE_SCAN;
          } else { st = ST_IDLE; gen.busy = false; return true; }
          break;
        case ST_MOTE_SCAN:
          if (!scanPart(world, ja, jslot, mdir, 0, 0, MSCAN, MOK, 1)) return false;
          BUD[0] -= SPACING_COST;
          placeMoteLine();
          st = ST_IDLE; gen.busy = false;
          return true;
        default:
          st = ST_IDLE; gen.busy = false;
          return true;
      }
    }
  }

  /** Hide slot i if it is alive (see hideTentative). @param {number} i */
  function hideSlot(i) {
    const b = world.bodies;
    if (i >= 0 && b.alive[i]) { HID[nHidden++] = i; b.alive[i] = 0; }
  }

  /**
   * At the end of update(): bodies the paused job has written but not committed (the path planet
   * and its partner until commit, a side planet or black hole under its check) leave the world
   * (alive = 0) until the job resumes, so collisions, latching, the aim line, black-hole pull and
   * the renderer only ever see committed bodies. Their data stays in the slot.
   */
  function hideTentative() {
    nHidden = 0;
    if (st >= ST_PATH_TRY && st <= ST_PATH_COMMIT) { hideSlot(jslot); hideSlot(jpartner); }
    else if (st === ST_SIDE_TRY || st === ST_SIDE_CHECK || st === ST_BH_TRY || st === ST_BH_CHECK) hideSlot(xslot);
  }

  /**
   * At the start of update(): put the paused job's bodies back for its checks. While hidden they
   * are not alive, so a recycle can have shrunk bodies.count below them: grow it back (Phase 4: a
   * black hole committed in such a slot stayed live beyond `count`, invisible to the aim line and
   * the renderer, until a later allocation grew `count` past it and it appeared in front of the comet).
   */
  function showTentative() {
    const b = world.bodies;
    for (let k = 0; k < nHidden; k++) {
      const i = HID[k];
      b.alive[i] = 1;
      if (i + 1 > b.count) b.count = i + 1;
    }
    nHidden = 0;
  }

  /**
   * A rejected try leaves the world at once (the next try rewrites the slot), so a body that broke
   * the spacing rules is never live across a step. Only tries under their window check are.
   * @param {number} i
   */
  function hideTry(i) {
    world.bodies.alive[i] = 0;
  }

  /**
   * Drop a job whose anchor was recycled under it (the comet fell thousands of units behind the
   * course and the front caught up): free what it had not committed.
   */
  function abandonJob() {
    const b = world.bodies;
    if (st === ST_PATH_TRY || st === ST_PATH_CHECK || st === ST_FB_TRY || st === ST_FB_CHECK) {
      if (jpartner >= 0 && b.alive[jpartner]) freeBody(jpartner);
      if (b.alive[jslot]) freeBody(jslot);
    } else if (st === ST_SIDE_TRY || st === ST_SIDE_CHECK || st === ST_BH_TRY || st === ST_BH_CHECK) {
      if (b.alive[xslot]) freeBody(xslot);
    }
    st = ST_IDLE; gen.busy = false;
  }

  /** @param {number} seed */
  function reset(seed) {
    rng.setState(hash32((seed >>> 0) ^ 0x51f15e5));
    nextId = 1;
    lineId = 0;
    bhPending = 0;
    st = ST_IDLE; gen.busy = false; nHidden = 0;
    const b = world.bodies, m = world.motes;
    b.alive.fill(0); b.count = 0;
    m.alive.fill(0); m.count = 0;
    recentSlot.fill(-1);
    sideSlot.fill(-1); sideHead = 0;
    OVR.fill(0);
    gen.pathCount = 0; gen.rerolls = 0; gen.fallbacks = 0; gen.urgent = 0;
    const slot = allocBody(-1);
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
  function update(maxPlacements) {
    const b = world.bodies, m = world.motes;
    const limit = world.front.y - RECYCLE_BELOW;
    for (let i = 0; i < b.count; i++) {
      if (!b.alive[i]) continue;
      const top = b.y[i] + (b.rc[i] > b.r[i] ? b.rc[i] : b.r[i]);
      if (top < limit) freeBody(i);
    }
    for (let i = 0; i < m.count; i++) if (m.alive[i] && m.y[i] < limit) freeMote(i);
    if (!gen.enabled) return;
    showTentative();
    if (st !== ST_IDLE && !b.alive[ja]) abandonJob();
    let y = world.comet.y;
    if (world.score.maxHeight > y) y = world.score.maxHeight;
    const target = y + CONFIG.GENERATE_AHEAD;
    const sync = maxPlacements !== undefined;
    prepped = 0;
    const most = sync ? maxPlacements : 0x3fffffff;
    // Catch-up: more work per step while the course ahead runs short (deterministic: positions only).
    let budget = STEP_BUDGET;
    const ahead = topY - y;
    if (ahead < CONFIG.GEN_CATCHUP_AHEAD) {
      let f = (CONFIG.GEN_CATCHUP_AHEAD - ahead) / (CONFIG.GEN_CATCHUP_AHEAD - CONFIG.GEN_URGENT_AHEAD);
      if (f > 1) f = 1;
      budget = Math.floor(STEP_BUDGET * (1 + (CONFIG.GEN_CATCHUP_MAX - 1) * f));
    }
    BUD[0] = sync ? Infinity : budget;
    for (let placed = 0; ;) {
      if (st === ST_IDLE) {
        if (placed >= most || topY >= target || !startPath()) break;
      }
      // The course ends too close above the comet: finish this placement now, whatever it costs.
      if (!sync && BUD[0] !== Infinity && topY < y + CONFIG.GEN_URGENT_AHEAD) { BUD[0] = Infinity; gen.urgent++; }
      if (!runJob()) break;
      placed++;
      if (!sync && BUD[0] === Infinity) break;
    }
    gen.work = BUD[0] === Infinity ? -1 : budget - BUD[0];
    hideTentative();
  }

  return gen;
}
