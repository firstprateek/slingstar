// Run missions (src/meta/missions.js): pure bookkeeping, persisted by main.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMissions, emptyRunStats, MISSION_TYPES, targetFor, ACTIVE_COUNT } from '../src/meta/missions.js';

/** Deterministic rand cycling through the given values. */
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
const stats = (o) => ({ ...emptyRunStats(), ...o });

test('missions: a new player starts with three distinct level-0 goals', () => {
  const m = createMissions(null, seq(0));
  assert.equal(m.active.length, ACTIVE_COUNT);
  assert.deepEqual(m.active.map((x) => x.id), ['path', 'perfect', 'zone']);
  for (const x of m.active) {
    const type = MISSION_TYPES.find((t) => t.id === x.id);
    assert.equal(x.target, type.targets[0]);
    assert.equal(x.done, false);
  }
  assert.equal(m.stars, 0);
});

test('missions: progress, completion, star, swap on the next run, harder target next time', () => {
  const m = createMissions(null, seq(0));
  m.beginRun();
  assert.equal(m.update(stats({ catches: 5 })).length, 0);
  assert.equal(m.active[0].progress, 5);
  const done = m.update(stats({ catches: 8 }));
  assert.equal(done.length, 1);
  assert.equal(done[0].id, 'path');
  assert.equal(m.active[0].done, true);
  assert.equal(m.active[0].fresh, true);
  assert.equal(m.stars, 1);
  assert.equal(m.update(stats({ catches: 9 })).length, 0, 'a finished mission does not pay twice');
  m.endRun();
  m.beginRun();
  assert.notEqual(m.active[0].id, 'path', 'replaced by another type');
  assert.equal(new Set(m.active.map((x) => x.id)).size, ACTIVE_COUNT, 'no duplicate types');
  assert.ok(m.active.every((x) => !x.done && !x.fresh));
  // Bring 'path' back later at the next level.
  const saved = m.toJSON();
  assert.equal(saved.levels.path, 1);
  assert.equal(targetFor(MISSION_TYPES[0], 1), MISSION_TYPES[0].targets[1]);
});

test('missions: zone-gated types are offered only after the player reaches that zone', () => {
  const m = createMissions(null, seq(0.999));
  for (let k = 0; k < 30; k++) {
    m.beginRun();
    for (const x of m.active) assert.ok(x.id !== 'sling' && x.id !== 'near', `offered ${x.id} at best zone 1`);
    // Finish everything so all three get swapped.
    m.update(stats({ catches: 999, zone: 1, perfects: 999, combo: 999, motes: 999, score: 1e9 }));
    m.endRun();
  }
  const n = createMissions({ bestZone: 4 }, seq(0.999));
  n.update(stats({ catches: 999, perfects: 999, zone: 9 }));
  n.endRun();
  n.beginRun();
  assert.ok(n.bestZone >= 4);
});

test('missions: the total mission adds catches across runs, banking each run once', () => {
  const m = createMissions({ active: [{ id: 'total' }, { id: 'path' }, { id: 'zone' }] }, seq(0));
  assert.equal(m.active[0].id, 'total');
  m.beginRun();
  m.update(stats({ catches: 25 }));
  m.endRun();
  m.update(stats({ catches: 25 }));   // the dead run is ignored until the next beginRun
  m.endRun();
  assert.equal(m.toJSON().totalCatches, 25);
  m.beginRun();
  const done = m.update(stats({ catches: 15 }));
  assert.equal(done.length, 1);
  assert.equal(done[0].id, 'total');
});

test('missions: survive a save/load round trip, including a mission finished just before closing', () => {
  const m = createMissions(null, seq(0));
  m.beginRun();
  m.update(stats({ catches: 8, perfects: 1 }));
  m.endRun();
  const json = JSON.parse(JSON.stringify(m.toJSON()));
  const r = createMissions(json, seq(0));
  assert.equal(r.stars, 2);
  assert.deepEqual(r.active.map((x) => [x.id, x.done]), [['path', true], ['perfect', true], ['zone', false]]);
  assert.equal(r.active[0].target, 8, 'shown at the level it was won at');
  r.beginRun();
  assert.equal(r.active.filter((x) => x.done).length, 0);
  assert.equal(r.toJSON().levels.path, 1);
});

test('missions: junk in storage starts fresh instead of throwing', () => {
  for (const junk of [null, 0, 'x', [], { active: 'no', levels: { path: -3 }, stars: 'lots' }, { active: [{ id: 'nope' }, null, { id: 'path' }, { id: 'path' }] }]) {
    const m = createMissions(junk, seq(0.5));
    assert.equal(m.active.length, ACTIVE_COUNT);
    assert.equal(new Set(m.active.map((x) => x.id)).size, ACTIVE_COUNT);
    assert.ok(Number.isFinite(m.stars));
  }
});

test('missions: types finished together are all replaced by other types', () => {
  for (let k = 0; k < 20; k++) {
    const m = createMissions(null, seq(k / 20, (k * 7 % 20) / 20, (k * 13 % 20) / 20));
    m.beginRun();
    m.update(stats({ catches: 99, perfects: 99, zone: 3 }));
    m.endRun();
    m.beginRun();
    for (const x of m.active) assert.ok(!['path', 'perfect', 'zone'].includes(x.id), `${x.id} came straight back`);
  }
});

test('missions: a run closed mid-way still counts toward the total, and only once', () => {
  const m = createMissions(null, seq(0));
  m.beginRun();
  m.update(stats({ catches: 30 }));
  const mid = JSON.parse(JSON.stringify(m.toJSON()));
  assert.equal(mid.totalCatches, 30, 'the live run is saved');
  m.endRun();
  assert.equal(m.toJSON().totalCatches, 30, 'banking it does not add it again');
  const reloaded = createMissions(mid, seq(0));
  reloaded.beginRun();
  reloaded.update(stats({ catches: 2 }));
  assert.equal(reloaded.toJSON().totalCatches, 32);
});
