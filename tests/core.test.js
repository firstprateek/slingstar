import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/core/rng.js';
import { createWorld } from '../src/sim/world.js';

test('rng is deterministic', () => {
  const a = createRng(42), b = createRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('world imports and steps under Node', () => {
  const w = createWorld({ seed: 1 });
  const input = { held: false, pressedThisStep: false, releasedThisStep: false };
  for (let i = 0; i < 120; i++) w.step(1 / 120, input);
  assert.ok(Number.isFinite(w.comet.x));
});
