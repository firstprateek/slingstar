// Generator, Phase 4 fixes: generation work per step is bounded and deterministic (a resumable job),
// release windows are guaranteed in time as well as in degrees, moon lanes stay out of other
// capture rings, and side planets keep an onward window (no dead ends).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/sim/world.js';
import { createGenerator, releaseWindowDeg, releaseWindowSeconds } from '../src/sim/generator.js';
import { solveWindowDeg, zoneOfPathIndex } from '../src/sim/scoring.js';
import { CONFIG } from '../src/config.js';
import { BODY, BODY_FLAG } from '../src/contracts.js';
import { botRun } from './helpers.js';

/** A pair (k-1, k) is final once path k + LOOKAHEAD has been placed. */
const LOOKAHEAD = 4;
/** Comet-centre clearance the generator keeps from a moon's surface (generator.js MOON_CLEAR). */
const MOON_CLEAR = Math.max(CONFIG.SOLVE_CLEARANCE, CONFIG.COMET_RADIUS + CONFIG.MOON_SAFE_GAP);

/**
 * Drive a generator with a fake comet climbing `climb` units per call. `budgeted`: call update()
 * with no count (the per-step path world.step uses) instead of update(4). onPair(w, gen, a, b, k)
 * sees each consecutive pair once it is final; onCall(w, gen) after every update.
 */
function drive(seed, { pathCount, climb, budgeted, onPair, onCall }) {
  const w = createWorld({ seed, generate: false });
  const gen = createGenerator(w);
  gen.reset(seed);
  let checked = 1, y = 0;
  if (budgeted) { w.comet.y = 0; w.front.y = -CONFIG.FRONT_MAX_LAG; gen.update(1000); }
  while (checked <= pathCount) {
    w.comet.y = y; w.score.maxHeight = y;
    w.front.y = y - CONFIG.FRONT_MAX_LAG;
    if (budgeted) gen.update(); else gen.update(4);
    if (onCall) onCall(w, gen);
    while (checked <= pathCount && gen.pathCount > checked + LOOKAHEAD) {
      const a = gen.slotOfPath(checked - 1), b = gen.slotOfPath(checked);
      assert.ok(a >= 0 && b >= 0, `seed ${seed}: path ${checked - 1}/${checked} still alive when checked`);
      if (onPair) onPair(w, gen, a, b, checked);
      checked++;
    }
    y += climb;
    assert.ok(y < 1e7, 'generation stalled');
  }
  return { w, gen };
}

/**
 * Every live body by id: layout fingerprint (positions at world time 0, which these drives never
 * advance). With `strict`, a live body must be committed: a non-zero id whose layout never changes
 * (an uncommitted try in a reused slot would show a stale id with a new layout).
 */
function fingerprint(w, into, strict = false) {
  const b = w.bodies;
  for (let i = 0; i < b.count; i++) {
    if (!b.alive[i]) continue;
    if (strict) assert.notEqual(b.id[i], 0, `slot ${i} is live but was never committed`);
    const f = [b.type[i], b.flags[i], b.pathIndex[i], b.x[i], b.y[i], b.r[i], b.rc[i], b.m0[i], b.m1[i], b.m2[i]].join(',');
    if (!into.has(b.id[i])) into.set(b.id[i], f);
    else if (strict) assert.equal(f, into.get(b.id[i]), `slot ${i} (id ${b.id[i]}) is live with an uncommitted layout`);
  }
}

test('budgeted generation: bounded work per step, never urgent, only committed bodies live between steps, and the same course as unbudgeted', () => {
  // 2400 units/s at 120 Hz: faster than the comet's sustained climb (speed cap 2080, plus boosts).
  const climb = 20, slack = 2000; // one indivisible step of work (a try, a scan setup, a ray) is far below this
  const cap = CONFIG.GEN_STEP_BUDGET * CONFIG.GEN_CATCHUP_MAX + slack;
  let maxWork = 0, calls = 0, minAhead = Infinity;
  for (let seed = 1; seed <= 12; seed++) {
    const budgeted = new Map(), plain = new Map();
    const { gen } = drive(seed, {
      pathCount: 70, climb, budgeted: true,
      onCall(w, g) {
        calls++;
        if (g.work > maxWork) maxWork = g.work;
        const top = g.slotOfPath(g.pathCount - 1);
        if (top >= 0) minAhead = Math.min(minAhead, w.bodies.y[top] - w.comet.y);
        fingerprint(w, budgeted, true);
      },
    });
    assert.equal(gen.urgent, 0, `seed ${seed}: generation fell behind (urgent steps ${gen.urgent})`);
    const last = gen.pathCount;
    drive(seed, { pathCount: 70, climb: 250, budgeted: false, onCall(w, g) { if (g.pathCount <= last) fingerprint(w, plain); } });
    for (const [id, f] of budgeted) if (plain.has(id)) assert.equal(f, plain.get(id), `seed ${seed}: body ${id} differs when the work is split across steps`);
    assert.ok(budgeted.size > 100, `seed ${seed}: compared only ${budgeted.size} bodies`);
  }
  assert.ok(maxWork <= cap, `an update used ${maxWork} work units (budget ${CONFIG.GEN_STEP_BUDGET}, catch-up ×${CONFIG.GEN_CATCHUP_MAX})`);
  assert.ok(minAhead >= CONFIG.GEN_URGENT_AHEAD, `course ended only ${minAhead} above the comet`);
  assert.ok(calls > 10000);
});

test('budgeted generation inside a live world is deterministic (bot play into the hazard zones)', () => {
  for (const seed of [7, 77]) {
    const a = botRun(seed, { maxTime: 50 }), b = botRun(seed, { maxTime: 50 });
    assert.ok(a.zone >= 4, `seed ${seed}: the bot only reached zone ${a.zone}`);
    assert.equal(a.w.hash(), b.w.hash(), `seed ${seed}: same seed and input, different world`);
    assert.equal(a.w.steps, b.w.steps);
  }
});

test(`time rule: every pair (and every side planet's onward pair) keeps ${CONFIG.SOLVE_WINDOW_MIN_S * 1000} ms at the assumed speed`, (t) => {
  const SEEDS = 30, PATH = 90; // zones 1–9
  let pairs = 0, sides = 0, tightest = Infinity, where = '';
  for (let seed = 1; seed <= SEEDS; seed++) {
    drive(seed, {
      pathCount: PATH, climb: 250, budgeted: false,
      onPair(w, gen, a, b, k) {
        const sec = releaseWindowSeconds(w, a, b);
        if (sec < tightest) { tightest = sec; where = `seed ${seed} pair ${k - 1}→${k}`; }
        assert.ok(sec >= CONFIG.SOLVE_WINDOW_MIN_S - 1e-9, `seed ${seed} pair ${k - 1}→${k}: ${(sec * 1000).toFixed(1)} ms`);
        pairs++;
        const s = gen.sideOf(k);
        if (s >= 0) {
          const ss = releaseWindowSeconds(w, s, b), deg = releaseWindowDeg(w, s, b);
          assert.ok(ss >= CONFIG.SOLVE_WINDOW_MIN_S - 1e-9, `seed ${seed} side planet → path ${k}: ${(ss * 1000).toFixed(1)} ms`);
          assert.ok(deg >= solveWindowDeg(zoneOfPathIndex(k)), `seed ${seed} side planet → path ${k}: ${deg}°`);
          sides++;
        }
      },
    });
  }
  t.diagnostic(`${pairs} path pairs, ${sides} side planets; tightest ${(tightest * 1000).toFixed(1)} ms (${where})`);
  assert.equal(pairs, SEEDS * PATH);
  assert.ok(sides >= SEEDS * 4, `only ${sides} side planets checked`);
});

/** Smallest distance between segments p0→p1 and q0→q1. */
function segDist(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const pt = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  };
  return Math.min(pt(p0x, p0y, q0x, q0y, q1x, q1y), pt(p1x, p1y, q0x, q0y, q1x, q1y), pt(q0x, q0y, p0x, p0y, p1x, p1y), pt(q1x, q1y, p0x, p0y, p1x, p1y));
}

/** Region a planet's centre sweeps: [x0, y0, x1, y1, reach]. */
function sweep(b, i) {
  if (b.flags[i] & BODY_FLAG.BINARY) return [b.m3[i], b.m4[i], b.m3[i], b.m4[i], b.m0[i]];
  if (b.flags[i] & BODY_FLAG.DRIFTING) { const a = Math.abs(b.m1[i]); return [b.m0[i] - a, b.y[i], b.m0[i] + a, b.y[i], 0]; }
  return [b.x[i], b.y[i], b.x[i], b.y[i], 0];
}

test('moon lanes stay clear of every other planet\'s capture ring, over both bodies\' motion', () => {
  let moons = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const seen = new Set();
    drive(seed, {
      pathCount: 70, climb: 250, budgeted: false,
      onCall(w) {
        const b = w.bodies;
        for (let m = 0; m < b.count; m++) {
          if (!b.alive[m] || b.type[m] !== BODY.MOON) continue;
          const p = b.parent[m];
          if (!seen.has(b.id[m])) { seen.add(b.id[m]); moons++; }
          const [px0, py0, px1, py1, pr] = sweep(b, p);
          for (let k = 0; k < b.count; k++) {
            if (k === p || !b.alive[k] || b.type[k] !== BODY.PLANET) continue;
            const [kx0, ky0, kx1, ky1, kr] = sweep(b, k);
            const d = segDist(px0, py0, px1, py1, kx0, ky0, kx1, ky1) - pr - kr;
            const need = b.rc[k] + b.m0[m] + b.r[m] + MOON_CLEAR;
            assert.ok(d >= need - 1e-6, `seed ${seed}: moon ${b.id[m]} lane comes ${(need - d).toFixed(1)} units into planet ${b.id[k]}'s ring margin`);
          }
        }
      },
    });
  }
  assert.ok(moons > 500, `only ${moons} moons generated`);
});
