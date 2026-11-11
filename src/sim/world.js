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
import { updateBodyMotion, blackHoleAccel, posAt, envelopeOf, MT, MP, ENV, MOVING_FLAGS } from './hazards.js';
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
 * @property {number} bhId            id of the black hole whose influence the comet is in (0 none).
 * @property {number} bhSlot
 * @property {number} bhMin           Closest distance to that hole's centre in this pass.
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
      armed: false, grazing: false, wasHeld: false,
    },
    bodies: createBodies(),
    motes: createMotes(),
    aim: { active: false, x0: 0, y0: 0, dx: 0, dy: 1, length: 0, target: -1, clear: false },
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
    leftInside: false, leftSlot: -1, bhId: 0, bhSlot: -1, bhMin: 0,
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
  sim.leftInside = false; sim.leftSlot = -1; sim.bhId = 0; sim.bhSlot = -1; sim.bhMin = 0;
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
  c.speed = w.baseSpeed;
  placeOnOrbit(w);
  c.px = c.x; c.py = c.y;
  w.front.y = w.front.py = CONFIG.HOME_Y - CONFIG.FRONT_START_BELOW; w.front.speed = 0;
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
    // A press in free flight latches at once inside a ring, otherwise arms the hold.
    if (c.state === COMET.FREE && pressed && !tryLatch(w, sim, true)) c.armed = true;

    if (c.state === COMET.ORBIT) {
      if (!w.started) {
        if (released) release(w, sim);
        else advanceOrbit(w, sim, dt, false);
      } else if (!held) release(w, sim);
      else advanceOrbit(w, sim, dt, true);
    }

    if (c.state === COMET.FREE) {
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
 * @param {WorldT} w @param {Sim} sim @param {number} i
 */
function ignoreLeft(w, sim, i) {
  if (!sim.leftInside || i !== sim.leftSlot) return false;
  const c = w.comet, b = w.bodies;
  // Velocity relative to the planet (a drifting or binary planet moves too), as one step's motion.
  const rvx = c.vx * STEP - (b.x[i] - b.px[i]), rvy = c.vy * STEP - (b.y[i] - b.py[i]);
  return (c.x - b.x[i]) * rvx + (c.y - b.y[i]) * rvy >= 0;
}

/** @param {number} ty BODY.* */
function deathCause(ty) {
  return ty === BODY.MOON ? DEATH_CAUSE.MOON : ty === BODY.BLACKHOLE ? DEATH_CAUSE.BLACKHOLE : DEATH_CAUSE.PLANET;
}

/** @param {WorldT} w @param {Sim} sim @param {number} i @param {boolean} isPress */
function latch(w, sim, i, isPress) {
  const c = w.comet, b = w.bodies, s = w.score;
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
  if (b.pathIndex[i] > 0) reachPath(w, b.pathIndex[i]);
}

/** Leave the orbit along the (aim-assisted) tangent. @param {WorldT} w @param {Sim} sim */
function release(w, sim) {
  const c = w.comet, b = w.bodies;
  const left = c.body;
  const a = w.aim;
  if (a.active && a.x0 === c.x && a.y0 === c.y) {
    // The comet has not moved since the aim line was computed (end of the previous step): leave
    // exactly along the line the player saw. Re-solving would see moving bodies one step later
    // (aim assist aims at their current positions) and could flip a marginal window.
    c.vx = a.dx * c.speed; c.vy = a.dy * c.speed;
  } else {
    RAY[5] = w.time - STEP; // this step's motion starts from the orbit position of the previous step
    solveAim(w);
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
  if (!w.started) {
    w.started = true;
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
      die(w, deathCause(b.type[i]), i);
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
  // flight, deep enough) pays the slingshot.
  if (sim.bhId !== 0 && (!b.alive[sim.bhSlot] || b.id[sim.bhSlot] !== sim.bhId)) sim.bhId = 0;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.BLACKHOLE) continue;
    const dx = c.x - b.x[i], dy = c.y - b.y[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < b.rc[i]) {
      if (sim.bhId !== b.id[i]) { sim.bhId = b.id[i]; sim.bhSlot = i; sim.bhMin = d; }
      else if (d < sim.bhMin) sim.bhMin = d;
    } else if (sim.bhId === b.id[i]) {
      sim.bhId = 0;
      if (sim.bhMin <= CONFIG.BLACKHOLE_SLINGSHOT_DEPTH * b.rc[i]) slingshot(w, i);
    }
  }
}

/** Survived a pass through black hole i's influence: bonus points and a speed boost. @param {WorldT} w @param {number} i */
function slingshot(w, i) {
  const c = w.comet, s = w.score;
  const pts = CONFIG.BLACKHOLE_SLINGSHOT_POINTS * s.multiplier;
  s.score += pts;
  let sp = c.speed * CONFIG.BLACKHOLE_SPEED_BOOST;
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
 * Cast the release ray in RAY and return the slot of the planet whose capture ring it enters first,
 * cleanly: at least AIM_RING_MARGIN deep before touching any body (black-hole influence counts as
 * a hit), before a wall and within AIM_TARGET_RANGE. Writes the drawn length into AIM[2]; -1 if none.
 *
 * Honest about motion: static bodies are tested analytically; moons and drifting / binary planets
 * are tested where they WILL be when the comet gets there (the comet flies straight at RAY[4] from
 * time RAY[5]; positions are pure functions of time), sampling every AIM_MARCH_STEP units along
 * the part of the ray that passes the body's motion envelope. So a moon that will have moved out
 * of the way does not block the line, one that will swing into it does, and a drifting planet
 * lights up only if the comet will meet its ring.
 *
 * Black holes: the line never lights through an influence radius. Free flight there is bent, so a
 * straight ray through it would promise a path the comet does not take; slingshots are a gamble
 * the player takes without the light.
 * @param {WorldT} w @param {number} exclude
 */
function castAim(w, exclude) {
  const b = w.bodies;
  const ox = RAY[0], oy = RAY[1], dx = RAY[2], dy = RAY[3];
  const cr = COMET_RADIUS;
  let hit = Infinity, ring = Infinity, target = -1, moving = 0;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || i === exclude) continue;
    const ty = b.type[i];
    if (ty === BODY.MOON || (b.flags[i] & MOVING_FLAGS) !== 0) { moving++; continue; }
    // Inlined ray-circle entries for the body and its ring (see advanceFree).
    const fx = ox - b.x[i], fy = oy - b.y[i];
    const f2 = fx * fx + fy * fy, fd = fx * dx + fy * dy;
    const hr = ty === BODY.BLACKHOLE ? b.rc[i] : b.r[i] + cr;
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
      if (cc <= 0) tr = 0;
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

  if (moving > 0) {
    let limit = hit < wall ? hit : wall;
    if (limit > AIM_TARGET_RANGE) limit = AIM_TARGET_RANGE;
    MV[0] = hit; MV[1] = ring; MV[2] = deep; MV[3] = limit;
    let tgt = target;
    for (let i = 0, n = b.count; i < n && MV[3] > 0; i++) {
      if (!b.alive[i] || i === exclude) continue;
      if (b.type[i] !== BODY.MOON && (b.flags[i] & MOVING_FLAGS) === 0) continue;
      if (marchMoving(b, i)) tgt = i;
    }
    hit = MV[0]; ring = MV[1]; deep = MV[2]; target = tgt;
  }
  AIM[2] = hit < AIM_LINE_LENGTH ? hit : AIM_LINE_LENGTH;
  if (target < 0 || ring >= hit || ring > wall || ring > AIM_TARGET_RANGE) return -1;
  if (deep >= hit || deep > wall) return -1;
  return target;
}

/**
 * castAim's pass over one moving body i (moon, drifting or binary planet): march the ray in RAY
 * every AIM_MARCH_STEP units across the stretch that passes the body's motion envelope, with the
 * body where it will be when the comet gets there. Reads and updates MV (hit, ring entry, deep
 * point, limit); returns true if i became the target (its ring is entered before the current one).
 * All doubles stay in typed arrays and locals of this small function, which V8 optimises on its own.
 * @param {import('../contracts.js').Bodies} b @param {number} i
 */
function marchMoving(b, i) {
  const ox = RAY[0], oy = RAY[1], dx = RAY[2], dy = RAY[3];
  const sp = RAY[4] > 1 ? RAY[4] : 1, t0 = RAY[5];
  const rc = b.rc[i];
  const isPl = b.type[i] === BODY.PLANET && rc > 0;
  const hr = b.r[i] + COMET_RADIUS;
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
    if (d2 < hr2) { if (s < MV[0]) MV[0] = s; break; }
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
  RAY[0] = ox; RAY[1] = oy; RAY[2] = dx; RAY[3] = dy; RAY[4] = sp;
  const t0 = castAim(w, ex);
  if (t0 >= 0) return t0;
  let best = -1, bestD = AIM_ASSIST_RANGE;
  for (let i = 0, n = b.count; i < n; i++) {
    if (!b.alive[i] || i === ex || b.type[i] !== BODY.PLANET || b.rc[i] <= 0) continue;
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
  RAY[2] = ndx; RAY[3] = ndy;
  const t1 = castAim(w, ex);
  if (t1 < 0) { RAY[2] = dx; RAY[3] = dy; castAim(w, ex); return -1; } // assist found nothing clean: keep the raw tangent
  AIM[0] = ndx; AIM[1] = ndy;
  return t1;
}

/** Refresh world.aim (valid while orbiting). @param {WorldT} w */
function computeAim(w) {
  const a = w.aim, c = w.comet;
  if (c.state !== COMET.ORBIT || w.dead) {
    a.active = false; a.target = -1; a.clear = false; a.length = 0;
    return;
  }
  RAY[5] = w.time; // the comet is at its orbit position now; a release next step flies from here
  const t = solveAim(w);
  a.active = true;
  a.x0 = c.x; a.y0 = c.y;
  a.dx = AIM[0]; a.dy = AIM[1]; a.length = AIM[2];
  a.target = t;
  a.clear = t >= 0;
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
  h = mix(h, w.score.score); h = mix(h, w.score.combo);
  const b = w.bodies;
  for (let i = 0; i < b.count; i++) if (b.alive[i]) { h = mix(h, b.id[i]); h = mix(h, b.x[i]); h = mix(h, b.y[i]); }
  return h >>> 0;
}
