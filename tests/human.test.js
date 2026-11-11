// Feel (PLAN.md §2.7, Phase 2 tuning): a new player's first three catches are easy. The human-like
// bot (tests/humanbot.js: 150–250 ms reactions, 40–80 ms release jitter, occasional late presses)
// reaches path planet 3 alive on at least 95 of 100 seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanRun } from './humanbot.js';

test('human-like bot: first three catches succeed on >= 95 of 100 seeds', (t) => {
  let ok = 0;
  const fails = [];
  for (let seed = 1; seed <= 100; seed++) {
    const r = humanRun(seed, { stopAtPath: 3, maxTime: 60 });
    if (r.pathReached >= 3) ok++; else fails.push(seed);
  }
  t.diagnostic(`first three catches on ${ok}/100 seeds${fails.length ? `; failed: ${fails.join(', ')}` : ''}`);
  assert.ok(ok >= 95, `only ${ok}/100`);
});
