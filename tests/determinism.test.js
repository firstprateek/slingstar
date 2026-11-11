// Determinism (PLAN.md §8): same seed + same input script → identical world.hash() after 60
// simulated seconds; different seeds differ; reset() reproduces a fresh world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/sim/world.js';
import { createBot } from '../src/sim/bot.js';
import { STEP } from '../src/config.js';

const STEPS_60S = 60 * 120;

/** A fixed, seed-independent input script: hold/release in an irregular rhythm. */
function scriptedHeld(k) {
  const phase = k % 211;
  return phase > 23 && phase < 150;
}

function runScripted(seed, world = createWorld({ seed })) {
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  let prev = false;
  for (let k = 0; k < STEPS_60S; k++) {
    const h = scriptedHeld(k);
    input.held = h; input.pressedThisStep = h && !prev; input.releasedThisStep = !h && prev; prev = h;
    world.step(STEP, input);
    world.events.count = 0;
  }
  return world.hash();
}

function runBot(seed, world = createWorld({ seed })) {
  const bot = createBot();
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  let prev = false;
  for (let k = 0; k < STEPS_60S; k++) {
    const h = bot.decide(world);
    input.held = h; input.pressedThisStep = h && !prev; input.releasedThisStep = !h && prev; prev = h;
    world.step(STEP, input);
    world.events.count = 0;
  }
  return { hash: world.hash(), score: world.score.score, path: world.score.pathReached, dead: world.dead };
}

test('same seed + same scripted input → identical hash after 60 s', () => {
  for (const seed of [1, 2, 20260101, 0xdeadbeef]) assert.equal(runScripted(seed), runScripted(seed), `seed ${seed}`);
});

test('same seed + bot input → identical hash, score and progress after 60 s', () => {
  for (const seed of [1, 7, 42]) {
    const a = runBot(seed), b = runBot(seed);
    assert.deepEqual(a, b);
    assert.ok(a.path > 30, 'the bot run is non-trivial');
  }
});

test('different seeds give different worlds', () => {
  const hashes = new Set();
  for (let seed = 1; seed <= 20; seed++) hashes.add(runScripted(seed));
  assert.equal(hashes.size, 20);
  assert.notEqual(runBot(1).hash, runBot(2).hash);
});

test('reset(seed) on a used world reproduces a fresh world exactly', () => {
  const w = createWorld({ seed: 99 });
  runBot(5, w);
  w.reset(13);
  const fresh = createWorld({ seed: 13 });
  assert.equal(w.hash(), fresh.hash());
  assert.equal(runBot(13, w).hash, runBot(13, fresh).hash);
});
