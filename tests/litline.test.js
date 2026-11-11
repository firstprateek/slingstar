// A release on a lit aim line keeps its promise (Phase 4 regression). A bot that lets go whenever
// the line is lit onto a planet higher up died to black holes ~0.25–0.6 s after such releases
// (seeds 100 and 177, zones 9 and 6, among others). The forecast was not the culprit: the black
// hole was not in bodies[0, count) when the line was computed. The generator hides a paused
// placement's tentative bodies between steps (alive = 0); a recycle in that window shrank
// bodies.count below them, and once committed they stayed live beyond `count`, invisible to the
// aim line, collisions and the renderer, until a later allocation grew `count` past them and the
// hole appeared in front of the comet. generator.js showTentative / commitId now keep `count`
// covering every live slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEP } from '../src/config.js';
import { BODY, COMET, EV } from '../src/contracts.js';
import { createWorld } from '../src/sim/world.js';

/**
 * Lit-only bot: in orbit, holds until the aim line is lit onto a planet more than 100 units higher
 * than the one orbited, then lets go; in free flight presses as src/sim/bot.js does. Reports deaths
 * between a lit release and the next latch, and live bodies outside bodies.count after any step.
 */
function litRun(seed, maxTime) {
  const w = createWorld({ seed });
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  let prev = false, pressedHome = false, litNow = false, inFlight = false;
  let releases = 0, broken = 0, outside = 0;
  const fails = [];
  while (!w.dead && w.time < maxTime) {
    const c = w.comet, b = w.bodies, a = w.aim;
    let h;
    if (c.state === COMET.ORBIT) {
      litNow = a.clear && a.target >= 0 && b.y[a.target] > b.y[c.body] + 100;
      if (!w.started && !pressedHome) { pressedHome = true; h = true; } else h = !litNow;
    } else {
      litNow = false;
      if (c.armed) h = true;
      else {
        let inLast = false, inOther = false;
        for (let i = 0; i < b.count; i++) {
          if (!b.alive[i] || b.type[i] !== BODY.PLANET) continue;
          const dx = c.x - b.x[i], dy = c.y - b.y[i];
          if (dx * dx + dy * dy >= b.rc[i] * b.rc[i]) continue;
          if (b.id[i] === c.lastBodyId) inLast = true; else inOther = true;
        }
        h = !inLast || inOther;
      }
    }
    const wasLit = litNow;
    input.held = h; input.pressedThisStep = h && !prev; input.releasedThisStep = !h && prev; prev = h;
    w.step(STEP, input);
    for (let i = w.bodies.count; i < w.bodies.alive.length; i++) if (w.bodies.alive[i]) { outside++; break; }
    const q = w.events;
    for (let i = 0; i < q.count; i++) {
      const t = q.type[i];
      if (t === EV.RELEASE) { inFlight = wasLit; if (wasLit) releases++; }
      else if (t === EV.LATCH) inFlight = false;
      else if (t === EV.DEATH && inFlight) { broken++; fails.push(`seed ${seed} t ${w.time.toFixed(2)} zone ${w.score.zone}: death cause ${q.a[i]}`); }
    }
    q.count = 0;
  }
  return { releases, broken, outside, fails, zone: w.score.zone };
}

test('a release on a lit line never dies before the lit ring: lit-only bot, seeds 100 and 177 (Phase 4 regression)', (t) => {
  for (const seed of [100, 177]) {
    const r = litRun(seed, 180);
    t.diagnostic(`seed ${seed}: ${r.releases} lit releases, reached zone ${r.zone}`);
    assert.equal(r.outside, 0, `seed ${seed}: ${r.outside} steps with a live body outside bodies.count`);
    assert.deepEqual(r.fails, []);
    assert.ok(r.zone >= 10, `seed ${seed}: only reached zone ${r.zone}`);
  }
});

test('every live body lies inside bodies.count after every step (20 seeds × 120 s of lit-only play)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = litRun(seed, 120);
    assert.equal(r.outside, 0, `seed ${seed}: ${r.outside} steps with a live body outside bodies.count`);
    assert.deepEqual(r.fails, []);
  }
});
