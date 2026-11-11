// Phase 3 rules (PLAN.md §2.4–2.5): moons, black holes, drifting planets, binary pairs, the aim
// line's handling of moving bodies, the wall fix for orbits that reach past a wall, the
// "just-left ring" press rule, and zone-by-zone element introduction in real runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, STEP } from '../src/config.js';
import { BODY, BODY_FLAG, COMET, EV, DEATH_CAUSE } from '../src/contracts.js';
import { castRay } from '../src/sim/world.js';
import {
  emptyWorld, addPlanet, setFree, driver, ofType, addMoon, addBlackHole, addDrifting, addBinary, botRun,
} from './helpers.js';

const DEG = Math.PI / 180;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

// ------------------------------------------------------------------ moons

test('moon: touching one in free flight is death (DEATH_CAUSE.MOON, b = moon slot)', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 60, 250);
  const m = addMoon(w, p, 150, 0, -Math.PI / 2, 18); // parked at (500, 2850)
  setFree(w, 500, 2400, 0, 800);
  const ev = driver(w).run(false, 120);
  const death = ofType(ev, EV.DEATH);
  assert.equal(death.length, 1);
  assert.equal(death[0].a, DEATH_CAUSE.MOON);
  assert.equal(death[0].b, m);
  near(w.comet.y, 2850 - 18 - CONFIG.COMET_RADIUS, 1e-6, 'stops at the moon surface');
});

test('moon: moves with its parent; a decaying orbit that reaches the moon lane dies on the moon', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 60, 250);
  const m = addMoon(w, p, 150, 1, 0, 18);
  setFree(w, 690, 3000, 0, 800);
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.body, p);
  let death = null;
  for (let k = 0; k < 120 * 6 && !death; k++) {
    const ev = d.step(true);
    const b = w.bodies;
    const th = 1 * w.time;
    near(b.x[m], 500 + 150 * Math.cos(th), 1e-9, 'moon x = parent + m0 cos(m2 + m1 t)');
    near(b.y[m], 3000 + 150 * Math.sin(th), 1e-9);
    death = ofType(ev, EV.DEATH)[0] ?? null;
  }
  assert.ok(death, 'the orbit runs into the moon');
  assert.equal(death.a, DEATH_CAUSE.MOON);
  assert.equal(death.b, m);
  assert.ok(w.comet.orbitRadius > 60 + CONFIG.CRASH_ALTITUDE + 30, 'died on the moon, not on the surface');
});

test('aim line predicts moon motion: a moon that will have moved away does not block, one that will swing in does', () => {
  // Ray straight up from (500, 3000) at 1000 u/s; target ring ahead; a moon circling a small body
  // off to the right crosses x = 500 only at angle π (point (500, 3300)), which the comet reaches at t = 0.3 s.
  const build = (phase) => {
    const w = emptyWorld();
    const t = addPlanet(w, 500, 3800, 60, 250);
    const q = addPlanet(w, 800, 3300, 10, 0);
    const m = addMoon(w, q, 300, 3, phase, 18);
    return { w, t, m };
  };
  // A: the moon sits on the ray now (at (500, 3300)) but is long gone when the comet gets there.
  const A = build(Math.PI);
  near(A.w.bodies.x[A.m], 500, 1e-9, 'moon currently on the ray');
  assert.equal(castRay(A.w, 500, 3000, 0, 1, 1000, A.w.time, -1), A.t, 'clear: the moon will have moved');
  setFree(A.w, 500, 3000, 0, 1000);
  const dA = driver(A.w);
  for (let k = 0; k < 90 && A.w.comet.state === COMET.FREE; k++) dA.step(true);
  assert.equal(A.w.dead, false);
  assert.equal(A.w.comet.body, A.t, 'and the flight really reaches the target');

  // B: the moon is off the ray now but arrives at (500, 3300) exactly when the comet does.
  const B = build(Math.PI - 0.9);
  assert.ok(Math.abs(B.w.bodies.x[B.m] - 500) > 100, 'moon currently well off the ray');
  assert.equal(castRay(B.w, 500, 3000, 0, 1, 1000, B.w.time, -1), -1, 'blocked: the moon will be there');
  setFree(B.w, 500, 3000, 0, 1000);
  const evB = driver(B.w).run(false, 60);
  const death = ofType(evB, EV.DEATH);
  assert.equal(death.length, 1, 'and the flight really meets the moon');
  assert.equal(death[0].a, DEATH_CAUSE.MOON);
});

// ------------------------------------------------------------------ black holes

test('black hole: bends free flight with accel = G / r², clamped, only inside the influence radius', () => {
  // One step at 150 from the centre: Δv = G / 150² × dt toward the hole.
  const w = emptyWorld();
  addBlackHole(w, 500, 3000);
  setFree(w, 650, 3000, 0, 800);
  driver(w).step(false);
  near(w.comet.vx, -(CONFIG.BLACKHOLE_G / (150 * 150)) * STEP, 1e-9, 'Δvx');
  near(w.comet.vy, 800, 1e-9);

  // At 50 from the centre G / r² exceeds the clamp.
  const w2 = emptyWorld();
  addBlackHole(w2, 500, 3000);
  setFree(w2, 550, 3000, 0, 800);
  driver(w2).step(false);
  assert.ok(CONFIG.BLACKHOLE_G / 2500 > CONFIG.BLACKHOLE_MAX_ACCEL);
  near(w2.comet.vx, -CONFIG.BLACKHOLE_MAX_ACCEL * STEP, 1e-9, 'clamped Δvx');

  // Outside the influence radius: a straight line.
  const w3 = emptyWorld();
  addBlackHole(w3, 500, 3000);
  setFree(w3, 500 + CONFIG.BLACKHOLE_INFLUENCE_RADIUS + 20, 2500, 0, 800);
  driver(w3).run(false, 180);
  assert.equal(w3.comet.vx, 0);
  assert.equal(w3.comet.speed, 800);

  // A pass at 180 off-centre curves toward the hole and survives.
  const w4 = emptyWorld();
  addBlackHole(w4, 500, 3000);
  setFree(w4, 680, 2500, 0, 800);
  driver(w4).run(false, 180);
  assert.equal(w4.dead, false);
  assert.ok(w4.comet.heading > 100 * DEG, `bent toward the hole: heading ${w4.comet.heading / DEG}°`);
});

test('black hole: cannot be orbited (a press inside the influence only arms); the core kills', () => {
  const w = emptyWorld();
  const h = addBlackHole(w, 500, 3000);
  setFree(w, 500, 2780, 0, 800); // 220 from the centre, inside the influence radius
  const d = driver(w);
  const ev = d.step(true);
  assert.equal(ofType(ev, EV.LATCH).length, 0);
  assert.equal(w.comet.state, COMET.FREE);
  assert.equal(w.comet.armed, true);
  const all = d.run(true, 120);
  const death = ofType(all, EV.DEATH);
  assert.equal(death.length, 1);
  assert.equal(death[0].a, DEATH_CAUSE.BLACKHOLE);
  assert.equal(death[0].b, h);
  assert.ok(Math.hypot(w.comet.x - 500, w.comet.y - 3000) <= CONFIG.BLACKHOLE_CORE_RADIUS + CONFIG.COMET_RADIUS + 1e-6);
});

test('black hole: surviving a deep pass pays the slingshot (EV.SLINGSHOT, 250 × multiplier, ×1.12 speed); a shallow pass does not', () => {
  const w = emptyWorld();
  const h = addBlackHole(w, 500, 3000);
  setFree(w, 680, 2500, 0, 800);
  w.score.combo = 4; w.score.tier = 2; w.score.multiplier = 2;
  const d = driver(w);
  let ev = [], before = 0, speedBefore = 0;
  for (let k = 0; k < 240 && !ofType(ev, EV.SLINGSHOT).length; k++) {
    before = w.score.score;
    ev = d.step(false);
    if (!ofType(ev, EV.SLINGSHOT).length) speedBefore = w.comet.speed;
  }
  const s = ofType(ev, EV.SLINGSHOT);
  assert.equal(s.length, 1);
  assert.equal(s[0].a, h);
  assert.equal(s[0].b, CONFIG.BLACKHOLE_SLINGSHOT_POINTS * 2);
  assert.ok(w.score.score - before >= CONFIG.BLACKHOLE_SLINGSHOT_POINTS * 2);
  // Gravity is conservative: the speed on the way out is back near 800, then the boost applies.
  near(speedBefore, 800, 15, 'speed just before leaving');
  near(w.comet.speed, 800 * CONFIG.BLACKHOLE_SPEED_BOOST, 20, 'boosted speed');
  assert.ok(w.comet.speed > speedBefore * (CONFIG.BLACKHOLE_SPEED_BOOST - 0.02));
  assert.equal(w.dead, false);
  assert.equal(ofType(d.run(false, 120), EV.SLINGSHOT).length, 0, 'one slingshot per pass');

  // Shallow: never gets within BLACKHOLE_SLINGSHOT_DEPTH × influence of the centre.
  const w2 = emptyWorld();
  addBlackHole(w2, 500, 3000);
  setFree(w2, 500 + 0.8 * CONFIG.BLACKHOLE_INFLUENCE_RADIUS + 40, 2500, 0, 800);
  const ev2 = driver(w2).run(false, 240);
  assert.equal(ofType(ev2, EV.SLINGSHOT).length, 0);
  assert.equal(w2.dead, false);
  near(w2.comet.speed, 800, 5);
});

test('black hole: the aim line never lights through an influence radius', () => {
  const w = emptyWorld();
  const t = addPlanet(w, 500, 4000, 60, 250);
  assert.equal(castRay(w, 500, 3000, 0, 1, 900, 0, -1), t);
  addBlackHole(w, 500 + CONFIG.BLACKHOLE_INFLUENCE_RADIUS - 20, 3400); // influence edge 20 over the ray
  assert.equal(castRay(w, 500, 3000, 0, 1, 900, 0, -1), -1);
});

// ------------------------------------------------------------------ drifting planets

test('drifting planet: x = m0 + m1 sin(2π t / m2 + m3), and an orbiting comet moves with it', () => {
  const w = emptyWorld();
  const p = addDrifting(w, 500, 3000, 150, 4, 0, 80, 250);
  setFree(w, 690, 3000, 0, 800);
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.body, p);
  const b = w.bodies;
  let minX = Infinity, maxX = -Infinity;
  for (let k = 0; k < 240; k++) {
    d.step(true);
    near(b.x[p], 500 + 150 * Math.sin((2 * Math.PI * w.time) / 4), 1e-9, 'drift law');
    near(Math.hypot(w.comet.x - b.x[p], w.comet.y - b.y[p]), w.comet.orbitRadius, 1e-9, 'orbit is about the moving centre');
    minX = Math.min(minX, b.x[p]); maxX = Math.max(maxX, b.x[p]);
  }
  assert.equal(w.dead, false);
  assert.equal(w.comet.body, p);
  assert.ok(maxX - minX > 140, `the planet really drifted (${(maxX - minX).toFixed(0)} units)`);
});

test('aim line predicts drift: lights a drifting ring only where the comet will meet it', () => {
  // Small ring above the ray's line; period 2 s, amplitude 150. The comet (1000 u/s from y 3000)
  // crosses the ring's height around t ≈ 0.5 s.
  const make = (phase) => {
    const w = emptyWorld();
    const p = addDrifting(w, 500, 3600, 150, 2, phase, 50, 110);
    return { w, p };
  };
  // Now on the ray, but drifted 150 to the right by the time the comet gets there.
  const A = make(0);
  near(A.w.bodies.x[A.p], 500, 1e-9);
  assert.equal(castRay(A.w, 500, 3000, 0, 1, 1000, 0, -1), -1);
  setFree(A.w, 500, 3000, 0, 1000);
  const dA = driver(A.w);
  dA.run(true, 100);
  assert.notEqual(A.w.comet.body, A.p, 'a held comet really misses it');
  // Now off the ray (static check would say miss), but drifts onto it as the comet arrives.
  const B = make(-Math.PI * 0.5);
  assert.ok(Math.abs(B.w.bodies.x[B.p] - 500) > 140);
  assert.equal(castRay(B.w, 500, 3000, 0, 1, 1000, 0, -1), B.p);
  setFree(B.w, 500, 3000, 0, 1000);
  const dB = driver(B.w);
  for (let k = 0; k < 100 && B.w.comet.state === COMET.FREE; k++) dB.step(true);
  assert.equal(B.w.comet.body, B.p, 'and an armed hold really catches it');
});

// ------------------------------------------------------------------ binary pairs

test('binary pair: both members circle the shared centre opposite each other, and each is catchable', () => {
  for (const member of [0, 1]) {
    const w = emptyWorld();
    const pair = addBinary(w, 500, 3000, 200, CONFIG.BINARY_ANGULAR_SPEED, 0, 70, 230, 5);
    const b = w.bodies;
    const x0 = member === 0 ? 700 : 300;
    setFree(w, x0, 2800, 0, 800);
    const d = driver(w);
    const ev = d.step(true);
    assert.equal(w.comet.state, COMET.ORBIT);
    assert.equal(w.comet.body, pair[member], `member ${member} catchable`);
    assert.equal(ofType(ev, EV.LATCH)[0].b, 1, 'a new catch');
    assert.equal(w.score.pathReached, 5, 'catching either member advances the path');
    for (let k = 0; k < 240; k++) {
      d.step(true);
      const th = CONFIG.BINARY_ANGULAR_SPEED * w.time;
      near(b.x[pair[0]], 500 + 200 * Math.cos(th), 1e-9);
      near(b.y[pair[0]], 3000 + 200 * Math.sin(th), 1e-9);
      near((b.x[pair[0]] + b.x[pair[1]]) / 2, 500, 1e-9, 'partner opposite');
      near((b.y[pair[0]] + b.y[pair[1]]) / 2, 3000, 1e-9);
      const i = pair[member];
      near(Math.hypot(w.comet.x - b.x[i], w.comet.y - b.y[i]), w.comet.orbitRadius, 1e-9, 'orbit about the moving member');
    }
    assert.equal(w.dead, false);
  }
});

// ------------------------------------------------------------------ walls (Phase 2 review fix)

test('wall: a release from an orbit that reaches past the wall turns around in place (no teleport)', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 200, 3000, 80, 250);
  setFree(w, 200, 2770, -800, 0); // bottom of the ring moving left → clockwise
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.body, p);
  assert.equal(w.comet.orbitDir, -1);
  for (let k = 0; k < 600 && w.comet.orbitAngle > -160 * DEG && w.comet.orbitAngle < 0; k++) d.step(true);
  const c = w.comet;
  assert.ok(c.x < -5, `orbit reaches past the wall (x ${c.x.toFixed(1)})`);
  const x0 = c.x, y0 = c.y;
  const ev = d.step(false);
  assert.equal(ofType(ev, EV.RELEASE).length, 1);
  const bo = ofType(ev, EV.BOUNCE);
  assert.equal(bo.length, 1);
  assert.equal(bo[0].a, -1);
  assert.ok(c.vx > 0, 'heading back into the field');
  assert.ok(Math.hypot(c.x - x0, c.y - y0) <= c.speed / (1 - CONFIG.WALL_SPEED_LOSS) * STEP + 1e-6,
    `moved one step, no teleport (${Math.hypot(c.x - x0, c.y - y0).toFixed(2)} units)`);
  // It flies back in without bouncing again.
  const prevX = c.x;
  const more = d.run(false, 30);
  assert.equal(ofType(more, EV.BOUNCE).length, 0);
  assert.ok(c.x > prevX);
  assert.equal(w.dead, false);
});

// ------------------------------------------------------------------ just-left ring (Phase 2 review fix)

test('a press right after a release, still inside the ring just left, arms for the next ring', () => {
  const w = emptyWorld();
  const a = addPlanet(w, 500, 3000, 80, 250);
  const nb = addPlanet(w, 500, 3700, 80, 250);
  setFree(w, 700, 3000, 0, 800);
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.body, a);
  // Let go at once: the tangent heads straight up toward the next ring.
  d.step(false);
  assert.equal(w.comet.state, COMET.FREE);
  const ev = d.step(true); // still well inside a's ring
  assert.ok(Math.hypot(w.comet.x - 500, w.comet.y - 3000) < 250);
  assert.equal(ofType(ev, EV.LATCH).length, 0, 'no latch back onto the planet just left');
  assert.equal(w.comet.armed, true);
  const all = [];
  for (let k = 0; k < 240 && w.comet.state === COMET.FREE; k++) all.push(...d.step(true));
  assert.equal(w.comet.body, nb, 'the armed hold catches the next planet');
  assert.equal(ofType(all, EV.COMBO_BREAK).length, 0);
  assert.equal(w.score.combo, 3, 'perfect catch (+2), then an armed catch (+1)');
});

// ------------------------------------------------------------------ zones in real runs

test('each zone introduces its element in real bot runs: moons 2, drift 3, black holes 4, binaries 5', () => {
  const kindOf = (b, i) => b.type[i] === BODY.MOON ? 'moon' : b.type[i] === BODY.BLACKHOLE ? 'blackhole'
    : b.flags[i] & BODY_FLAG.BINARY ? 'binary' : b.flags[i] & BODY_FLAG.DRIFTING ? 'drift' : null;
  const intro = { moon: 2, drift: 3, blackhole: 4, binary: 5 };
  const seenIn = { moon: 0, drift: 0, blackhole: 0, binary: 0 };
  const SEEDS = 10;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const seen = {};
    botRun(seed, {
      stopAt: 51, maxTime: 120,
      onStep(w) {
        const b = w.bodies;
        for (let i = 0; i < b.count; i++) {
          if (!b.alive[i]) continue;
          const k = kindOf(b, i);
          if (!k) continue;
          assert.ok(b.zone[i] >= intro[k], `seed ${seed}: ${k} generated in zone ${b.zone[i]} before its zone ${intro[k]}`);
          if (b.zone[i] === intro[k]) seen[k] = 1;
        }
      },
    });
    for (const k of Object.keys(seen)) seenIn[k]++;
  }
  for (const k of Object.keys(intro)) assert.ok(seenIn[k] >= SEEDS - 1, `${k} appears in zone ${intro[k]} on only ${seenIn[k]}/${SEEDS} seeds`);
});

// ------------------------------------------------------------------ the aim line keeps its promise

test('a release on a lit aim line catches the lit planet (hazard zones, 40 seeds × 60 s of bot play)', (t) => {
  let releases = 0, broken = 0;
  const fails = [];
  for (let seed = 1; seed <= 40; seed++) {
    let litPath = -1, pending = -1;
    botRun(seed, {
      maxTime: 60,
      onStep(w) {
        const a = w.aim;
        litPath = w.comet.state === COMET.ORBIT && a.clear ? w.bodies.pathIndex[a.target] : -1;
      },
      onEvent(w, type, x, y, a) {
        if (type === EV.RELEASE && litPath >= 0) { pending = litPath; releases++; }
        else if (type === EV.LATCH && pending >= 0) {
          if (w.bodies.pathIndex[a] !== pending) { broken++; fails.push(`seed ${seed} t ${w.time.toFixed(2)}: lit path ${pending}, caught ${w.bodies.pathIndex[a]}`); }
          pending = -1;
        } else if (type === EV.DEATH && pending >= 0) { broken++; fails.push(`seed ${seed} t ${w.time.toFixed(2)}: died on the way to lit path ${pending}`); }
      },
    });
  }
  t.diagnostic(`${releases} lit releases, ${broken} broken${fails.length ? `: ${fails.slice(0, 5).join('; ')}` : ''}`);
  assert.ok(releases > 1500);
  assert.equal(broken, 0);
});
