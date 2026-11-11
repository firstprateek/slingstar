// Shared test helpers (not a test file itself: node --test only runs *.test.js).
import { createWorld } from '../src/sim/world.js';
import { createBot } from '../src/sim/bot.js';
import { CONFIG, STEP } from '../src/config.js';
import { BODY, COMET, EV } from '../src/contracts.js';

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
