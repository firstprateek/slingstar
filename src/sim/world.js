// @ts-check
/**
 * The world: all simulation state and the fixed-step update. PURE — no window, document,
 * performance, Date or Math.random. Runs unchanged under Node.
 *
 * PHASE 0 STUB: allocates the full state shape from contracts.js and keeps the comet circling the
 * home planet so other workstreams have something live to read. Stream A replaces step().
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG, COMET, MODE } from '../contracts.js';
import { createEventQueue, clearEvents } from '../core/events.js';

/** @typedef {import('../contracts.js').WorldT} WorldT */
/** @typedef {import('../contracts.js').SimInput} SimInput */

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
 * @param {{ seed?: number, mode?: string }} [opts]
 * @returns {WorldT}
 */
export function createWorld(opts = {}) {
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
    step: (dt, input) => step(world, dt, input),
    reset: (seed, mode) => reset(world, seed, mode),
    hash: () => hashWorld(world),
  };
  reset(world, opts.seed ?? 1, opts.mode ?? MODE.ENDLESS);
  return world;
}

/** @param {WorldT} w @param {number} seed @param {string} [mode] */
function reset(w, seed, mode) {
  w.seed = seed >>> 0;
  if (mode) w.mode = mode;
  w.time = 0; w.steps = 0; w.started = false; w.dead = false; w.deathTime = -1;
  w.baseSpeed = CONFIG.BASE_SPEED_START;
  const b = w.bodies;
  b.alive.fill(0); b.count = 0;
  w.motes.alive.fill(0); w.motes.count = 0;
  clearEvents(w.events);
  // Home planet in slot 0.
  b.count = 1; b.alive[0] = 1; b.id[0] = 1; b.type[0] = BODY.PLANET; b.flags[0] = BODY_FLAG.HOME;
  b.x[0] = b.px[0] = CONFIG.HOME_X; b.y[0] = b.py[0] = CONFIG.HOME_Y;
  b.r[0] = CONFIG.HOME_R; b.rc[0] = CONFIG.HOME_R + CONFIG.CAPTURE_BAND_Z1;
  b.seed[0] = seed >>> 0; b.zone[0] = 1; b.pathIndex[0] = 0; b.parent[0] = -1;
  const c = w.comet;
  c.state = COMET.ORBIT; c.body = 0; c.bodyId = 1; c.lastBodyId = 0;
  c.orbitRadius = CONFIG.HOME_R + CONFIG.CAPTURE_BAND_Z1 * 0.55; c.orbitDir = 1; c.orbitAngle = 0;
  c.laps = 0; c.armed = false; c.grazing = false; c.wasHeld = false;
  c.speed = CONFIG.BASE_SPEED_START * 0.6;
  placeOnOrbit(w);
  c.px = c.x; c.py = c.y;
  w.front.y = w.front.py = CONFIG.HOME_Y - CONFIG.FRONT_START_BELOW; w.front.speed = 0;
  const s = w.score;
  s.score = 0; s.combo = 0; s.bestCombo = 0; s.tier = 1; s.multiplier = 1; s.zone = 1;
  s.maxHeight = 0; s.catches = 0; s.perfects = 0; s.pathReached = 0;
  w.aim.active = false; w.aim.target = -1; w.aim.clear = false;
}

/** @param {WorldT} w */
function placeOnOrbit(w) {
  const c = w.comet, b = w.bodies, i = c.body;
  const cx = b.x[i], cy = b.y[i];
  c.x = cx + Math.cos(c.orbitAngle) * c.orbitRadius;
  c.y = cy + Math.sin(c.orbitAngle) * c.orbitRadius;
  const tx = -Math.sin(c.orbitAngle) * c.orbitDir, ty = Math.cos(c.orbitAngle) * c.orbitDir;
  c.vx = tx * c.speed; c.vy = ty * c.speed; c.heading = Math.atan2(c.vy, c.vx);
  c.altitude = c.orbitRadius - b.r[i];
}

/** STUB step: circle the home planet forever. @param {WorldT} w @param {number} dt @param {SimInput} _input */
function step(w, dt, _input) {
  w.time += dt; w.steps++;
  const c = w.comet;
  c.px = c.x; c.py = c.y;
  for (let i = 0; i < w.bodies.count; i++) { w.bodies.px[i] = w.bodies.x[i]; w.bodies.py[i] = w.bodies.y[i]; }
  w.front.py = w.front.y;
  c.orbitAngle += c.orbitDir * (c.speed / c.orbitRadius) * dt;
  placeOnOrbit(w);
}

/** FNV-1a over the comet, score and live bodies. @param {WorldT} w */
export function hashWorld(w) {
  let h = 0x811c9dc5;
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  /** @param {number} v */
  const mix = (v) => {
    f64[0] = v;
    for (let k = 0; k < 2; k++) { h ^= u32[k]; h = Math.imul(h, 0x01000193) >>> 0; }
  };
  const c = w.comet;
  mix(c.x); mix(c.y); mix(c.vx); mix(c.vy); mix(c.state); mix(w.score.score); mix(w.score.combo);
  const b = w.bodies;
  for (let i = 0; i < b.count; i++) if (b.alive[i]) { mix(b.id[i]); mix(b.x[i]); mix(b.y[i]); }
  return h >>> 0;
}
