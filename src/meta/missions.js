// @ts-check
/**
 * Run missions: three short goals at a time, kept across runs on this device. Finishing one earns a
 * star; it stays ticked on the game-over card and is swapped for a new goal when the next run
 * starts. Each mission type has its own level, so the same kind of goal comes back a little harder.
 *
 * Pure: no DOM, no storage, no Math.random (main.js passes `rand` and persists `toJSON()`). Runs
 * under Node for tests. Not part of the simulation, so it never changes a course or a score.
 */
/**
 * @typedef {Object} MissionType
 * @property {string} id
 * @property {readonly number[]} targets  Target per level; past the end, `step` more per level.
 * @property {number} step
 * @property {(n: number) => string} label
 * @property {number} [minZone]  Offered only once the player has reached this zone in some run.
 * @property {boolean} [total]   Progress adds up across runs (otherwise it is per run).
 */

/** @param {number} n */
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => (n === 1 ? one : many);

/** Targets were set against tests/humanbot.js runs (median per run: 42 planets, zone 5, ~18 stardust,
 * 0-1 perfects, near misses and slingshots), starting low for a first-time player.
 * @type {readonly MissionType[]} */
export const MISSION_TYPES = Object.freeze([
  { id: 'path', targets: [8, 15, 25, 35, 50, 70], step: 20, label: (n) => `Catch ${n} planets in one run` },
  { id: 'zone', targets: [2, 3, 4, 5, 6, 8], step: 2, label: (n) => `Reach zone ${n}` },
  { id: 'perfect', targets: [1, 2, 4, 6, 9], step: 3, label: (n) => `${n} perfect ${plural(n, 'catch', 'catches')} in one run` },
  { id: 'combo', targets: [5, 8, 12, 16, 22], step: 6, label: (n) => `Build a combo of ${n}` },
  { id: 'motes', targets: [8, 15, 25, 40, 60], step: 20, label: (n) => `Collect ${n} stardust in one run` },
  { id: 'score', targets: [2500, 6000, 12000, 20000, 35000], step: 15000, label: (n) => `Score ${fmt(n)} in one run` },
  { id: 'total', targets: [40, 120, 250, 500, 1000], step: 500, total: true, label: (n) => `Catch ${n} planets in total` },
  { id: 'near', targets: [1, 2, 3, 5], step: 2, minZone: 2, label: (n) => (n === 1 ? 'Survive a near miss' : `${n} near misses in one run`) },
  { id: 'sling', targets: [1, 2, 3, 5], step: 2, minZone: 4, label: (n) => (n === 1 ? 'Slingshot past a black hole' : `${n} black-hole slingshots in one run`) },
]);

const BY_ID = new Map(MISSION_TYPES.map((t) => [t.id, t]));
/** A new player's first three. */
const FIRST = Object.freeze(['path', 'perfect', 'zone']);
export const ACTIVE_COUNT = 3;

/** Target of `type` at `level`. @param {MissionType} type @param {number} level */
export function targetFor(type, level) {
  const t = type.targets, last = t.length - 1;
  return level <= last ? t[level] : t[last] + type.step * (level - last);
}

/**
 * @typedef {Object} Mission
 * @property {string} id
 * @property {number} target
 * @property {string} label
 * @property {number} progress  This run's progress (or the running total for a `total` mission), capped at target.
 * @property {boolean} done     Finished (this run or an earlier one); swapped out when the next run starts.
 * @property {boolean} fresh    Finished during the current run (the game-over card highlights it).
 */

/**
 * Per-run counters main.js feeds in. `path`, `zone`, `combo` and `score` come from world.score;
 * the event counters from sim events.
 * @typedef {Object} RunStats
 * @property {number} path
 * @property {number} zone
 * @property {number} combo
 * @property {number} score
 * @property {number} catches
 * @property {number} perfects
 * @property {number} motes
 * @property {number} near
 * @property {number} sling
 */

/** @returns {RunStats} */
export function emptyRunStats() {
  return { path: 0, zone: 1, combo: 0, score: 0, catches: 0, perfects: 0, motes: 0, near: 0, sling: 0 };
}

/** @param {any} v @returns {number} non-negative integer, 0 for junk */
const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * @param {any} saved   Whatever toJSON() returned earlier (or null / junk: starts fresh).
 * @param {() => number} rand  Uniform [0, 1).
 */
export function createMissions(saved, rand) {
  const s = saved && typeof saved === 'object' ? saved : {};
  /** @type {Record<string, number>} */
  const levels = {};
  for (const t of MISSION_TYPES) levels[t.id] = int(s.levels && s.levels[t.id]);
  let stars = int(s.stars);
  /** Planets caught in all finished runs (the `total` mission's progress before this run). */
  let totalCatches = int(s.totalCatches);
  let bestZone = Math.max(1, int(s.bestZone));
  const run = emptyRunStats();
  /** endRun() banked this run's catches; update() ignores the dead run until beginRun(). */
  let ended = false;
  /** Reused return value of update() (the frame loop allocates nothing). @type {Mission[]} */
  const finished = [];

  /** @type {Mission[]} */
  const active = [];
  /** @param {string} id @param {boolean} done */
  const make = (id, done) => {
    const type = /** @type {MissionType} */ (BY_ID.get(id));
    const target = targetFor(type, levels[id]);
    return { id, target, label: type.label(target), progress: 0, done, fresh: false };
  };
  if (Array.isArray(s.active)) {
    for (const a of s.active) {
      const id = a && a.id;
      if (typeof id !== 'string' || !BY_ID.has(id) || active.some((m) => m.id === id) || active.length >= ACTIVE_COUNT) continue;
      // A finished mission was saved with its level already raised: rebuild it at the level it was won at.
      const done = !!a.done;
      if (done) levels[id] = Math.max(0, levels[id] - 1);
      active.push(make(id, done));
      if (done) levels[id] += 1;
    }
  }
  for (const id of FIRST) if (active.length < ACTIVE_COUNT && !active.some((m) => m.id === id)) active.push(make(id, false));
  refresh();

  /**
   * A type to replace a finished mission: not already shown, not the one just finished, and
   * unlocked by bestZone. @param {string} finishedId
   */
  function pickType(finishedId) {
    const pool = MISSION_TYPES.filter((t) => t.id !== finishedId && !active.some((m) => m.id === t.id) && (t.minZone || 1) <= bestZone);
    if (!pool.length) return MISSION_TYPES[0].id;
    let i = Math.floor(rand() * pool.length);
    if (!(i >= 0 && i < pool.length)) i = 0;
    return pool[i].id;
  }

  /** Recompute every unfinished mission's progress from the run counters. */
  function refresh() {
    for (const m of active) {
      if (m.done) { m.progress = m.target; continue; }
      const v = valueOf(m.id);
      m.progress = v < m.target ? v : m.target;
    }
  }

  /** @param {string} id */
  function valueOf(id) {
    switch (id) {
      case 'path': return run.path;
      case 'zone': return run.zone > 1 ? run.zone : 0;   // zone 1 is where every run starts: no progress yet
      case 'perfect': return run.perfects;
      case 'combo': return run.combo;
      case 'motes': return run.motes;
      case 'score': return run.score;
      case 'total': return totalCatches + run.catches;
      case 'near': return run.near;
      case 'sling': return run.sling;
      default: return 0;
    }
  }

  const api = {
    active,
    get stars() { return stars; },
    get bestZone() { return bestZone; },
    /** New run: swap out finished missions and clear the run counters. */
    beginRun() {
      Object.assign(run, emptyRunStats());
      ended = false;
      for (let i = 0; i < active.length; i++) {
        if (!active[i].done) { active[i].fresh = false; continue; }
        const [old] = active.splice(i, 1);
        active.splice(i, 0, make(pickType(old.id), false));
      }
      refresh();
    },
    /**
     * Update from the current run. Returns the missions finished by this update (usually none;
     * the array is reused, so read it before the next call).
     * @param {RunStats} stats
     * @returns {Mission[]}
     */
    update(stats) {
      finished.length = 0;
      if (ended) return finished;
      Object.assign(run, stats);
      if (run.zone > bestZone) bestZone = run.zone;
      refresh();
      for (const m of active) {
        if (m.done || m.progress < m.target) continue;
        m.done = true; m.fresh = true;
        stars++;
        levels[m.id] += 1;
        finished.push(m);
      }
      return finished;
    },
    /** The run ended: bank its catches toward the `total` mission. Later updates are ignored until beginRun. */
    endRun() {
      if (ended) return;
      ended = true;
      totalCatches += run.catches;
      run.catches = 0;
      refresh();
    },
    toJSON() {
      return {
        v: 1, stars, totalCatches, bestZone, levels: { ...levels },
        active: active.map((m) => ({ id: m.id, done: m.done })),
      };
    },
  };
  return api;
}
