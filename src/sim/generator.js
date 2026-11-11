// @ts-check
/**
 * Level generation (PLAN.md §2.6): seeded (mulberry32), chunked ahead of the comet, recycles
 * bodies and motes below the collapse front, enforces the solvability rule. Pure and
 * allocation-free after creation. Owned by stream A.
 *
 * Path planets are placed one at a time. Each placement is re-rolled (up to SOLVE_MAX_TRIES)
 * until it keeps the body spacing rules and every recent consecutive path pair still has a clear
 * release window (both orbit directions, since the player's direction depends on the approach;
 * on the mid-band orbit the rule names and on the outer orbit where armed holds latch).
 * After that a deterministic safe fallback is used. Optional side planets and stardust lines are
 * added afterwards and validated the same way.
 *
 * Phase 3 hook: `decoratePath` / `placeHazards` are where zone 2-5 elements (moons, drifting,
 * black holes, binaries — contracts.js BODY/BODY_FLAG and m0..m4) slot in. The solvability ray
 * test already treats every non-endpoint body as an obstacle (rings and black-hole influence
 * radii are kept clear too).
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { createRng, hash32 } from '../core/rng.js';
import { rayCircleHit, OUT, TAU } from '../core/math.js';
import { zoneOfPathIndex, captureBand, solveWindowDeg, pathSpacingMax } from './scoring.js';

/** @typedef {import('../contracts.js').WorldT} WorldT */

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
/** Placements per update() call (spreads work; reset fills the whole lookahead at once). */
const PLACEMENTS_PER_UPDATE = 2;

// ---------------------------------------------------------------- scratch (allocated once)
const N = CONFIG.SOLVE_RAY_SAMPLES;
const COS = new Float64Array(N);
const SIN = new Float64Array(N);
for (let i = 0; i < N; i++) { COS[i] = Math.cos((TAU * i) / N); SIN[i] = Math.sin((TAU * i) / N); }
const OK = new Uint8Array(N);
/** WIN[0] = widest window (deg), WIN[1] = its centre angle (rad). */
const WIN = new Float64Array(2);
/** RAYG[0..3] = ray origin x, y and unit direction x, y for rayOk. Doubles go through memory
 * because computed doubles passed as call arguments to a non-inlined function are boxed. */
const RAYG = new Float64Array(4);
/** PL[0..3] = x, y, r, rc for writePlanet (same reason). */
const PL = new Float64Array(4);
/** Scale for rng.u30() → [0, 1). The generator uses u30 (a Smi) so random draws never box. */
const U30 = 1 / 1073741824;

/**
 * Is the straight ray RAYG (origin, unit direction) a fair release onto B? It must enter B's
 * ring, stay inside the walls until then, and keep SOLVE_CLEARANCE from every other body's surface
 * without entering any other capture ring / influence radius first.
 * @param {WorldT} w @param {number} a @param {number} bi
 */
function rayOk(w, a, bi) {
  const b = w.bodies;
  const px = RAYG[0], py = RAYG[1], dx = RAYG[2], dy = RAYG[3];
  // Entry into B's (slightly shrunk) ring, inlined ray-circle.
  const fx = px - b.x[bi], fy = py - b.y[bi], rB = b.rc[bi] - SOLVE_RING_MARGIN;
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
  const clr = CONFIG.SOLVE_CLEARANCE;
  for (let k = 0, n = b.count; k < n; k++) {
    if (!b.alive[k] || k === a || k === bi) continue;
    let need = b.r[k] + clr;
    if (b.rc[k] > need) need = b.rc[k];
    // Segment-point distance, inlined: a helper call V8 does not inline boxes its double args.
    const ex = b.x[k] - px, ey = b.y[k] - py;
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
 * orbit (outer = 0) or outer orbit (outer = 1). Writes WIN: width in degrees (conservative:
 * (samples - 1) × step) and centre angle.
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} dir @param {number} outer
 */
function scanWindow(w, a, bi, dir, outer) {
  const b = w.bodies, ax = b.x[a], ay = b.y[a];
  const rho = outer ? b.rc[a] - SOLVE_OUTER_INSET : (b.r[a] + b.rc[a]) * 0.5;
  for (let i = 0; i < N; i++) {
    const c = COS[i], s = SIN[i];
    RAYG[0] = ax + rho * c; RAYG[1] = ay + rho * s; RAYG[2] = -s * dir; RAYG[3] = c * dir;
    OK[i] = rayOk(w, a, bi) ? 1 : 0;
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

/**
 * Both orbit directions of pair A→B have a window of at least the zone's SOLVE_WINDOW_DEG.
 * @param {WorldT} w @param {number} a @param {number} bi @param {number} zone
 */
function pairSolvable(w, a, bi, zone) {
  const req = solveWindowDeg(zone);
  for (let outer = 0; outer < 2; outer++) {
    scanWindow(w, a, bi, 1, outer);
    if (WIN[0] < req) return false;
    scanWindow(w, a, bi, -1, outer);
    if (WIN[0] < req) return false;
  }
  return true;
}

/**
 * Solvability check for a consecutive path pair A→B (slot indices) at the current world time.
 * Returns the widest clear release window in degrees on A's mid-band orbit, taking the smaller of
 * the clockwise and counter-clockwise windows (0 if none).
 * @param {WorldT} world @param {number} a @param {number} b
 * @returns {number}
 */
export function releaseWindowDeg(world, a, b) {
  scanWindow(world, a, b, 1, 0);
  const ccw = WIN[0];
  if (ccw <= 0) return 0;
  scanWindow(world, a, b, -1, 0);
  return WIN[0] < ccw ? WIN[0] : ccw;
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

  /** @type {Generator} */
  const gen = {
    reset, update, enabled: opts.enabled !== false, pathCount: 0, slotOfPath, rerolls: 0, fallbacks: 0,
  };

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

  /** @param {number} i */
  function freeBody(i) {
    const b = world.bodies;
    b.alive[i] = 0;
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

  /** Remove motes overlapping body i. @param {number} i */
  function clearMotesAround(i) {
    const b = world.bodies, m = world.motes;
    const rr = b.r[i] + CONFIG.MOTE_RADIUS;
    for (let k = 0; k < m.count; k++) {
      if (!m.alive[k]) continue;
      const dx = m.x[k] - b.x[i], dy = m.y[k] - b.y[i];
      if (dx * dx + dy * dy < rr * rr) freeMote(k);
    }
  }

  /** Body i keeps its surface out of every other ring and vice versa. @param {number} i */
  function spacingOk(i) {
    const b = world.bodies;
    for (let k = 0, n = b.count; k < n; k++) {
      if (k === i || !b.alive[k]) continue;
      const dx = b.x[k] - b.x[i], dy = b.y[k] - b.y[i];
      let need = b.rc[i] + b.r[k];
      const n2 = b.rc[k] + b.r[i];
      if (n2 > need) need = n2;
      need += BODY_GAP;
      if (dx * dx + dy * dy < need * need) return false;
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
      if (!pairSolvable(world, sa, sb, b.zone[sb])) return false;
    }
    return true;
  }

  /** Like slotOfPath but also sees the planet currently being placed (pathCount not yet bumped). @param {number} p */
  function slotOfPathRaw(p) {
    if (p !== gen.pathCount) return slotOfPath(p);
    const s = recentSlot[p % RECENT];
    return s >= 0 && world.bodies.alive[s] ? s : -1;
  }

  /** Kill side planets near height y (fallback). @param {number} y */
  function clearSidePlanets(y) {
    const b = world.bodies;
    for (let k = 0; k < b.count; k++) {
      if (b.alive[k] && b.pathIndex[k] < 0 && Math.abs(b.y[k] - y) < 2000) freeBody(k);
    }
  }

  /** Place the next path planet above the previous one. Returns false if the pool is full. */
  function placePath() {
    const p = gen.pathCount;
    const a = slotOfPathRaw(p - 1);
    if (a < 0) return false;
    const slot = allocBody();
    if (slot < 0) return false;
    const b = world.bodies;
    const ax = b.x[a], ay = b.y[a];
    const z = zoneOfPathIndex(p);
    const band = captureBand(z), smax = pathSpacingMax(z);
    const flags = rng.u30() * U30 < CONFIG.RINGED_FRACTION ? BODY_FLAG.RINGED : 0;
    const seed = hash32(rng.u30());
    recentSlot[p % RECENT] = slot;
    let placed = false;
    for (let t = 0; t < CONFIG.SOLVE_MAX_TRIES && !placed; t++) {
      const r = CONFIG.PLANET_R_MIN + (CONFIG.PLANET_R_MAX - CONFIG.PLANET_R_MIN) * rng.u30() * U30;
      const s = CONFIG.PATH_SPACING_MIN + (smax - CONFIG.PATH_SPACING_MIN) * rng.u30() * U30;
      let lo = ax - PATH_DX_FRACTION * s, hi = ax + PATH_DX_FRACTION * s;
      if (lo < CONFIG.PLANET_X_MIN) lo = CONFIG.PLANET_X_MIN;
      if (hi > CONFIG.PLANET_X_MAX) hi = CONFIG.PLANET_X_MAX;
      const x = lo + (hi - lo) * rng.u30() * U30, dx = x - ax;
      PL[0] = x; PL[1] = ay + Math.sqrt(s * s - dx * dx); PL[2] = r; PL[3] = r + band;
      writePlanet(slot, p, z, flags, seed);
      placed = spacingOk(slot) && pairsOk(p);
      if (!placed) gen.rerolls++;
    }
    if (!placed) gen.fallbacks++;
    for (let t = 0; t < 2 && !placed; t++) {
      // Plain safe placement: straight-ish up, toward the centre, medium planet.
      const x = ax + (CONFIG.FIELD_WIDTH * 0.5 - ax) * FALLBACK_TOWARD_CENTER, dx = x - ax;
      const s = FALLBACK_SPACING;
      PL[0] = x; PL[1] = ay + Math.sqrt(s * s - dx * dx); PL[2] = FALLBACK_R; PL[3] = FALLBACK_R + band;
      writePlanet(slot, p, z, flags, seed);
      placed = spacingOk(slot) && pairsOk(p);
      if (!placed) clearSidePlanets(ay);
    }
    commitId(slot);
    recentId[p % RECENT] = b.id[slot];
    clearMotesAround(slot);
    gen.pathCount = p + 1;
    topY = b.y[slot];
    decoratePath(slot, z);
    if (rng.u30() * U30 < SIDE_PLANET_CHANCE) placeSidePlanet(a, slot, z);
    if (rng.u30() * U30 < MOTE_LINE_CHANCE) placeMoteLine(a, slot);
    return true;
  }

  /**
   * Phase 3 hook: attach the zone's element (moons, drift, binary partner) to a path planet.
   * Phase 1 generates plain planets in every zone.
   * @param {number} _slot @param {number} _zone
   */
  function decoratePath(_slot, _zone) {}

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
    const flags = rng.u30() * U30 < CONFIG.RINGED_FRACTION ? BODY_FLAG.RINGED : 0;
    const seed = hash32(rng.u30());
    const W = CONFIG.FIELD_WIDTH;
    for (let t = 0; t < SIDE_TRIES; t++) {
      const r = SIDE_R_MIN + (SIDE_R_MAX - SIDE_R_MIN) * rng.u30() * U30;
      const y = b.y[a] + (b.y[bs] - b.y[a]) * (0.2 + 0.6 * rng.u30() * U30);
      const x = midX < W * 0.5
        ? W * 0.65 + (CONFIG.PLANET_X_MAX - W * 0.65) * rng.u30() * U30
        : CONFIG.PLANET_X_MIN + (W * 0.35 - CONFIG.PLANET_X_MIN) * rng.u30() * U30;
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
   * A short line of motes along the centre ray of a release window A→B (random orbit direction).
   * @param {number} a @param {number} bs
   */
  function placeMoteLine(a, bs) {
    const b = world.bodies;
    const dir = rng.u30() * U30 < 0.5 ? 1 : -1;
    const span = CONFIG.MOTES_PER_LINE_MAX - CONFIG.MOTES_PER_LINE_MIN + 1;
    const want = CONFIG.MOTES_PER_LINE_MIN + Math.floor(rng.u30() * U30 * span);
    const rho = (b.r[a] + b.rc[a]) * 0.5;
    scanWindow(world, a, bs, dir, 0);
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
      const i = allocMote();
      if (i < 0) return;
      PL[0] = x; PL[1] = y;
      writeMote(i, line, order++);
    }
  }

  /** @param {number} seed */
  function reset(seed) {
    rng.setState(hash32((seed >>> 0) ^ 0x51f15e5));
    nextId = 1;
    lineId = 0;
    const b = world.bodies, m = world.motes;
    b.alive.fill(0); b.count = 0;
    m.alive.fill(0); m.count = 0;
    recentSlot.fill(-1);
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
