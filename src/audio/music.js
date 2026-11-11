// @ts-check
/**
 * Look-ahead music scheduler, five tier layers, zone keys (PLAN.md §5).
 *
 * The scheduler works in 16th notes at CONFIG.BPM. `scheduleUntil(t)` creates every note that
 * starts before `t`; the engine calls it from a 25ms setInterval with a 100ms horizon, and the
 * test page calls it once with a long horizon on an OfflineAudioContext.
 *
 * Layers (join with the multiplier tier, fade in/out rather than cut):
 *   1 pad (warm detuned saws, one chord per bar)   2 bass pulse (8ths on the chord root)
 *   3 arpeggio (16ths over chord tones)            4 noise hats (16ths, offbeat accents)
 *   5 sparkle lead (bell melody, minor pentatonic)
 * Chords: i – VI – III – VII in the zone's key (all inside natural minor, so the pentatonic
 * melody and SFX always sit well over them). A zone change takes effect at the next bar.
 */
import { CONFIG, ZONES } from '../config.js';
import { SCREEN } from '../contracts.js';
import { mtof, scaleNote, pluckEnv, swellEnv, onEnd } from './graph.js';

const SPB = 60 / CONFIG.BPM;
const S16 = SPB / 4;
const BAR = SPB * 4;
const LAYERS = 5;

/** Mix level of each layer when active. */
const LEVEL = new Float32Array([0.55, 0.5, 0.38, 0.42, 0.4]);
/** Reverb send per layer. */
const SEND = new Float32Array([0.45, 0.05, 0.35, 0.12, 0.7]);
/** Fade time constants, seconds. */
const FADE_IN_TAU = 0.5;
const FADE_OUT_TAU = 0.7;
/** After a layer's target drops to 0, keep scheduling its notes this long (covers the fade-out). */
const FADE_OUT_HOLD = FADE_OUT_TAU * 6;

/** Chord roots (semitones above the key root) and the chord's third, per bar of the 4-bar loop. */
const PROG = new Int8Array([0, 8, 3, 10]);
const THIRD = new Int8Array([3, 4, 4, 4]);
/** Arpeggio pattern: indices into the 6 chord tones below. */
const ARP = new Int8Array([0, 1, 2, 3, 4, 3, 2, 1, 0, 2, 3, 5, 4, 3, 2, 1]);
/** Hat velocities per 16th. */
const HAT = new Float32Array([0.22, 0.12, 0.85, 0.14, 0.22, 0.12, 0.85, 0.3, 0.22, 0.12, 0.85, 0.14, 0.22, 0.18, 0.85, 0.4]);
/** Bass velocity per 8th (index = step / 2). */
const BASS = new Float32Array([1, 0.55, 0.8, 0.55, 0.9, 0.55, 0.8, 0.65]);
/** Sparkle lead: 4-bar phrase of scale degrees per 16th, -1 = rest (degree 5 = octave). */
const LEAD = new Int8Array([
  7, -1, -1, -1, -1, -1, 5, -1, -1, -1, 6, -1, -1, -1, -1, -1,
  5, -1, -1, -1, -1, -1, -1, -1, 4, -1, -1, 3, -1, -1, -1, -1,
  4, -1, -1, -1, -1, -1, 5, -1, -1, -1, 7, -1, -1, -1, 8, -1,
  7, -1, -1, -1, -1, -1, 6, -1, 5, -1, -1, -1, -1, -1, -1, -1,
]);

/** @param {number} zone 1-based */
export function zoneRoot(zone) {
  const z = zone < 1 ? 1 : Math.floor(zone);
  return ZONES[(z - 1) % ZONES.length].root;
}

/**
 * @typedef {Object} Music
 * @property {number} root          Key root (MIDI) currently sounding.
 * @property {number} pendingRoot   Key root that takes over at the next bar.
 * @property {number} tier
 * @property {number} zone
 * @property {number} nextTime      Start time of the next unscheduled 16th.
 * @property {GainNode[]} layers
 * @property {(t: number) => void} start
 * @property {(t: number) => void} resync      Move the next 16th to `t` (after a stall), keeping position.
 * @property {(end: number) => void} scheduleUntil
 * @property {(tier: number, t: number) => void} setTier
 * @property {(zone: number) => void} setZone
 * @property {(after: number) => number} nextBar  Start time of the first bar at or after `after`
 *   (where a pending key change lands), or -1 when the scheduler has not started.
 * @property {(scene: string, t: number) => void} setScene
 * @property {(t: number) => void} reset       Tier 1, zone 1 key (immediately).
 * @property {(t: number, i: number, on: boolean) => void} forceLayer  Test hook: solo / mute a layer.
 */

/**
 * @param {import('./graph.js').AudioGraph} g
 * @returns {Music}
 */
export function createMusic(g) {
  const ctx = g.ctx;

  /** @type {GainNode[]} */
  const layers = [];
  for (let i = 0; i < LAYERS; i++) {
    const lg = ctx.createGain();
    lg.gain.value = 0;
    lg.connect(g.musicBus);
    const send = ctx.createGain();
    send.gain.value = SEND[i];
    lg.connect(send);
    send.connect(g.verb);
    layers.push(lg);
  }
  // Shared per-layer tone shaping (voices connect into these; nothing created per note here).
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass'; padFilter.frequency.value = 1300; padFilter.Q.value = 0.6;
  padFilter.connect(layers[0]);
  const bassFilter = ctx.createBiquadFilter();
  bassFilter.type = 'lowpass'; bassFilter.frequency.value = 700; bassFilter.Q.value = 0.8;
  bassFilter.connect(layers[1]);
  const arpFilter = ctx.createBiquadFilter();
  arpFilter.type = 'lowpass'; arpFilter.frequency.value = 2400; arpFilter.Q.value = 0.9;
  arpFilter.connect(layers[2]);
  const hatFilter = ctx.createBiquadFilter();
  hatFilter.type = 'highpass'; hatFilter.frequency.value = 7000; hatFilter.Q.value = 0.7;
  hatFilter.connect(layers[3]);
  const leadFilter = ctx.createBiquadFilter();
  leadFilter.type = 'lowpass'; leadFilter.frequency.value = 5000; leadFilter.Q.value = 0.5;
  leadFilter.connect(layers[4]);

  const target = new Float32Array(LAYERS);
  const activeUntil = new Float64Array(LAYERS);
  const forced = new Int8Array(LAYERS); // test hook: 0 auto, 1 on, -1 off
  let titleMode = true;
  let step = 0;
  let bar = 0;

  /** @type {Music} */
  const m = {
    root: zoneRoot(1),
    pendingRoot: zoneRoot(1),
    tier: 1,
    zone: 1,
    nextTime: 0,
    layers,
    start(t) {
      step = 0; bar = 0; m.nextTime = t;
      applyLayers(t);
    },
    resync(t) { m.nextTime = t; },
    scheduleUntil(end) {
      while (m.nextTime < end) {
        scheduleStep(step, m.nextTime);
        m.nextTime += S16;
        step = (step + 1) & 15;
        if (step === 0) bar++;
      }
    },
    setTier(tier, t) {
      const n = tier < 1 ? 1 : tier > LAYERS ? LAYERS : Math.floor(tier);
      if (n === m.tier) return;
      m.tier = n;
      applyLayers(t);
    },
    setZone(zone) {
      m.zone = zone;
      m.pendingRoot = zoneRoot(zone);
    },
    nextBar(after) {
      if (!(m.nextTime > 0)) return -1;
      let tb = m.nextTime + ((16 - step) & 15) * S16;
      while (tb < after) tb += BAR;
      return tb;
    },
    setScene(scene, t) {
      if (scene === SCREEN.TITLE) titleMode = true;
      else if (scene === SCREEN.PLAYING || scene === SCREEN.GAMEOVER) titleMode = false;
      else return; // paused / resume / rotate / boot: keep what is playing
      applyLayers(t);
    },
    reset(t) {
      m.tier = 1; m.zone = 1;
      m.root = m.pendingRoot = zoneRoot(1);
      applyLayers(t);
    },
    forceLayer(t, i, on) {
      forced[i] = on ? 1 : -1;
      applyLayers(t);
    },
  };

  /** @param {number} t */
  function applyLayers(t) {
    for (let i = 0; i < LAYERS; i++) {
      let lvl = 0;
      if (forced[i] !== 0) lvl = forced[i] > 0 ? LEVEL[i] : 0;
      else if (titleMode) lvl = i === 0 ? LEVEL[0] * 0.7 : 0;
      else lvl = i < m.tier ? LEVEL[i] : 0;
      if (lvl === target[i]) continue;
      // Chain a new target from wherever the current fade is (no cancel / .value read needed).
      const p = layers[i].gain;
      if (lvl > 0) {
        p.setTargetAtTime(lvl, t, FADE_IN_TAU);
      } else {
        p.setTargetAtTime(0, t, FADE_OUT_TAU);
        activeUntil[i] = t + FADE_OUT_HOLD;
      }
      target[i] = lvl;
    }
  }

  /** @param {number} i @param {number} t */
  function live(i, t) { return target[i] > 0 || t < activeUntil[i]; }

  /** @param {number} s 16th within the bar @param {number} t */
  function scheduleStep(s, t) {
    if (s === 0) m.root = m.pendingRoot;
    const bi = bar & 3;
    let off = PROG[bi];
    if (off > 6) off -= 12;              // keep chord roots near the key root
    const chordRoot = m.root + off;
    const third = THIRD[bi];

    if (s === 0 && live(0, t) && (!titleMode || (bar & 1) === 0)) {
      pad(t, chordRoot + 12, third, titleMode ? BAR * 2 : BAR);
    }
    if ((s & 1) === 0 && live(1, t)) bass(t, chordRoot, BASS[s >> 1]);
    if (live(2, t)) arp(t, chordRoot + 24, third, ARP[s], s);
    if (live(3, t)) hat(t, HAT[s]);
    if (live(4, t)) {
      const d = LEAD[(bar & 3) * 16 + s];
      if (d >= 0) lead(t, scaleNote(m.root + 24, d, CONFIG.SCALE));
    }
  }

  // ------------------------------------------------------------ voices

  /** Chord of detuned saws through the shared pad low-pass. */
  /** @param {number} t @param {number} midi @param {number} third @param {number} dur */
  function pad(t, midi, third, dur) {
    const env = ctx.createGain();
    env.connect(padFilter);
    const end = swellEnv(env.gain, t, 0.07, Math.min(0.9, dur * 0.4), t + dur, 0.45);
    for (let n = 0; n < 3; n++) {
      const f = mtof(midi + (n === 0 ? 0 : n === 1 ? third : 7));
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = k === 0 ? -7 : 7;
        o.connect(env);
        o.start(t);
        o.stop(end);
        if (n === 0 && k === 0) onEnd(o, env);
      }
    }
  }

  /** @param {number} t @param {number} midi @param {number} vel */
  function bass(t, midi, vel) {
    const env = ctx.createGain();
    env.connect(bassFilter);
    const end = pluckEnv(env.gain, t, 0.42 * vel, 0.006, 0.075);
    const o = ctx.createOscillator();
    o.setPeriodicWave(g.soft);
    o.frequency.value = mtof(midi);
    o.connect(env);
    o.start(t);
    o.stop(end);
    onEnd(o, env);
  }

  /** @param {number} t @param {number} base @param {number} third @param {number} idx @param {number} s */
  function arp(t, base, third, idx, s) {
    // chord tones over two octaves: 1, 3, 5, 8, 10, 12
    const semis = idx === 0 ? 0 : idx === 1 ? third : idx === 2 ? 7 : idx === 3 ? 12 : idx === 4 ? 12 + third : 19;
    const env = ctx.createGain();
    env.connect(arpFilter);
    const vel = (s & 3) === 0 ? 1 : 0.7;
    const end = pluckEnv(env.gain, t, 0.16 * vel, 0.004, 0.06);
    const o = ctx.createOscillator();
    o.setPeriodicWave(g.soft);
    o.frequency.value = mtof(base + semis);
    o.connect(env);
    o.start(t);
    o.stop(end);
    onEnd(o, env);
  }

  /** @param {number} t @param {number} vel */
  function hat(t, vel) {
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    const env = ctx.createGain();
    src.connect(env);
    env.connect(hatFilter);
    const end = pluckEnv(env.gain, t, 0.22 * vel, 0.002, vel > 0.5 ? 0.03 : 0.015);
    src.start(t, Math.random() * 1.5);
    src.stop(end);
    onEnd(src, env);
  }

  /** @param {number} t @param {number} midi */
  function lead(t, midi) {
    const env = ctx.createGain();
    env.connect(leadFilter);
    const end = pluckEnv(env.gain, t, 0.13, 0.008, 0.32);
    const f = mtof(midi);
    const o = ctx.createOscillator();
    o.setPeriodicWave(g.bell);
    o.frequency.value = f;
    o.connect(env);
    o.start(t);
    o.stop(end);
    onEnd(o, env);
    // faint octave shimmer
    const env2 = ctx.createGain();
    env2.connect(leadFilter);
    const end2 = pluckEnv(env2.gain, t, 0.035, 0.004, 0.12);
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 2;
    o2.connect(env2);
    o2.start(t);
    o2.stop(end2);
    onEnd(o2, env2);
  }

  return m;
}
