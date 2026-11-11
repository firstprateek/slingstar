// Shared test helpers (not a test file itself: node --test only runs *.test.js).
import { createWorld } from '../src/sim/world.js';
import { createBot } from '../src/sim/bot.js';
import { CONFIG, STEP } from '../src/config.js';
import { BODY, BODY_FLAG, COMET, EV } from '../src/contracts.js';

export { STEP };

/**
 * A world with only the home planet (no generation): rule tests build their own layouts far above
 * it and drive the comet directly.
 */
export function emptyWorld(seed = 1) {
  return createWorld({ seed, generate: false });
}

let nextTestId = 10000;

/** Add a plain catchable planet. Returns its slot. */
export function addPlanet(w, x, y, r = 80, rc = 250, pathIndex = -1) {
  const b = w.bodies;
  const i = b.count;
  b.count = i + 1;
  b.alive[i] = 1; b.id[i] = nextTestId++; b.type[i] = BODY.PLANET; b.flags[i] = 0;
  b.x[i] = b.px[i] = x; b.y[i] = b.py[i] = y; b.r[i] = r; b.rc[i] = rc;
  b.seed[i] = 1; b.zone[i] = 1; b.pathIndex[i] = pathIndex; b.parent[i] = -1;
  b.m0[i] = b.m1[i] = b.m2[i] = b.m3[i] = b.m4[i] = 0;
  return i;
}

/** Put the comet in free flight, as if a run were under way; the front is parked far below. */
export function setFree(w, x, y, vx, vy) {
  const c = w.comet;
  c.state = COMET.FREE; c.body = -1; c.bodyId = 0;
  c.x = c.px = x; c.y = c.py = y; c.vx = vx; c.vy = vy;
  c.speed = Math.hypot(vx, vy); c.heading = Math.atan2(vy, vx);
  c.armed = false; c.grazing = false; c.laps = 0; c.altitude = Infinity;
  w.started = true;
  w.score.maxHeight = y + 1e6; // keep height points out of rule-test scores
  w.front.y = w.front.py = y - 100000; w.front.speed = CONFIG.FRONT_SPEED_START;
}

/**
 * Input driver that derives press/release edges from a held sequence, like main.js does.
 * `step(held)` advances one step and returns the events of that step as plain objects.
 */
export function driver(w) {
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  let prev = false;
  return {
    step(held) {
      input.held = held; input.pressedThisStep = held && !prev; input.releasedThisStep = !held && prev;
      prev = held;
      w.step(STEP, input);
      const out = [];
      const q = w.events;
      for (let i = 0; i < q.count; i++) out.push({ type: q.type[i], x: q.x[i], y: q.y[i], a: q.a[i], b: q.b[i] });
      q.count = 0;
      return out;
    },
    /** Step n times with a constant hold; returns all events. */
    run(held, n) {
      const all = [];
      for (let k = 0; k < n; k++) all.push(...this.step(held));
      return all;
    },
  };
}

export const ofType = (events, type) => events.filter((e) => e.type === type);

/**
 * Let the bot play one seed until pathReached >= stopAt, death, or maxTime.
 * Returns summary stats.
 */
export function botRun(seed, { stopAt = Infinity, maxTime = 180, onEvent, onStep } = {}) {
  const w = createWorld({ seed });
  const bot = createBot();
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  let prev = false, cause = -1;
  while (!w.dead && w.time < maxTime && w.score.pathReached < stopAt) {
    const h = bot.decide(w);
    input.held = h; input.pressedThisStep = h && !prev; input.releasedThisStep = !h && prev; prev = h;
    if (onStep) onStep(w);
    w.step(STEP, input);
    const q = w.events;
    for (let i = 0; i < q.count; i++) {
      if (q.type[i] === EV.DEATH) cause = q.a[i];
      if (onEvent) onEvent(w, q.type[i], q.x[i], q.y[i], q.a[i], q.b[i]);
    }
    q.count = 0;
  }
  return { w, dead: w.dead, cause, pathReached: w.score.pathReached, time: w.time, zone: w.score.zone };
}

// ------------------------------------------------------------------ Phase 3 hazard builders
// (motion params as documented in contracts.js; positions are set for the world's current time)

/** Add a moon circling `parent` at orbit radius `orbitR`, `rate` rad/s (signed), phase `phase`. */
export function addMoon(w, parent, orbitR, rate, phase, r = 18) {
  const b = w.bodies;
  const i = addPlanet(w, 0, 0, r, 0);
  b.type[i] = BODY.MOON; b.parent[i] = parent;
  b.m0[i] = orbitR; b.m1[i] = rate; b.m2[i] = phase;
  const th = phase + rate * w.time;
  b.x[i] = b.px[i] = b.x[parent] + orbitR * Math.cos(th);
  b.y[i] = b.py[i] = b.y[parent] + orbitR * Math.sin(th);
  return i;
}

/** Add a black hole (core radius `core`, influence radius `influence`). */
export function addBlackHole(w, x, y, core = CONFIG.BLACKHOLE_CORE_RADIUS, influence = CONFIG.BLACKHOLE_INFLUENCE_RADIUS) {
  const i = addPlanet(w, x, y, core, influence);
  w.bodies.type[i] = BODY.BLACKHOLE;
  return i;
}

/** Add a drifting planet: x = baseX + amp sin(2π t / period + phase). */
export function addDrifting(w, baseX, y, amp, period, phase, r = 80, rc = 250, pathIndex = -1) {
  const b = w.bodies;
  const i = addPlanet(w, baseX, y, r, rc, pathIndex);
  b.flags[i] = BODY_FLAG.DRIFTING;
  b.m0[i] = baseX; b.m1[i] = amp; b.m2[i] = period; b.m3[i] = phase;
  b.x[i] = b.px[i] = baseX + amp * Math.sin((2 * Math.PI * w.time) / period + phase);
  return i;
}

/** Add a binary pair circling (cx, cy) at radius `half`, `rate` rad/s, member 1 at `phase`. Returns [a, b]. */
export function addBinary(w, cx, cy, half, rate, phase, r = 70, rc = 230, pathIndex = -1) {
  const b = w.bodies;
  const ids = [];
  for (let k = 0; k < 2; k++) {
    const th = phase + Math.PI * k;
    const i = addPlanet(w, cx + half * Math.cos(th + rate * w.time), cy + half * Math.sin(th + rate * w.time), r, rc, pathIndex);
    b.flags[i] = BODY_FLAG.BINARY;
    b.m0[i] = half; b.m1[i] = rate; b.m2[i] = th; b.m3[i] = cx; b.m4[i] = cy;
    ids.push(i);
  }
  b.parent[ids[0]] = ids[1]; b.parent[ids[1]] = ids[0];
  return ids;
}
