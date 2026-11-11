// @ts-check
/**
 * Audio test page driver (src/audio/test.html). Not shipped with the game.
 * Buttons trigger every SFX through `audio.onEvent` with representative payloads; tier / zone /
 * scene / graze drive a fake world through `audio.update`. "Measure all" renders each sound and
 * each tier's music into an OfflineAudioContext with the same graph code and reports peak / RMS.
 * `window.__audioTest` exposes the engine and `measureAll()` for Playwright.
 */
import { EV, SCREEN } from '../contracts.js';
import { createAudio, createCore } from './engine.js';

const audio = createAudio();

/** Fake world: only the fields audio.update reads. */
const world = /** @type {any} */ ({
  dead: false,
  score: { tier: 1, zone: 1 },
  comet: { grazing: false },
});

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

let combo = 0;
let moteIdx = 0;

/** @type {[string, () => void][]} */
const SFX = [
  ['Catch (latch)', () => { combo = combo >= 15 ? 1 : combo + 1; audio.onEvent(EV.LATCH, 500, 0, 3, combo); }],
  ['Re-catch', () => audio.onEvent(EV.LATCH, 500, 0, 3, 0)],
  ['Perfect', () => audio.onEvent(EV.PERFECT, 500, 0, 3, 150)],
  ['Release', () => audio.onEvent(EV.RELEASE, 500, 0, 1100, 1.2)],
  ['Mote', () => { audio.onEvent(EV.MOTE, 500, 0, moteIdx, 10); moteIdx = (moteIdx + 1) % 7; }],
  ['Mote streak ×8', () => {
    for (let i = 0; i < 8; i++) setTimeout(() => audio.onEvent(EV.MOTE, 500, 0, i, 10), i * 55);
  }],
  ['Mote spam ×12 (cap)', () => { for (let i = 0; i < 12; i++) audio.onEvent(EV.MOTE, 500, 0, i, 10); }],
  ['Bounce', () => audio.onEvent(EV.BOUNCE, 0, 0, -1, 900)],
  ['Near miss', () => audio.onEvent(EV.NEAR_MISS, 500, 0, 4, 18)],
  ['Combo break', () => { audio.onEvent(EV.COMBO_BREAK, 0, 0, combo, 0); combo = 0; }],
  ['Tier up', () => {
    const prev = world.score.tier;
    const next = prev >= 5 ? 5 : prev + 1;
    world.score.tier = next; syncTierButtons();
    audio.onEvent(EV.TIER_UP, 0, 0, next, prev);
  }],
  ['Zone change', () => {
    const prev = world.score.zone;
    const next = prev >= 5 ? 1 : prev + 1;
    world.score.zone = next; syncZoneButtons();
    audio.onEvent(EV.ZONE_CHANGE, 0, 0, next, prev);
  }],
  ['Slingshot', () => audio.onEvent(EV.SLINGSHOT, 500, 0, 7, 250)],
  ['Black-hole drone (2s sweep)', () => {
    const c = audio.core, x = audio.context;
    if (!c || !x) return;
    for (let i = 0; i <= 20; i++) setTimeout(() => { const ac = audio.context; if (ac && audio.core) audio.core.sfx.well(i <= 10 ? i / 10 : (20 - i) / 10, ac.currentTime); }, i * 100);
  }],
  ['Death', () => { world.dead = true; audio.onEvent(EV.DEATH, 500, 0, 0, 3); }],
  ['Death (black hole)', () => { world.dead = true; audio.onEvent(EV.DEATH, 500, 0, 2, 3); }],
];

const sfxRow = $('sfx');
for (const [label, fn] of SFX) {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.sfx = label;
  b.addEventListener('click', fn);
  sfxRow.appendChild(b);
}

/** @type {HTMLButtonElement[]} */ const tierButtons = [];
/** @type {HTMLButtonElement[]} */ const zoneButtons = [];
for (let i = 1; i <= 5; i++) {
  const t = document.createElement('button');
  t.textContent = `×${i}`; t.dataset.tier = String(i);
  t.addEventListener('click', () => { world.score.tier = i; syncTierButtons(); });
  $('tiers').appendChild(t); tierButtons.push(t);
  const z = document.createElement('button');
  z.textContent = `Zone ${i}`; z.dataset.zone = String(i);
  z.addEventListener('click', () => {
    const prev = world.score.zone;
    world.score.zone = i; syncZoneButtons();
    if (prev !== i) audio.onEvent(EV.ZONE_CHANGE, 0, 0, i, prev);
  });
  $('zones').appendChild(z); zoneButtons.push(z);
}
function syncTierButtons() { tierButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === world.score.tier))); }
function syncZoneButtons() { zoneButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === world.score.zone))); }
syncTierButtons(); syncZoneButtons();

/** @type {string} */
let scene = SCREEN.TITLE;
/** @type {HTMLButtonElement[]} */ const sceneButtons = [];
for (const s of [SCREEN.TITLE, SCREEN.PLAYING, SCREEN.PAUSED, SCREEN.GAMEOVER]) {
  const b = document.createElement('button');
  b.textContent = s; b.dataset.scene = s;
  b.addEventListener('click', () => {
    scene = s; audio.setScene(s);
    if (s === SCREEN.PLAYING) world.dead = false;
    sceneButtons.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.scene === scene)));
  });
  $('scenes').appendChild(b); sceneButtons.push(b);
}
sceneButtons.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.scene === scene)));
audio.setScene(scene);

$('unlock').addEventListener('click', () => audio.unlock());
$('sound').addEventListener('click', (e) => {
  const b = /** @type {HTMLButtonElement} */ (e.currentTarget);
  const on = !audio.enabled;
  audio.setEnabled(on);
  if (on) audio.unlock();
  b.textContent = on ? 'Sound on' : 'Sound off';
  b.setAttribute('aria-pressed', String(on));
});
$('suspend').addEventListener('click', () => audio.suspend());
$('resume').addEventListener('click', () => { audio.unlock(); audio.resume(); });
$('reset').addEventListener('click', () => {
  world.dead = false; world.score.tier = 1; world.score.zone = 1; combo = 0; moteIdx = 0;
  syncTierButtons(); syncZoneButtons(); audio.resetRun();
});
$('graze').addEventListener('click', (e) => {
  const b = /** @type {HTMLButtonElement} */ (e.currentTarget);
  world.comet.grazing = !world.comet.grazing;
  b.textContent = world.comet.grazing ? 'Graze on' : 'Graze off';
  b.setAttribute('aria-pressed', String(world.comet.grazing));
});

let last = performance.now();
let statusText = '';
/** @param {number} now */
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  audio.update(world, dt);
  const core = audio.core;
  const ctx = audio.context;
  const txt = `state: ${audio.state} · enabled: ${audio.enabled} · scene: ${scene} · tier ${world.score.tier} · zone ${world.score.zone}` +
    (core && ctx ? ` · key root ${core.music.root} · grazing ${core.sfx.grazing} · voices ${core.sfx.voices(ctx.currentTime)} · t ${ctx.currentTime.toFixed(1)}s` : '');
  if (txt !== statusText) { statusText = txt; $('status').textContent = txt; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- offline level measurement

const SR = 44100;
const BAR = (60 / 108) * 4;

/**
 * @typedef {Object} Level
 * @property {string} name
 * @property {number} seconds
 * @property {number} peak        Linear sample peak (both channels).
 * @property {number} peakDb
 * @property {number} rmsDb       RMS over the whole render.
 * @property {number} maxRms50Db  Loudest 50ms window RMS.
 * @property {number} [rmsA]      Extra windows for specific checks (dB).
 * @property {number} [rmsB]
 * @property {number} [hfA]       High-frequency (first-difference) RMS in window A (dB).
 * @property {number} [hfB]
 * @property {number} [peakA]     Sample peak in window A / B (dBFS).
 * @property {number} [peakB]
 */

/**
 * @param {string} name @param {number} seconds
 * @param {(core: import('./engine.js').AudioCore) => void} setup
 * @param {[number, number][]} [windows] two [from, to] windows to report RMS for
 * @returns {Promise<Level>}
 */
async function render(name, seconds, setup, windows) {
  const w = /** @type {any} */ (window);
  const C = w.OfflineAudioContext || w.webkitOfflineAudioContext;
  const oc = new C(2, Math.ceil(seconds * SR), SR);
  const core = createCore(oc);
  setup(core);
  /** @type {AudioBuffer} */
  const buf = await oc.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let peak = 0, sum = 0, maxWin = 0, win = 0;
  const W = Math.floor(SR * 0.05);
  for (let i = 0; i < L.length; i++) {
    const a = L[i], b = R[i];
    const aa = a < 0 ? -a : a, bb = b < 0 ? -b : b;
    if (aa > peak) peak = aa;
    if (bb > peak) peak = bb;
    const e = (a * a + b * b) * 0.5;
    sum += e; win += e;
    if (i % W === W - 1) { if (win / W > maxWin) maxWin = win / W; win = 0; }
  }
  /** @param {number} p */
  const db = (p) => (p > 0 ? 20 * Math.log10(p) : -Infinity);
  /** @type {Level} */
  const out = { name, seconds, peak, peakDb: db(peak), rmsDb: db(Math.sqrt(sum / L.length)), maxRms50Db: db(Math.sqrt(maxWin)) };
  if (windows) {
    /** @param {number} a @param {number} b */
    const rmsOf = (a, b) => {
      let s = 0; const i0 = Math.floor(a * SR), i1 = Math.min(L.length, Math.floor(b * SR));
      for (let i = i0; i < i1; i++) s += (L[i] * L[i] + R[i] * R[i]) * 0.5;
      return db(Math.sqrt(s / Math.max(1, i1 - i0)));
    };
    /** RMS of the first difference: a crude high-pass, to show the low-pass closing. @param {number} a @param {number} b */
    const hfOf = (a, b) => {
      let s = 0; const i0 = Math.max(1, Math.floor(a * SR)), i1 = Math.min(L.length, Math.floor(b * SR));
      for (let i = i0; i < i1; i++) { const d = L[i] - L[i - 1], e = R[i] - R[i - 1]; s += (d * d + e * e) * 0.5; }
      return db(Math.sqrt(s / Math.max(1, i1 - i0)));
    };
    /** @param {number} a @param {number} b */
    const peakOf = (a, b) => {
      let p = 0; const i0 = Math.floor(a * SR), i1 = Math.min(L.length, Math.floor(b * SR));
      for (let i = i0; i < i1; i++) { const x = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (x > p) p = x; }
      return db(p);
    };
    out.peakA = peakOf(windows[0][0], windows[0][1]);
    out.peakB = peakOf(windows[1][0], windows[1][1]);
    out.rmsA = rmsOf(windows[0][0], windows[0][1]);
    out.rmsB = rmsOf(windows[1][0], windows[1][1]);
    out.hfA = hfOf(windows[0][0], windows[0][1]);
    out.hfB = hfOf(windows[1][0], windows[1][1]);
  }
  return out;
}

/** @param {import('./engine.js').AudioCore} c @param {number} tier @param {string} sc @param {number} secs */
function playMusic(c, tier, sc, secs) {
  c.music.setScene(sc, 0);
  c.music.setTier(tier, 0);
  c.music.start(0);
  c.music.scheduleUntil(secs);
}

/**
 * Busy 10 s scenario: everything that can coincide in real play, at the density of a good run.
 * Music is scheduled in 50 ms chunks interleaved with the events (as the live 25 ms scheduler does),
 * so tier layers join at the right moments. Window A (4.5–8.8 s) is the loud stretch; B is after death.
 * @param {import('./engine.js').AudioCore} c
 */
function busyScenario(c) {
  /** @type {[number, (t: number) => void][]} */
  const ev = [];
  let combo = 0;
  for (let t = 0.4; t < 8.9; t += 0.62) {           // a catch every 0.62 s, release 0.3 s later
    const cb = ++combo;
    ev.push([t, (x) => c.trigger(EV.LATCH, 0, 0, 0, cb, x)]);
    if (cb % 2 === 0) ev.push([t + 0.01, (x) => c.trigger(EV.PERFECT, 0, 0, 0, 150, x)]);
    ev.push([t + 0.3, (x) => c.trigger(EV.RELEASE, 0, 0, 900 + cb * 60, 0, x)]);
    for (let k = 0; k < 4; k++) ev.push([t + 0.34 + k * 0.05, (x) => c.trigger(EV.MOTE, 0, 0, k, 10, x)]);
  }
  for (const [t, tier] of [[1.0, 2], [2.4, 3], [3.6, 4], [4.6, 5]]) ev.push([t, (x) => c.trigger(EV.TIER_UP, 0, 0, tier, tier - 1, x)]);
  ev.push([2.0, (x) => c.trigger(EV.ZONE_CHANGE, 0, 0, 4, 3, x)]);
  ev.push([3.0, (x) => c.sfx.graze(true, x)]);
  ev.push([4.6, (x) => c.sfx.graze(false, x)]);
  for (const t of [1.7, 5.2, 7.9]) ev.push([t, (x) => c.trigger(EV.BOUNCE, 0, 0, 1, 900, x)]);
  for (const t of [2.9, 6.6, 8.2]) ev.push([t, (x) => c.trigger(EV.NEAR_MISS, 0, 0, 4, 18, x)]);
  ev.push([3.3, (x) => c.trigger(EV.COMBO_BREAK, 0, 0, 7, 0, x)]);
  for (let i = 0; i <= 10; i++) ev.push([5.4 + i * 0.07, (x) => c.sfx.well(i / 10, x)]);   // into a black hole's well…
  ev.push([6.2, (x) => { c.sfx.well(0, x); c.trigger(EV.SLINGSHOT, 0, 0, 7, 250, x); }]);  // …and out
  ev.push([9.0, (x) => c.trigger(EV.DEATH, 0, 0, 1, 3, x)]);
  ev.sort((p, q) => p[0] - q[0]);
  c.music.setScene(SCREEN.PLAYING, 0);
  c.music.start(0.02);
  let i = 0;
  for (let t = 0; t < 10.4; t += 0.05) {
    while (i < ev.length && ev[i][0] < t + 0.05) { const [et, fn] = ev[i++]; fn(et); }
    c.music.scheduleUntil(t + 0.05);
  }
}

/** @returns {Promise<Level[]>} */
async function measureAll() {
  /** @type {Level[]} */
  const res = [];
  const T0 = 0.05;
  const two = BAR * 2 + 0.6;
  /** @type {[string, number, number, number, number, number][]} */
  const sfx = [
    ['sfx latch combo 1', 1.5, EV.LATCH, 3, 1, 0],
    ['sfx latch combo 12', 1.5, EV.LATCH, 3, 12, 0],
    ['sfx latch re-catch', 1.5, EV.LATCH, 3, 0, 0],
    ['sfx perfect', 2, EV.PERFECT, 3, 150, 0],
    ['sfx release', 1.2, EV.RELEASE, 1100, 1.2, 0],
    ['sfx mote 0', 0.8, EV.MOTE, 0, 10, 0],
    ['sfx mote 6', 0.8, EV.MOTE, 6, 10, 0],
    ['sfx bounce', 1, EV.BOUNCE, -1, 900, 0],
    ['sfx near miss', 1, EV.NEAR_MISS, 4, 18, 0],
    ['sfx combo break', 1.2, EV.COMBO_BREAK, 7, 0, 0],
    ['sfx tier up', 2, EV.TIER_UP, 3, 2, 0],
    ['sfx zone change', 3.5, EV.ZONE_CHANGE, 2, 1, 0],
    ['sfx slingshot', 2, EV.SLINGSHOT, 7, 250, 0],
    ['sfx death', 3.5, EV.DEATH, 0, 3, 0],
    ['sfx death (black hole)', 3.5, EV.DEATH, 2, 3, 0],
  ];
  for (const [name, secs, type, a, b] of sfx) {
    res.push(await render(name, secs, (c) => {
      // keep the tier-up from also fading in music layers (no scheduler runs here anyway)
      c.trigger(type, 500, 0, a, b, T0);
    }));
  }
  res.push(await render('sfx graze loop (1.2s)', 1.8, (c) => { c.sfx.graze(true, T0); c.sfx.graze(false, T0 + 1.2); }));
  res.push(await render('sfx black-hole drone (full depth 1s)', 1.8, (c) => { c.sfx.well(1, T0); c.sfx.well(0, T0 + 1); }));
  res.push(await render('sfx mote streak ×8', 1.2, (c) => { for (let i = 0; i < 8; i++) c.trigger(EV.MOTE, 0, 0, i, 10, T0 + i * 0.055); }));

  res.push(await render('music title (pad, sparse)', two, (c) => playMusic(c, 1, SCREEN.TITLE, two - 0.6)));
  for (let t = 1; t <= 5; t++) {
    res.push(await render(`music tier ${t}`, two, (c) => playMusic(c, t, SCREEN.PLAYING, two - 0.6)));
  }
  const LAYER_NAMES = ['pad', 'bass pulse', 'arpeggio', 'noise hats', 'sparkle lead'];
  for (let i = 0; i < 5; i++) {
    res.push(await render(`music layer ${i + 1} solo (${LAYER_NAMES[i]})`, two, (c) => {
      c.music.setScene(SCREEN.PLAYING, 0);
      for (let k = 0; k < 5; k++) c.music.forceLayer(0, k, k === i);
      c.music.start(0);
      c.music.scheduleUntil(two - 0.6);
    }));
  }
  // Worst case: full music plus a pile of simultaneous SFX.
  res.push(await render('worst case: tier 5 + 10 SFX at once', 4, (c) => {
    playMusic(c, 5, SCREEN.PLAYING, 3.5);
    const t = 1.5;
    c.trigger(EV.LATCH, 0, 0, 0, 15, t); c.trigger(EV.PERFECT, 0, 0, 0, 150, t);
    c.trigger(EV.RELEASE, 0, 0, 2000, 0, t); c.trigger(EV.BOUNCE, 0, 0, 1, 900, t);
    c.trigger(EV.SLINGSHOT, 0, 0, 0, 250, t); c.trigger(EV.TIER_UP, 0, 0, 5, 4, t);
    for (let i = 0; i < 4; i++) c.trigger(EV.MOTE, 0, 0, i, 10, t + i * 0.02);
    c.sfx.graze(true, t);
  }));
  // A busy 10 s of play, scheduled in time order like the live scheduler (see busyScenario).
  res.push(await render('busy 10s: tiers 1→5, zone change, catches, motes, graze, slingshot, death at 9s', 10.5, busyScenario,
    [[4.5, 8.8], [9.4, 10.5]]));
  // Death low-pass on music: RMS before (A: 1.2–2.2s) vs after (B: 2.8–4.4s) death at 2.3s.
  res.push(await render('death low-pass: tier 5 music, death at 2.3s', 4.6, (c) => {
    playMusic(c, 5, SCREEN.PLAYING, 4.6);
    c.trigger(EV.DEATH, 0, 0, 0, 3, 2.3);
  }, [[1.2, 2.2], [3.4, 4.6]]));
  // Same render with the death SFX itself muted, to isolate the filtered music.
  res.push(await render('death low-pass: music only (sfxDry muted)', 4.6, (c) => {
    c.graph.sfxDry.gain.value = 0;
    playMusic(c, 5, SCREEN.PLAYING, 4.6);
    c.trigger(EV.DEATH, 0, 0, 0, 3, 2.3);
  }, [[1.2, 2.2], [3.4, 4.6]]));
  showLevels(res);
  return res;
}

/** @param {Level[]} res */
function showLevels(res) {
  /** @param {number} v */
  const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-inf');
  let html = '<table><tr><th>sound</th><th>peak dBFS</th><th>RMS dB</th><th>max 50ms RMS dB</th><th>win A</th><th>win B</th><th>HF A</th><th>HF B</th></tr>';
  for (const r of res) {
    const bad = r.peak >= 1 || r.peak < 1e-4;
    html += `<tr class="${bad ? 'bad' : ''}"><td>${r.name}</td><td>${f(r.peakDb)}</td><td>${f(r.rmsDb)}</td><td>${f(r.maxRms50Db)}</td>` +
      `<td>${r.rmsA != null ? f(r.rmsA) : ''}</td><td>${r.rmsB != null ? f(r.rmsB) : ''}</td>` +
      `<td>${r.hfA != null ? f(r.hfA) : ''}</td><td>${r.hfB != null ? f(r.hfB) : ''}</td></tr>`;
  }
  $('levels').innerHTML = html + '</table>';
}

$('measure').addEventListener('click', () => { measureAll().catch((e) => { $('levels').textContent = String(e); console.error(e); }); });

/** @type {any} */ (window).__audioTest = { audio, world, measureAll, sfxLabels: SFX.map((s) => s[0]) };
