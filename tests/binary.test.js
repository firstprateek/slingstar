// Binary pairs (PLAN.md §2.5, Phase 4): "two planets circling a shared centre, each catchable".
// Until Phase 4 every generated "binary" was its own partner (one planet circling an empty centre).
// These tests pin the real pairs: the generator makes two live members, the aim line and latch rules
// treat the partner of the planet being left fairly, the combo rules stay sensible, and the bot
// plays through them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { BODY, BODY_FLAG, COMET, EV } from '../src/contracts.js';
import { createWorld, castRay } from '../src/sim/world.js';
import { createGenerator } from '../src/sim/generator.js';
import { emptyWorld, addPlanet, setFree, driver, ofType, addBinary, botRun } from './helpers.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);
const TAU = 2 * Math.PI;

/** Drive a generator up a course; onPath(w, slot, k) once per path planet k (while it is live). */
function generate(seed, pathCount, onPath) {
  const w = createWorld({ seed, generate: false });
  const gen = createGenerator(w);
  gen.reset(seed);
  let y = 0, seen = 1;
  while (seen <= pathCount) {
    w.comet.y = y; w.front.y = y - CONFIG.FRONT_MAX_LAG;
    gen.update(4);
    while (seen <= pathCount && gen.pathCount > seen) {
      const s = gen.slotOfPath(seen);
      assert.ok(s >= 0);
      onPath(w, s, seen);
      seen++;
    }
    y += 250;
  }
  return gen;
}

test('generated binary pairs are two live, distinct members circling one centre opposite each other, with one path index', (t) => {
  const byZone = {};
  let pairs = 0;
  for (let seed = 1; seed <= 60; seed++) {
    generate(seed, 60, (w, s, k) => {
      const b = w.bodies;
      if (!(b.flags[s] & BODY_FLAG.BINARY)) return;
      const p = b.parent[s];
      assert.ok(p >= 0 && p !== s, `seed ${seed} path ${k}: partner slot ${p} (own slot ${s})`);
      assert.equal(b.alive[p], 1, 'partner alive');
      assert.notEqual(b.id[p], b.id[s], 'distinct bodies');
      assert.equal(b.type[p], BODY.PLANET);
      assert.ok(b.flags[p] & BODY_FLAG.BINARY);
      assert.equal(b.parent[p], s, 'partners point at each other');
      assert.equal(b.pathIndex[p], k, 'same path step');
      assert.ok(b.rc[p] > b.r[p] && b.rc[s] > b.r[s], 'both catchable');
      for (const m of ['m0', 'm1', 'm3', 'm4']) assert.equal(b[m][p], b[m][s], `shared ${m}`);
      let dph = Math.abs(b.m2[p] - b.m2[s]) % TAU;
      near(dph, Math.PI, 1e-9, 'phases π apart');
      near((b.x[s] + b.x[p]) / 2, b.m3[s], 1e-6, 'midpoint is the centre');
      near((b.y[s] + b.y[p]) / 2, b.m4[s], 1e-6);
      near(Math.hypot(b.x[s] - b.x[p], b.y[s] - b.y[p]), 2 * b.m0[s], 1e-6);
      const sep = 2 * b.m0[s];
      assert.ok(sep >= CONFIG.BINARY_SEPARATION_MIN - 1e-6 && sep <= CONFIG.BINARY_SEPARATION_MAX + 1e-6, `separation ${sep}`);
      assert.ok(b.r[s] + b.rc[p] + CONFIG.BODY_GAP <= sep + 1e-6 && b.r[p] + b.rc[s] + CONFIG.BODY_GAP <= sep + 1e-6, 'each body clear of the other ring');
      byZone[b.zone[s]] = (byZone[b.zone[s]] ?? 0) + 1;
      pairs++;
    });
  }
  t.diagnostic(`${pairs} pairs over 60 seeds × 60 path planets, by zone ${JSON.stringify(byZone)}`);
  assert.ok((byZone[5] ?? 0) >= 60, 'binaries in zone 5 on most seeds');
  assert.ok((byZone[6] ?? 0) >= 20, 'and later');
});

test('a binary pair rotates about its shared centre in a live world (BINARY_ANGULAR_SPEED)', () => {
  const r = botRun(7, { stopAt: 52, maxTime: 150, onStep(w) {
    const b = w.bodies;
    for (let i = 0; i < b.count; i++) {
      if (!b.alive[i] || !(b.flags[i] & BODY_FLAG.BINARY)) continue;
      const th = b.m2[i] + b.m1[i] * w.time;
      near(b.x[i], b.m3[i] + b.m0[i] * Math.cos(th), 1e-6, 'binary law');
      near(b.y[i], b.m4[i] + b.m0[i] * Math.sin(th), 1e-6);
      near(Math.abs(b.m1[i]), CONFIG.BINARY_ANGULAR_SPEED, 1e-12);
      const p = b.parent[i];
      if (p >= 0) { near((b.x[i] + b.x[p]) / 2, b.m3[i], 1e-6, 'partner opposite'); near((b.y[i] + b.y[p]) / 2, b.m4[i], 1e-6); }
    }
  } });
  assert.ok(r.pathReached >= 52, `the bot reached path ${r.pathReached}`);
});

/**
 * A still pair (rate 0, so geometry is easy to reason about) at centre (500, 3000): member 0 at
 * (380, 3000), member 1 at (620, 3000), r 60, rings 200, path step 5. Next planet B (path 6) above.
 */
function pairWorld(bx = 530) {
  const w = emptyWorld();
  const [m0, m1] = addBinary(w, 500, 3000, 120, 0, Math.PI, 60, 200, 5);
  const B = addPlanet(w, bx, 3900, 80, 250, 6);
  return { w, m0, m1, B };
}

test('aim line from one member looks past its partner\'s ring to the next planet; the partner\'s body blocks it', () => {
  const { w, m0, m1, B } = pairWorld();
  // Straight up at x = 530: inside m1's ring at the start, 90 from m1's centre (clear of its body), into B's ring.
  assert.equal(castRay(w, 530, 3000, 0, 1, 1200, w.time, m0), B, 'leaving m0: past m1\'s ring onto B');
  // From below the pair (not leaving it), m1's ring is entered first and is a target as usual.
  assert.equal(castRay(w, 510, 2700, 0, 1, 1200, w.time, -1), m1, 'from elsewhere, m1\'s ring is a target as usual');
  // Straight up at x = 600: into m1's body. Dark from m0 (not a lit hop onto the partner).
  assert.equal(castRay(w, 600, 2800, 0, 1, 1200, w.time, m0), -1, 'the partner\'s body blocks the line');
});

test('a lit release from one member flies through its partner\'s ring: a press there arms and catches the lit planet', () => {
  const { w, m0, m1, B } = pairWorld();
  setFree(w, 230, 3000, 0, -1100); // left of m0 heading down: latches m0 counter-clockwise
  const d = driver(w);
  const ev = d.step(true);
  assert.equal(w.comet.body, m0);
  assert.ok(ofType(ev, EV.LATCH)[0].b >= 1, 'a new catch');
  // Orbit until the line lights; it must never light m1 (the partner is no target from m0).
  let k = 0;
  for (; k < 240 && !(w.aim.clear && w.aim.target === B); k++) {
    assert.notEqual(w.aim.target, m1);
    d.step(true);
  }
  assert.ok(w.aim.clear && w.aim.target === B, 'the line lights B');
  const all = d.step(false); // release on the lit line
  assert.equal(ofType(all, EV.RELEASE).length, 1);
  let pressedInPartner = false;
  for (let s = 0; s < 240 && w.comet.state === COMET.FREE && !w.dead; s++) {
    const inM1 = Math.hypot(w.comet.x - w.bodies.x[m1], w.comet.y - w.bodies.y[m1]) < w.bodies.rc[m1];
    if (inM1) pressedInPartner = true;
    all.push(...d.step(true)); // pressed at once and held: armed through m1's ring
  }
  assert.ok(pressedInPartner, 'the flight passed through the partner\'s ring with the hold down');
  assert.equal(w.dead, false);
  assert.equal(w.comet.body, B, 'caught the lit planet, not the partner');
  assert.deepEqual(ofType(all, EV.LATCH).map((e) => e.a), [B]);
  assert.equal(w.score.pathReached, 6);
  assert.equal(ofType(all, EV.COMBO_BREAK).length, 0);
});

test('catching the partner of the planet just left (after a dark release) is allowed, scores nothing and keeps the combo', () => {
  const { w, m0, m1 } = pairWorld(900); // B far to the side: nothing lit along the hop
  setFree(w, 230, 3000, 0, -1100);
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.body, m0);
  const combo = w.score.combo, catches = w.score.catches, score = w.score.score;
  assert.ok(combo >= 1);
  // Counter-clockwise, the bottom of the orbit (angle -π/2) heads right, through m1's ring.
  for (let k = 0; k < 600 && Math.abs(w.comet.orbitAngle + Math.PI / 2) > 0.05; k++) d.step(true);
  assert.ok(Math.abs(w.comet.orbitAngle + Math.PI / 2) <= 0.05);
  assert.equal(w.aim.clear, false, 'a dark line');
  const all = d.step(false);
  for (let s = 0; s < 120 && Math.hypot(w.comet.x - w.bodies.x[m1], w.comet.y - w.bodies.y[m1]) >= w.bodies.rc[m1] - 20; s++) all.push(...d.step(false));
  all.push(...d.step(true)); // press inside m1's ring
  assert.equal(w.comet.body, m1, 'the partner is catchable');
  const latch = ofType(all, EV.LATCH);
  assert.equal(latch.length, 1);
  assert.equal(latch[0].b, 0, 'not a new planet: the pair was caught at m0');
  assert.equal(ofType(all, EV.COMBO_BREAK).length, 0, 'not a re-catch of the planet just left');
  assert.equal(w.score.combo, combo);
  assert.equal(w.score.catches, catches);
  assert.equal(w.score.score, score, 'no catch points');
});

test('the bot plays binaries: catches both members, and every lit release from a member reaches the lit planet', (t) => {
  const catches = [0, 0];
  let lit = 0, broken = 0, deathsOnPair = 0, maxWait = 0;
  const fails = [];
  for (let seed = 1; seed <= 24; seed++) {
    let litPath = -1, fromPair = false, pending = -1, latchT = -1;
    botRun(seed, {
      stopAt: 62, maxTime: 160,
      onStep(w) {
        const c = w.comet, b = w.bodies, a = w.aim;
        litPath = c.state === COMET.ORBIT && a.clear ? b.pathIndex[a.target] : -1;
        fromPair = c.state === COMET.ORBIT && (b.flags[c.body] & BODY_FLAG.BINARY) !== 0;
      },
      onEvent(w, type, x, y, a, bb) {
        const b = w.bodies;
        if (type === EV.RELEASE) {
          if (latchT >= 0) maxWait = Math.max(maxWait, w.time - latchT);
          latchT = -1;
          pending = fromPair && litPath >= 0 ? litPath : -1;
          if (pending >= 0) lit++;
        } else if (type === EV.LATCH) {
          const i = a | 0;
          if (b.flags[i] & BODY_FLAG.BINARY) {
            const p = b.parent[i];
            catches[p >= 0 && b.id[p] < b.id[i] ? 1 : 0]++; // the member committed second is the partner
            latchT = w.time;
          }
          if (pending >= 0 && b.pathIndex[i] !== pending) { broken++; fails.push(`seed ${seed}: lit path ${pending}, caught ${b.pathIndex[i]}`); }
          pending = -1;
        } else if (type === EV.DEATH) {
          if (bb >= 0 && (b.flags[bb] & BODY_FLAG.BINARY)) deathsOnPair++;
          if (pending >= 0) { broken++; fails.push(`seed ${seed}: died on the way to lit path ${pending}`); }
        }
      },
    });
  }
  t.diagnostic(`catches: first member ${catches[0]}, second member ${catches[1]}; ${lit} lit releases from a member, ${broken} broken; ` +
    `deaths on a binary body ${deathsOnPair}; longest stay on a member ${maxWait.toFixed(2)} s${fails.length ? `; ${fails.slice(0, 4).join('; ')}` : ''}`);
  assert.ok(catches[0] >= 20 && catches[1] >= 20, 'both members get caught');
  assert.ok(lit >= 40);
  assert.equal(broken, 0);
  assert.equal(deathsOnPair, 0);
});
