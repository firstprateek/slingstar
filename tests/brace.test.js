// Brace (2026-11): flying into a body opens a BRACE_WINDOW_S window at the contact point; a press
// in it, or one that came at most BRACE_WINDOW_S before the hit, bounces the comet off and costs
// BRACE_SIZE_LOSS of its size. Below BRACE_MIN_SIZE a hit is fatal; stardust regrows size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, STEP } from '../src/config.js';
import { COMET, EV, COMBO_BREAK_REASON, DEATH_CAUSE } from '../src/contracts.js';
import { emptyWorld, addPlanet, setFree, driver, ofType } from './helpers.js';

const WINDOW_STEPS = Math.round(CONFIG.BRACE_WINDOW_S / STEP);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

/** A planet with no ring (nothing to latch) straight above a comet flying up at it. */
function setup(speed = 600) {
  const w = emptyWorld();
  const p = addPlanet(w, 500, 3000, 80, 0);
  setFree(w, 500, 2700, 0, speed);
  return { w, p, d: driver(w) };
}

/** Step without pressing until the impact opens; returns the steps taken. */
function flyToImpact(w, d) {
  let n = 0;
  while (w.comet.impact < 0 && !w.dead && n < 600) { d.step(false); n++; }
  return n;
}

test('brace: an unbraced hit stops at the contact point and dies when the window closes', () => {
  const { w, p, d } = setup();
  const ev = [];
  let n = 0;
  while (w.comet.impact < 0 && n < 600) { ev.push(...d.step(false)); n++; }
  const hit = ofType(ev, EV.IMPACT);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].a, DEATH_CAUSE.PLANET);
  assert.equal(hit[0].b, p);
  assert.equal(w.dead, false, 'not dead during the window');
  near(3000 - w.comet.y, 80 + CONFIG.COMET_RADIUS, 1e-6, 'stopped at the contact point');
  const y = w.comet.y;
  const during = d.run(false, WINDOW_STEPS - 1);
  assert.equal(ofType(during, EV.DEATH).length, 0);
  assert.equal(w.comet.y, y, 'the comet stays put in the window');
  const after = d.run(false, 3);
  const death = ofType(after, EV.DEATH);
  assert.equal(death.length, 1);
  assert.equal(death[0].a, DEATH_CAUSE.PLANET);
  assert.equal(death[0].b, p);
});

test('brace: a press inside the window bounces off, costs size and breaks the combo', () => {
  const { w, p, d } = setup();
  w.score.combo = 7;
  flyToImpact(w, d);
  d.run(false, Math.floor(WINDOW_STEPS / 2));
  const ev = d.step(true);
  const br = ofType(ev, EV.BRACE);
  assert.equal(br.length, 1);
  assert.equal(br[0].b, p);
  near(w.comet.size, 1 - CONFIG.BRACE_SIZE_LOSS, 1e-9, 'size');
  near(br[0].a, w.comet.size, 1e-9);
  assert.equal(w.comet.impact, -1);
  assert.ok(w.comet.vy < 0, 'heading away from the planet');
  assert.ok(Math.hypot(w.comet.x - 500, w.comet.y - 3000) > 80 + CONFIG.COMET_RADIUS, 'outside the surface');
  const cb = ofType(ev, EV.COMBO_BREAK);
  assert.equal(cb.length, 1);
  assert.equal(cb[0].b, COMBO_BREAK_REASON.BRACE);
  assert.equal(w.score.combo, 0);
  const later = d.run(true, 120);   // keep holding: flies away, no death
  assert.equal(ofType(later, EV.DEATH).length, 0);
  assert.equal(w.dead, false);
});

test('brace: a press up to BRACE_WINDOW_S before the hit braces on contact', () => {
  const { w, d } = setup(600);
  // 300 - 88 = 212 units to the surface at 600 u/s ≈ 0.353 s. Press 0.15 s before contact.
  const toHit = (300 - 88) / 600;
  d.run(false, Math.floor((toHit - 0.15) / STEP));
  const ev = d.run(true, 60);
  assert.equal(ofType(ev, EV.IMPACT).length, 1);
  assert.equal(ofType(ev, EV.BRACE).length, 1);
  assert.equal(w.dead, false);
});

test('brace: a press earlier than the window does not brace', () => {
  const { w, d } = setup(600);
  const toHit = (300 - 88) / 600;
  d.run(false, Math.floor((toHit - CONFIG.BRACE_WINDOW_S - 0.05) / STEP));
  const ev = d.run(true, 120);    // pressed 0.25 s early and held: dies
  assert.equal(ofType(ev, EV.BRACE).length, 0);
  assert.equal(ofType(ev, EV.DEATH).length, 1);
});

test('brace: a press too close to a ringed planet braces instead of latching a crashing orbit', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 500, 3000 - 80 - 8 - 4, 0, 600);   // altitude 12 (< CRASH_ALTITUDE + 2), flying straight in
  const d = driver(w);
  const ev = d.run(true, 30);
  assert.equal(ofType(ev, EV.LATCH).length, 0);
  assert.equal(ofType(ev, EV.BRACE).length, 1);
  assert.equal(w.comet.state, COMET.FREE);
  assert.equal(w.dead, false);
});

test('brace: five braces from full size, the sixth hit is fatal; stardust regrows size', () => {
  const { w, d } = setup();
  for (let k = 0; k < 5; k++) {
    w.comet.impact = -1;
    setFreeKeepSize(w);
    flyToImpact(w, d);
    const ev = d.step(true);
    assert.equal(ofType(ev, EV.BRACE).length, 1, `brace ${k + 1}`);
    d.step(false);
  }
  near(w.comet.size, CONFIG.BRACE_MIN_SIZE, 1e-9);
  setFreeKeepSize(w);
  flyToImpact(w, d);
  const ev = d.step(true);
  assert.equal(ofType(ev, EV.BRACE).length, 0);
  assert.equal(ofType(ev, EV.DEATH).length, 1, 'a brace below the minimum size is fatal');

  // Regrowth: a mote adds BRACE_DUST_REFILL.
  const w2 = emptyWorld();
  setFree(w2, 500, 1000, 0, 600);
  w2.comet.size = 0.7;
  const m = w2.motes;
  m.count = 1; m.alive[0] = 1; m.x[0] = 500; m.y[0] = 1010; m.line[0] = 1; m.order[0] = 0;
  const d2 = driver(w2);
  const ev2 = d2.run(false, 5);
  assert.equal(ofType(ev2, EV.MOTE).length, 1);
  near(w2.comet.size, 0.7 + CONFIG.BRACE_DUST_REFILL, 1e-9);
});

/** Put the comet back below the planet in free flight, keeping its size. */
function setFreeKeepSize(w) {
  const s = w.comet.size;
  setFree(w, 500, 2700, 0, 600);
  w.comet.size = s;
}

test('brace: the bounce does not hit the same body again on the next steps', () => {
  for (const speed of [600, 1200]) {
    const { w, d } = setup(speed);
    flyToImpact(w, d);
    const ev = [...d.step(true), ...d.run(true, 60)];
    assert.equal(ofType(ev, EV.BRACE).length, 1);
    assert.equal(ofType(ev, EV.IMPACT).length, 0, `speed ${speed}: hit again after the bounce`);
    assert.equal(w.dead, false);
  }
});

test('brace: the braced planet is not re-latched on the way out, even after a fresh press', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 80, 250);
  setFree(w, 500, 2700, 0, 600);   // inside the ring after a few steps, flying in without holding
  const d = driver(w);
  flyToImpact(w, d);
  assert.equal(ofType(d.step(true), EV.BRACE).length, 1);
  d.run(false, 3);
  const ev = d.run(true, 120);    // press again while still inside its ring, and hold
  assert.equal(ofType(ev, EV.LATCH).length, 0, 'no latch onto the planet just braced off');
  assert.equal(w.dead, false);
});

test('brace: a hold kept down through the brace still catches the next ring', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 80, 0);          // ringless: the comet hits it
  const next = addPlanet(w, 500, 2200, 80, 250);
  setFree(w, 500, 2700, 0, 600);
  const d = driver(w);
  const toHit = (300 - 88) / 600;
  d.run(false, Math.floor((toHit - 0.1) / STEP));
  const ev = d.run(true, 240);             // pressed 0.1 s early, held: brace, bounce down, catch
  assert.equal(ofType(ev, EV.BRACE).length, 1);
  const latch = ofType(ev, EV.LATCH);
  assert.equal(latch.length, 1);
  assert.equal(latch[0].a, next);
  assert.equal(w.dead, false);
});

test('brace: a press that latched an orbit does not also brace a later hit', () => {
  const w = emptyWorld();
  addPlanet(w, 500, 3000, 80, 250);
  const rock = addPlanet(w, 640, 2800, 30, 0);   // ringless, just along the release tangent
  setFree(w, 500, 2800, 600, 0);                 // inside the ring, 120 above the surface, heading +x
  const d = driver(w);
  const ev = [...d.step(true), ...d.step(false)];  // tap: latch, then let go a step later
  assert.equal(ofType(ev, EV.LATCH).length, 1);
  assert.equal(ofType(ev, EV.RELEASE).length, 1);
  const rest = d.run(false, 120);
  const hit = ofType(rest, EV.IMPACT);
  assert.equal(hit.length, 1, 'the flight hits the rock');
  assert.equal(hit[0].b, rock);
  assert.equal(ofType(rest, EV.BRACE).length, 0, 'the latching tap is not a brace');
  assert.equal(ofType(rest, EV.DEATH).length, 1);
});

test('brace: the window is exactly BRACE_WINDOW_S', () => {
  for (const [wait, ok] of [[WINDOW_STEPS - 1, true], [WINDOW_STEPS + 1, false]]) {
    const { w, d } = setup();
    flyToImpact(w, d);
    d.run(false, wait);
    const ev = d.step(true);
    assert.equal(ofType(ev, EV.BRACE).length, ok ? 1 : 0, `press ${wait} steps in`);
  }
});
