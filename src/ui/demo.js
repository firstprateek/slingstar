// @ts-check
/**
 * Shell demo (stream D, dev only — never precached). Mounts the real HUD, screens, input,
 * lifecycle, storage, debug overlay and PWA registration against stub callbacks and a fake world
 * whose score / combo / zone change over time. A 2D canvas paints a bright, bloomy stand-in scene
 * so HUD legibility can be judged.
 *
 * URL params:
 *   ?screen=title|playing|paused|gameover|resume|rotate|boot   show that screen and freeze the flow
 *   ?newbest=1      game over shows "New best"
 *   ?best=N         title shows this best score
 *   ?zone=N         starting zone for the fake world / palette
 *   ?prompt=TEXT    force a HUD prompt
 *   ?controls=1     on-screen buttons for every screen and HUD event
 *   ?debug=0        hide the debug overlay (shown by default here)
 *   ?sw=0           skip service-worker registration;  ?sw=cache forces cache-first
 *   ?events=0       no automatic fake HUD events (tests drive them)
 * Everything is exposed on window.__demo for Playwright.
 */
import { CONFIG, ZONES } from '../config.js';
import { EV, MODE, SCREEN, STORAGE } from '../contracts.js';
import { createHud } from './hud.js';
import { createScreens } from './screens.js';
import { createDebug } from './debug.js';
import { createInput } from '../platform/input.js';
import { createLifecycle } from '../platform/lifecycle.js';
import { storage } from '../platform/storage.js';
import { registerServiceWorker, reload } from '../platform/pwa.js';
import { VERSION } from '../version.js';

const params = new URLSearchParams(location.search);
const forcedScreen = params.get('screen');
const autoEvents = params.get('events') !== '0';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const hudRoot = /** @type {HTMLElement} */ (document.getElementById('hud'));
const screensRoot = /** @type {HTMLElement} */ (document.getElementById('screens'));
const debugRoot = /** @type {HTMLElement} */ (document.getElementById('debug'));

// ------------------------------------------------------------------ fake world
const startZone = Math.max(1, Number(params.get('zone')) || 1);
const world = /** @type {any} */ ({
  mode: MODE.ENDLESS,
  score: { score: 0, combo: 0, bestCombo: 0, tier: 1, multiplier: 1, zone: startZone, maxHeight: 0, catches: 0, perfects: 0, pathReached: 0 },
});
/** @param {number} combo */
const tierFor = (combo) => { let t = 1; for (let i = 0; i < CONFIG.TIER_COMBO.length; i++) if (combo >= CONFIG.TIER_COMBO[i]) t = i + 1; return t; };

/** @type {{ name: string, args: any[], t: number }[]} */
const calls = [];
/** @param {string} name @param {...any} args */
const log = (name, ...args) => { calls.push({ name, args, t: performance.now() }); };

// ------------------------------------------------------------------ settings & storage
/** @type {import('../contracts.js').Settings} */
const settings = storage.get(STORAGE.SETTINGS, { sound: true, mode: MODE.ENDLESS });
/** @type {import('../contracts.js').FirstRunFlags} */
const firstRun = storage.get(STORAGE.FIRST_RUN, { released: false, caught: false });
const bestKey = () => (settings.mode === MODE.DAILY ? STORAGE.BEST_DAILY_PREFIX + todayKey() : STORAGE.BEST_ENDLESS);
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ modules
const hud = createHud(hudRoot);
const debug = params.get('debug') === '0' ? null : createDebug(debugRoot);
/** @type {string} */
let beforeOverlay = SCREEN.TITLE;
const screens = createScreens(screensRoot, {
  onMode(m) { log('onMode', m); settings.mode = m; storage.set(STORAGE.SETTINGS, settings); showTitle(); },
  onSound(on) { log('onSound', on); settings.sound = on; storage.set(STORAGE.SETTINGS, settings); },
  onPause() { log('onPause'); go(SCREEN.PAUSED); },
  onResume() { log('onResume'); input.reset(); go(SCREEN.PLAYING); },
  onRestart() { log('onRestart'); startRun(); },
  onReload() { log('onReload'); if (new URLSearchParams(location.search).get('noreload') !== '1') reload(); },
});
const input = createInput(canvas, { onGesture() { gestures++; } });
let gestures = 0;
const lifecycle = createLifecycle({
  onHide() { log('onHide'); if (screens.current === SCREEN.PLAYING) go(SCREEN.PAUSED); },
  onShow() { log('onShow'); if (screens.current === SCREEN.PAUSED || screens.current === SCREEN.PLAYING) go(SCREEN.RESUME); },
  onOrientation(landscape) {
    log('onOrientation', landscape);
    if (landscape) { if (screens.current !== SCREEN.ROTATE) beforeOverlay = screens.current; go(SCREEN.ROTATE); }
    else if (screens.current === SCREEN.ROTATE) go(beforeOverlay === SCREEN.PLAYING ? SCREEN.RESUME : beforeOverlay);
  },
});

/** @type {Promise<ServiceWorkerRegistration | null>} */
const swReady = params.get('sw') === '0' ? Promise.resolve(null)
  : registerServiceWorker({ strategy: params.get('sw') === 'cache' ? 'cache' : 'auto' });

// ------------------------------------------------------------------ flow
/** @param {string} s @param {any} [data] */
function go(s, data) {
  if (s === SCREEN.TITLE) return showTitle();
  if (s === SCREEN.PAUSED) data = data || { sound: settings.sound, version: VERSION };
  if (s === SCREEN.GAMEOVER && !data) {
    const best = storage.get(bestKey(), 0);
    const sc = world.score.score;
    const newBest = sc > best;
    if (newBest) storage.set(bestKey(), sc);
    data = { score: sc, best: Math.max(best, sc), newBest, zone: world.score.zone, bestCombo: world.score.bestCombo, mode: settings.mode };
  }
  screens.show(s, data);
  hud.setVisible(s === SCREEN.PLAYING || s === SCREEN.PAUSED);
  input.setEnabled(s === SCREEN.TITLE || s === SCREEN.PLAYING);
}
function showTitle() {
  const best = params.has('best') ? Number(params.get('best')) : storage.get(bestKey(), 0);
  screens.show(SCREEN.TITLE, { best, mode: settings.mode, sound: settings.sound });
  hud.setVisible(false);
  input.setEnabled(true);
}
function startRun() {
  const s = world.score;
  s.score = 0; s.combo = 0; s.bestCombo = 0; s.tier = 1; s.multiplier = 1; s.zone = startZone;
  hud.resetRun();
  runTime = 0;
  go(SCREEN.PLAYING);
}

// ------------------------------------------------------------------ fake events
let runTime = 0;
let nextCombo = 1.2, nextZone = 6, nextPerfect = 3.3, nextBreak = 14;
/** @param {number} type @param {number} a @param {number} b */
function emit(type, a, b) { hud.onEvent(type, 0, 0, a, b); }
function comboUp(inc = 1) {
  const s = world.score;
  s.combo += inc; if (s.combo > s.bestCombo) s.bestCombo = s.combo;
  const t = tierFor(s.combo);
  if (t !== s.tier) { emit(EV.TIER_UP, t, s.tier); s.tier = t; s.multiplier = t; }
  emit(EV.COMBO_UP, s.combo, inc);
}
function zoneUp() { const s = world.score; s.zone++; emit(EV.ZONE_CHANGE, s.zone, s.zone - 1); }
function perfect() { emit(EV.PERFECT, 0, CONFIG.POINTS_PERFECT * world.score.multiplier); comboUp(2); }
/** @param {number} dt */
function tickWorld(dt) {
  runTime += dt;
  const s = world.score;
  s.score += Math.round(dt * 260 * s.multiplier);
  if (!autoEvents) return;
  if (runTime > nextCombo) { nextCombo += 1.4; comboUp(1); }
  if (runTime > nextPerfect) { nextPerfect += 4.7; perfect(); }
  if (runTime > nextZone) { nextZone += 9; zoneUp(); }
  if (runTime > nextBreak) { nextBreak += 14; emit(EV.COMBO_BREAK, s.combo, 0); s.combo = 0; s.tier = 1; s.multiplier = 1; }
}

// ------------------------------------------------------------------ stand-in scene (2D canvas)
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
let cw = 0, ch = 0, dpr = 1;
function resize() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  cw = Math.round(canvas.clientWidth * dpr); ch = Math.round(canvas.clientHeight * dpr);
  canvas.width = cw; canvas.height = ch;
}
addEventListener('resize', resize);
resize();
/** @param {number} x @param {number} y @param {number} r @param {string} col @param {number} a */
function glow(x, y, r, col, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(0.15, col);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
/** @param {number} t */
function drawScene(t) {
  const z = ZONES[(world.score.zone - 1) % ZONES.length];
  const u = cw / 1000;   // world unit → pixels
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = z.bg; ctx.fillRect(0, 0, cw, ch);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.55; glow(cw * 0.2, ch * 0.25, cw * 0.9, z.nebulaA, 0); glow(cw * 0.9, ch * 0.7, cw * 0.8, z.nebulaB, 0);
  ctx.globalAlpha = 1;
  for (let i = 0; i < 120; i++) {
    const sx = ((i * 7919) % 1000) / 1000 * cw, sy = (((i * 104729) % 1000) / 1000 * ch + t * 20 * (1 + (i % 3))) % ch;
    ctx.fillStyle = `rgba(255,255,255,${0.3 + (i % 5) * 0.12})`; ctx.fillRect(sx, sy, dpr * (1 + (i % 2)), dpr * (1 + (i % 2)));
  }
  // home planet at 35% up the screen, with its capture ring
  const px = cw * 0.5, py = ch * 0.65, pr = 90 * u;
  ctx.strokeStyle = `${z.accent}55`; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(px, py, (90 + 170) * u, 0, Math.PI * 2); ctx.stroke();
  glow(px, py, pr * 2.2, z.nebulaB, 0.0);
  const pg = ctx.createRadialGradient(px - pr * 0.35, py - pr * 0.35, pr * 0.1, px, py, pr);
  pg.addColorStop(0, '#c9d6ff'); pg.addColorStop(0.5, z.nebulaA); pg.addColorStop(1, '#05060f');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  // a bright upper planet drifting under the score (worst case for HUD legibility)
  const qx = cw * (0.5 + 0.25 * Math.sin(t * 0.4)), qy = ch * 0.1;
  glow(qx, qy, 220 * u, z.accent, 0.9);
  // comet orbiting the home planet with a tail
  const or = (90 + 110) * u;
  for (let k = 40; k >= 0; k--) {
    const a = t * 2.2 - k * 0.045;
    const cx = px + Math.cos(a) * or, cy = py + Math.sin(a) * or;
    glow(cx, cy, (26 - k * 0.5) * u * (input.held ? 1.6 : 1), z.accent, k === 0 ? 1 : 0.25);
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ------------------------------------------------------------------ frame loop
/** @type {import('../contracts.js').RenderStats} */
const stats = { drawCalls: 14, particles: 0, renderScale: 1, cpuMs: 0, width: 0, height: 0, halfFloat: true };
/** @type {import('../contracts.js').SimInput} */
const simInput = { held: false, pressedThisStep: false, releasedThisStep: false };
let last = performance.now();
let t = 0;
const heldTag = document.createElement('div');
heldTag.id = 'demo-held';
if (params.get('controls') === '1') document.body.appendChild(heldTag);
let lastHeld = /** @type {boolean | null} */ (null);

/** @param {number} now */
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  t += dt;
  const t0 = performance.now();
  if (demo.autoSample && !forcedScreen) {
    input.sample(simInput);
    if (screens.current === SCREEN.TITLE && simInput.releasedThisStep) startRun();
    if (screens.current === SCREEN.PLAYING) {
      if (simInput.releasedThisStep && !firstRun.released) { firstRun.released = true; storage.set(STORAGE.FIRST_RUN, firstRun); }
      else if (simInput.pressedThisStep && firstRun.released && !firstRun.caught) { firstRun.caught = true; storage.set(STORAGE.FIRST_RUN, firstRun); }
    }
  }
  if (screens.current === SCREEN.PLAYING && !forcedScreen) tickWorld(dt);
  if (!params.get('prompt') && screens.current === SCREEN.PLAYING) {
    hud.prompt(!firstRun.released ? 'RELEASE to fling' : !firstRun.caught ? 'HOLD to catch' : null);
  }
  hud.update(world);
  const simMs = performance.now() - t0;
  drawScene(t);
  stats.cpuMs = performance.now() - t0 - simMs;
  stats.particles = 1200 + Math.round(600 * Math.sin(t));
  stats.width = cw; stats.height = ch;
  if (debug) debug.update(dt * 1000, simMs, stats);
  if (input.held !== lastHeld) { lastHeld = input.held; heldTag.textContent = input.held ? 'HELD' : 'up'; }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot
const demo = {
  input, hud, screens, lifecycle, storage, debug, world, calls, swReady, settings, firstRun,
  autoSample: true,
  get gestures() { return gestures; },
  /** Sample input once, returning a copy of the SimInput. */
  sample() { input.sample(simInput); return { held: simInput.held, pressed: simInput.pressedThisStep, released: simInput.releasedThisStep }; },
  go, startRun, comboUp, zoneUp, perfect,
  version: VERSION,
};
/** @type {any} */ (window).__demo = demo;

if (params.get('controls') === '1') {
  const bar = document.createElement('div');
  bar.id = 'demo-controls';
  /** @type {[string, () => void][]} */
  const items = [
    ['title', () => go(SCREEN.TITLE)], ['play', () => startRun()], ['pause', () => go(SCREEN.PAUSED)],
    ['over', () => go(SCREEN.GAMEOVER)], ['resume', () => go(SCREEN.RESUME)], ['rotate', () => go(SCREEN.ROTATE)],
    ['zone+', () => zoneUp()], ['combo+', () => comboUp(1)], ['perfect', () => perfect()],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.setAttribute('data-ui', '');
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    bar.appendChild(b);
  }
  document.body.appendChild(bar);
}

const forcedPrompt = params.get('prompt');
if (forcedPrompt) hud.prompt(forcedPrompt);

// Brief boot splash, then the requested screen.
setTimeout(() => {
  if (!forcedScreen) { showTitle(); return; }
  if (forcedScreen === SCREEN.BOOT) return;
  const s = world.score;
  if (forcedScreen === SCREEN.PLAYING || forcedScreen === SCREEN.PAUSED || forcedScreen === SCREEN.GAMEOVER) {
    s.score = 48210; s.combo = 7; s.bestCombo = 12; s.tier = 3; s.multiplier = 3; s.zone = Math.max(startZone, 3);
  }
  if (forcedScreen === SCREEN.GAMEOVER) {
    const nb = params.get('newbest') === '1';
    go(SCREEN.GAMEOVER, { score: s.score, best: nb ? s.score : 52340, newBest: nb, zone: s.zone, bestCombo: s.bestCombo, mode: settings.mode });
    hud.setVisible(false);
    return;
  }
  go(forcedScreen);
  if (forcedScreen === SCREEN.PLAYING) {
    hud.onEvent(EV.ZONE_CHANGE, 0, 0, s.zone, s.zone - 1);
    hud.onEvent(EV.COMBO_UP, 0, 0, s.combo, 1);
  }
}, 250);

requestAnimationFrame(frame);
