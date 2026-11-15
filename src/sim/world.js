// @ts-check
/**
 * The world: all simulation state and the fixed-step update (PLAN.md §2.1–2.3). PURE — no window,
 * document, performance, Date or Math.random. Runs unchanged under Node. Allocation-free per step:
 * all scratch is module-level typed arrays; sim-internal per-slot state is keyed by body id so
 * recycled slots never inherit stale flags.
 */
import { CONFIG, STEP } from '../config.js';
import { BODY, COMET, MODE, EV, COMBO_BREAK_REASON, DEATH_CAUSE } from '../contracts.js';
import { createEventQueue, clearEvents, pushEvent } from '../core/events.js';
import { rayCircleHit, OUT, TAU, DEG } from '../core/math.js';
import { createGenerator } from './generator.js';
import { updateBodyMotion, blackHoleAccel, blackHoleAccelAt, BHQ, posAt, envelopeOf, partnerOf, maxSpeedOf, MT, MP, ENV, VS, MOVING_FLAGS } from './hazards.js';
import { comboUp, comboBreak, reachPath, updateHeight } from './scoring.js';

/** @typedef {import('../contracts.js').WorldT} WorldT */
/** @typedef {import('../contracts.js').SimInput} SimInput */
/** @typedef {import('./generator.js').Generator} Generator */

// ---------------------------------------------------------------- module-local tuning
// Aliases of config.js values (every gameplay number lives in config.js).
/** The aim ray can light a target ring up to this far away (the drawn line stays AIM_LINE_LENGTH). */
const AIM_TARGET_RANGE = CONFIG.AIM_TARGET_RANGE;
/** Aim assist only considers rings whose centre is within this distance. @type {number} */
const AIM_ASSIST_RANGE = CONFIG.AIM_TARGET_RANGE;
/** The aim only counts a ring as a clean target if the ray gets this far inside it. */
const AIM_RING_MARGIN = CONFIG.AIM_RING_MARGIN;
/** Swept armed latches place the comet this far inside the ring edge. */
const LATCH_EPSILON = CONFIG.LATCH_EPSILON;
/** A near-miss pass ends when the comet is this much farther than NEAR_MISS_DISTANCE away. */
const NEAR_MISS_HYSTERESIS = CONFIG.NEAR_MISS_HYSTERESIS;

// ---------------------------------------------------------------- scratch (allocated once)
/** AIM[0..1] = aim direction (after assist), AIM[2] = drawn length. */
const AIM = new Float64Array(3);
/** Aliases read once (hot aim code: see castAim). */
const AIM_LINE_LENGTH = CONFIG.AIM_LINE_LENGTH, COMET_RADIUS = CONFIG.COMET_RADIUS;
const WALL_LO = CONFIG.WALL_MARGIN, WALL_HI = CONFIG.FIELD_WIDTH - CONFIG.WALL_MARGIN;
/** Moving bodies are checked against the aim ray at their predicted positions this often (units). */
const AIM_MARCH_STEP = CONFIG.AIM_MARCH_STEP;
/** RAY[0..3] = origin x, y and unit direction x, y for castAim; RAY[4] = comet speed, RAY[5] =
 * world time at which the comet is at the origin (doubles passed through memory: passing computed
 * doubles as call arguments to a function V8 does not inline boxes them). */
const RAY = new Float64Array(6);
/** castAim's moving-body pass state: MV[0] hit distance, MV[1] ring entry, MV[2] deep point, MV[3] march limit. */
const MV = new Float64Array(4);
/** Black-hole acceleration out-param. */
const ACC = new Float64Array(2);
/** The aim forecast's black-hole acceleration out-param. */
const ACC2 = new Float64Array(2);
/** Aim path being built by castAim: vertices as (x, y) offsets from its origin (PATH_O), PATH_N[0]
 * of them. computeAim copies the final one into world.aim.points. */
const AIM_PATH_MAX = CONFIG.AIM_PATH_MAX_POINTS;
const PATH = new Float32Array(2 * AIM_PATH_MAX);
const PATH_N = new Int32Array(1);
const PATH_O = new Float64Array(2);
/** castAim's release time (world time at the cast origin), for latchSafe. */
const CAST_T0 = new Float64Array(1);
/** Binary partner of the orbited planet while castAim is on its first straight leg, else -1: its
 * ring is not a target (not progress, and a press does not latch it on that flight), its body is
 * an obstacle like any other. */
const AIMP = new Int32Array(1);
/** pushPath input: the vertex's absolute position. */
const PV = new Float64Array(2);
/**
 * Bent-flight forecast state (castAim / marchBent): MS[0..1] position, MS[2..3] velocity, MS[4]
 * speed, MS[5] world time (exactly as free flight would have them at a step boundary), MS[6] arc
 * length flown since the release, MS[7] closest comet-to-core surface distance seen.
 */
const MS = new Float64Array(8);
/** castStraight results: LEG[0] = distance along the leg to the first hit (body or influence-free
 * drawn end), LEG[1] = distance to the first black-hole influence entry (Infinity if none). */
const LEG = new Float64Array(2);
/** Slingshot depth scaling: SL[0] = closest approach to the hole's centre (in), SL[1] = paid fraction (out). */
const SL = new Float64Array(2);
const AIM_MIN_ENTRY_S = CONFIG.AIM_MIN_ENTRY_S, AIM_SAFE_PRESS_S = CONFIG.AIM_SAFE_PRESS_S;
const AIM_CORE_CLEARANCE = CONFIG.AIM_CORE_CLEARANCE;
const HASH_F64 = new Float64Array(1);
const HASH_U32 = new Uint32Array(HASH_F64.buffer);

/**
 * @typedef {Object} Sim  Sim-internal state that is not part of the WorldState contract.
 * @property {Generator} gen
 * @property {Uint32Array} caughtId   body id caught this run, per slot (0 = never).
 * @property {Uint32Array} nmId       body id the near-miss state belongs to, per slot.
 * @property {Uint8Array} nmState     0 idle, 1 inside the near-miss distance, 2 reported / suppressed.
 * @property {Float64Array} nmMin     Closest surface distance in the current pass.
 * @property {Float64Array} nmX       Closest point on the surface in the current pass.
 * @property {Float64Array} nmY
 * @property {number} grazeAcc        Fractional graze points not yet added.
 * @property {number} streakLine      Mote line of the last pickup (-1 none).
 * @property {number} streakIdx       Pickups so far in that line.
 * @property {boolean} lapBroken      COMBO_BREAK_LAPS already applied on this planet.
 * @property {boolean} leftInside     Not yet clear of the ring of the planet just left (slot leftSlot):
 *                                    a press does not re-catch it unless the comet heads back in.
 * @property {number} leftSlot
 * @property {number} relDx           Unit flight direction at the last release (ignoreLeft).
 * @property {number} relDy
 * @property {number} bhId            id of the black hole whose influence the comet is in (0 none).
 * @property {number} bhSlot
 * @property {number} bhMin           Closest distance to that hole's centre in this pass.
 * @property {boolean} queued         Pre-start: a release happened while the aim line was dark; the
 *                                    comet lets go at the first step the line is lit (a new hold cancels).
 * @property {number} passSlot        Binary partner of the planet just left, after a release on a lit
 *                                    line (-1 otherwise): not latchable while the comet still flies
 *                                    straight along that line (the line looked past its ring).
 * @property {number} passId          bodies.id of passSlot.
 * @property {number} lastPress       w.time of the last press in free flight (a brace if a hit follows within BRACE_WINDOW_S).
 * @property {number} impactT0        w.time the current brace window opened.
 * @property {number} impactSlot      Body hit (slot and id), and the DEATH_CAUSE if the window closes unbraced.
 * @property {number} impactId
 * @property {number} impactCause
 */

/** @returns {import('../contracts.js').Bodies} */
export function createBodies(cap = CONFIG.MAX_BODIES) {
  return {
    count: 0,
    alive: new Uint8Array(cap),
    id: new Uint32Array(cap),
    type: new Uint8Array(cap),
    flags: new Uint8Array(cap),
    x: new Float64Array(cap), y: new Float64Array(cap),
    px: new Float64Array(cap), py: new Float64Array(cap),
    r: new Float32Array(cap), rc: new Float32Array(cap),
    seed: new Uint32Array(cap),
    zone: new Uint8Array(cap),
    pathIndex: new Int32Array(cap),
    parent: new Int32Array(cap),
    m0: new Float64Array(cap), m1: new Float64Array(cap), m2: new Float64Array(cap),
    m3: new Float64Array(cap), m4: new Float64Array(cap),
  };
}

/** @returns {import('../contracts.js').Motes} */
export function createMotes(cap = CONFIG.MAX_MOTES) {
  return {
    count: 0,
    alive: new Uint8Array(cap),
    x: new Float64Array(cap), y: new Float64Array(cap),
    line: new Uint16Array(cap),
    order: new Uint8Array(cap),
  };
}

/**
 * @param {{ seed?: number, mode?: string, generate?: boolean }} [opts]
 *   `generate: false` keeps only the home planet (rule tests build their own layouts).
 * @returns {WorldT}
 */
export function createWorld(opts = {}) {
  /** @type {Sim} */
  let sim;
  /** @type {WorldT} */
  const world = {
    seed: 0,
    mode: MODE.ENDLESS,
    time: 0,
    steps: 0,
    started: false,
    dead: false,
    deathTime: -1,
    baseSpeed: CONFIG.BASE_SPEED_START,
    comet: {
      x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, speed: 0, heading: 0,
      state: COMET.ORBIT, body: -1, bodyId: 0, lastBodyId: 0,
      orbitRadius: 0, orbitDir: 1, orbitAngle: 0, laps: 0, altitude: Infinity,
      armed: false, grazing: false, wasHeld: false, size: 1, impact: -1,
    },
    bodies: createBodies(),
    motes: createMotes(),
    aim: {
      active: false, x0: 0, y0: 0, dx: 0, dy: 1, length: 0, target: -1, clear: false,
      points: new Float32Array(2 * CONFIG.AIM_PATH_MAX_POINTS), pointCount: 0,
    },
    front: { y: 0, py: 0, speed: 0 },
    score: {
      score: 0, combo: 0, bestCombo: 0, tier: 1, multiplier: 1, zone: 1,
      maxHeight: 0, catches: 0, perfects: 0, pathReached: 0,
    },
    events: createEventQueue(),
    step: (dt, input) => step(world, sim, dt, input),
    reset: (seed, mode) => reset(world, sim, seed, mode),
    hash: () => hashWorld(world),
  };
  const cap = CONFIG.MAX_BODIES;
  sim = {
    gen: createGenerator(world, { enabled: opts.generate !== false }),
    caughtId: new Uint32Array(cap),
    nmId: new Uint32Array(cap),
    nmState: new Uint8Array(cap),
    nmMin: new Float64Array(cap),
    nmX: new Float64Array(cap),
    nmY: new Float64Array(cap),
    grazeAcc: 0, streakLine: -1, streakIdx: 0, lapBroken: false,
    leftInside: false, leftSlot: -1, bhId: 0, bhSlot: -1, bhMin: 0, queued: false, relDx: 0, relDy: 1,
    passSlot: -1, passId: 0,
    lastPress: -Infinity, impactT0: 0, impactSlot: -1, impactId: 0, impactCause: 0,
  };
  reset(world, sim, opts.seed ?? 1, opts.mode ?? MODE.ENDLESS);
  return world;
}

/** @param {WorldT} w @param {Sim} sim @param {number} seed @param {string} [mode] */
function reset(w, sim, seed, mode) {
  w.seed = seed >>> 0;
  if (mode) w.mode = mode;
  w.time = 0; w.steps = 0; w.started = false; w.dead = false; w.deathTime = -1;
  w.baseSpeed = CONFIG.BASE_SPEED_START;
  clearEvents(w.events);
  sim.caughtId.fill(0); sim.nmId.fill(0); sim.nmState.fill(0);
  sim.grazeAcc = 0; sim.streakLine = -1; sim.streakIdx = 0; sim.lapBroken = false;
  sim.leftInside = false; sim.leftSlot = -1; sim.bhId = 0; sim.bhSlot = -1; sim.bhMin = 0; sim.queued = false;
  sim.passSlot = -1; sim.passId = 0;
  const s = w.score;
  s.score = 0; s.combo = 0; s.bestCombo = 0; s.tier = 1; s.multiplier = 1; s.zone = 1;
  s.maxHeight = 0; s.catches = 0; s.perfects = 0; s.pathReached = 0;

  sim.gen.reset(w.seed);
  const b = w.bodies;
  sim.caughtId[0] = b.id[0];
  const c = w.comet;
  c.state = COMET.ORBIT; c.body = 0; c.bodyId = b.id[0]; c.lastBodyId = 0;
  c.orbitRadius = (b.r[0] + b.rc[0]) * 0.5; c.orbitDir = 1; c.orbitAngle = -Math.PI * 0.5;
  c.laps = 0; c.armed = false; c.grazing = false; c.wasHeld = false;
  c.size = 1; c.impact = -1;
  sim.lastPress = -Infinity; sim.impactSlot = -1; sim.impactId = 0;
  c.speed = w.baseSpeed;
  placeOnOrbit(w);
  c.px = c.x; c.py = c.y;
  // PLAN §2.2: the front starts FRONT_START_BELOW under the comet (re-anchored at the first release).
  w.front.y = w.front.py = c.y - CONFIG.FRONT_START_BELOW; w.front.speed = 0;
  sim.gen.update(1000);
  computeAim(w);
}

/** Put the comet on its orbit and set velocity, heading and altitude. @param {WorldT} w */
function placeOnOrbit(w) {
  const c = w.comet, b = w.bodies, i = c.body;
  const ca = Math.cos(c.orbitAngle), sa = Math.sin(c.orbitAngle);
  c.x = b.x[i] + ca * c.orbitRadius;
  c.y = b.y[i] + sa * c.orbitRadius;
  c.vx = -sa * c.orbitDir * c.speed; c.vy = ca * c.orbitDir * c.speed;
  c.heading = Math.atan2(c.vy, c.vx);
  c.altitude = c.orbitRadius - b.r[i];
}

/**
 * Advance one fixed step.
 * @param {WorldT} w @param {Sim} sim @param {number} dt @param {SimInput} input
 */
function step(w, sim, dt, input) {
  w.time += dt; w.steps++;
  const c = w.comet, b = w.bodies;
  c.px = c.x; c.py = c.y;
  for (let i = 0, n = b.count; i < n; i++) { b.px[i] = b.x[i]; b.py[i] = b.y[i]; }
  w.front.py = w.front.y;
  updateBodyMotion(w);

  const held = input.held;
  const pressed = input.pressedThisStep || (held && !c.wasHeld);
  const released = input.releasedThisStep || (!held && c.wasHeld);
  c.wasHeld = held;

  if (!w.dead) {
    if (c.state === COMET.FREE && c.impact >= 0) {
      // Brace window: the comet sits at the contact point, moving with the body it hit; a press
      // braces, otherwise it dies once the window has passed (exactly BRACE_WINDOW_S: closing is
      // checked before the press).
      c.impact = w.time - sim.impactT0;
      const k = sim.impactSlot;
      const there = k >= 0 && b.alive[k] === 1 && b.id[k] === sim.impactId;
      if (there) { c.x += b.x[k] - b.px[k]; c.y += b.y[k] - b.py[k]; c.px = c.x; c.py = c.y; }
      if (!there) c.impact = -1;                       // body recycled: fly on
      else if (c.impact > CONFIG.BRACE_WINDOW_S + 1e-9) {
        c.impact = -1;
        die(w, sim.impactCause, k);
      } else if (pressed) brace(w, sim);
    } else if (c.state === COMET.FREE && pressed) {
      // A press in free flight latches at once inside a ring, otherwise arms the hold.
      sim.lastPress = w.time;
      if (!tryLatch(w, sim, true)) c.armed = true;
    }

    if (c.state === COMET.ORBIT) {
      if (!w.started) {
        // The first act is a safe release (PLAN §2.7): a release while the aim line is not lit onto
        // a path planet ahead is queued, and the comet lets go at the first step it is — exactly
        // along the line the player sees (world.aim is from the end of the previous step, at this
        // position). Holding again cancels it. (Side planets are not lit targets here: they need
        // not have a way on up the course.)
        if (held) sim.queued = false;
        else if (released) sim.queued = true;
        const a = w.aim;
        if (sim.queued && a.active && a.clear && b.pathIndex[a.target] > b.pathIndex[c.body]) release(w, sim);
        else advanceOrbit(w, sim, dt, false);
      } else if (!held) release(w, sim);
      else advanceOrbit(w, sim, dt, true);
    }

    if (c.state === COMET.FREE && c.impact < 0) {
      if (!held) c.armed = false;
      advanceFree(w, sim, dt);
    }

    if (!w.dead && w.started) {
      pickMotes(w, sim);
      updateFront(w, sim, dt);
    }
    if (!w.dead && w.started) updateHeight(w);
  }
  computeAim(w);
  sim.gen.update();
}

// ================================================================ orbit

/**
 * @param {WorldT} w @param {Sim} sim @param {number} dt
 * @param {boolean} live  false before the run starts: no decay, no speed gain, no graze/laps.
 */
function advanceOrbit(w, sim, dt, live) {
  const c = w.comet, b = w.bodies, i = c.body;
  // Body recycled under us (cannot happen while the comet is above the front): let go.
  if (!b.alive[i] || b.id[i] !== c.bodyId) { release(w, sim); return; }
  if (live) {
    c.orbitRadius -= (CONFIG.ORBIT_DECAY_BASE + CONFIG.ORBIT_DECAY_PER_LAP * c.laps) * dt;
    const cap = w.baseSpeed * CONFIG.SPEED_CAP_FACTOR;
    if (c.speed < cap) {
      c.speed *= 1 + CONFIG.ORBIT_SPEED_GAIN * dt;
      if (c.speed > cap) c.speed = cap;
    }
  }
  const radius = c.orbitRadius > 1 ? c.orbitRadius : 1;
  const dAng = (c.speed / radius) * dt;
  let ang = c.orbitAngle + c.orbitDir * dAng;
  if (ang > Math.PI) ang -= TAU; else if (ang < -Math.PI) ang += TAU;
  c.orbitAngle = ang;
  placeOnOrbit(w);
  if (!live) return;
  c.laps += dAng / TAU;
  if (c.altitude < CONFIG.CRASH_ALTITUDE) { die(w, DEATH_CAUSE.PLANET, i); return; }
  // Anything the orbit runs into: in practice a moon of this planet whose lane the decaying orbit
  // has reached (relative motion per step is far below the smallest hit radius, so a point test is enough).
  for (let k = 0, n = b.count; k < n; k++) {
    if (!b.alive[k] || k === i) continue;
    const rr = b.r[k] + CONFIG.COMET_RADIUS;
    const dx = c.x - b.x[k], dy = c.y - b.y[k];
    if (dx * dx + dy * dy < rr * rr) { die(w, deathCause(b.type[k]), k); return; }
  }
  if (c.altitude < CONFIG.GRAZE_ALTITUDE) {
    if (!c.grazing) { c.grazing = true; pushEvent(w.events, EV.GRAZE, c.x, c.y, 1, 0); }
    sim.grazeAcc += CONFIG.POINTS_GRAZE_PER_S * w.score.multiplier * dt;
    if (sim.grazeAcc >= 1) {
      const whole = Math.floor(sim.grazeAcc);
      w.score.score += whole;
      sim.grazeAcc -= whole;
    }
  } else if (c.grazing) endGraze(w);
  if (!sim.lapBroken && c.laps >= CONFIG.COMBO_BREAK_LAPS) {
    sim.lapBroken = true;
    comboBreak(w, COMBO_BREAK_REASON.LAPS);
  }
}

/** @param {WorldT} w */
function endGraze(w) {
  const c = w.comet;
  c.grazing = false;
  pushEvent(w.events, EV.GRAZE, c.x, c.y, 0, 0);
}

/**
 * Latch into the ring the comet is inside, if any. Prefers any ring other than the planet just
 * left (so pressing where two rings overlap catches the new one), then the most central.
 * @param {WorldT} w @param {Sim} sim @param {boolean} isPress  true for a press (perfect possible), false for an armed latch.
 */
function tryLatch(w, sim, isPress) {
  const c = w.comet, b = w.bodies;
  let best = -1, bestScore = Infinity;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.PLANET || b.rc[i] <= 0) continue;
    if (ignoreLeft(w, sim, i)) continue;
    const dx = c.x - b.x[i], dy = c.y - b.y[i];
    const rc = b.rc[i];
    const d2 = dx * dx + dy * dy;
    if (d2 >= rc * rc) continue;
    // A press this close to the surface would latch an orbit that crashes at once: it is a brace
    // (the swept hit that follows opens the impact with this press inside BRACE_WINDOW_S).
    if (isPress && Math.sqrt(d2) - b.r[i] < CONFIG.CRASH_ALTITUDE + 2) continue;
    const score = Math.sqrt(d2) / rc + (b.id[i] === c.lastBodyId ? 10 : 0);
    if (score < bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return false;
  latch(w, sim, best, isPress);
  return true;
}

/**
 * While the comet is still inside the ring of the planet it just left (or within
 * LEFT_RING_CLEAR outside it) and moving away from it, that ring cannot be latched (a press arms
 * the hold for the next ring instead). Once it is clear of the ring, or if it heads back in
 * (after a bounce or a black-hole bend), re-catching is possible and resets the combo (PLAN.md
 * §2.3). The margin matters for drifting planets: a comet leaving tangentially from the ring edge
 * can hover at the edge while the planet drifts after it.
 * Binary pairs (Phase 4): after a release on a lit line from one member, the partner's ring (which
 * the line looked past, see castAim) cannot be latched until the flight changes direction, so a
 * press on the way arms the hold for the lit ring. After a dark release it is catchable as usual
 * (no new planet: see latch).
 * @param {WorldT} w @param {Sim} sim @param {number} i
 */
function ignoreLeft(w, sim, i) {
  if (i === sim.passSlot) return w.bodies.id[i] === sim.passId && flyingStraight(w, sim);
  if (!sim.leftInside || i !== sim.leftSlot) return false;
  const c = w.comet, b = w.bodies;
  // Velocity relative to the planet (a drifting or binary planet moves too), as one step's motion.
  const rvx = c.vx * STEP - (b.x[i] - b.px[i]), rvy = c.vy * STEP - (b.y[i] - b.py[i]);
  // Still flying straight along the release line: never "heading back in", even though an
  // aim-assisted release (turned up to AIM_ASSIST_DEG toward the target) can start slightly inward
  // (Phase 4: a quick re-press after an assisted release used to re-latch the planet just left —
  // e.g. home, right after the first fling). Only a bounce, a black-hole bend or another change of
  // direction makes a re-catch possible.
  if (flyingStraight(w, sim)) return true;
  return (c.x - b.x[i]) * rvx + (c.y - b.y[i]) * rvy >= 0;
}

/** Is the comet still flying along the line it was released on (no bounce or bend since)?
 * @param {WorldT} w @param {Sim} sim */
function flyingStraight(w, sim) {
  const c = w.comet;
  return c.speed > 0 && (c.vx * sim.relDx + c.vy * sim.relDy) / c.speed >= 1 - 1e-9;
}

/** @param {number} ty BODY.* */
function deathCause(ty) {
  return ty === BODY.MOON ? DEATH_CAUSE.MOON : ty === BODY.BLACKHOLE ? DEATH_CAUSE.BLACKHOLE : DEATH_CAUSE.PLANET;
}

/** @param {WorldT} w @param {Sim} sim @param {number} i @param {boolean} isPress */
function latch(w, sim, i, isPress) {
  const c = w.comet, b = w.bodies, s = w.score;
  sim.lastPress = -Infinity;   // that press caught a planet: it cannot also brace a later hit
  const rx = c.x - b.x[i], ry = c.y - b.y[i];
  let d = Math.sqrt(rx * rx + ry * ry);
  if (d < 1e-6) d = 1e-6;
  const cross = rx * c.vy - ry * c.vx;
  const radial = (rx * c.vx + ry * c.vy) / d;
  const perfect = isPress && Math.abs(radial) < CONFIG.PERFECT_RADIAL_FRACTION * c.speed;
  c.state = COMET.ORBIT;
  c.body = i; c.bodyId = b.id[i];
  c.orbitRadius = d;
  c.orbitDir = cross >= 0 ? 1 : -1;
  c.orbitAngle = Math.atan2(ry, rx);
  c.laps = 0; c.armed = false;
  placeOnOrbit(w);
  sim.lapBroken = false;
  sim.leftInside = false;
  sim.passSlot = -1;
  sim.bhId = 0; // latching inside an influence radius forfeits the slingshot
  sim.nmId[i] = b.id[i]; sim.nmState[i] = 2;

  const id = b.id[i];
  if (id === c.lastBodyId) {
    pushEvent(w.events, EV.LATCH, c.x, c.y, i, 0);
    comboBreak(w, COMBO_BREAK_REASON.RECATCH);
    return;
  }
  if (sim.caughtId[i] === id) {
    pushEvent(w.events, EV.LATCH, c.x, c.y, i, 0);
    return;
  }
  sim.caughtId[i] = id;
  // Either member of a binary pair catches that path step: the other one is no new planet after it
  // (no catch points, no combo change; and as the partner of the planet just left it does not count
  // as a re-catch either, so hopping across the pair never breaks the combo).
  const p = partnerOf(b, i);
  if (p >= 0) sim.caughtId[p] = b.id[p];
  const inc = perfect ? 2 : 1;
  pushEvent(w.events, EV.LATCH, c.x, c.y, i, s.combo + inc);
  comboUp(w, inc);
  s.score += CONFIG.POINTS_CATCH * s.multiplier;
  s.catches++;
  if (perfect) {
    const bonus = CONFIG.POINTS_PERFECT * s.multiplier;
    s.score += bonus;
    s.perfects++;
    pushEvent(w.events, EV.PERFECT, c.x, c.y, i, bonus);
  }
  // A zone change can raise the speed to the new base speed; reachPath rescales the velocity with it.
  if (b.pathIndex[i] > 0) reachPath(w, b.pathIndex[i]);
}

/** Leave the orbit along the (aim-assisted) tangent. @param {WorldT} w @param {Sim} sim */
function release(w, sim) {
  const c = w.comet, b = w.bodies;
  const left = c.body;
  const a = w.aim;
  let lit = false;
  if (a.active && a.x0 === c.x && a.y0 === c.y) {
    // The comet has not moved since the aim line was computed (end of the previous step): leave
    // exactly along the line the player saw. Re-solving would see moving bodies one step later
    // (aim assist aims at their current positions) and could flip a marginal window.
    c.vx = a.dx * c.speed; c.vy = a.dy * c.speed;
    lit = a.clear;
  } else {
    RAY[5] = w.time - STEP; // this step's motion starts from the orbit position of the previous step
    lit = solveAim(w) >= 0;
    c.vx = AIM[0] * c.speed; c.vy = AIM[1] * c.speed;
  }
  c.heading = Math.atan2(c.vy, c.vx);
  c.state = COMET.FREE;
  c.lastBodyId = c.bodyId;
  c.body = -1; c.bodyId = 0;
  c.altitude = Infinity; c.laps = 0; c.armed = false;
  if (c.grazing) endGraze(w);
  if (left >= 0) { sim.nmId[left] = b.id[left]; sim.nmState[left] = 2; }
  sim.leftInside = left >= 0 && b.alive[left] === 1;
  sim.leftSlot = left;
  sim.passSlot = lit && left >= 0 ? partnerOf(b, left) : -1;
  sim.passId = sim.passSlot >= 0 ? b.id[sim.passSlot] : 0;
  sim.relDx = c.vx / c.speed; sim.relDy = c.vy / c.speed;
  if (!w.started) {
    w.started = true;
    sim.queued = false;
    w.front.y = w.front.py = c.y - CONFIG.FRONT_START_BELOW;
    w.front.speed = CONFIG.FRONT_SPEED_START;
  }
  pushEvent(w.events, EV.RELEASE, c.x, c.y, c.speed, c.heading);
}

// ================================================================ free flight

/** @param {WorldT} w @param {Sim} sim @param {number} dt */
function advanceFree(w, sim, dt) {
  const c = w.comet, b = w.bodies;
  blackHoleAccel(w, ACC);
  if (ACC[0] !== 0 || ACC[1] !== 0) {
    c.vx += ACC[0] * dt; c.vy += ACC[1] * dt;
    c.speed = Math.sqrt(c.vx * c.vx + c.vy * c.vy);
  }
  c.x += c.vx * dt; c.y += c.vy * dt;

  // Armed hold: latch the instant the path enters a ring (swept, so fast comets cannot skip a
  // thin chord, and before any wall bounce in the same step).
  if (c.armed && latchSwept(w, sim)) return;

  // Walls. A comet that crossed the wall this step is reflected by its overshoot (at most one
  // step of travel). One that was already outside — released from an orbit that reaches past the
  // wall — only turns around where it is: mirroring that position would teleport it.
  const lo = CONFIG.WALL_MARGIN, hi = CONFIG.FIELD_WIDTH - CONFIG.WALL_MARGIN;
  if (c.x < lo && c.vx < 0) bounce(w, -1, c.px >= lo ? 2 * lo - c.x : c.x);
  else if (c.x > hi && c.vx > 0) bounce(w, 1, c.px <= hi ? 2 * hi - c.x : c.x);
  c.heading = Math.atan2(c.vy, c.vx);
  if (sim.leftInside) {
    const L = sim.leftSlot;
    if (L < 0 || !b.alive[L] || b.id[L] !== c.lastBodyId) sim.leftInside = false;
    else {
      const ex = c.x - b.x[L], ey = c.y - b.y[L], out = b.rc[L] + CONFIG.LEFT_RING_CLEAR;
      if (ex * ex + ey * ey >= out * out) sim.leftInside = false;
    }
  }

  // Swept collision against every body surface. Hot loop: geometry is inlined, because helper
  // calls V8 does not inline would box their double arguments (allocation per call).
  const ox = c.px, oy = c.py;
  const sx = c.x - ox, sy = c.y - oy;
  const len = Math.sqrt(sx * sx + sy * sy);
  const ux = len > 0 ? sx / len : 0, uy = len > 0 ? sy / len : 0;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i]) continue;
    const rr = b.r[i] + CONFIG.COMET_RADIUS;
    const ex = b.x[i] - ox, ey = b.y[i] - oy;
    let t = ex * ux + ey * uy;
    t = t < 0 ? 0 : t > len ? len : t;
    const qx = ux * t - ex, qy = uy * t - ey;
    if (qx * qx + qy * qy < rr * rr) {
      if (rayCircleHit(c.px, c.py, ux, uy, b.x[i], b.y[i], rr) && OUT[0] <= len) {
        c.x = c.px + ux * OUT[0]; c.y = c.py + uy * OUT[0];
      }
      impact(w, sim, deathCause(b.type[i]), i);
      return;
    }
  }

  // Near misses: report once per pass at the closest approach.
  const near = CONFIG.NEAR_MISS_DISTANCE;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i]) continue;
    if (sim.nmId[i] !== b.id[i]) { sim.nmId[i] = b.id[i]; sim.nmState[i] = 0; }
    const dx = c.x - b.x[i], dy = c.y - b.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);
    const d = dist - b.r[i];
    const st = sim.nmState[i];
    if (st === 0) {
      if (d < near) {
        sim.nmState[i] = 1; sim.nmMin[i] = d;
        sim.nmX[i] = b.x[i] + (dx / dist) * b.r[i]; sim.nmY[i] = b.y[i] + (dy / dist) * b.r[i];
      }
    } else if (st === 1) {
      if (d <= sim.nmMin[i]) {
        sim.nmMin[i] = d;
        sim.nmX[i] = b.x[i] + (dx / dist) * b.r[i]; sim.nmY[i] = b.y[i] + (dy / dist) * b.r[i];
      } else {
        pushEvent(w.events, EV.NEAR_MISS, sim.nmX[i], sim.nmY[i], i, sim.nmMin[i]);
        sim.nmState[i] = 2;
      }
    } else if (d > near + NEAR_MISS_HYSTERESIS) sim.nmState[i] = 0;
  }

  // Black-hole passes: entering an influence radius starts a pass; leaving it alive (in free
  // flight) pays the slingshot, scaled by how deep the pass went (PLAN §2.5). castAim's bent-path
  // forecast (marchBent) mirrors this block exactly.
  if (sim.bhId !== 0 && (!b.alive[sim.bhSlot] || b.id[sim.bhSlot] !== sim.bhId)) sim.bhId = 0;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.BLACKHOLE) continue;
    const dx = c.x - b.x[i], dy = c.y - b.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < b.rc[i]) {
      if (sim.bhId !== b.id[i]) { sim.bhId = b.id[i]; sim.bhSlot = i; sim.bhMin = d; }
      else if (d < sim.bhMin) sim.bhMin = d;
    } else if (sim.bhId !== 0 && sim.bhId === b.id[i]) { // 0 = no pass (never match an id-less slot)
      sim.bhId = 0;
      SL[0] = sim.bhMin;
      slingScale(b, i);
      slingshot(w, i);
    }
  }
}

/**
 * Fraction of the slingshot a pass through hole i pays, from its closest approach SL[0] to the
 * centre: BLACKHOLE_SLINGSHOT_MIN_SCALE at the influence edge, rising linearly to 1 at
 * BLACKHOLE_SLINGSHOT_DEPTH × influence and deeper. Writes SL[1].
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
function slingScale(b, i) {
  const rc = b.rc[i], lo = CONFIG.BLACKHOLE_SLINGSHOT_MIN_SCALE;
  const span = (1 - CONFIG.BLACKHOLE_SLINGSHOT_DEPTH) * rc;
  let q = span > 0 ? (rc - SL[0]) / span : 1;
  if (q > 1) q = 1; else if (q < 0) q = 0;
  SL[1] = lo + (1 - lo) * q;
}

/**
 * Survived a pass through black hole i's influence: bonus points and a speed boost, both scaled
 * by SL[1] (slingScale). @param {WorldT} w @param {number} i
 */
function slingshot(w, i) {
  const c = w.comet, s = w.score;
  const pts = Math.round(CONFIG.BLACKHOLE_SLINGSHOT_POINTS * s.multiplier * SL[1]);
  s.score += pts;
  let sp = c.speed * (1 + (CONFIG.BLACKHOLE_SPEED_BOOST - 1) * SL[1]);
  const cap = w.baseSpeed * CONFIG.SPEED_CAP_FACTOR * CONFIG.BLACKHOLE_SPEED_BOOST;
  if (sp > cap) sp = cap;
  if (sp > c.speed && c.speed > 0) {
    const k = sp / c.speed;
    c.vx *= k; c.vy *= k; c.speed = sp;
  }
  pushEvent(w.events, EV.SLINGSHOT, c.x, c.y, i, pts);
}

/**
 * Armed latch along this step's path (c.px,c.py)→(c.x,c.y): find the ring entered first, move the
 * comet to that entry point and latch there. Returns true if it latched.
 * @param {WorldT} w @param {Sim} sim
 */
function latchSwept(w, sim) {
  const c = w.comet, b = w.bodies;
  const sx = c.x - c.px, sy = c.y - c.py;
  const len = Math.sqrt(sx * sx + sy * sy);
  if (len <= 0) return tryLatch(w, sim, false);
  const ux = sx / len, uy = sy / len;
  const ox = c.px, oy = c.py;
  let best = -1, bestT = Infinity;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.PLANET || b.rc[i] <= 0) continue;
    if (ignoreLeft(w, sim, i)) continue;
    // Inlined ray-circle entry (see advanceFree).
    const fx = ox - b.x[i], fy = oy - b.y[i];
    const r = b.rc[i] - LATCH_EPSILON;
    const cc = fx * fx + fy * fy - r * r;
    let t = 0;
    // Already inside the ring and too close to the surface for an orbit: a brace, not a latch (tryLatch).
    if (cc <= 0 && Math.sqrt(fx * fx + fy * fy) - b.r[i] < CONFIG.CRASH_ALTITUDE + 2) continue;
    if (cc > 0) {
      const bb = fx * ux + fy * uy;
      if (bb > 0) continue;
      const disc = bb * bb - cc;
      if (disc < 0) continue;
      t = -bb - Math.sqrt(disc);
    }
    if (t <= len && t < bestT) { bestT = t; best = i; }
  }
  if (best < 0) return false;
  c.x = c.px + ux * bestT; c.y = c.py + uy * bestT;
  latch(w, sim, best, false);
  return true;
}

// ================================================================ brace

/**
 * Free flight hit body `slot`: brace at once if the player pressed within BRACE_WINDOW_S before,
 * otherwise stop at the contact point and open the brace window (step() resolves it).
 * @param {WorldT} w @param {Sim} sim @param {number} cause DEATH_CAUSE @param {number} slot
 */
function impact(w, sim, cause, slot) {
  const c = w.comet;
  sim.impactSlot = slot; sim.impactId = w.bodies.id[slot]; sim.impactCause = cause;
  sim.impactT0 = w.time;
  pushEvent(w.events, EV.IMPACT, c.x, c.y, cause, slot);
  if (w.time - sim.lastPress <= CONFIG.BRACE_WINDOW_S + 1e-9) { brace(w, sim); return; }
  c.impact = 0;
  c.armed = false;
}

/**
 * Brace off the body hit: lose BRACE_SIZE_LOSS of size (fatal below BRACE_MIN_SIZE), bounce off
 * the surface like a wall (combo resets) and leave it as if just released from it, so a hold
 * does not latch its ring on the way out.
 * @param {WorldT} w @param {Sim} sim
 */
function brace(w, sim) {
  const c = w.comet, b = w.bodies, i = sim.impactSlot;
  c.impact = -1;
  sim.lastPress = -Infinity;   // one press, one brace
  if (i < 0 || !b.alive[i] || b.id[i] !== sim.impactId) return;   // body recycled: fly on
  const size = c.size - CONFIG.BRACE_SIZE_LOSS;
  if (size < CONFIG.BRACE_MIN_SIZE - 1e-9) { die(w, sim.impactCause, i); return; }
  c.size = size;
  let nx = c.x - b.x[i], ny = c.y - b.y[i];
  let d = Math.sqrt(nx * nx + ny * ny);
  if (d < 1e-6) { nx = -c.vx; ny = -c.vy; d = Math.sqrt(nx * nx + ny * ny) || 1; }
  nx /= d; ny /= d;
  const out = b.r[i] + CONFIG.COMET_RADIUS + CONFIG.BRACE_PUSH_OUT;
  c.x = b.x[i] + nx * out; c.y = b.y[i] + ny * out;
  // The next swept collision test starts here, not at the contact point (which touches the body).
  c.px = c.x; c.py = c.y;
  const vn = c.vx * nx + c.vy * ny;
  if (vn < 0) { c.vx -= 2 * vn * nx; c.vy -= 2 * vn * ny; }
  let sp = c.speed * (1 - CONFIG.BRACE_SPEED_LOSS);
  if (sp < w.baseSpeed) sp = w.baseSpeed;
  const k = sp / (Math.sqrt(c.vx * c.vx + c.vy * c.vy) || 1);
  c.vx *= k; c.vy *= k; c.speed = sp;
  c.heading = Math.atan2(c.vy, c.vx);
  // A hold that is still down stays armed for the next ring (the braced planet's own ring is
  // excluded below, as for a planet just left).
  c.armed = c.wasHeld;
  if (b.type[i] === BODY.PLANET && b.rc[i] > 0) c.lastBodyId = b.id[i];
  sim.leftInside = b.type[i] === BODY.PLANET && b.rc[i] > 0;
  sim.leftSlot = i;
  sim.bhId = 0;   // a brace off a core is not a slingshot pass
  sim.passSlot = -1; sim.passId = 0;
  sim.relDx = c.vx / sp; sim.relDy = c.vy / sp;
  sim.nmId[i] = b.id[i]; sim.nmState[i] = 2;   // the bounce is not also a near miss
  comboBreak(w, COMBO_BREAK_REASON.BRACE);
  pushEvent(w.events, EV.BRACE, c.x, c.y, c.size, i);
}

/** @param {WorldT} w @param {number} side -1 left, +1 right @param {number} x reflected x */
function bounce(w, side, x) {
  const c = w.comet;
  c.x = x;
  c.vx = -c.vx;
  let sp = c.speed * (1 - CONFIG.WALL_SPEED_LOSS);
  if (sp < w.baseSpeed) sp = w.baseSpeed;
  const k = sp / c.speed;
  c.vx *= k; c.vy *= k; c.speed = sp;
  pushEvent(w.events, EV.BOUNCE, c.x, c.y, side, sp);
  comboBreak(w, COMBO_BREAK_REASON.WALL);
}

/** Collect motes swept by the comet this step. @param {WorldT} w @param {Sim} sim */
function pickMotes(w, sim) {
  const c = w.comet, m = w.motes;
  const sx = c.x - c.px, sy = c.y - c.py;
  const len = Math.sqrt(sx * sx + sy * sy);
  const ux = len > 0 ? sx / len : 0, uy = len > 0 ? sy / len : 0;
  const rr = CONFIG.MOTE_RADIUS;
  for (let i = 0, n = m.count; i < n; i++) {
    if (!m.alive[i]) continue;
    const ex = m.x[i] - c.px, ey = m.y[i] - c.py;
    if (ex * ex + ey * ey > (len + rr) * (len + rr)) continue;
    let t = ex * ux + ey * uy;
    t = t < 0 ? 0 : t > len ? len : t;
    const qx = ux * t - ex, qy = uy * t - ey;
    if (qx * qx + qy * qy >= rr * rr) continue;
    m.alive[i] = 0;
    const line = m.line[i];
    if (line === sim.streakLine) sim.streakIdx++;
    else { sim.streakLine = line; sim.streakIdx = 0; }
    const pts = CONFIG.POINTS_MOTE * w.score.multiplier;
    w.score.score += pts;
    if (c.size < 1) c.size = Math.min(1, c.size + CONFIG.BRACE_DUST_REFILL);
    pushEvent(w.events, EV.MOTE, m.x[i], m.y[i], sim.streakIdx, pts);
  }
  while (m.count > 0 && !m.alive[m.count - 1]) m.count--;
}

/** @param {WorldT} w @param {Sim} _sim @param {number} dt */
function updateFront(w, _sim, dt) {
  const f = w.front, c = w.comet;
  const cap = CONFIG.FRONT_SPEED_CAP_FRACTION * w.baseSpeed;
  f.speed += CONFIG.FRONT_ACCEL * dt;
  if (f.speed > cap) f.speed = cap;
  f.y += f.speed * dt;
  if (f.y < c.y - CONFIG.FRONT_MAX_LAG) f.y = c.y - CONFIG.FRONT_MAX_LAG;
  if (c.y <= f.y) die(w, DEATH_CAUSE.FRONT, -1);
}

/** @param {WorldT} w @param {number} cause DEATH_CAUSE @param {number} slot body index or -1 */
function die(w, cause, slot) {
  if (w.dead) return;
  const c = w.comet;
  if (c.grazing) endGraze(w);
  w.dead = true;
  w.deathTime = w.time;
  c.state = COMET.DEAD;
  c.body = -1; c.bodyId = 0; c.armed = false; c.altitude = Infinity;
  pushEvent(w.events, EV.DEATH, c.x, c.y, cause, slot);
}

// ================================================================ aim

/**
 * Forecast a release from RAY (origin, unit direction, speed, world time) and return the slot of
 * the planet whose capture ring the flight enters first, cleanly — or -1. Clean means: it reaches
 * AIM_RING_MARGIN inside the ring before touching any body or a wall, within AIM_TARGET_RANGE of
 * flight; a human re-press after the release latches it safely (latchSafe: no ring entered too
 * soon to press before it unless the latch there is safe); and
 * any black-hole pass on the way keeps AIM_CORE_CLEARANCE from the core. Writes the drawn length (AIM_LINE_LENGTH of flight, or less where it would hit) into AIM[2]
 * and the drawn path into PATH / PATH_N (offsets from PATH_O = the origin).
 *
 * Straight legs are tested analytically (castStraight). Where a leg enters a black hole's influence
 * the flight is bent, and marchBent steps it exactly as free flight will (same fixed step, same
 * acceleration code, same slingshot boost on the way out), then the next straight leg starts where
 * the comet leaves the influence. So the line follows the path the comet really takes, and lights
 * a slingshot only when that path really ends in a ring.
 *
 * Honest about motion: moons and drifting / binary planets are tested where they WILL be when the
 * comet gets there (positions are pure functions of time), see marchMoving.
 *
 * Binary pairs: from one member the line looks past its partner's ring (it is not progress, and
 * after a lit release a press on that straight flight does not latch it; see ignoreLeft) to the
 * next ring, but the partner's body blocks it like any body, where it will be. Onto a binary,
 * whichever member's ring the flight enters first is the target (both are the same path step).
 * @param {WorldT} w @param {number} exclude  The orbited planet (never a target on the first leg).
 */
function castAim(w, exclude) {
  CAST_T0[0] = RAY[5];
  PATH_O[0] = RAY[0]; PATH_O[1] = RAY[1];
  PATH[0] = 0; PATH[1] = 0; PATH_N[0] = 1;
  MS[6] = 0; MS[7] = Infinity;
  AIM[2] = 0;
  AIMP[0] = exclude >= 0 ? partnerOf(w.bodies, exclude) : -1;
  let ex = exclude;
  for (let leg = 0; leg <= CONFIG.AIM_MAX_BENDS; leg++) {
    const target = castStraight(w, ex);
    if (target !== -2) {
      // Draw this leg up to its first hit (or the rest of AIM_LINE_LENGTH).
      let len = AIM_LINE_LENGTH - MS[6];
      if (LEG[0] < len) len = LEG[0];
      if (len > 0) {
        PV[0] = RAY[0] + RAY[2] * len; PV[1] = RAY[1] + RAY[3] * len; pushPath();
        AIM[2] = MS[6] + len;
      }
      if (target < 0 || MS[7] < AIM_CORE_CLEARANCE) return -1;
      return latchSafe(w, target) ? target : -1;
    }
    if (leg === CONFIG.AIM_MAX_BENDS || !marchBent(w, leg === 0)) return -1;
    ex = -1; // after a bend the comet could come back into the ring it left (or its partner's)
    AIMP[0] = -1;
  }
  return -1;
}

/**
 * Can a human catch the target safely after this release? A ring entered at least AIM_MIN_ENTRY_S
 * after the release: yes — a re-press before the entry arms the hold, which latches at the ring
 * edge. A ring entered sooner (or already around the comet) is caught wherever the comet is when
 * the finger comes back down, so from the entry until AIM_SAFE_PRESS_S the comet must stay inside
 * the ring and no deeper than the safe floor (AIM_LATCH_FLOOR above the surface, AIM_LATCH_MOON_GAP
 * clear of the target's moon lane) — otherwise the line stays dark (Phase 4: lit lines used to
 * promise rings left within 150 ms, or latches in a moon lane).
 * Uses the current straight leg in RAY (the target ring is always entered on the last leg) and
 * MV[1] (ring entry distance along it); CAST_T0[0] is the release time. @param {WorldT} w @param {number} tgt
 */
function latchSafe(w, tgt) {
  const b = w.bodies;
  const sp = RAY[4] > 1 ? RAY[4] : 1;
  const legT = RAY[5] - CAST_T0[0];
  const tE = legT + MV[1] / sp;
  if (tE >= AIM_MIN_ENTRY_S) return true;
  let floor = b.r[tgt] + CONFIG.AIM_LATCH_FLOOR;
  for (let k = 0, n = b.count; k < n; k++) {
    if (!b.alive[k] || b.type[k] !== BODY.MOON || b.parent[k] !== tgt) continue;
    const lane = b.m0[k] + b.r[k] + COMET_RADIUS + CONFIG.AIM_LATCH_MOON_GAP;
    if (lane > floor) floor = lane;
  }
  const moving = (b.flags[tgt] & MOVING_FLAGS) !== 0, rc = b.rc[tgt];
  for (let t = tE; ; t += STEP) {
    const last = t >= AIM_SAFE_PRESS_S;
    const s = ((last ? AIM_SAFE_PRESS_S : t) - legT) * sp;
    let bx = b.x[tgt], by = b.y[tgt];
    if (moving) { MT[0] = RAY[5] + s / sp; posAt(b, tgt); bx = MP[0]; by = MP[1]; }
    const dx = RAY[0] + RAY[2] * s - bx, dy = RAY[1] + RAY[3] * s - by;
    const d2 = dx * dx + dy * dy;
    if (d2 < floor * floor) return false;
    if (last) return d2 < rc * rc;
  }
}

/** Append the vertex at absolute position (PV[0], PV[1]) to PATH if there is room (doubles go
 * through memory: as call arguments to a function V8 does not inline they would be boxed). */
function pushPath() {
  const n = PATH_N[0];
  if (n >= AIM_PATH_MAX) return;
  PATH[2 * n] = PV[0] - PATH_O[0]; PATH[2 * n + 1] = PV[1] - PATH_O[1];
  PATH_N[0] = n + 1;
}

/**
 * One straight leg of castAim, from RAY. Returns the target slot, -1 (no clean target: hit, wall,
 * out of range, too shallow), or -2 when the leg enters a black hole's influence first (LEG[1] =
 * entry distance; castAim then bends the flight). LEG[0] = distance to the first body hit; MV[1] =
 * entry distance into the target's ring. MS[6] (flight so far) limits the range.
 * @param {WorldT} w @param {number} exclude
 */
function castStraight(w, exclude) {
  const b = w.bodies;
  const ox = RAY[0], oy = RAY[1], dx = RAY[2], dy = RAY[3];
  const cr = COMET_RADIUS;
  let hit = Infinity, ring = Infinity, target = -1, moving = 0, bend = Infinity;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || i === exclude) continue;
    const ty = b.type[i];
    if (ty === BODY.MOON || (b.flags[i] & MOVING_FLAGS) !== 0) { moving++; continue; }
    // Inlined ray-circle entries for the body and its ring (see advanceFree).
    const fx = ox - b.x[i], fy = oy - b.y[i];
    const f2 = fx * fx + fy * fy, fd = fx * dx + fy * dy;
    if (ty === BODY.BLACKHOLE) {
      // The core lies inside the influence, so the influence entry always comes first.
      const rc = b.rc[i], cc = f2 - rc * rc;
      if (cc < 0) bend = 0;
      else if (fd <= 0 && fd * fd >= cc) {
        const th = -fd - Math.sqrt(fd * fd - cc);
        if (th < bend) bend = th;
      }
      continue;
    }
    const hr = b.r[i] + cr;
    let cc = f2 - hr * hr;
    if (cc <= 0) hit = 0;
    else if (fd <= 0 && fd * fd >= cc) {
      const th = -fd - Math.sqrt(fd * fd - cc);
      if (th < hit) hit = th;
    }
    const rc = b.rc[i];
    if (ty === BODY.PLANET && rc > 0) {
      cc = f2 - rc * rc;
      let tr = -1;
      if (cc <= 0) tr = 0; // already inside: entered "now" (see latchSafe)
      else if (fd <= 0 && fd * fd >= cc) tr = -fd - Math.sqrt(fd * fd - cc);
      if (tr >= 0 && tr < ring) { ring = tr; target = i; }
    }
  }
  let wall = Infinity;
  const lo = WALL_LO, hi = WALL_HI;
  if (dx < 0) wall = ox > lo ? (ox - lo) / -dx : 0;
  else if (dx > 0) wall = ox < hi ? (hi - ox) / dx : 0;
  // Where the ray gets AIM_RING_MARGIN inside the target ring (not just grazing its edge).
  let deep = Infinity;
  if (target >= 0) {
    // Inlined ray-circle entry (a non-inlined helper call would box its double arguments).
    const fx = ox - b.x[target], fy = oy - b.y[target], rr = b.rc[target] - AIM_RING_MARGIN;
    const fd = fx * dx + fy * dy, cc = fx * fx + fy * fy - rr * rr;
    if (cc <= 0) deep = 0;
    else if (fd <= 0 && fd * fd >= cc) deep = -fd - Math.sqrt(fd * fd - cc);
  }
  const range = AIM_TARGET_RANGE - MS[6];

  if (moving > 0) {
    let limit = hit < wall ? hit : wall;
    if (bend < limit) limit = bend;
    if (limit > range) limit = range;
    MV[0] = hit; MV[1] = ring; MV[2] = deep; MV[3] = limit;
    let tgt = target;
    for (let i = 0, n = b.count; i < n && MV[3] > 0; i++) {
      if (!b.alive[i] || i === exclude) continue;
      if (b.type[i] !== BODY.MOON && (b.flags[i] & MOVING_FLAGS) === 0) continue;
      if (marchMoving(b, i)) tgt = i;
    }
    hit = MV[0]; ring = MV[1]; deep = MV[2]; target = tgt;
  }
  MV[1] = ring;
  LEG[1] = bend;
  // The comet latches (armed) where it enters the target ring: a bend or hit after that is moot.
  const reached = target >= 0 && ring < hit && ring <= wall && ring <= range && deep < hit && deep <= wall;
  if (bend < Infinity && bend < hit && bend <= wall && bend <= range && !(reached && deep < bend)) {
    LEG[0] = bend;
    // A ring entered before the bend but not deep enough before it: no clean promise either way.
    return ring < bend ? -1 : -2;
  }
  LEG[0] = hit;
  return reached ? target : -1;
}

/**
 * Bent leg of castAim: step the flight from the current leg's start exactly as free flight does
 * (advanceFree: black-hole acceleration at the step's start, then the move, a swept body test with
 * every body where it will be at that step, walls, then the pass bookkeeping and its slingshot
 * boost on the way out), drawing a vertex per step. Returns true once the comet is out of every
 * influence again (MS and RAY then hold the state for the next straight leg), false if the flight
 * hits something, reaches a wall or runs out of range / steps (AIM[2] then ends there).
 * `first`: start from the release (RAY) rather than from the previous bent leg's exit (MS).
 * @param {WorldT} w @param {boolean} first
 */
function marchBent(w, first) {
  const b = w.bodies, cr = COMET_RADIUS;
  if (first) {
    // release(): v = aim direction × speed; each step x += v·dt from the release point.
    MS[0] = RAY[0]; MS[1] = RAY[1]; MS[2] = RAY[2] * RAY[4]; MS[3] = RAY[3] * RAY[4];
    MS[4] = RAY[4]; MS[5] = RAY[5];
  }
  let x = MS[0], y = MS[1], vx = MS[2], vy = MS[3], sp = MS[4], t = MS[5];
  let arc = MS[6], bhId = 0, bhMin = 0, entered = false;
  // A leg that only clips an influence edge between two steps is never bent: once it is this far
  // past castStraight's entry point without having been pulled, it carries on straight.
  const passBy = arc + LEG[1] + 2 * sp * STEP;
  // Fast-forward the straight approach: castStraight already cleared it up to the influence entry,
  // so only the position (the same repeated additions as free flight, for exactness), time and
  // flown length advance; one vertex marks its end.
  let k = 0;
  const seg0 = sp * STEP, skipTo = arc + LEG[1] - 2 * seg0;
  if (arc + seg0 < skipTo) {
    while (arc + seg0 < skipTo && k < CONFIG.AIM_BEND_MAX_STEPS) {
      const ox = x, oy = y;
      x += vx * STEP; y += vy * STEP; t += STEP; k++;
      if (arc < AIM_LINE_LENGTH && arc + seg0 > AIM_LINE_LENGTH) {
        const f = (AIM_LINE_LENGTH - arc) / seg0;
        PV[0] = ox + (x - ox) * f; PV[1] = oy + (y - oy) * f; pushPath(); AIM[2] = AIM_LINE_LENGTH;
      }
      arc += seg0;
    }
    if (arc <= AIM_LINE_LENGTH) { PV[0] = x; PV[1] = y; pushPath(); AIM[2] = arc; }
  }
  for (; k < CONFIG.AIM_BEND_MAX_STEPS; k++) {
    t += STEP;
    BHQ[0] = x; BHQ[1] = y;
    blackHoleAccelAt(w, ACC2);
    if (ACC2[0] !== 0 || ACC2[1] !== 0) {
      vx += ACC2[0] * STEP; vy += ACC2[1] * STEP;
      sp = Math.sqrt(vx * vx + vy * vy);
      entered = true;
    }
    const ox = x, oy = y;
    x += vx * STEP; y += vy * STEP;
    const sx = x - ox, sy = y - oy;
    const len = Math.sqrt(sx * sx + sy * sy);
    const ux = len > 0 ? sx / len : 0, uy = len > 0 ? sy / len : 0;
    // Walls: the aim line never promises anything past a bounce.
    let stop = (x < WALL_LO && vx < 0) || (x > WALL_HI && vx > 0) || arc + len > AIM_TARGET_RANGE;
    // Swept body test (advanceFree's), with moving bodies where they will be at time t.
    let hitT = -1;
    MT[0] = t;
    for (let i = 0, n = b.count; i < n; i++) {
      if (!b.alive[i]) continue;
      let bx = b.x[i], by = b.y[i];
      if (b.type[i] === BODY.MOON || (b.flags[i] & MOVING_FLAGS) !== 0) { posAt(b, i); bx = MP[0]; by = MP[1]; }
      const rr = b.r[i] + cr;
      const ex = bx - ox, ey = by - oy;
      let s = ex * ux + ey * uy;
      s = s < 0 ? 0 : s > len ? len : s;
      const qx = ux * s - ex, qy = uy * s - ey;
      const q2 = qx * qx + qy * qy;
      if (b.type[i] === BODY.BLACKHOLE) {
        const lim = rr + AIM_CORE_CLEARANCE;
        if (q2 < lim * lim) { const cl = Math.sqrt(q2) - rr; if (cl < MS[7]) MS[7] = cl; }
      }
      if (q2 < rr * rr) {
        // Contact point along this step (inlined ray-circle entry), as advanceFree places it.
        const fx = ox - bx, fy = oy - by, fd = fx * ux + fy * uy, cc = fx * fx + fy * fy - rr * rr;
        const disc = fd * fd - cc;
        let th = cc <= 0 ? 0 : disc >= 0 ? -fd - Math.sqrt(disc) : len;
        if (th > len || th < 0) th = len;
        if (hitT < 0 || th < hitT) hitT = th;
      }
    }
    if (hitT >= 0) { x = ox + ux * hitT; y = oy + uy * hitT; stop = true; }
    // Draw: one vertex per step up to AIM_LINE_LENGTH of flight.
    const seg = hitT >= 0 ? hitT : len;
    if (arc < AIM_LINE_LENGTH) {
      if (arc + seg <= AIM_LINE_LENGTH) { PV[0] = x; PV[1] = y; pushPath(); AIM[2] = arc + seg; }
      else { const f = AIM_LINE_LENGTH - arc; PV[0] = ox + ux * f; PV[1] = oy + uy * f; pushPath(); AIM[2] = AIM_LINE_LENGTH; }
    }
    arc += seg;
    if (stop) { MS[6] = arc; return false; }
    // Pass bookkeeping and slingshot boost, exactly as advanceFree.
    let inside = false;
    for (let i = 0, n = b.count; i < n; i++) {
      if (!b.alive[i] || b.type[i] !== BODY.BLACKHOLE) continue;
      const dx = x - b.x[i], dy = y - b.y[i];
      const d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
      const rc = b.rc[i];
      if (d2 <= rc * rc) inside = true;
      if (d < rc) {
        if (bhId !== b.id[i]) { bhId = b.id[i]; bhMin = d; entered = true; }
        else if (d < bhMin) bhMin = d;
      } else if (bhId !== 0 && bhId === b.id[i]) {
        bhId = 0;
        SL[0] = bhMin;
        slingScale(b, i);
        let ns = sp * (1 + (CONFIG.BLACKHOLE_SPEED_BOOST - 1) * SL[1]);
        const cap = w.baseSpeed * CONFIG.SPEED_CAP_FACTOR * CONFIG.BLACKHOLE_SPEED_BOOST;
        if (ns > cap) ns = cap;
        if (ns > sp && sp > 0) { const kk = ns / sp; vx *= kk; vy *= kk; sp = ns; }
      }
    }
    if (!inside && bhId === 0 && (entered || arc > passBy)) {
      // Out of every influence: hand over to the next straight leg.
      MS[0] = x; MS[1] = y; MS[2] = vx; MS[3] = vy; MS[4] = sp; MS[5] = t; MS[6] = arc;
      RAY[0] = x; RAY[1] = y; RAY[2] = vx / sp; RAY[3] = vy / sp; RAY[4] = sp; RAY[5] = t;
      return true;
    }
  }
  MS[6] = arc;
  return false;
}

/**
 * castAim's pass over one moving body i (moon, drifting or binary planet): march the ray in RAY
 * every AIM_MARCH_STEP units across the stretch that passes the body's motion envelope, with the
 * body where it will be when the comet gets there. Reads and updates MV (hit, ring entry, deep
 * point, limit); returns true if i became the target (its ring is entered before the current one).
 * All doubles stay in typed arrays and locals of this small function, which V8 optimises on its own.
 *
 * The hit test keeps a margin (Phase 4): free flight tests each step's path against where a moving
 * body is at the END of the step (advanceFree), which can be up to one step of the body's motion
 * nearer than the true relative path; and the samples are AIM_MARCH_STEP apart, so the closest
 * approach can fall between two of them (by at most the sagitta of half a sample spacing of the
 * relative motion, on the hit circle). A line grazing a fast body (a binary partner turning at
 * ~230 u/s) used to light, and a release on it died ~2 units short (seeds 104 and 145, zones 5 and
 * 6, perfect bot). Where a sample is inside, the hit distance is refined to the circle entry
 * around the body's position at that sample (exact for a body that does not move).
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
function marchMoving(b, i) {
  const ox = RAY[0], oy = RAY[1], dx = RAY[2], dy = RAY[3];
  const sp = RAY[4] > 1 ? RAY[4] : 1, t0 = RAY[5];
  const rc = b.rc[i];
  const isPl = b.type[i] === BODY.PLANET && rc > 0 && i !== AIMP[0];
  maxSpeedOf(b, i);
  const vb = VS[0], h0 = b.r[i] + COMET_RADIUS, half = AIM_MARCH_STEP * 0.5 * (1 + vb / sp);
  const hr = h0 + vb * STEP + (half * half) / (2 * h0) + 0.05;
  // Bounding circle of everything this body (or its ring) can ever cover.
  envelopeOf(b, i);
  const ex = (ENV[0] + ENV[2]) * 0.5, ey = (ENV[1] + ENV[3]) * 0.5;
  const hx = (ENV[2] - ENV[0]) * 0.5, hy = (ENV[3] - ENV[1]) * 0.5;
  const R = Math.sqrt(hx * hx + hy * hy) + ENV[4] + (isPl ? rc : hr);
  const fx = ox - ex, fy = oy - ey;
  const fd = fx * dx + fy * dy, cc = fx * fx + fy * fy - R * R;
  const disc = fd * fd - cc;
  if (disc <= 0) return false;
  const sq = Math.sqrt(disc);
  let s = -fd - sq, s1 = -fd + sq;
  if (s1 < 0) return false;
  if (s < 0) s = 0;
  if (s1 > MV[3]) s1 = MV[3];
  const hr2 = hr * hr, rc2 = isPl ? rc * rc : -1;
  const rd = rc - AIM_RING_MARGIN, deep2 = isPl && rd > 0 ? rd * rd : -1;
  let entered = -1, became = false;
  for (; s <= s1; s += AIM_MARCH_STEP) {
    MT[0] = t0 + s / sp;
    posAt(b, i);
    const qx = ox + dx * s - MP[0], qy = oy + dy * s - MP[1];
    const d2 = qx * qx + qy * qy;
    if (d2 < hr2) {
      // Entry into the hit circle around the body where it is at this sample, kept within the
      // last sample spacing (the previous sample was outside).
      const fd = qx * dx + qy * dy - s, disc = fd * fd - ((ox - MP[0]) * (ox - MP[0]) + (oy - MP[1]) * (oy - MP[1]) - hr2);
      let th = disc >= 0 ? -fd - Math.sqrt(disc) : s;
      if (th > s) th = s;
      if (th < s - AIM_MARCH_STEP) th = s - AIM_MARCH_STEP;
      if (th < 0) th = 0;
      if (th < MV[0]) MV[0] = th;
      break;
    }
    if (isPl) {
      if (entered < 0 && d2 < rc2) entered = s;
      if (d2 < deep2) {
        if (entered < MV[1]) { MV[1] = entered; MV[2] = s; became = true; }
        entered = -1;
        break;
      }
    }
  }
  // Entered the ring but not deep enough before the interval ended (or a hit): a bad target.
  if (entered >= 0 && entered < MV[1]) { MV[1] = entered; MV[2] = Infinity; became = true; }
  if (MV[0] < MV[3]) MV[3] = MV[0];
  return became;
}

/**
 * Where a straight release would go (tools and test bots; same rules as the aim line): the slot
 * of the planet whose ring a comet leaving (ox, oy) along unit (dx, dy) at `speed`, at world time
 * `t0`, enters cleanly, or -1. `exclude` is the slot being orbited. Not for per-step use.
 * @param {WorldT} w @param {number} ox @param {number} oy @param {number} dx @param {number} dy
 * @param {number} speed @param {number} t0 @param {number} exclude
 */
export function castRay(w, ox, oy, dx, dy, speed, t0, exclude) {
  RAY[0] = ox; RAY[1] = oy; RAY[2] = dx; RAY[3] = dy; RAY[4] = speed; RAY[5] = t0;
  return castAim(w, exclude);
}

/**
 * Aim direction from the current orbit tangent, with aim assist: if the raw tangent has no clean
 * target and misses the nearest catchable ring ahead by under AIM_ASSIST_DEG, rotate toward it
 * (aiming 1.5 × AIM_RING_MARGIN inside the edge) by at most AIM_ASSIST_DEG; kept only if the
 * rotated ray then has a clean target.
 * Writes AIM[0..2] and returns the target slot (-1 none). The caller sets RAY[5] (time origin).
 * @param {WorldT} w
 */
function solveAim(w) {
  const c = w.comet, b = w.bodies;
  const sp = c.speed > 0 ? c.speed : 1;
  const dx = c.vx / sp, dy = c.vy / sp;
  const ox = c.x, oy = c.y, ex = c.body;
  AIM[0] = dx; AIM[1] = dy;
  // castAim moves RAY along a bent flight, so every cast below starts from a fresh RAY.
  const time = RAY[5];
  RAY[0] = ox; RAY[1] = oy; RAY[2] = dx; RAY[3] = dy; RAY[4] = sp;
  const t0 = castAim(w, ex);
  if (t0 >= 0) return t0;
  let best = -1, bestD = AIM_ASSIST_RANGE;
  const ep = ex >= 0 ? partnerOf(b, ex) : -1;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || i === ex || i === ep || b.type[i] !== BODY.PLANET || b.rc[i] <= 0) continue;
    const rx = b.x[i] - ox, ry = b.y[i] - oy;
    if (rx * dx + ry * dy <= 0) continue;
    const d = Math.sqrt(rx * rx + ry * ry);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD <= b.rc[best]) return -1;
  const rx = b.x[best] - ox, ry = b.y[best] - oy;
  const ang = Math.atan2(dx * ry - dy * rx, dx * rx + dy * ry);
  const maxA = CONFIG.AIM_ASSIST_DEG * DEG;
  const miss = Math.abs(ang) - Math.asin(b.rc[best] / bestD);
  if (miss >= maxA) return -1;
  let inner = b.rc[best] - 1.5 * AIM_RING_MARGIN;
  if (inner < 0) inner = 0;
  let rot = Math.abs(ang) - Math.asin(inner / bestD);
  if (rot <= 0) return -1;
  if (rot > maxA) rot = maxA;
  if (ang < 0) rot = -rot;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const ndx = dx * cr - dy * sr, ndy = dx * sr + dy * cr;
  RAY[0] = ox; RAY[1] = oy; RAY[2] = ndx; RAY[3] = ndy; RAY[4] = sp; RAY[5] = time;
  const t1 = castAim(w, ex);
  if (t1 < 0) {
    // Assist found nothing clean: keep the raw tangent (re-cast so AIM[2] and the path match it).
    RAY[0] = ox; RAY[1] = oy; RAY[2] = dx; RAY[3] = dy; RAY[4] = sp; RAY[5] = time;
    castAim(w, ex);
    return -1;
  }
  AIM[0] = ndx; AIM[1] = ndy;
  return t1;
}

/** Refresh world.aim (valid while orbiting). @param {WorldT} w */
function computeAim(w) {
  const a = w.aim, c = w.comet;
  if (c.state !== COMET.ORBIT || w.dead) {
    a.active = false; a.target = -1; a.clear = false; a.length = 0; a.pointCount = 0;
    return;
  }
  RAY[5] = w.time; // the comet is at its orbit position now; a release next step flies from here
  const t = solveAim(w);
  a.active = true;
  a.x0 = c.x; a.y0 = c.y;
  a.dx = AIM[0]; a.dy = AIM[1]; a.length = AIM[2];
  a.target = t;
  a.clear = t >= 0;
  const n = PATH_N[0], pts = a.points;
  for (let k = 0, m = 2 * n; k < m; k++) pts[k] = PATH[k];
  a.pointCount = n;
}

// ================================================================ hash

/** @param {number} h @param {number} v */
function mix(h, v) {
  HASH_F64[0] = v;
  h ^= HASH_U32[0]; h = Math.imul(h, 0x01000193) >>> 0;
  h ^= HASH_U32[1]; h = Math.imul(h, 0x01000193) >>> 0;
  return h;
}

/** FNV-1a over the comet, score and live bodies. @param {WorldT} w */
export function hashWorld(w) {
  let h = 0x811c9dc5;
  const c = w.comet;
  h = mix(h, c.x); h = mix(h, c.y); h = mix(h, c.vx); h = mix(h, c.vy); h = mix(h, c.state);
  h = mix(h, w.score.score); h = mix(h, w.score.combo); h = mix(h, c.size);
  const b = w.bodies;
  for (let i = 0; i < b.count; i++) if (b.alive[i]) { h = mix(h, b.id[i]); h = mix(h, b.x[i]); h = mix(h, b.y[i]); }
  return h >>> 0;
}
