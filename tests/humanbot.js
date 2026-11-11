// Human-like test bot (Phase 2 tuning; not a test file itself). Unlike src/sim/bot.js, which
// releases on the exact step the aim line lights up and arms its hold the moment it leaves a ring,
// this bot plays with human timing:
//   - it only "sees" a new situation after a reaction delay (150–250 ms);
//   - it plans each release for the centre of the next clear release window (as a player watching
//     the aim line sweep would) and misses that moment by a Gaussian timing error (σ 40–80 ms per
//     player). Its forecast uses the aim line's rule (sim castRay), so it sees moons and
//     drifting / binary planets where they will be;
//   - it presses ahead of the next ring (an armed hold), never while still inside the ring it
//     just left (it waits for the comet to clear it, then reacts), and on some approaches presses
//     late, after the comet is already inside the ring.
// Deterministic: all randomness comes from a mulberry32 seeded per run. Pure (reads world state
// only, like the real bot) and decides one held value per fixed step.
//
// Two release models:
//   - default ("planner", optimistic): forecasts the orbit and aims for the centre of the next
//     clear window, as a practised player who has learnt the rhythm might;
//   - `honest: true` ("reactive"): no forecasting at all. It watches the aim line; once the line is
//     lit onto the next path planet (and the orbit has been perceived), it lets go one sampled
//     reaction time later (reactionMin..reactionMax), whether or not the line is still lit then.
//     When the orbit gets low (altitude < desperateAltitude) it also takes a line lit onto any
//     planet higher up. This is the pessimistic end of human play.
import { CONFIG, STEP } from '../src/config.js';
import { BODY, COMET, EV } from '../src/contracts.js';
import { createRng, hash32 } from '../src/core/rng.js';
import { createWorld, castRay } from '../src/sim/world.js';

export const HUMAN_DEFAULTS = Object.freeze({
  reactionMin: 0.15, reactionMax: 0.25,
  sigmaMin: 0.04, sigmaMax: 0.08,
  /** Normal presses come this far ahead of the predicted ring entry (s). */
  leadMin: 0.05, leadMax: 0.35,
  /** Chance an approach is pressed late — reacting to the ring crossing instead of anticipating
   * it — and how late after ring entry that press lands (s, a reaction time). */
  pLate: 0.06, lateMin: 0.15, lateMax: 0.25,
  /** After the comet clears the ring just left, the earliest press comes this much later (s). */
  exitReactMin: 0.1, exitReactMax: 0.2,
  /** How far ahead the release planner looks (s of orbit). */
  planHorizon: 3,
  /** Reactive release model (see the header). */
  honest: false,
  /** Reactive model: below this altitude a line lit onto any higher planet will do. */
  desperateAltitude: 50,
});

/**
 * @param {number} seed  Player seed (timing randomness), independent of the level seed.
 * @param {Partial<typeof HUMAN_DEFAULTS>} [opts]
 */
export function createHumanBot(seed, opts = {}) {
  const o = { ...HUMAN_DEFAULTS, ...opts };
  const rng = createRng(hash32((seed >>> 0) ^ 0x9e3779b9));
  const sigma = o.sigmaMin + (o.sigmaMax - o.sigmaMin) * rng.next();
  const gauss = () => {
    // Box–Muller, clamped to ±2.5σ (no absurd outliers).
    const u = Math.max(1e-9, rng.next()), v = rng.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(-2.5, Math.min(2.5, z)) * sigma;
  };
  const reaction = () => o.reactionMin + (o.reactionMax - o.reactionMin) * rng.next();

  let mode = 'none';          // 'orbit' | 'free'
  let modeBody = -1;
  let perceiveAt = 0;         // world.time when the current orbit is "seen"
  let releaseAt = -1;         // planned release time (-1: none yet)
  let replanAt = -1;
  let held = false;
  let lead = 0, late = false;
  let insideSince = -1, insideBody = -1, exitAt = -1;

  /** Comet inside the ring of the planet it just left and no other ring (where rings overlap a
   * player presses for the new one, which the latch rule prefers). */
  function insideOnlyLast(w) {
    const c = w.comet, b = w.bodies;
    let last = false;
    for (let i = 0; i < b.count; i++) {
      if (!b.alive[i] || b.type[i] !== BODY.PLANET) continue;
      const dx = c.x - b.x[i], dy = c.y - b.y[i];
      if (dx * dx + dy * dy >= b.rc[i] * b.rc[i]) continue;
      if (b.id[i] === c.lastBodyId) last = true; else return false;
    }
    return last;
  }

  function reset() {
    mode = 'none'; modeBody = -1; releaseAt = -1; replanAt = -1; held = false; insideSince = -1; insideBody = -1;
  }

  /** Next path planet slot after the orbited body. */
  function targetSlot(w) {
    const b = w.bodies, c = w.comet;
    const cur = c.body >= 0 ? b.pathIndex[c.body] : -1;
    const want = (cur >= 0 ? cur : w.score.pathReached) + 1;
    for (let i = 0; i < b.count; i++) if (b.alive[i] && b.type[i] === BODY.PLANET && b.pathIndex[i] === want) return i;
    return -1;
  }

  /**
   * Forecast the orbit forward and return the centre time of the first clear window whose centre
   * is at or after `from` (absolute world time), or -1. `anyAbove`: accept any planet higher up
   * than the one orbited (the lit aim line onto another planet) instead of only the next path one.
   */
  function planRelease(w, from, anyAbove) {
    const c = w.comet, b = w.bodies, i = c.body;
    const t = targetSlot(w);
    if (t < 0 && !anyAbove) return -1;
    let ang = c.orbitAngle, rho = c.orbitRadius, sp = c.speed, laps = c.laps;
    const live = w.started, cap = w.baseSpeed * CONFIG.SPEED_CAP_FACTOR;
    let time = w.time, inWin = false, winStart = 0;
    const end = w.time + o.planHorizon;
    while (time < end) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const px = b.x[i] + ca * rho, py = b.y[i] + sa * rho;
      const dx = -sa * c.orbitDir, dy = ca * c.orbitDir;
      // The same rule as the aim line, with moving bodies where they will be (sim castRay).
      const hitSlot = castRay(w, px, py, dx, dy, sp, time, i);
      const ok = hitSlot >= 0 && (hitSlot === t || (anyAbove && b.y[hitSlot] > b.y[i] + 100));
      if (ok && !inWin) { inWin = true; winStart = time; }
      if (!ok && inWin) {
        inWin = false;
        const centre = (winStart + time - STEP) / 2;
        if (centre >= from) return centre;
      }
      if (live) {
        rho -= (CONFIG.ORBIT_DECAY_BASE + CONFIG.ORBIT_DECAY_PER_LAP * laps) * STEP;
        if (sp < cap) sp = Math.min(cap, sp * (1 + CONFIG.ORBIT_SPEED_GAIN * STEP));
        if (rho - b.r[i] < CONFIG.CRASH_ALTITUDE) break;
      }
      const d = (sp / Math.max(1, rho)) * STEP;
      ang += c.orbitDir * d;
      if (live) laps += d / (2 * Math.PI);
      time += STEP;
    }
    return -1;
  }

  /** Time until the comet enters the first ring ahead (0 when already inside a fresh ring), and which. */
  function ringAhead(w) {
    const c = w.comet, b = w.bodies;
    const sp = c.speed > 0 ? c.speed : 1, dx = c.vx / sp, dy = c.vy / sp;
    let best = Infinity, bi = -1;
    for (let i = 0; i < b.count; i++) {
      if (!b.alive[i] || b.type[i] !== BODY.PLANET || b.rc[i] <= 0) continue;
      const fx = c.x - b.x[i], fy = c.y - b.y[i];
      const cc = fx * fx + fy * fy - b.rc[i] * b.rc[i];
      if (cc <= 0) {
        if (b.id[i] === c.lastBodyId) continue;   // still leaving the planet just released
        if (0 < best) { best = 0; bi = i; }
        continue;
      }
      const fd = fx * dx + fy * dy;
      if (fd > 0 || fd * fd < cc) continue;
      const d = -fd - Math.sqrt(fd * fd - cc);
      if (d < best) { best = d; bi = i; }
    }
    return { time: best / sp, body: bi };
  }

  /** @param {import('../src/contracts.js').WorldT} w */
  function decide(w) {
    const c = w.comet;
    if (w.dead || c.state === COMET.DEAD) { held = false; return false; }

    if (c.state === COMET.ORBIT) {
      if (mode !== 'orbit' || modeBody !== c.bodyId) {
        mode = 'orbit'; modeBody = c.bodyId;
        perceiveAt = w.time + reaction();
        releaseAt = -1; replanAt = -1;
        if (!w.started) held = true;   // touch down on the home planet, release later
      }
      if (o.honest) {
        if (releaseAt < 0 && w.time >= perceiveAt && w.aim.clear && w.aim.target >= 0) {
          const b = w.bodies, tg = w.aim.target;
          const cur = b.pathIndex[c.body];
          const want = (cur >= 0 ? cur : w.score.pathReached) + 1;
          const onPath = b.pathIndex[tg] === want;
          const higher = b.y[tg] > b.y[c.body] + 100;
          if (onPath || (higher && w.started && c.altitude < o.desperateAltitude)) releaseAt = w.time + reaction();
        }
      } else if (releaseAt < 0 && w.time >= perceiveAt && (replanAt < 0 || w.time >= replanAt)) {
        let centre = planRelease(w, w.time, false);
        if (centre < 0) centre = planRelease(w, w.time, true);
        if (centre >= 0) releaseAt = centre + gauss();
        else replanAt = w.time + 0.5;
      }
      // Nothing lights up and the orbit is about to crash: bail out heading upward.
      if (releaseAt < 0 && w.started && c.altitude < CONFIG.CRASH_ALTITUDE + 20 && c.vy > 0.3 * c.speed) releaseAt = w.time;
      if (!w.started) {
        // Pre-start the home orbit only lets go on a release edge: hold, then lift at the plan.
        held = !(releaseAt >= 0 && w.time >= releaseAt);
        return held;
      }
      held = !(releaseAt >= 0 && w.time >= releaseAt);
      return held;
    }

    // Free flight.
    if (mode !== 'free') {
      mode = 'free'; modeBody = -1; held = false;
      late = rng.next() < o.pLate;
      lead = late ? -(o.lateMin + (o.lateMax - o.lateMin) * rng.next()) : o.leadMin + (o.leadMax - o.leadMin) * rng.next();
      insideSince = -1; insideBody = -1; exitAt = -1;
    }
    if (held) return true;   // armed: keep holding until it latches
    // A player does not press while the comet is still inside the ring it just left (that would
    // re-catch it); they wait for it to clear the ring and react to that.
    if (insideOnlyLast(w)) { exitAt = -1; return false; }
    if (exitAt < 0) exitAt = w.time + o.exitReactMin + (o.exitReactMax - o.exitReactMin) * rng.next();
    const ra = ringAhead(w);
    if (ra.body < 0) return false;
    if (w.time < exitAt && !(late && ra.time === 0)) return false;
    if (!late) {
      if (ra.time <= lead) held = true;
    } else if (ra.time === 0) {
      if (insideBody !== ra.body) { insideBody = ra.body; insideSince = w.time; }
      if (w.time - insideSince >= -lead) held = true;
    }
    return held;
  }

  return { decide, reset, sigma, get late() { return late; }, get exitAt() { return exitAt; } };
}

/**
 * Play one level seed with the human-like bot until death or maxTime.
 * Returns run statistics, including how the first three flights went.
 */
export function humanRun(seed, { maxTime = 300, player = seed, opts, stopAtPath = Infinity } = {}) {
  const w = createWorld({ seed });
  const bot = createHumanBot(player, opts);
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  let prev = false, cause = -1, flights = 0, directCatches = 0, firstThreeDirect = true, firstThreeDone = false;
  let wantPath = 1, releaseTime = 0, startTime = -1, firstCatchTimes = [];
  while (!w.dead && w.time - Math.max(0, startTime) < maxTime && w.score.pathReached < stopAtPath) {
    if (w.time > 60 && startTime < 0) break; // never released (should not happen)
    const h = bot.decide(w);
    input.held = h; input.pressedThisStep = h && !prev; input.releasedThisStep = !h && prev; prev = h;
    w.step(STEP, input);
    const q = w.events;
    for (let i = 0; i < q.count; i++) {
      const t = q.type[i];
      if (t === EV.RELEASE) {
        if (startTime < 0) startTime = w.time;
        flights++; releaseTime = w.time;
        const b = w.bodies;
        // intended target is the path planet after the one left
        wantPath = w.score.pathReached + 1;
      } else if (t === EV.LATCH) {
        const pi = w.bodies.pathIndex[q.a[i] | 0];
        if (flights <= 3 && !firstThreeDone) {
          if (pi === wantPath) { directCatches++; firstCatchTimes.push(w.time - releaseTime); }
          else firstThreeDirect = false;
          if (flights === 3) firstThreeDone = true;
        }
      } else if (t === EV.DEATH) cause = q.a[i];
    }
    if (w.dead && flights <= 3 && !firstThreeDone) firstThreeDirect = false;
    q.count = 0;
  }
  const runTime = startTime < 0 ? 0 : w.time - startTime;
  return {
    seed, dead: w.dead, cause, time: runTime, score: w.score.score, zone: w.score.zone,
    pathReached: w.score.pathReached, firstThree: w.score.pathReached >= 3 || (!w.dead && false),
    firstThreeDirect: firstThreeDirect && directCatches >= 3, catches: w.score.catches,
    speed: w.comet.speed, baseSpeed: w.baseSpeed,
  };
}
