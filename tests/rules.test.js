// Zone-1 rules (PLAN.md §2.1–2.3): latching, armed hold, perfect catch, orbit decay, graze, wall
// bounce, combo resets, collapse front, pre-start, aim line and assist, near miss, motes, zones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/sim/world.js';
import { CONFIG, STEP } from '../src/config.js';
import { BODY, COMET, EV, COMBO_BREAK_REASON, DEATH_CAUSE } from '../src/contracts.js';
import { emptyWorld, addPlanet, setFree, driver, ofType } from './helpers.js';

const DEG = Math.PI / 180;
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

// ------------------------------------------------------------------ latching

test('press inside a ring latches at once; CCW when cross(rel, v) > 0; radius = current distance', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000);
  setFree(w, 700, 3000, 0, 800); // right of centre, moving up → counter-clockwise
  const ev = driver(w).step(true);
  const c = w.comet;
  assert.equal(c.state, COMET.ORBIT);
  assert.equal(c.body, p);
  assert.equal(c.orbitDir, 1);
  near(c.orbitRadius, 200, 0.5, 'orbit radius');
  near(c.speed, 800, 1, 'speed unchanged at latch');
  assert.equal(ofType(ev, EV.LATCH).length, 1);
  assert.equal(ofType(ev, EV.LATCH)[0].a, p);
});

test('latch direction is clockwise when cross(rel, v) < 0 (both mirror cases)', () => {
  for (const [x, vy] of [[700, -800], [300, 800]]) {
    const w = emptyWorld();
    addPlanet(w, 500, 3000);
    setFree(w, x, 3000, 0, vy);
    driver(w).step(true);
    assert.equal(w.comet.state, COMET.ORBIT);
    assert.equal(w.comet.orbitDir, -1, `x=${x} vy=${vy}`);
  }
  const w = emptyWorld();
  addPlanet(w, 500, 3000);
  setFree(w, 300, 3000, 0, -800); // left of centre moving down → CCW
  driver(w).step(true);
  assert.equal(w.comet.orbitDir, 1);
});

test('armed hold: press outside every ring arms, then latches the instant the comet enters a ring', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 600, 2600, 0, 800); // 412 from centre, heading into the ring
  const d = driver(w);
  let ev = d.step(true);
  assert.equal(w.comet.state, COMET.FREE);
  assert.equal(w.comet.armed, true);
  assert.equal(ofType(ev, EV.LATCH).length, 0);
  let steps = 0;
  const all = [];
  while (w.comet.state === COMET.FREE && steps++ < 120) all.push(...d.step(true));
  assert.equal(w.comet.state, COMET.ORBIT);
  assert.equal(w.comet.body, p);
  assert.equal(w.comet.armed, false);
  near(w.comet.orbitRadius, 250, 1, 'latched at the ring edge');
  assert.equal(ofType(all, EV.LATCH).length, 1);
  assert.equal(ofType(all, EV.PERFECT).length, 0, 'an armed latch is never perfect');
});

test('armed latch is swept: a fast comet cannot skip a thin ring chord between steps', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 250);
  // Passes 248 units from the centre: the chord inside the ring is ~63 units, travel per step is ~25.
  setFree(w, 500 + 248, 2500, 0, 3000);
  const d = driver(w);
  d.step(true);
  for (let k = 0; k < 120 && w.comet.state === COMET.FREE; k++) d.step(true);
  assert.equal(w.comet.state, COMET.ORBIT);
  assert.equal(w.comet.body, p);
});

test('releasing the hold disarms; entering a ring without a hold does not latch', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 700, 2500, 0, 800);
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.armed, true);
  d.step(false);
  assert.equal(w.comet.armed, false);
  const ev = d.run(false, 120);
  assert.equal(ofType(ev, EV.LATCH).length, 0);
  assert.equal(w.comet.state, COMET.FREE);
});

test('pressing where two rings overlap prefers the ring that is not the planet just left', () => {
  const w = emptyWorld();
  const a = addPlanet(w, 500, 3000, 80, 280);
  const b = addPlanet(w, 500, 3520, 80, 280);
  setFree(w, 700, 3000, 0, 800);
  const d = driver(w);
  d.step(true);
  assert.equal(w.comet.body, a);
  d.step(false); // release (heading roughly up)
  const c = w.comet;
  c.x = c.px = 560; c.y = c.py = 3260; // inside both rings
  d.step(true);
  assert.equal(w.comet.body, b);
});

// ------------------------------------------------------------------ perfect catch

test('perfect catch: press inside the ring with radial speed under 15% of speed', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000);
  setFree(w, 700, 3000, 0, 800);
  const ev = driver(w).step(true);
  const perf = ofType(ev, EV.PERFECT);
  assert.equal(perf.length, 1);
  assert.equal(perf[0].a, p);
  assert.equal(perf[0].b, CONFIG.POINTS_PERFECT * 1);
  assert.equal(w.score.combo, 2, 'perfect gives combo +2');
  assert.equal(w.score.perfects, 1);
  assert.equal(ofType(ev, EV.COMBO_UP)[0].b, 2);
});

test('perfect threshold: 14% radial is perfect, 16% is not', () => {
  for (const [frac, expect] of [[0.14, 1], [0.16, 0]]) {
    const w = emptyWorld();
    addPlanet(w, 500, 3000);
    const vr = frac * 800, vt = Math.sqrt(800 * 800 - vr * vr);
    setFree(w, 700, 3000, -vr, vt); // radial component points inward
    const ev = driver(w).step(true);
    assert.equal(w.comet.state, COMET.ORBIT);
    assert.equal(ofType(ev, EV.PERFECT).length, expect, `radial ${frac}`);
    assert.equal(w.score.combo, expect ? 2 : 1);
    assert.equal(w.score.score, expect ? 250 : 100);
  }
});

// ------------------------------------------------------------------ orbiting

test('orbit decays at 15 + 25 × laps units/s, speed rises 6%/s, and holding too long crashes', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 700, 3000, 0, 800);
  const d = driver(w);
  const all = d.step(true);
  const c = w.comet;
  near(c.orbitRadius, 200 - CONFIG.ORBIT_DECAY_BASE * STEP, 1e-9, 'first step decays at the base rate');
  let prevR = c.orbitRadius, steps = 1, checkedRate = false;
  while (!w.dead && steps < 120 * 20) {
    const laps = c.laps;
    all.push(...d.step(true));
    steps++;
    if (w.dead) break;
    assert.ok(c.orbitRadius < prevR, 'radius strictly decreases');
    if (!checkedRate && laps > 1) {
      near(prevR - c.orbitRadius, (CONFIG.ORBIT_DECAY_BASE + CONFIG.ORBIT_DECAY_PER_LAP * laps) * STEP, 1e-9, 'decay rate after a lap');
      checkedRate = true;
    }
    if (steps === 120) near(c.speed, 800 * Math.pow(1 + CONFIG.ORBIT_SPEED_GAIN * STEP, 120), 1e-6, 'speed after 1s');
    prevR = c.orbitRadius;
  }
  assert.ok(checkedRate);
  assert.equal(w.dead, true);
  const death = ofType(all, EV.DEATH);
  assert.equal(death.length, 1);
  assert.equal(death[0].a, DEATH_CAUSE.PLANET);
  assert.equal(death[0].b, p);
  assert.ok(prevR - 80 >= CONFIG.CRASH_ALTITUDE - 1, 'did not crash early');
  // Graze: exactly one start before the crash and one end at it.
  const graze = ofType(all, EV.GRAZE).map((e) => e.a);
  assert.deepEqual(graze, [1, 0]);
  assert.ok(w.score.score > 250, 'graze paid points');
});

test('orbit speed gain stops at baseSpeed × SPEED_CAP_FACTOR', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 60, 260);
  const cap = w.baseSpeed * CONFIG.SPEED_CAP_FACTOR;
  setFree(w, 750, 3000, 0, cap - 5);
  const d = driver(w);
  d.run(true, 120);
  assert.equal(w.comet.state, COMET.ORBIT);
  assert.equal(w.comet.speed, cap);
});

// ------------------------------------------------------------------ walls

test('wall bounce: vx flips, speed -10% (never below base), combo resets', () => {
  const w = emptyWorld();
  setFree(w, 30, 3000, -900, 300);
  w.score.combo = 4; w.score.tier = 2; w.score.multiplier = 2;
  const d = driver(w);
  const ev = d.run(false, 10);
  const b = ofType(ev, EV.BOUNCE);
  assert.equal(b.length, 1);
  assert.equal(b[0].a, -1);
  const expected = Math.hypot(900, 300) * (1 - CONFIG.WALL_SPEED_LOSS);
  near(b[0].b, expected, 1e-9);
  near(w.comet.speed, expected, 1e-9);
  assert.ok(w.comet.vx > 0);
  near(Math.hypot(w.comet.vx, w.comet.vy), expected, 1e-9);
  const br = ofType(ev, EV.COMBO_BREAK);
  assert.equal(br.length, 1);
  assert.equal(br[0].a, 4);
  assert.equal(br[0].b, COMBO_BREAK_REASON.WALL);
  assert.equal(w.score.combo, 0);
  assert.equal(w.score.multiplier, 1);
  assert.equal(ofType(ev, EV.TIER_UP).length, 0, 'no TIER_UP on a drop');
  assert.equal(w.dead, false);

  const w2 = emptyWorld();
  setFree(w2, 970, 3000, 820, 0);
  const ev2 = driver(w2).run(false, 10);
  const b2 = ofType(ev2, EV.BOUNCE);
  assert.equal(b2.length, 1);
  assert.equal(b2[0].a, 1);
  assert.equal(w2.comet.speed, w2.baseSpeed, 'speed floor is base speed');
  assert.ok(w2.comet.vx < 0);
});

// ------------------------------------------------------------------ combo

test('combo +1 per new planet, TIER_UP at 3, re-catching an older planet changes nothing', () => {
  const w = emptyWorld();
  const ps = [addPlanet(w, 300, 3000), addPlanet(w, 700, 4000), addPlanet(w, 300, 5000), addPlanet(w, 700, 6000)];
  const d = driver(w);
  const all = [];
  // Non-perfect entries (strong inward radial velocity), then release.
  const catchAt = (i) => {
    const b = w.bodies;
    setFree(w, b.x[i] + 200, b.y[i], -600, 529);
    all.push(...d.step(true));
    assert.equal(w.comet.body, i);
    all.push(...d.step(false));
  };
  catchAt(ps[0]); catchAt(ps[1]);
  assert.equal(w.score.combo, 2);
  assert.equal(ofType(all, EV.TIER_UP).length, 0);
  catchAt(ps[2]);
  assert.equal(w.score.combo, 3);
  const tu = ofType(all, EV.TIER_UP);
  assert.equal(tu.length, 1);
  assert.equal(tu[0].a, 2); assert.equal(tu[0].b, 1);
  assert.equal(w.score.multiplier, 2);
  assert.equal(w.score.catches, 3);
  const before = w.score.score;
  catchAt(ps[0]); // caught before, but not the planet just left
  assert.equal(w.score.combo, 3);
  assert.equal(w.score.score, before, 'no catch points for an old planet');
  const latches = ofType(all, EV.LATCH);
  assert.deepEqual(latches.map((e) => e.b), [1, 2, 3, 0]);
  assert.equal(ofType(all, EV.COMBO_BREAK).length, 0);
  catchAt(ps[3]);
  assert.equal(w.score.combo, 4);
  assert.equal(w.score.bestCombo, 4);
});

test('combo resets on re-catching the planet just left', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 700, 3000, 0, 800);
  const d = driver(w);
  d.step(true);
  assert.equal(w.score.combo, 2);
  d.step(false);
  assert.equal(w.comet.state, COMET.FREE);
  const ev = d.step(true); // still inside the ring just left
  assert.equal(w.comet.body, p);
  const br = ofType(ev, EV.COMBO_BREAK);
  assert.equal(br.length, 1);
  assert.equal(br[0].a, 2);
  assert.equal(br[0].b, COMBO_BREAK_REASON.RECATCH);
  assert.equal(ofType(ev, EV.LATCH)[0].b, 0);
  assert.equal(w.score.combo, 0);
});

test('combo resets after 2.5 laps on one planet', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 60, 240);
  w.score.combo = 5; w.score.tier = 2; w.score.multiplier = 2;
  setFree(w, 720, 3000, 0, 1500);
  const d = driver(w);
  const all = d.step(true);
  assert.equal(w.score.combo, 7);
  let breakLaps = -1;
  for (let k = 0; k < 120 * 5 && breakLaps < 0 && !w.dead; k++) {
    const ev = d.step(true);
    all.push(...ev);
    if (ofType(ev, EV.COMBO_BREAK).length) breakLaps = w.comet.laps;
  }
  assert.equal(w.dead, false);
  assert.ok(breakLaps >= CONFIG.COMBO_BREAK_LAPS && breakLaps < CONFIG.COMBO_BREAK_LAPS + 0.05, `laps at break ${breakLaps}`);
  const br = ofType(all, EV.COMBO_BREAK);
  assert.equal(br.length, 1);
  assert.equal(br[0].a, 7);
  assert.equal(br[0].b, COMBO_BREAK_REASON.LAPS);
  assert.equal(w.score.combo, 0);
});

test('catching path planet 10 enters zone 2: ZONE_CHANGE, base speed rises', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 80, 250, 10);
  setFree(w, 700, 3000, 0, 800);
  const ev = driver(w).step(true);
  const z = ofType(ev, EV.ZONE_CHANGE);
  assert.equal(z.length, 1);
  assert.equal(z[0].a, 2); assert.equal(z[0].b, 1);
  assert.equal(w.score.zone, 2);
  assert.equal(w.score.pathReached, 10);
  assert.equal(w.baseSpeed, CONFIG.BASE_SPEED_START + CONFIG.BASE_SPEED_PER_ZONE);
  assert.ok(w.comet.speed >= w.baseSpeed);
});

// ------------------------------------------------------------------ collapse front

test('the collapse front catches a comet that falls behind it', () => {
  const w = emptyWorld();
  setFree(w, 500, 3000, 0, -800);
  w.front.y = w.front.py = 2900;
  const ev = driver(w).run(false, 60);
  const death = ofType(ev, EV.DEATH);
  assert.equal(death.length, 1);
  assert.equal(death[0].a, DEATH_CAUSE.FRONT);
  assert.equal(death[0].b, -1);
  assert.equal(w.dead, true);
  assert.equal(w.comet.state, COMET.DEAD);
});

test('front: starts 1500 below and still before the run, 220 u/s + 4 u/s², capped at 75% base, ≤ 2600 behind', () => {
  const w = createWorld({ seed: 7 });
  const d = driver(w);
  assert.equal(w.front.y, CONFIG.HOME_Y - CONFIG.FRONT_START_BELOW);
  d.run(false, 240);
  assert.equal(w.started, false);
  assert.equal(w.front.y, CONFIG.HOME_Y - CONFIG.FRONT_START_BELOW);

  const e = emptyWorld();
  addPlanet(e, 500, 3000, 80, 250);
  setFree(e, 700, 3000, 0, 800);
  e.front.y = e.front.py = 3000 - 1500; e.front.speed = CONFIG.FRONT_SPEED_START;
  const de = driver(e);
  de.run(true, 120); // orbit for one second
  near(e.front.speed, CONFIG.FRONT_SPEED_START + CONFIG.FRONT_ACCEL, 1e-9);
  e.front.speed = CONFIG.FRONT_SPEED_CAP_FRACTION * e.baseSpeed - 1;
  de.run(true, 120);
  assert.equal(e.front.speed, CONFIG.FRONT_SPEED_CAP_FRACTION * e.baseSpeed);

  const f = emptyWorld();
  setFree(f, 500, 3000, 0, 2400);
  f.front.y = f.front.py = 3000 - 1500;
  const df = driver(f);
  for (let k = 0; k < 360; k++) {
    df.step(false);
    assert.ok(f.comet.y - f.front.y <= CONFIG.FRONT_MAX_LAG + 1e-6);
  }
  near(f.comet.y - f.front.y, CONFIG.FRONT_MAX_LAG, 1e-6);
});

// ------------------------------------------------------------------ pre-start

test('pre-start: home orbit holds without decay or speed gain until the first release', () => {
  const w = createWorld({ seed: 3 });
  const d = driver(w);
  const r0 = w.comet.orbitRadius, s0 = w.comet.speed, f0 = w.front.y;
  d.run(false, 360);
  d.run(true, 120); // a hold does nothing before the start
  assert.equal(w.started, false);
  assert.equal(w.comet.state, COMET.ORBIT);
  assert.equal(w.comet.body, 0);
  assert.equal(w.comet.orbitRadius, r0);
  assert.equal(w.comet.speed, s0);
  assert.equal(w.front.y, f0);
  assert.equal(w.score.score, 0);
  const ev = d.step(false);
  assert.equal(ofType(ev, EV.RELEASE).length, 1);
  assert.equal(w.started, true);
  assert.equal(w.comet.state, COMET.FREE);
  d.run(false, 60);
  assert.ok(w.front.y > f0, 'front moves once started');
});

// ------------------------------------------------------------------ release & aim

/**
 * Pre-start home orbit is exact (no decay/gain), so the next tangent can be predicted. First
 * rotate the comet to the right side of home so the tangent points up the field.
 */
function predictNextTangent(w) {
  const c = w.comet;
  const d = driver(w);
  while (c.orbitAngle < -0.1) d.step(false);
  const ang = c.orbitAngle + c.orbitDir * (c.speed / c.orbitRadius) * STEP;
  const x = 500 + Math.cos(ang) * c.orbitRadius, y = Math.sin(ang) * c.orbitRadius;
  return { x, y, dx: -Math.sin(ang) * c.orbitDir, dy: Math.cos(ang) * c.orbitDir };
}

/** Add a planet at distance D whose ring the ray from (x,y) along (dx,dy) misses by `missDeg`. */
function planetMissing(w, t, D, rc, missDeg) {
  const half = Math.asin(rc / D);
  const a = Math.atan2(t.dy, t.dx) + half + missDeg * DEG;
  return addPlanet(w, t.x + Math.cos(a) * D, t.y + Math.sin(a) * D, 60, rc);
}

test('aim line: lights the planet whose ring the tangent enters cleanly; a body in the way blocks it', () => {
  const w = emptyWorld();
  const t = predictNextTangent(w);
  const q = addPlanet(w, t.x + t.dx * 700, t.y + t.dy * 700, 80, 250);
  driver(w).step(false);
  assert.equal(w.aim.active, true);
  assert.equal(w.aim.target, q);
  assert.equal(w.aim.clear, true);
  assert.equal(w.aim.length, CONFIG.AIM_LINE_LENGTH);

  const w2 = emptyWorld();
  const t2 = predictNextTangent(w2);
  addPlanet(w2, t2.x + t2.dx * 700, t2.y + t2.dy * 700, 80, 250);
  const b = w2.bodies, m = addPlanet(w2, t2.x + t2.dx * 300, t2.y + t2.dy * 300, 20, 0);
  b.type[m] = BODY.MOON;
  driver(w2).step(false);
  assert.equal(w2.aim.clear, false);
  assert.equal(w2.aim.target, -1);
  near(w2.aim.length, 300 - 20 - CONFIG.COMET_RADIUS, 0.5, 'line stops at the blocking body');
});

test('aim assist rotates up to 3° toward a ring the tangent just misses, and release follows the aim', () => {
  const w = emptyWorld();
  const t = predictNextTangent(w);
  const q = planetMissing(w, t, 900, 200, 1.5);
  const d = driver(w);
  d.step(true);
  const rot = Math.acos(Math.min(1, w.aim.dx * t.dx + w.aim.dy * t.dy)) / DEG;
  assert.ok(rot > 1.5 && rot <= CONFIG.AIM_ASSIST_DEG + 1e-6, `assist rotation ${rot}°`);
  assert.equal(w.aim.target, q);
  assert.equal(w.aim.clear, true);
  const aimHeading = Math.atan2(w.aim.dy, w.aim.dx);
  const ev = d.step(false);
  const rel = ofType(ev, EV.RELEASE);
  assert.equal(rel.length, 1);
  near(rel[0].b, aimHeading, 1e-12, 'release heading equals the aim heading');
  // and the comet actually reaches q's ring and latches with an armed hold
  for (let k = 0; k < 240 && Math.hypot(w.comet.x - 500, w.comet.y) < w.bodies.rc[0]; k++) d.step(false);
  for (let k = 0; k < 240 && w.comet.state === COMET.FREE; k++) d.step(true);
  assert.equal(w.comet.body, q);

  const w2 = emptyWorld();
  const t2 = predictNextTangent(w2);
  planetMissing(w2, t2, 900, 200, 4);
  driver(w2).step(true);
  near(w2.aim.dx * t2.dx + w2.aim.dy * t2.dy, 1, 1e-12, 'no assist beyond 3°');
  assert.equal(w2.aim.clear, false);
});

// ------------------------------------------------------------------ free flight

test('free flight is a straight line at constant speed', () => {
  const w = emptyWorld();
  setFree(w, 400, 3000, 300, 700);
  driver(w).run(false, 120);
  near(w.comet.x, 400 + 300, 1e-6);
  near(w.comet.y, 3000 + 700, 1e-6);
  near(w.comet.speed, Math.hypot(300, 700), 1e-9);
});

test('hitting a planet body kills; the world keeps stepping but the comet is inert', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 500, 2600, 0, 800);
  const d = driver(w);
  const ev = d.run(false, 120);
  const death = ofType(ev, EV.DEATH);
  assert.equal(death.length, 1);
  assert.equal(death[0].a, DEATH_CAUSE.PLANET);
  assert.equal(death[0].b, p);
  near(3000 - w.comet.y, 80 + CONFIG.COMET_RADIUS, 1e-6, 'comet stops at the contact point');
  const x = w.comet.x, y = w.comet.y, t = w.time;
  const after = d.run(true, 120);
  assert.equal(after.length, 0);
  assert.equal(w.comet.x, x); assert.equal(w.comet.y, y);
  assert.ok(w.time > t);
  assert.equal(w.aim.active, false);
});

test('near miss: one event per pass at the closest approach, only when the comet survives', () => {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 500 + 80 + 18, 2600, 0, 800);
  const ev = driver(w).run(false, 120);
  const nm = ofType(ev, EV.NEAR_MISS);
  assert.equal(nm.length, 1);
  assert.equal(nm[0].a, p);
  near(nm[0].b, 18, 0.5);
  near(nm[0].x, 580, 0.5); near(nm[0].y, 3000, 7);
  assert.equal(w.dead, false);

  const w2 = emptyWorld();
  addPlanet(w2, 500, 3000, 80, 250);
  setFree(w2, 500 + 80 + 5, 2600, 0, 800);
  const ev2 = driver(w2).run(false, 120);
  assert.equal(ofType(ev2, EV.NEAR_MISS).length, 0);
  assert.equal(ofType(ev2, EV.DEATH).length, 1);
});

test('motes: picked up within MOTE_RADIUS, 10 × multiplier, streak index rises along a line', () => {
  const w = emptyWorld();
  const m = w.motes;
  const put = (i, x, y, line, order) => { m.alive[i] = 1; m.x[i] = x; m.y[i] = y; m.line[i] = line; m.order[i] = order; };
  put(0, 500, 3100, 7, 0); put(1, 500 + CONFIG.MOTE_RADIUS - 1, 3160, 7, 1); put(2, 500 + CONFIG.MOTE_RADIUS + 2, 3220, 7, 2);
  put(3, 500, 3400, 8, 0);
  m.count = 4;
  setFree(w, 500, 3000, 0, 800);
  w.score.combo = 3; w.score.tier = 2; w.score.multiplier = 2;
  const ev = ofType(driver(w).run(false, 90), EV.MOTE);
  assert.deepEqual(ev.map((e) => e.a), [0, 1, 0]);
  assert.ok(ev.every((e) => e.b === CONFIG.POINTS_MOTE * 2));
  assert.equal(m.alive[2], 1, 'mote outside the pickup radius stays');
});
