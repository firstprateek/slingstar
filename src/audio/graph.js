// @ts-check
/**
 * Audio graph builder and shared helpers (PLAN.md §5). Works on any BaseAudioContext, so the same
 * code drives the live AudioContext and an OfflineAudioContext (used by the test page to measure
 * peak / RMS levels objectively).
 *
 *   music voices → layer gains → musicBus ─┐
 *   sfx voices ─────────────────→ sfxBus ──┼→ lowpass (death effect) → compressor → master → out
 *   layer / sfx sends → convolver → verbReturn ┘          ↑
 *   death burst / sub drop ──────→ sfxDry ────────────────┘  (bypasses the death low-pass)
 *
 * Noise buffers and the reverb impulse are generated once, when the graph is built (at unlock).
 */

/** Master output level. Everything is mixed to leave headroom below 0 dBFS. */
export const MASTER_LEVEL = 0.8;
/** The low-pass sits here when open (effectively transparent). */
export const LOWPASS_OPEN_HZ = 18000;
/** Length of the shared white-noise buffer, seconds. */
const NOISE_SECONDS = 2;
/** Reverb impulse length, seconds. Small room / short plate. */
const IMPULSE_SECONDS = 1.6;

/**
 * @typedef {Object} AudioGraph
 * @property {BaseAudioContext} ctx
 * @property {GainNode} master        Output level / mute.
 * @property {DynamicsCompressorNode} comp
 * @property {BiquadFilterNode} lowpass  Death low-pass, normally open.
 * @property {GainNode} musicBus
 * @property {GainNode} sfxBus
 * @property {GainNode} sfxDry        SFX that bypass the death low-pass (the death sound itself).
 * @property {ConvolverNode} verb     Reverb input (connect sends here).
 * @property {GainNode} sfxSend       sfxBus → verb amount.
 * @property {AudioBuffer} noise      Mono white noise, NOISE_SECONDS long.
 * @property {PeriodicWave} soft      Soft, rounded waveform (a few decaying harmonics).
 * @property {PeriodicWave} bell      Bright waveform for the sparkle lead / chimes.
 * @property {number} lowpassOpenHz
 */

/**
 * Build the whole graph on `ctx` and connect it to `ctx.destination`.
 * @param {BaseAudioContext} ctx
 * @param {number} [masterLevel]
 * @returns {AudioGraph}
 */
export function buildGraph(ctx, masterLevel = MASTER_LEVEL) {
  const master = ctx.createGain();
  master.gain.value = masterLevel;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;

  const lowpassOpenHz = Math.min(LOWPASS_OPEN_HZ, ctx.sampleRate * 0.5 - 200);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = lowpassOpenHz;
  lowpass.Q.value = 0.7;

  const musicBus = ctx.createGain();
  const sfxBus = ctx.createGain();
  const sfxDry = ctx.createGain();

  const verb = ctx.createConvolver();
  verb.buffer = makeImpulse(ctx, IMPULSE_SECONDS);
  const verbReturn = ctx.createGain();
  verbReturn.gain.value = 0.55;
  const sfxSend = ctx.createGain();
  sfxSend.gain.value = 0.22;

  musicBus.connect(lowpass);
  sfxBus.connect(lowpass);
  sfxBus.connect(sfxSend);
  sfxSend.connect(verb);
  verb.connect(verbReturn);
  verbReturn.connect(lowpass);
  lowpass.connect(comp);
  sfxDry.connect(comp);
  comp.connect(master);
  master.connect(ctx.destination);

  return {
    ctx, master, comp, lowpass, musicBus, sfxBus, sfxDry, verb, sfxSend,
    noise: makeNoise(ctx, NOISE_SECONDS),
    soft: makeWave(ctx, [1, 0.32, 0.12, 0.05, 0.02]),
    bell: makeWave(ctx, [1, 0.0, 0.25, 0.0, 0.1, 0.0, 0.04]),
    lowpassOpenHz,
  };
}

/**
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 */
function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Stereo decaying-noise impulse, gently low-passed so the tail is warm rather than hissy.
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 */
function makeImpulse(ctx, seconds) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // one-pole low-pass whose cutoff falls over the tail (high frequencies die first)
      const k = 0.55 - 0.4 * t;
      lp += k * ((Math.random() * 2 - 1) - lp);
      const pre = i < sr * 0.012 ? i / (sr * 0.012) : 1; // short fade-in avoids a click
      d[i] = lp * pre * Math.pow(1 - t, 2.6);
    }
  }
  return buf;
}

/**
 * @param {BaseAudioContext} ctx
 * @param {number[]} harmonics  Amplitudes of harmonics 1..n (sine phase).
 */
function makeWave(ctx, harmonics) {
  const n = harmonics.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 1; i < n; i++) imag[i] = harmonics[i - 1];
  return ctx.createPeriodicWave(real, imag);
}

// ---------------------------------------------------------------- helpers

/** MIDI note → Hz. @param {number} m */
export function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/**
 * Note `degree` steps up the minor pentatonic (several octaves), relative to `base` MIDI.
 * @param {number} base @param {number} degree @param {readonly number[]} scale
 */
export function scaleNote(base, degree, scale) {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  return base + 12 * oct + scale[degree - oct * n];
}

/** Envelope tails run this many time constants (≈ -60 dB) before the source stops. */
export const TAIL_TAUS = 7;

/**
 * Percussive envelope: short linear attack to `peak`, then exponential decay with time constant
 * `tau`. Returns the time by which it has decayed to about -60 dB (stop the source there).
 * @param {AudioParam} p @param {number} t @param {number} peak @param {number} attack @param {number} tau
 */
export function pluckEnv(p, t, peak, attack, tau) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, tau);
  return t + attack + tau * TAIL_TAUS;
}

/**
 * Swell envelope: linear attack to `peak`, hold until `release`, then decay with time constant
 * `tau`. Returns the time by which it has decayed to about -60 dB.
 * @param {AudioParam} p @param {number} t @param {number} peak @param {number} attack
 * @param {number} release @param {number} tau
 */
export function swellEnv(p, t, peak, attack, release, tau) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setValueAtTime(peak, release);
  p.setTargetAtTime(0, release, tau);
  return release + tau * TAIL_TAUS;
}

/**
 * Shared `onended` handler: disconnect the source and the node chain hung off it, so finished
 * voices are released promptly. One function for every voice (no per-voice closure).
 * @this {AudioScheduledSourceNode}
 */
export function endVoice() {
  const self = /** @type {any} */ (this);
  self.disconnect();
  if (self.__tail) { self.__tail.disconnect(); self.__tail = null; }
  if (self.__tail2) { self.__tail2.disconnect(); self.__tail2 = null; }
}

/**
 * Attach cleanup to a voice: when `src` ends, disconnect it and up to two tail nodes.
 * @param {AudioScheduledSourceNode} src @param {AudioNode | null} tail @param {AudioNode | null} [tail2]
 */
export function onEnd(src, tail, tail2) {
  const s = /** @type {any} */ (src);
  s.__tail = tail;
  s.__tail2 = tail2 || null;
  src.onended = endVoice;
}

/**
 * Fixed-size voice pool: tracks when each slot's sound ends. `take` returns false when every slot
 * is still sounding, so callers can drop the new sound (voice cap). No allocation.
 */
export class VoicePool {
  /** @param {number} size */
  constructor(size) { this.ends = new Float64Array(size); }
  /** @param {number} now @param {number} end */
  take(now, end) {
    const e = this.ends;
    for (let i = 0; i < e.length; i++) {
      if (e[i] <= now) { e[i] = end; return true; }
    }
    return false;
  }
  /** @param {number} now */
  active(now) {
    let n = 0;
    const e = this.ends;
    for (let i = 0; i < e.length; i++) if (e[i] > now) n++;
    return n;
  }
  clear() { this.ends.fill(0); }
}
