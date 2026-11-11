// Generator (PLAN.md §2.6, §8): for 200 seeds × 60 path planets, every consecutive path pair passes
// the solvability rule, measured once every body that could affect the pair exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/sim/world.js';
import { createGenerator, releaseWindowDeg } from '../src/sim/generator.js';
import { solveWindowDeg, zoneOfPathIndex, captureBand } from '../src/sim/scoring.js';
import { CONFIG } from '../src/config.js';
import { BODY, BODY_FLAG } from '../src/contracts.js';

const SEEDS = 200, PATH = 60;
/** A pair (k-1, k) is final once path k + LOOKAHEAD has been placed. */
const LOOKAHEAD = 4;

/** Drive one seed's generator forward by moving a fake comet up; returns per-pair windows. */
function generate(seed, onPair) {
  const w = createWorld({ seed, generate: false });
  const gen = createGenerator(w);
  gen.reset(seed);
  let checked = 1; // next pair end index to check
  let y = 0;
  while (checked <= PATH) {
    w.comet.y = y;
    w.front.y = y - CONFIG.FRONT_MAX_LAG;
    gen.update(4);
    while (checked <= PATH && gen.pathCount > checked + LOOKAHEAD) {
      const a = gen.slotOfPath(checked - 1), b = gen.slotOfPath(checked);
      assert.ok(a >= 0 && b >= 0, `seed ${seed}: path ${checked - 1}/${checked} still alive when checked`);
      onPair(w, a, b, checked);
      checked++;
    }
    y += 250;
    assert.ok(y < 1e7, 'generation stalled');
  }
  return { w, gen };
}

test(`solvability: ${SEEDS} seeds × ${PATH} path planets, every consecutive pair has its window (hazard zones included)`, (t) => {
  let pairs = 0, minMargin = Infinity, worst = '', rerolls = 0, fallbacks = 0;
  // Pairs whose check really involved each hazard (zones 1–6 are all inside 60 path planets).
  const withHazard = { moonOnA: 0, moonOnB: 0, drifting: 0, binary: 0, blackHoleBeside: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { gen } = generate(seed, (w, a, b, k) => {
      const req = solveWindowDeg(zoneOfPathIndex(k));
      const win = releaseWindowDeg(w, a, b);
      if (win - req < minMargin) { minMargin = win - req; worst = `seed ${seed} pair ${k - 1}→${k}: ${win.toFixed(1)}° (need ${req.toFixed(1)}°)`; }
      assert.ok(win >= req, `seed ${seed} pair ${k - 1}→${k}: window ${win}° < ${req}°`);
      pairs++;
      const bd = w.bodies;
      let moonA = false, moonB = false, bh = false;
      const ylo = Math.min(bd.y[a], bd.y[b]) - 400, yhi = Math.max(bd.y[a], bd.y[b]) + 400;
      for (let i = 0; i < bd.count; i++) {
        if (!bd.alive[i]) continue;
        if (bd.type[i] === BODY.MOON && bd.parent[i] === a) moonA = true;
        if (bd.type[i] === BODY.MOON && bd.parent[i] === b) moonB = true;
        if (bd.type[i] === BODY.BLACKHOLE && bd.y[i] > ylo && bd.y[i] < yhi) bh = true;
      }
      if (moonA) withHazard.moonOnA++;
      if (moonB) withHazard.moonOnB++;
      if ((bd.flags[a] | bd.flags[b]) & BODY_FLAG.DRIFTING) withHazard.drifting++;
      if ((bd.flags[a] | bd.flags[b]) & BODY_FLAG.BINARY) withHazard.binary++;
      if (bh) withHazard.blackHoleBeside++;
    });
    rerolls += gen.rerolls; fallbacks += gen.fallbacks;
  }
  t.diagnostic(`${pairs} pairs checked; tightest: ${worst}; re-rolls ${rerolls}, fallbacks ${fallbacks}; ` +
    `pairs with hazards ${JSON.stringify(withHazard)}`);
  assert.equal(pairs, SEEDS * PATH);
  for (const [k, n] of Object.entries(withHazard)) assert.ok(n >= SEEDS, `only ${n} pairs with ${k}`);
});

test('zone elements: none before its zone (moons 2, drift 3, black holes 4, binaries 5); each present in its zone', () => {
  const intro = { moon: 2, drift: 3, blackhole: 4, binary: 5 };
  const present = { moon: 0, drift: 0, blackhole: 0, binary: 0 };
  const N = 60;
  for (let seed = 1; seed <= N; seed++) {
    const seen = {};
    generate(seed, (w) => {
      const bd = w.bodies;
      for (let i = 0; i < bd.count; i++) {
        if (!bd.alive[i]) continue;
        const k = bd.type[i] === BODY.MOON ? 'moon' : bd.type[i] === BODY.BLACKHOLE ? 'blackhole'
          : bd.flags[i] & BODY_FLAG.BINARY ? 'binary' : bd.flags[i] & BODY_FLAG.DRIFTING ? 'drift' : null;
        if (!k) continue;
        assert.ok(bd.zone[i] >= intro[k], `seed ${seed}: ${k} in zone ${bd.zone[i]}`);
        if (bd.zone[i] === intro[k]) seen[k] = 1;
      }
    });
    for (const k of Object.keys(seen)) present[k]++;
  }
  for (const k of Object.keys(intro)) assert.ok(present[k] >= 0.9 * N, `${k} in its zone on only ${present[k]}/${N} seeds`);
});

test('path planets follow the zone rules (radius, capture band, spacing, x range) and pools stay bounded', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { w } = generate(seed, (w, a, b, k) => {
      const bd = w.bodies;
      assert.equal(bd.type[b], BODY.PLANET);
      assert.equal(bd.pathIndex[b], k);
      const z = zoneOfPathIndex(k);
      const r = bd.r[b], band = bd.rc[b] - r;
      assert.ok(Math.abs(band - captureBand(z)) < 1e-3, `band ${band} zone ${z}`);
      assert.ok(r >= CONFIG.PLANET_R_MIN - 1e-3 && r <= CONFIG.PLANET_R_MAX + 1e-3);
      assert.ok(bd.x[b] >= CONFIG.PLANET_X_MIN - 1e-6 && bd.x[b] <= CONFIG.PLANET_X_MAX + 1e-6);
      const s = Math.hypot(bd.x[b] - bd.x[a], bd.y[b] - bd.y[a]);
      assert.ok(s >= CONFIG.PATH_SPACING_MIN - 1e-6 && s <= CONFIG.PATH_SPACING_MAX_LATE + 1e-6, `spacing ${s}`);
      assert.ok(bd.y[b] > bd.y[a]);
    });
    assert.ok(w.bodies.count <= CONFIG.MAX_BODIES);
    assert.ok(w.motes.count <= CONFIG.MAX_MOTES);
  }
});

test('generation is deterministic per seed and differs across seeds', () => {
  const layout = (seed) => {
    const out = [];
    generate(seed, (w, a, b) => { out.push(w.bodies.x[b].toFixed(6), w.bodies.y[b].toFixed(6)); });
    return out.join(',');
  };
  assert.equal(layout(5), layout(5));
  assert.notEqual(layout(5), layout(6));
});

test('in a live world bodies and motes are recycled below the front and the pools never overflow', () => {
  const w = createWorld({ seed: 11 });
  const b = w.bodies;
  let maxBodies = 0, maxMotes = 0;
  // Fake a comet climbing steadily; the front follows FRONT_MAX_LAG behind.
  for (let y = 0; y < 60000; y += 50) {
    w.comet.y = y; w.score.maxHeight = y;
    w.front.y = y - CONFIG.FRONT_MAX_LAG;
    w.step(1 / 120, { held: true, pressedThisStep: false, releasedThisStep: false });
    let live = 0;
    for (let i = 0; i < b.count; i++) if (b.alive[i]) {
      live++;
      assert.ok(b.y[i] + b.rc[i] >= w.front.y - 400, 'nothing lingers far below the front');
    }
    maxBodies = Math.max(maxBodies, live);
    let lm = 0;
    for (let i = 0; i < w.motes.count; i++) if (w.motes.alive[i]) lm++;
    maxMotes = Math.max(maxMotes, lm);
  }
  assert.ok(maxBodies <= CONFIG.MAX_BODIES);
  assert.ok(maxBodies >= 8, `expected a populated field, max live ${maxBodies}`);
  assert.ok(maxMotes > 0, 'stardust lines are generated');
  assert.ok(maxMotes <= CONFIG.MAX_MOTES);
});
