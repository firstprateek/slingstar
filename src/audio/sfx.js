// @ts-check
/**
 * Synthesised sound effects (PLAN.md §5). Every function takes the start time `t` explicitly, so
 * the same code runs on the live AudioContext and on an OfflineAudioContext for level checks.
 * Nodes are created per sound at trigger time (they are short-lived and released on `ended`);
 * nothing is created per frame. Voice pools cap overlap: mote blips beyond MOTE_VOICES and any
 * SFX beyond SFX_VOICES are dropped (the important ones — tier up, zone change, death — always play).
 */
import { CONFIG } from '../config.js';
import { mtof, scaleNote, pluckEnv, swellEnv, onEnd, VoicePool } from './graph.js';
import { zoneRoot } from './music.js';

const MOTE_VOICES = CONFIG.AUDIO_MOTE_VOICES;
const SFX_VOICES = CONFIG.AUDIO_SFX_VOICES;
const SCALE = CONFIG.SCALE;

/**
 * @typedef {Object} Sfx
 * @property {(t: number, combo: number) => void} latch
 * @property {(t: number) => void} perfect
 * @property {(t: number, speed: number) => void} release
 * @property {(t: number, index: number) => void} mote
 * @property {(t: number) => void} bounce
 * @property {(t: number, tier: number) => void} tierUp
 * @property {(t: number, zone: number) => void} zoneChange
 * @property {(t: number) => void} slingshot
 * @property {(t: number) => void} nearMiss
 * @property {(t: number) => void} comboBreak
 * @property {(t: number) => void} death
 * @property {(on: boolean, t: number) => void} graze   Start / stop the sizzle loop (idempotent).
 * @property {boolean} grazing
 * @property {(now: number) => number} voices          Active capped voices (debug).
 * @property {() => void} clear
 */

/**
 * @param {import('./graph.js').AudioGraph} g
 * @param {import('./music.js').Music} music   For the current key root.
 * @returns {Sfx}
 */
export function createSfx(g, music) {
  const ctx = g.ctx;
  const motePool = new VoicePool(MOTE_VOICES);
  const pool = new VoicePool(SFX_VOICES);

  /** @type {AudioBufferSourceNode | null} */
  let grazeSrc = null;
  /** @type {GainNode | null} */
  let grazeEnv = null;
  /** @type {OscillatorNode | null} */
  let grazeLfo = null;

  // ------------------------------------------------------------ building blocks

  /**
   * Tonal pluck/blip: oscillator → (optional low-pass with falling cutoff) → envelope → dest.
   * @param {number} t @param {number} freq @param {number} peak @param {number} attack @param {number} tau
   * @param {PeriodicWave | OscillatorType} wave @param {number} cutoffMul 0 = no filter, else cutoff starts at freq × this
   * @param {AudioNode} dest
   * @returns {number} end time
   */
  function tone(t, freq, peak, attack, tau, wave, cutoffMul, dest) {
    const o = ctx.createOscillator();
    if (typeof wave === 'string') o.type = /** @type {OscillatorType} */ (wave); else o.setPeriodicWave(wave);
    o.frequency.value = freq;
    const env = ctx.createGain();
    const end = pluckEnv(env.gain, t, peak, attack, tau);
    if (cutoffMul > 0) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1.2;
      f.frequency.setValueAtTime(Math.min(freq * cutoffMul, 16000), t);
      f.frequency.setTargetAtTime(freq * 1.4, t + 0.005, tau * 0.6);
      o.connect(f); f.connect(env);
      onEnd(o, env, f);
    } else {
      o.connect(env);
      onEnd(o, env);
    }
    env.connect(dest);
    o.start(t);
    o.stop(end);
    return end;
  }

  /**
   * Filtered noise sweep: noise → band-pass sweeping f0→f1 over `sweep` s → envelope → dest.
   * @param {number} t @param {number} f0 @param {number} f1 @param {number} sweep @param {number} q
   * @param {number} peak @param {number} attack @param {number} tau @param {AudioNode} dest
   * @param {BiquadFilterType} [type]
   * @returns {number} end time
   */
  function noiseSweep(t, f0, f1, sweep, q, peak, attack, tau, dest, type = 'bandpass') {
    const src = ctx.createBufferSource();
    src.buffer = g.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + sweep);
    const env = ctx.createGain();
    const end = pluckEnv(env.gain, t, peak, attack, tau);
    src.connect(f); f.connect(env); env.connect(dest);
    src.start(t, Math.random() * 1.2);
    src.stop(end);
    onEnd(src, f, env);
    return end;
  }

  /**
   * Pitch glide: oscillator sweeping f0→f1 (exponential) over `glide` s.
   * @param {number} t @param {number} f0 @param {number} f1 @param {number} glide
   * @param {number} peak @param {number} attack @param {number} tau @param {OscillatorType} type @param {AudioNode} dest
   * @returns {number} end time
   */
  function glide(t, f0, f1, glide, peak, attack, tau, type, dest) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + glide);
    const env = ctx.createGain();
    const end = pluckEnv(env.gain, t, peak, attack, tau);
    o.connect(env); env.connect(dest);
    o.start(t);
    o.stop(end);
    onEnd(o, env);
    return end;
  }

  // ------------------------------------------------------------ the sounds

  /** @type {Sfx} */
  const s = {
    grazing: false,

    latch(t, combo) {
      if (!pool.take(t, t + 1)) return;
      const d = combo > 0 ? Math.min(combo - 1, 13) : 0;
      const f = mtof(scaleNote(music.root + 12, d, SCALE));
      const dull = combo <= 0;
      tone(t, f, dull ? 0.22 : 0.3, 0.003, 0.16, g.soft, dull ? 2.5 : 7, g.sfxBus);
      tone(t, f * 2, dull ? 0.04 : 0.08, 0.002, 0.07, 'triangle', 0, g.sfxBus);
    },

    perfect(t) {
      if (!pool.take(t, t + 2)) return;
      const r = music.root + 36;
      for (let i = 0; i < 2; i++) {
        const ti = t + i * 0.07;
        const f = mtof(i === 0 ? r : r + 7);
        tone(ti, f, 0.12, 0.003, 0.35, 'sine', 0, g.sfxBus);
        tone(ti, f * 2.76, 0.035, 0.002, 0.12, 'sine', 0, g.sfxBus); // inharmonic bell partial
        tone(ti, f * 5.4, 0.012, 0.001, 0.05, 'sine', 0, g.sfxBus);
      }
    },

    release(t, speed) {
      if (!pool.take(t, t + 0.6)) return;
      const k = Math.max(0, Math.min(1, (speed - 600) / 1400));
      noiseSweep(t, 450, 2200 + 1600 * k, 0.22, 1.3, 0.5 + 0.18 * k, 0.035, 0.09, g.sfxBus);
    },

    mote(t, index) {
      if (!motePool.take(t, t + 0.18)) return; // voice cap: drop blips beyond a few overlapping
      const d = Math.max(0, Math.min(index | 0, 11));
      const f = mtof(scaleNote(music.root + 24, d, SCALE));
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * 0.97, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.02);
      const env = ctx.createGain();
      const end = pluckEnv(env.gain, t, 0.16, 0.002, 0.045);
      o.connect(env); env.connect(g.sfxBus);
      o.start(t); o.stop(end);
      onEnd(o, env);
      tone(t, f * 3, 0.025, 0.001, 0.02, 'sine', 0, g.sfxBus);
    },

    bounce(t) {
      if (!pool.take(t, t + 0.6)) return;
      glide(t, 230, 85, 0.12, 0.45, 0.003, 0.06, 'sine', g.sfxBus);
      noiseSweep(t, 1800, 600, 0.05, 0.8, 0.12, 0.001, 0.012, g.sfxBus, 'lowpass');
    },

    tierUp(t, tier) {
      // rising 4-note pentatonic run, starting higher for higher tiers; always plays
      const base = music.root + 24;
      const start = Math.max(0, Math.min(4, (tier | 0) - 1));
      for (let i = 0; i < 4; i++) {
        const f = mtof(scaleNote(base, start + i * 2, SCALE));
        tone(t + i * 0.065, f, 0.13, 0.003, 0.14, g.soft, 6, g.sfxBus);
      }
      const top = mtof(scaleNote(base, start + 8, SCALE));
      tone(t + 0.26, top * 2, 0.05, 0.004, 0.3, 'sine', 0, g.sfxBus);
    },

    zoneChange(t, zone) {
      // airy riser into a soft chord in the new key; always plays
      const r = zoneRoot(zone) + 12;
      const src = ctx.createBufferSource();
      src.buffer = g.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.4;
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(4500, t + 0.8);
      const env = ctx.createGain();
      const nEnd = swellEnv(env.gain, t, 0.16, 0.75, t + 0.8, 0.08);
      src.connect(f); f.connect(env); env.connect(g.sfxBus);
      src.start(t, Math.random() * 0.5);
      src.stop(nEnd);
      onEnd(src, f, env);
      const tc = t + 0.75;
      for (let i = 0; i < 4; i++) {
        const semis = i === 0 ? 0 : i === 1 ? 7 : i === 2 ? 12 : 15;
        const o = ctx.createOscillator();
        o.setPeriodicWave(g.soft);
        o.frequency.value = mtof(r + semis);
        const e = ctx.createGain();
        const end = swellEnv(e.gain, tc, 0.07, 0.05, tc + 0.35, 0.5);
        o.connect(e); e.connect(g.sfxBus);
        o.start(tc); o.stop(end);
        onEnd(o, e);
      }
    },

    slingshot(t) {
      if (!pool.take(t, t + 1)) return;
      glide(t, 160, 880, 0.4, 0.16, 0.05, 0.16, 'triangle', g.sfxBus);
      noiseSweep(t, 300, 3200, 0.4, 1.6, 0.2, 0.15, 0.12, g.sfxBus);
      tone(t + 0.36, mtof(music.root + 31), 0.08, 0.003, 0.25, g.bell, 0, g.sfxBus);
    },

    nearMiss(t) {
      if (!pool.take(t, t + 0.4)) return;
      noiseSweep(t, 3200, 1100, 0.16, 2, 0.13, 0.02, 0.05, g.sfxBus);
    },

    comboBreak(t) {
      if (!pool.take(t, t + 0.6)) return;
      const r = music.root + 19;
      tone(t, mtof(r), 0.1, 0.004, 0.08, g.soft, 3, g.sfxBus);
      tone(t + 0.09, mtof(r - 5), 0.1, 0.004, 0.12, g.soft, 3, g.sfxBus);
    },

    death(t) {
      // noise burst + sub drop on the dry path (the music low-pass is closed by the engine)
      noiseSweep(t, 4000, 180, 0.5, 0.7, 0.5, 0.004, 0.16, g.sfxDry, 'lowpass');
      glide(t, 150, 32, 0.9, 0.62, 0.01, 0.35, 'sine', g.sfxDry);
      glide(t, 300, 64, 0.9, 0.12, 0.01, 0.2, 'triangle', g.sfxDry); // audible on phone speakers
      s.graze(false, t);
    },

    graze(on, t) {
      if (on === s.grazing) return;
      s.grazing = on;
      if (on) {
        const src = ctx.createBufferSource();
        src.buffer = g.noise;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 5200; bp.Q.value = 0.9;
        const mod = ctx.createGain();       // crackle: fast amplitude wobble
        mod.gain.value = 0.65;
        const lfo = ctx.createOscillator();
        lfo.type = 'square'; lfo.frequency.value = 27;
        const lfoAmt = ctx.createGain();
        lfoAmt.gain.value = 0.35;
        lfo.connect(lfoAmt); lfoAmt.connect(mod.gain);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t);
        env.gain.setTargetAtTime(0.11, t, 0.04);
        src.connect(bp); bp.connect(mod); mod.connect(env); env.connect(g.sfxBus);
        src.start(t, Math.random() * 1.5);
        lfo.start(t);
        onEnd(src, bp, env);
        onEnd(lfo, lfoAmt);
        grazeSrc = src; grazeEnv = env; grazeLfo = lfo;
      } else if (grazeSrc && grazeEnv && grazeLfo) {
        // chain a new target after the fade-in (no cancel: reading .value is unreliable offline)
        grazeEnv.gain.setTargetAtTime(0, t, 0.05);
        const end = t + 0.4;
        grazeSrc.stop(end);
        grazeLfo.stop(end);
        grazeSrc = null; grazeEnv = null; grazeLfo = null;
      }
    },

    voices(now) { return pool.active(now) + motePool.active(now); },

    clear() { pool.clear(); motePool.clear(); },
  };
  return s;
}
