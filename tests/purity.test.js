// The sim is pure and allocation-free (PLAN.md §3.1, §4.4): src/sim and src/core touch no browser
// globals, performance, Date or Math.random, and a step allocates nothing once optimised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['src/sim', 'src/core'];
const files = dirs.flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(root, d, f)));

test('sim/core sources reference no browser globals, timers, clocks or Math.random', () => {
  const banned = /\b(window|document|performance|navigator|localStorage|sessionStorage|requestAnimationFrame|setTimeout|setInterval|globalThis|self|Date)\b|Math\.random/;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments (JSDoc mentions the rules)
      .replace(/\/\/.*$/gm, '')           // line comments
      .replace(/'(?:[^'\\]|\\.)*'/g, "''"); // string literals
    const m = src.match(banned);
    assert.equal(m, null, `${path.relative(root, f)} uses ${m && m[0]}`);
  }
});

test('importing and running the sim under Node with trapped globals touches none of them', () => {
  // A child process whose performance / Date / Math.random throw on use and which has no window or
  // document at all; it imports every sim module and plays 30 simulated seconds with the bot.
  const script = `
    const trap = (name) => () => { throw new Error('sim touched ' + name); };
    Object.defineProperty(globalThis, 'performance', { get: trap('performance'), configurable: true });
    globalThis.Date = new Proxy(Date, { construct: trap('new Date'), apply: trap('Date()'), get: trap('Date.*') });
    Math.random = trap('Math.random');
    const root = ${JSON.stringify(root)};
    const { createWorld } = await import(root + '/src/sim/world.js');
    const { createBot } = await import(root + '/src/sim/bot.js');
    await import(root + '/src/sim/generator.js'); await import(root + '/src/sim/hazards.js'); await import(root + '/src/sim/scoring.js');
    const w = createWorld({ seed: 4 }); const bot = createBot();
    const inp = { held: false, pressedThisStep: false, releasedThisStep: false }; let prev = false;
    for (let k = 0; k < 3600; k++) { const h = bot.decide(w); inp.held = h; inp.pressedThisStep = h && !prev; inp.releasedThisStep = !h && prev; prev = h; w.step(1 / 120, inp); w.events.count = 0; }
    w.reset(5); w.hash();
    console.log('ok', w.steps, typeof window, typeof document);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok 0 undefined undefined/);
});

test('steady-state steps allocate nothing (V8 total_allocated_bytes)', async (t) => {
  if (typeof v8.getHeapStatistics().total_allocated_bytes !== 'number') { t.skip('total_allocated_bytes unavailable'); return; }
  const { createWorld } = await import('../src/sim/world.js');
  const { createBot } = await import('../src/sim/bot.js');
  const { STEP } = await import('../src/config.js');
  const A = () => v8.getHeapStatistics().total_allocated_bytes;
  const inp = { held: false, pressedThisStep: false, releasedThisStep: false };
  const loop = (w, n) => { for (let k = 0; k < n; k++) { w.step(STEP, inp); w.events.count = 0; } };
  /** Best of a few 100k-step samples, bytes per step (the stats call itself allocates a little). */
  const measure = (w, setup) => {
    setup(w); loop(w, 30000);
    let best = Infinity;
    for (let r = 0; r < 4; r++) { setup(w); const a = A(); loop(w, 100000); best = Math.min(best, (A() - a) / 100000); }
    return best;
  };
  const orbit = measure(createWorld({ seed: 3 }), () => {});
  const free = measure(createWorld({ seed: 3, generate: false }), (w) => {
    const c = w.comet; c.state = 1; c.body = -1; c.x = c.px = 500; c.y = c.py = 5000; c.vx = 0; c.vy = 800; c.speed = 800;
    w.started = true; w.front.y = -1e9;
  });
  // A full bot run includes generation, which runs a few times per second and mostly in V8's
  // lower tiers (where doubles are boxed); report its amortised cost.
  const w = createWorld({ seed: 3 }); const bot = createBot(); let prev = false;
  const play = (n) => { for (let k = 0; k < n; k++) { const h = bot.decide(w); inp.held = h; inp.pressedThisStep = h && !prev; inp.releasedThisStep = !h && prev; prev = h; w.step(STEP, inp); w.events.count = 0; } };
  play(30000);
  const a = A(); play(100000); const botRun = (A() - a) / 100000;
  t.diagnostic(`bytes/step: pre-start orbit ${orbit.toFixed(2)}, free flight ${free.toFixed(2)}, full bot run incl. generation ${botRun.toFixed(1)}`);
  assert.ok(orbit < 4, `orbit step allocates ${orbit} B`);
  assert.ok(free < 4, `free-flight step allocates ${free} B`);
  assert.ok(botRun < 400, `bot run allocates ${botRun} B/step amortised`);
});

test('hazard steps allocate nothing: orbiting a drifting planet with a moon, black holes and moving bodies on the aim ray', async (t) => {
  if (typeof v8.getHeapStatistics().total_allocated_bytes !== 'number') { t.skip('total_allocated_bytes unavailable'); return; }
  const { STEP, CONFIG } = await import('../src/config.js');
  const { COMET } = await import('../src/contracts.js');
  const h = await import('./helpers.js');
  const A = () => v8.getHeapStatistics().total_allocated_bytes;
  const inp = { held: true, pressedThisStep: false, releasedThisStep: false };
  /** A fresh hazard field with the comet orbiting a drifting planet (no decay: pre-start orbit). */
  const build = () => {
    const w = h.emptyWorld();
    const p = h.addDrifting(w, 500, 3000, 150, 5, 0, 70, 260);
    h.addMoon(w, p, 140, 1.2, 0, 18);
    h.addBinary(w, 500, 3900, 200, CONFIG.BINARY_ANGULAR_SPEED, 0, 70, 230);
    const q = h.addDrifting(w, 300, 4800, 150, 4, 1, 70, 230);
    h.addMoon(w, q, 140, -1, 2, 18);
    h.addBlackHole(w, 880, 3500);
    h.addBlackHole(w, 120, 4300);
    const c = w.comet;
    c.state = COMET.ORBIT; c.body = p; c.bodyId = w.bodies.id[p]; c.orbitRadius = 220; c.orbitDir = 1; c.orbitAngle = 0;
    c.speed = 800; w.started = false; w.front.y = -1e9;
    return w;
  };
  const loop = (w, n) => { for (let k = 0; k < n; k++) { w.step(STEP, inp); w.events.count = 0; } };
  const w = build();
  loop(w, 60000);
  assert.equal(w.dead, false);
  let best = Infinity;
  for (let r = 0; r < 5; r++) { const a = A(); loop(w, 100000); best = Math.min(best, (A() - a) / 100000); }
  // Free flight through a black hole's influence (bend + slingshot bookkeeping).
  const f = h.emptyWorld();
  h.addBlackHole(f, 500, 3000);
  const m = h.addPlanet(f, 900, 9000, 10, 0);
  h.addMoon(f, m, 100, 1, 0, 18);
  const reset = () => { h.setFree(f, 680, 2500, 0, 800); };
  const freeLoop = (n) => { for (let k = 0; k < n; k++) { if (f.comet.y > 3600) reset(); f.step(STEP, { held: false, pressedThisStep: false, releasedThisStep: false }); f.events.count = 0; } };
  const finp = { held: false, pressedThisStep: false, releasedThisStep: false };
  const freeLoop2 = (n) => { for (let k = 0; k < n; k++) { if (f.comet.y > 3600) reset(); f.step(STEP, finp); f.events.count = 0; } };
  reset(); freeLoop(1); freeLoop2(60000);
  let bestFree = Infinity;
  for (let r = 0; r < 5; r++) { const a = A(); freeLoop2(100000); bestFree = Math.min(bestFree, (A() - a) / 100000); }
  t.diagnostic(`bytes/step: hazard orbit with moving aim targets ${best.toFixed(2)}, black-hole free flight ${bestFree.toFixed(2)}`);
  assert.ok(best < 4, `hazard orbit step allocates ${best} B`);
  assert.ok(bestFree < 4, `black-hole free flight allocates ${bestFree} B`);
});
