// Fairness (PLAN.md §8): the bot (holds in rings, releases when the aim ray is clear onto the next
// path planet) reaches zone 4 — pathReached >= 30 — on at least 90 of 100 seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botRun } from './helpers.js';
import { EV, COMET } from '../src/contracts.js';
import { CONFIG } from '../src/config.js';

const CAUSE = ['planet', 'moon', 'blackhole', 'front'];

test('bot reaches zone 4 on at least 90 of 100 seeds', (t) => {
  let reached = 0, sumPath = 0, sumTime = 0;
  const causes = {};
  const failures = [];
  for (let seed = 1; seed <= 100; seed++) {
    const r = botRun(seed, { stopAt: 30, maxTime: 180 });
    sumPath += r.pathReached;
    if (r.pathReached >= 30) { reached++; sumTime += r.time; } else failures.push(`seed ${seed}: path ${r.pathReached}, ${r.dead ? CAUSE[r.cause] : 'timeout'}`);
    const k = r.dead ? CAUSE[r.cause] : r.pathReached >= 30 ? 'reached' : 'timeout';
    causes[k] = (causes[k] ?? 0) + 1;
  }
  t.diagnostic(`zone 4 reached on ${reached}/100 seeds; mean pathReached ${(sumPath / 100).toFixed(1)}; ` +
    `mean time to zone 4 ${(sumTime / Math.max(1, reached)).toFixed(1)}s; outcomes ${JSON.stringify(causes)}`);
  if (failures.length) t.diagnostic(failures.join('; '));
  assert.ok(reached >= 90, `only ${reached}/100 seeds reached zone 4`);
});

test('bot plays honestly: releases follow the aim line, aim assist never exceeds 3°, no wall bounces', (t) => {
  let releases = 0, assisted = 0, maxAssist = 0, bounces = 0;
  for (let seed = 1; seed <= 10; seed++) {
    let prevHeading = 0;
    botRun(seed, {
      stopAt: 40, maxTime: 120,
      onEvent(w, type, x, y, a, b) {
        if (type === EV.RELEASE) {
          releases++;
          let d = Math.abs(b - prevHeading);
          if (d > Math.PI) d = 2 * Math.PI - d;
          const deg = (d * 180) / Math.PI;
          if (deg > 1e-6) assisted++;
          maxAssist = Math.max(maxAssist, deg);
        }
        if (type === EV.BOUNCE) bounces++;
      },
      onStep(w) { if (w.comet.state === COMET.ORBIT) prevHeading = w.comet.heading; },
    });
  }
  assert.ok(releases > 300);
  assert.ok(maxAssist <= CONFIG.AIM_ASSIST_DEG + 1e-6, `max assist ${maxAssist}°`);
  assert.equal(bounces, 0);
  t.diagnostic(`${releases} releases, ${assisted} aim-assisted, max assist ${maxAssist.toFixed(2)}°`);
});

test('bot statistics over 100 seeds × 90 s (diagnostic; asserts only sanity)', (t) => {
  let sumPath = 0, minPath = Infinity, maxPath = 0, sumZone = 0;
  const causes = {};
  for (let seed = 1; seed <= 100; seed++) {
    const r = botRun(seed, { maxTime: 90 });
    sumPath += r.pathReached; sumZone += r.zone;
    minPath = Math.min(minPath, r.pathReached); maxPath = Math.max(maxPath, r.pathReached);
    const k = r.dead ? CAUSE[r.cause] : 'alive';
    causes[k] = (causes[k] ?? 0) + 1;
  }
  t.diagnostic(`90s runs: mean pathReached ${(sumPath / 100).toFixed(1)} (min ${minPath}, max ${maxPath}), ` +
    `mean zone ${(sumZone / 100).toFixed(1)}, outcomes ${JSON.stringify(causes)}`);
  assert.ok(minPath >= 30);
});
