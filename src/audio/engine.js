// @ts-check
/**
 * WebAudio engine (PLAN.md §5): one AudioContext, created or resumed inside `unlock()` (call it
 * from a pointerup handler — iOS needs a gesture), a reactive music scheduler and synthesised SFX.
 *
 * Usage (main.js):
 *   const audio = createAudio();
 *   input onGesture → audio.unlock();
 *   per drained event → audio.onEvent(type, x, y, a, b);
 *   per frame → audio.update(world, dtReal);
 *   screens → audio.setScene(SCREEN.*); new run → audio.resetRun();
 *   page hidden → audio.suspend(); back + gesture → audio.resume();
 *   sound toggle → audio.setEnabled(on); audio.unlock();   (in that order, inside the tap)
 *
 * Nothing is scheduled or synthesised before unlock or while disabled / hidden. While sound is off
 * the AudioContext is never created, and an existing one is suspended (after a short fade).
 */
import { CONFIG } from '../config.js';
import { BODY, COMET, EV, SCREEN } from '../contracts.js';
import { buildGraph, MASTER_LEVEL } from './graph.js';
import { createMusic } from './music.js';
import { createSfx } from './sfx.js';

/** Death: music low-pass closes to CONFIG.DEATH_LOWPASS_HZ over this long. */
const DEATH_FILTER_S = CONFIG.DEATH_LOWPASS_S;
/** Music bus level while the death low-pass is closed (the bass still thumps through it). */
const DEATH_MUSIC_DUCK = CONFIG.DEATH_MUSIC_DUCK;
/** Small offset so sounds triggered "now" are not scheduled in the past. */
const LEAD_IN = 0.005;
/** Black-hole drone: re-target its level only when it moves by more than this (fewer automation events). */
const WELL_STEP = 0.04;

/**
 * How deep the free-flying comet is inside the nearest black hole's influence radius, 0..1
 * (0 outside, 1 at the core). Reads world state only; no allocation.
 * @param {import('../contracts.js').WorldT} world
 */
export function wellDepth(world) {
  const c = world.comet;
  if (world.dead || c.state !== COMET.FREE) return 0;
  const b = world.bodies;
  let best = 0;
  for (let i = 0, n = b.count; i < n; i++) {
    if (b.alive[i] === 0 || b.type[i] !== BODY.BLACKHOLE) continue;
    const dx = c.x - b.x[i], dy = c.y - b.y[i];
    const rc = b.rc[i];
    const d2 = dx * dx + dy * dy;
    if (d2 >= rc * rc) continue;
    const k = 1 - Math.sqrt(d2) / rc;
    if (k > best) best = k;
  }
  return best;
}

/**
 * @typedef {Object} AudioCore  The graph plus music and SFX on one context (live or offline).
 * @property {import('./graph.js').AudioGraph} graph
 * @property {import('./music.js').Music} music
 * @property {import('./sfx.js').Sfx} sfx
 * @property {(t: number) => void} closeFilter   Death low-pass (to 200Hz over ~0.3s).
 * @property {(t: number) => void} openFilter
 * @property {(type: number, x: number, y: number, a: number, b: number, t: number) => void} trigger
 */

/**
 * Build graph + music + SFX on any BaseAudioContext. Used by `createAudio` (live) and by the test
 * page on an OfflineAudioContext to measure levels.
 * @param {BaseAudioContext} ctx
 * @param {number} [masterLevel]
 * @returns {AudioCore}
 */
export function createCore(ctx, masterLevel = MASTER_LEVEL) {
  const graph = buildGraph(ctx, masterLevel);
  const music = createMusic(graph);
  const sfx = createSfx(graph, music);
  const lp = graph.lowpass.frequency;

  /** @type {AudioCore} */
  const core = {
    graph, music, sfx,
    closeFilter(t) {
      lp.cancelScheduledValues(t);
      lp.setValueAtTime(Math.max(CONFIG.DEATH_LOWPASS_HZ, lp.value), t);
      lp.exponentialRampToValueAtTime(CONFIG.DEATH_LOWPASS_HZ, t + DEATH_FILTER_S);
      graph.musicBus.gain.setTargetAtTime(DEATH_MUSIC_DUCK, t, DEATH_FILTER_S / 3);
    },
    openFilter(t) {
      lp.cancelScheduledValues(t);
      lp.setValueAtTime(Math.max(CONFIG.DEATH_LOWPASS_HZ, lp.value), t);
      lp.exponentialRampToValueAtTime(graph.lowpassOpenHz, t + 0.25);
      graph.musicBus.gain.setTargetAtTime(1, t, 0.08);
    },
    trigger(type, x, y, a, b, t) {
      switch (type) {
        case EV.LATCH: sfx.latch(t, b); break;
        case EV.PERFECT: sfx.perfect(t); break;
        case EV.RELEASE: sfx.release(t, a); break;
        case EV.GRAZE: break; // the sizzle loop follows world.comet.grazing in update()
        case EV.MOTE: sfx.mote(t, a); break;
        case EV.NEAR_MISS: sfx.nearMiss(t); break;
        case EV.BOUNCE: sfx.bounce(t); break;
        case EV.COMBO_UP: break; // the catch pluck already climbs with the combo
        case EV.COMBO_BREAK: sfx.comboBreak(t); break;
        case EV.TIER_UP: music.setTier(a, t); sfx.tierUp(t, a); break;
        case EV.ZONE_CHANGE: music.setZone(a); sfx.zoneChange(t, a); break;
        case EV.SLINGSHOT: sfx.slingshot(t); break;
        case EV.DEATH: sfx.death(t, a); core.closeFilter(t); break;
        default: break;
      }
    },
  };
  return core;
}

/** @param {any} _e */
function ignore(_e) {}

/** Sound off: wait for the master fade (time constant 0.03 s) before suspending the context. */
const OFF_SUSPEND_MS = 200;

/**
 * Safari 16.4+: an "ambient" audio session mixes with other apps' audio (music keeps playing)
 * instead of interrupting it, and follows the silent switch. Must be set before audio starts.
 */
function setAmbientSession() {
  try {
    const s = /** @type {any} */ (navigator).audioSession;
    if (s && s.type !== 'ambient') s.type = 'ambient';
  } catch (_e) { /* unsupported */ }
}

/**
 * @typedef {import('../contracts.js').Audio & {
 *   context: AudioContext | null,
 *   core: AudioCore | null,
 *   setGraze: (on: boolean) => void,
 * }} AudioEngine
 */

/**
 * @param {{ context?: AudioContext }} [opts]  `context`: use this context instead of creating one
 *   (tests). It is still resumed in unlock().
 * @returns {AudioEngine}
 */
export function createAudio(opts) {
  /** @type {AudioContext | null} */
  let ctx = (opts && opts.context) || null;
  /** @type {AudioCore | null} */
  let core = null;
  let timer = 0;
  let hidden = false;
  let started = false;
  /** @type {string} */
  let scene = SCREEN.TITLE;
  let deathClosed = false;
  /** Pending "sound turned off → suspend the context" timer. */
  let offTimer = 0;

  /** @type {AudioEngine} */
  const api = {
    enabled: true,
    get state() { return ctx ? /** @type {string} */ (ctx.state) : 'none'; },
    get context() { return ctx; },
    get core() { return core; },

    unlock() {
      hidden = false;
      // Sound off: never create or resume the context. A running (even silent) AudioContext can
      // pause or duck other apps' music on iPhone. setEnabled(true) + unlock() in the toggle's tap
      // brings it up.
      if (!api.enabled) return;
      if (!ctx) {
        const w = /** @type {any} */ (window);
        const C = w.AudioContext || w.webkitAudioContext;
        if (!C) return;
        setAmbientSession();
        try { ctx = new C({ latencyHint: 'interactive' }); } catch (_e) { ctx = new C(); }
      }
      if (!ctx) return;
      if (!core) {
        core = createCore(ctx, MASTER_LEVEL);
        // iOS: starting any source inside the gesture fully unlocks output on older WebKit.
        const b = ctx.createBuffer(1, 1, ctx.sampleRate);
        const s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
        core.music.setScene(scene, ctx.currentTime);
      }
      cancelOffSuspend();
      const st = /** @type {string} */ (ctx.state);
      if (st === 'suspended' || st === 'interrupted') ctx.resume().catch(ignore);
      startScheduler();
    },

    suspend() {
      hidden = true;
      cancelOffSuspend();
      stopScheduler();
      if (core && ctx) { core.sfx.graze(false, ctx.currentTime); core.sfx.well(0, ctx.currentTime); }
      if (ctx && ctx.state === 'running') ctx.suspend().catch(ignore);
    },

    resume() {
      hidden = false;
      if (!ctx || !api.enabled) return;
      cancelOffSuspend();
      const st = /** @type {string} */ (ctx.state);
      if (st === 'suspended' || st === 'interrupted') ctx.resume().catch(ignore);
      startScheduler();
    },

    setEnabled(on) {
      api.enabled = on;
      if (!ctx || !core) return;
      const t = ctx.currentTime;
      core.graph.master.gain.setTargetAtTime(on ? MASTER_LEVEL : 0, t, on ? 0.08 : 0.03);
      if (on) {
        // Called from the sound toggle's tap: resuming here is inside the gesture.
        cancelOffSuspend();
        const st = /** @type {string} */ (ctx.state);
        if (!hidden && (st === 'suspended' || st === 'interrupted')) ctx.resume().catch(ignore);
        startScheduler();
      } else {
        stopScheduler();
        core.sfx.graze(false, t); core.sfx.well(0, t);
        // Let the master fade out, then stop the context so nothing runs while sound is off.
        cancelOffSuspend();
        offTimer = /** @type {any} */ (setTimeout(suspendIfOff, OFF_SUSPEND_MS));
      }
    },

    onEvent(type, x, y, a, b) {
      if (!core || !ctx) return;
      const t = ctx.currentTime + LEAD_IN;
      if (type === EV.DEATH) deathClosed = true;
      if (!api.enabled || hidden || ctx.state !== 'running') {
        // keep the cheap state changes so the mix is right when sound comes back
        if (type === EV.DEATH) core.closeFilter(t);
        else if (type === EV.ZONE_CHANGE) core.music.setZone(a);
        return;
      }
      core.trigger(type, x, y, a, b, t);
    },

    update(world, _dtReal) {
      if (!core || !ctx || !api.enabled || hidden) return;
      const t = ctx.currentTime;
      const m = core.music;
      const sc = world.score;
      if (sc.tier !== m.tier) m.setTier(sc.tier, t);
      if (sc.zone !== m.zone) m.setZone(sc.zone);
      const playing = scene === SCREEN.PLAYING && !world.dead;
      const g = playing && world.comet.grazing;
      if (g !== core.sfx.grazing) core.sfx.graze(g, t);
      const w = playing ? wellDepth(world) : 0;
      const wl = core.sfx.wellLevel;
      if (w === 0 ? wl !== 0 : (w - wl > WELL_STEP || wl - w > WELL_STEP)) core.sfx.well(w, t);
    },

    setScene(s) {
      scene = s;
      if (!core || !ctx) return;
      const t = ctx.currentTime;
      core.music.setScene(s, t);
      if (s === SCREEN.TITLE && deathClosed) { core.openFilter(t); deathClosed = false; }
      if (s !== SCREEN.PLAYING) { core.sfx.graze(false, t); core.sfx.well(0, t); }
    },

    resetRun() {
      if (!core || !ctx) return;
      const t = ctx.currentTime;
      core.openFilter(t);
      deathClosed = false;
      core.music.reset(t);
      core.sfx.graze(false, t);
      core.sfx.well(0, t);
      core.sfx.clear();
    },

    setGraze(on) {
      if (!core || !ctx) return;
      core.sfx.graze(on, ctx.currentTime);
    },
  };

  function suspendIfOff() {
    offTimer = 0;
    if (!api.enabled && ctx && ctx.state === 'running') ctx.suspend().catch(ignore);
  }

  function cancelOffSuspend() {
    if (offTimer) { clearTimeout(offTimer); offTimer = 0; }
  }

  function tick() {
    if (!ctx || !core) return;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const m = core.music;
    if (!started) { m.start(now + 0.06); started = true; }
    else if (m.nextTime < now) m.resync(now + 0.02); // timer stalled (background, jank): skip ahead
    m.scheduleUntil(now + CONFIG.SCHEDULER_HORIZON_S);
  }

  function startScheduler() {
    if (timer || !core || !api.enabled || hidden) return;
    timer = /** @type {any} */ (setInterval(tick, CONFIG.SCHEDULER_INTERVAL_MS));
    tick();
  }

  function stopScheduler() {
    if (timer) { clearInterval(timer); timer = 0; }
  }

  return api;
}
