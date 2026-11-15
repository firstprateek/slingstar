// @ts-check
/**
 * Boot, state machine, frame loop and wiring (PLAN.md §3.2, §7). The only module that knows every
 * other module. Owns: screens flow (BOOT → TITLE → PLAYING → PAUSED / GAMEOVER, plus RESUME and
 * ROTATE overlays), run seeds and modes, best scores, first-run prompts, slow motion (near miss and
 * death) and the ?autoplay / ?debug / ?seed hooks.
 *
 * The frame loop allocates nothing: every closure, object and string it uses is created at boot.
 * Sim events are drained once per frame and handed to renderer, audio and HUD, then cleared.
 */
import { CONFIG, STEP, ZONES } from './config.js';
import { COMET, EV, MODE, SCREEN, STORAGE } from './contracts.js';
import { clearEvents } from './core/events.js';
import { createWorld } from './sim/world.js';
import { createBot } from './sim/bot.js';
import { createRenderer } from './render/renderer.js';
import { createAudio } from './audio/engine.js';
import { createHud } from './ui/hud.js';
import { createScreens } from './ui/screens.js';
import { createDebug } from './ui/debug.js';
import { createInput } from './platform/input.js';
import { createLifecycle } from './platform/lifecycle.js';
import { storage } from './platform/storage.js';
import { createMissions, emptyRunStats } from './meta/missions.js';
import { registerServiceWorker, reload } from './platform/pwa.js';
import { VERSION } from './version.js';

/** @typedef {import('./contracts.js').SimInput} SimInput */
/** @typedef {import('./contracts.js').Renderer} Renderer */

// ------------------------------------------------------------------ URL flags
const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const AUTOPLAY = params.get('autoplay') === '1';
const seedParam = params.get('seed');
const FIXED_SEED = seedParam != null && seedParam !== '' && Number.isFinite(Number(seedParam))
  ? Number(seedParam) >>> 0 : -1;
/**
 * ?fast=N (with ?autoplay=1 only): run the sim N× real time (1..8), so tests reach late zones sooner.
 * `window.__slingstar.fast` can change it at runtime (autoplay only), e.g. back to 1 for a screenshot:
 * the camera follows in real time, so at N > 1 it trails the comet.
 */
const fastParam = Math.floor(Number(params.get('fast')));
let fast = AUTOPLAY && fastParam > 1 ? Math.min(fastParam, 8) : 1;

const PROMPT_RELEASE = 'RELEASE to fling';
const PROMPT_HOLD = 'HOLD to catch';
/** After resuming mid-orbit the comet keeps orbiting on its own until the player's next press. */
const PROMPT_RESUME = 'TAP to fling';

/** Accent colour per palette, precomputed so zone changes write prebuilt strings. */
const ACCENT_HEX = ZONES.map((z) => z.accent);
const ACCENT_RGB = ZONES.map((z) => {
  const n = parseInt(z.accent.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
});

// ------------------------------------------------------------------ DOM
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const hudRoot = /** @type {HTMLElement} */ (document.getElementById('hud'));
const screensRoot = /** @type {HTMLElement} */ (document.getElementById('screens'));
const debugRoot = /** @type {HTMLElement} */ (document.getElementById('debug'));

// ------------------------------------------------------------------ settings & storage
/** Local date as YYYYMMDD. */
function todayKey() {
  const d = new Date();
  return String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
}

/** Short local date for the Daily chip, e.g. "Nov 10". Falls back to "today". */
function todayLabel() {
  try { return new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return 'today'; }
}

/** @type {import('./contracts.js').Settings} */
const settings = (() => {
  /** @type {any} */
  const s = storage.get(STORAGE.SETTINGS, null);
  return {
    sound: s && typeof s.sound === 'boolean' ? s.sound : true,
    mode: s && (s.mode === MODE.DAILY || s.mode === MODE.ENDLESS) ? s.mode : MODE.ENDLESS,
  };
})();
const saveSettings = () => storage.set(STORAGE.SETTINGS, settings);

/** @type {import('./contracts.js').FirstRunFlags} */
const firstRun = (() => {
  /** @type {any} */
  const f = storage.get(STORAGE.FIRST_RUN, null);
  return { released: !!(f && f.released), caught: !!(f && f.caught) };
})();
const saveFirstRun = () => storage.set(STORAGE.FIRST_RUN, firstRun);

/** @param {string} mode @param {string} [day] YYYYMMDD of the run (default today) */
const bestKey = (mode, day) => (mode === MODE.DAILY ? STORAGE.BEST_DAILY_PREFIX + (day || todayKey()) : STORAGE.BEST_ENDLESS);
/** @param {string} mode @param {string} [day] */
const readBest = (mode, day) => {
  const v = Number(storage.get(bestKey(mode, day), 0));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

/** Seed for a new run in `mode`. ?seed=N wins; Daily = today's date; Endless = random. @param {string} mode */
function runSeed(mode) {
  if (FIXED_SEED >= 0) return FIXED_SEED;
  if (mode === MODE.DAILY) return Number(todayKey());
  return (Math.random() * 4294967296) >>> 0;
}

// ------------------------------------------------------------------ renderer (may fail)
const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
let reducedMotion = !!(reducedQuery && reducedQuery.matches);

/** @type {Renderer | null} */
let renderer = null;
/** @type {string} */
let renderError = '';
try {
  const stored = Number(storage.get(STORAGE.RENDER_SCALE, CONFIG.RENDER_SCALE_MAX));
  renderer = createRenderer(canvas, {
    renderScale: Number.isFinite(stored) ? stored : CONFIG.RENDER_SCALE_MAX,
    reducedMotion,
    onRenderScale: (s) => storage.set(STORAGE.RENDER_SCALE, s),
  });
  if (!renderer.gl) { renderError = 'This device or browser does not support WebGL2.'; renderer = null; }
} catch (e) {
  renderError = 'The graphics could not start' + (e && /** @type {Error} */ (e).message ? `: ${/** @type {Error} */ (e).message}` : '.');
  renderer = null;
  try { console.warn('[slingstar] renderer failed:', e); } catch { /* */ }
}

if (!renderer) showFatal(renderError);
else boot(renderer);

/** Readable fallback instead of a black screen. @param {string} message */
function showFatal(message) {
  const bootEl = document.getElementById('boot');
  if (bootEl) bootEl.remove();
  const box = document.createElement('div');
  box.className = 'fatal';
  const h = document.createElement('div');
  h.className = 'fatal-title';
  h.textContent = 'SLINGSTAR';
  const p = document.createElement('p');
  p.textContent = message;
  const q = document.createElement('p');
  q.className = 'fatal-sub';
  q.textContent = 'Try updating iOS / Safari, or close other apps and reopen the game.';
  box.append(h, p, q);
  document.body.appendChild(box);
  /** @type {any} */ (window).__slingstar = { world: null, screen: SCREEN.BOOT, stats: null, version: VERSION, frames: 0, restart() {}, error: message };
}

// ================================================================== boot
/** @param {Renderer} renderer */
function boot(renderer) {
  const world = createWorld({ seed: runSeed(settings.mode), mode: settings.mode });
  const bot = createBot();
  const audio = createAudio();
  audio.setEnabled(settings.sound);
  const hud = createHud(hudRoot);
  const debug = DEBUG ? createDebug(debugRoot) : null;

  /** @type {string} */
  let screen = SCREEN.BOOT;
  /** Screen to return to when the ROTATE overlay goes away. @type {string} */
  let beforeRotate = SCREEN.TITLE;
  /** Sim steps only on these screens and while the page is visible. */
  let simRunning = false;
  let pageHidden = false;

  // Slow motion and death timers (real seconds; -1 = inactive).
  let nearT = -1;
  let deathT = -1;
  let overT = -1;
  let timeScale = 1;

  /** Local date (YYYYMMDD) the current run's Daily seed and best belong to. */
  let runDay = todayKey();
  /**
   * Resume latch: after "Tap to resume" / Resume mid-orbit, feed held=true to the sim so the comet
   * keeps orbiting (pause/hide dropped the real hold, and the sim treats held=false as a release).
   * Cleared by the next real press (then real input takes over), death, leaving the orbit or a new run.
   */
  let resumeHold = false;

  // Missions (meta/missions.js): progress only counts in real play, never under ?autoplay.
  const missions = createMissions(storage.get(STORAGE.MISSIONS, null), Math.random);
  const saveMissions = () => { if (!AUTOPLAY) storage.set(STORAGE.MISSIONS, missions.toJSON()); };
  const runStats = emptyRunStats();
  /** @type {import('./contracts.js').MissionView[]} */
  const missionViews = missions.active;

  /** @type {import('./contracts.js').GameOverData} */
  const overData = { score: 0, best: 0, newBest: false, zone: 1, bestCombo: 0, mode: settings.mode, missions: missionViews, stars: 0 };
  let accentPal = -1;

  const screens = createScreens(screensRoot, {
    onMode(m) {
      audio.unlock();
      if (m !== MODE.DAILY && m !== MODE.ENDLESS) return;
      if (screen !== SCREEN.TITLE || m === settings.mode) return;
      settings.mode = m;
      saveSettings();
      newRun();
      showTitle();
    },
    onSound(on) {
      settings.sound = on;
      saveSettings();
      // Enable first, then unlock inside this tap: turning sound on creates / resumes the context;
      // turning it off suspends it (unlock does nothing while sound is off).
      audio.setEnabled(on);
      audio.unlock();
    },
    onPause() {
      audio.unlock();
      if (screen === SCREEN.PLAYING) go(SCREEN.PAUSED, { sound: settings.sound, version: VERSION });
    },
    onResume() {
      audio.unlock();
      audio.resume();
      input.reset();
      if (screen === SCREEN.PAUSED || screen === SCREEN.RESUME) {
        resumeHold = !AUTOPLAY && world.started && !world.dead && world.comet.state === COMET.ORBIT;
        go(SCREEN.PLAYING);
      }
    },
    onRestart() {
      audio.unlock();
      if (screen !== SCREEN.GAMEOVER && screen !== SCREEN.PAUSED) return;
      restart();
    },
    onReload() { reload(); },
  });

  // The whole window is the button: on a wide screen the game is a centred column, and a press
  // beside it holds too (buttons and overlays carry data-ui, so they never start a hold).
  const input = createInput(document.body, { onGesture: () => audio.unlock() });

  createLifecycle({
    onHide() {
      pageHidden = true;
      audio.suspend();
      if (screen === SCREEN.PLAYING || screen === SCREEN.PAUSED) go(SCREEN.RESUME);
      else updateRunning();
    },
    onShow() {
      pageHidden = false;
      // Back on the title after midnight: today's Daily is a new course.
      if (screen === SCREEN.TITLE && settings.mode === MODE.DAILY && runDay !== todayKey()) { newRun(); showTitle(); }
      updateRunning();
      // TITLE / GAMEOVER carry on; audio comes back with the next tap (input onGesture → unlock).
    },
    onOrientation(landscape) {
      if (landscape) {
        if (screen !== SCREEN.ROTATE) beforeRotate = screen;
        go(SCREEN.ROTATE);
      } else if (screen === SCREEN.ROTATE) {
        if (beforeRotate === SCREEN.PLAYING || beforeRotate === SCREEN.PAUSED || beforeRotate === SCREEN.RESUME) go(SCREEN.RESUME);
        else if (beforeRotate === SCREEN.GAMEOVER) go(SCREEN.GAMEOVER, overData);
        else showTitle();
      }
    },
  });

  registerServiceWorker();

  // ---------------------------------------------------------------- screen flow
  function updateRunning() {
    simRunning = !pageHidden && (screen === SCREEN.TITLE || screen === SCREEN.PLAYING || screen === SCREEN.GAMEOVER);
  }

  /** @param {string} s @param {any} [data] */
  function go(s, data) {
    screens.show(s, data);
    screen = s;
    handle.screen = s;
    const overlay = s === SCREEN.PAUSED || s === SCREEN.RESUME || s === SCREEN.ROTATE;
    renderer.setScene(overlay ? SCREEN.PAUSED : s);
    audio.setScene(s);
    hud.setVisible(s === SCREEN.PLAYING || s === SCREEN.PAUSED || s === SCREEN.TITLE);
    hudRoot.classList.toggle('title-mode', s === SCREEN.TITLE);
    input.setEnabled(s === SCREEN.TITLE || s === SCREEN.PLAYING);
    if (s !== SCREEN.TITLE && s !== SCREEN.PLAYING) hud.prompt(null);
    overT = s === SCREEN.GAMEOVER ? 0 : -1;
    updateRunning();
  }

  function showTitle() {
    // The single title instruction: first run shows the HUD prompt "RELEASE to fling" in place of the hint.
    document.documentElement.classList.toggle('first-run', !AUTOPLAY && !firstRun.released);
    go(SCREEN.TITLE, {
      best: readBest(settings.mode), mode: settings.mode, sound: settings.sound, daily: todayLabel(),
      missions: AUTOPLAY ? [] : missionViews, stars: missions.stars,
    });
  }

  /** Reset everything for a new run in place (no allocation-heavy work: well under 300ms). */
  function newRun() {
    runDay = todayKey();
    world.reset(runSeed(settings.mode), settings.mode);
    bot.reset();
    renderer.resetRun(world);
    audio.resetRun();
    hud.resetRun();
    nearT = -1; deathT = -1; timeScale = 1; acc = 0;
    botHeld = false; pendPressed = false; pendReleased = false; resumeHold = false;
    beginMissionRun();
    setAccent(1);
  }

  /** Restart from GAMEOVER / PAUSED: straight to PLAYING with the comet orbiting home. */
  function restart() {
    newRun();
    input.reset();
    go(SCREEN.PLAYING);
  }

  let savedCatches = 0;
  /** New run (also at boot and on a restart from pause, which banks the abandoned run's catches). */
  function beginMissionRun() {
    Object.assign(runStats, emptyRunStats());
    savedCatches = 0;
    if (AUTOPLAY) return;
    missions.endRun();
    missions.beginRun();
    saveMissions();
  }

  /** Feed the run's progress to the missions; toast any that finish. */
  function updateMissions() {
    if (AUTOPLAY || !world.started) return;
    const s = world.score;
    runStats.path = s.pathReached; runStats.zone = s.zone; runStats.combo = s.bestCombo;
    runStats.score = s.score; runStats.catches = s.catches; runStats.perfects = s.perfects;
    const done = missions.update(runStats);
    if (done.length === 0) {
      // Keep the "total" mission's count safe if the run is abandoned (one write per new catch).
      if (runStats.catches !== savedCatches) { savedCatches = runStats.catches; saveMissions(); }
      return;
    }
    hud.mission(done.length === 1 ? done[0].label : done.map((m) => m.label).join(' · '));
    savedCatches = runStats.catches;
    saveMissions();
  }

  /** Death: record the best score and fill the game-over card. */
  function onDeath() {
    updateMissions();
    if (!AUTOPLAY) { missions.endRun(); saveMissions(); }
    const s = world.score;
    const prev = readBest(world.mode, runDay);
    const newBest = s.score > prev && s.score > 0;
    if (newBest && !AUTOPLAY) storage.set(bestKey(world.mode, runDay), s.score);
    overData.score = s.score;
    overData.best = newBest ? s.score : prev;
    overData.newBest = newBest;
    overData.zone = s.zone;
    overData.bestCombo = s.bestCombo;
    overData.mode = world.mode;
    overData.missions = AUTOPLAY ? [] : missionViews;
    overData.stars = missions.stars;
  }

  /** UI accent follows the zone palette (CSS custom properties; only on change). @param {number} zone */
  function setAccent(zone) {
    const p = (zone - 1) % ZONES.length;
    if (p === accentPal) return;
    accentPal = p;
    const st = document.documentElement.style;
    st.setProperty('--accent', ACCENT_HEX[p]);
    st.setProperty('--accent-rgb', ACCENT_RGB[p]);
  }

  // ---------------------------------------------------------------- events
  /** @param {number} type @param {number} a */
  function react(type, a) {
    switch (type) {
      case EV.NEAR_MISS:
        if (!world.dead && deathT < 0) nearT = 0;
        if (!world.dead) runStats.near++;
        break;
      case EV.MOTE:
        runStats.motes++;
        break;
      case EV.SLINGSHOT:
        runStats.sling++;
        break;
      case EV.DEATH:
        deathT = 0; nearT = -1;
        onDeath();
        break;
      case EV.RELEASE:
        if (screen === SCREEN.TITLE) go(SCREEN.PLAYING);
        if (!AUTOPLAY && !firstRun.released) {
          firstRun.released = true; saveFirstRun();
          document.documentElement.classList.remove('first-run');
        }
        break;
      case EV.LATCH:
        if (!AUTOPLAY && !firstRun.caught && world.started) { firstRun.caught = true; saveFirstRun(); }
        break;
      case EV.ZONE_CHANGE:
        setAccent(a | 0);
        break;
      default:
        break;
    }
  }

  function dispatch() {
    const q = world.events;
    for (let i = 0, n = q.count; i < n; i++) {
      const t = q.type[i], x = q.x[i], y = q.y[i], a = q.a[i], b = q.b[i];
      renderer.onEvent(t, x, y, a, b);
      audio.onEvent(t, x, y, a, b);
      hud.onEvent(t, x, y, a, b);
      react(t, a);
    }
    clearEvents(q);
  }

  // ---------------------------------------------------------------- frame loop
  /** @type {SimInput} */
  const sampled = { held: false, pressedThisStep: false, releasedThisStep: false };
  /** @type {SimInput} */
  const simIn = { held: false, pressedThisStep: false, releasedThisStep: false };
  let pendPressed = false, pendReleased = false;
  let botHeld = false;
  let acc = 0;
  let last = -1;
  let frames = 0;

  /** Slow-motion factor for this frame, advancing the real-time timers. @param {number} dt */
  function slowMotion(dt) {
    let ts = 1;
    if (deathT >= 0) {
      deathT += dt;
      if (deathT < CONFIG.DEATH_DURATION) ts = CONFIG.DEATH_TIMESCALE;
      else {
        deathT = -1;
        if (screen === SCREEN.PLAYING) go(SCREEN.GAMEOVER, overData);
      }
    } else if (nearT >= 0) {
      nearT += dt;
      const hold = CONFIG.NEAR_MISS_DURATION, ease = CONFIG.NEAR_MISS_EASE_S, lo = CONFIG.NEAR_MISS_TIMESCALE;
      if (nearT < hold) ts = lo;
      else if (nearT < hold + ease) {
        const u = (nearT - hold) / ease;
        ts = lo + (1 - lo) * u * u * (3 - 2 * u);
      } else nearT = -1;
    }
    if (reducedMotion && ts < 1) ts = 1 - (1 - ts) * CONFIG.REDUCED_MOTION_SLOWMO;
    return ts;
  }

  /**
   * Whether the free comet is still inside the capture ring of the planet it just left. A press
   * there re-latches that planet, so "HOLD to catch" waits until the comet is clear of it.
   */
  function insideLastRing() {
    const c = world.comet, b = world.bodies;
    if (c.lastBodyId === 0) return false;
    for (let i = 0, n = b.count; i < n; i++) {
      if (b.alive[i] === 0 || b.id[i] !== c.lastBodyId) continue;
      const dx = c.x - b.x[i], dy = c.y - b.y[i], rc = b.rc[i];
      return dx * dx + dy * dy < rc * rc;
    }
    return false;
  }

  function updatePrompt() {
    if (AUTOPLAY || world.dead || (screen !== SCREEN.TITLE && screen !== SCREEN.PLAYING)) { hud.prompt(null); return; }
    if (resumeHold) hud.prompt(PROMPT_RESUME);
    else if (!world.started) hud.prompt(firstRun.released ? null : PROMPT_RELEASE);
    else hud.prompt(!firstRun.caught && world.comet.state === COMET.FREE && !insideLastRing() ? PROMPT_HOLD : null);
  }

  /** @param {number} now */
  function frame(now) {
    requestAnimationFrame(frame);
    const rawMs = last < 0 ? 1000 / 60 : now - last;
    last = now;
    let dtReal = rawMs / 1000;
    if (dtReal > CONFIG.MAX_FRAME_DT) dtReal = CONFIG.MAX_FRAME_DT;
    if (dtReal < 0) dtReal = 0;

    // WebGL context lost mid-run (iOS does this in the foreground under memory pressure): the
    // screen is black, so stop the run behind "Tap to resume", like a hide. Resuming keeps the
    // orbit; while the context is still lost, PLAYING comes straight back here.
    if (screen === SCREEN.PLAYING && renderer.isContextLost()) go(SCREEN.RESUME);

    // Input: sample once per frame; edges wait for the first step that runs.
    input.sample(sampled);
    let simMs = 0;
    if (simRunning) {
      if (sampled.pressedThisStep) pendPressed = true;
      if (sampled.releasedThisStep) pendReleased = true;
      timeScale = slowMotion(dtReal);
      acc += dtReal * timeScale * fast;
      const t0 = DEBUG ? performance.now() : 0;
      let steps = 0;
      while (acc >= STEP && steps < CONFIG.MAX_STEPS_PER_FRAME * fast) {
        if (AUTOPLAY) {
          const h = bot.decide(world);
          simIn.held = h;
          simIn.pressedThisStep = h && !botHeld;
          simIn.releasedThisStep = !h && botHeld;
          botHeld = h;
        } else {
          // Resume latch hands over to real input on the first real press (a quick tap = press +
          // release, so it flings right away; a press-and-hold keeps orbiting until let go).
          if (resumeHold && (pendPressed || sampled.held || world.dead || world.comet.state !== COMET.ORBIT)) resumeHold = false;
          simIn.held = resumeHold || sampled.held;
          simIn.pressedThisStep = pendPressed;
          simIn.releasedThisStep = pendReleased;
          pendPressed = false; pendReleased = false;
        }
        world.step(STEP, simIn);
        acc -= STEP;
        steps++;
      }
      if (acc >= STEP) acc = 0;   // hit the step cap: drop the backlog rather than spiral
      if (DEBUG) simMs = performance.now() - t0;
      dispatch();
      if (screen === SCREEN.PLAYING && !world.dead) updateMissions();
      if (screen === SCREEN.GAMEOVER && overT >= 0) {
        overT += dtReal;
        if (AUTOPLAY && overT >= CONFIG.AUTOPLAY_RESTART_S) restart();
      }
    } else {
      pendPressed = false; pendReleased = false;
    }

    hud.update(world);
    updatePrompt();
    audio.update(world, dtReal);
    renderer.draw(world, acc / STEP, dtReal);
    handle.frames = ++frames;
    if (debug) debug.update(rawMs, simMs, renderer.stats);
  }

  // ---------------------------------------------------------------- debug handle
  /** @type {import('./contracts.js').SlingstarDebugHandle} */
  const handle = {
    world,
    screen,
    stats: renderer.stats,
    version: VERSION,
    frames: 0,
    restart() { restart(); },
  };
  /** @type {any} */ (window).__slingstar = handle;
  // Extra test hooks (tools/smoke.mjs): audio state and the resume latch.
  Object.defineProperty(handle, 'audioState', { get: () => audio.state, enumerable: true });
  Object.defineProperty(handle, 'resumeHold', { get: () => resumeHold, enumerable: true });
  Object.defineProperty(handle, 'audio', { value: audio });
  Object.defineProperty(handle, 'fast', {
    get: () => fast,
    set: (/** @type {number} */ n) => { if (AUTOPLAY) fast = Math.max(1, Math.min(8, Math.floor(Number(n)) || 1)); },
    enumerable: true,
  });

  // ---------------------------------------------------------------- resize / motion preference
  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
  if (reducedQuery) {
    const onMotion = () => { reducedMotion = reducedQuery.matches; renderer.setReducedMotion(reducedMotion); };
    if (typeof reducedQuery.addEventListener === 'function') reducedQuery.addEventListener('change', onMotion);
    else if (typeof reducedQuery.addListener === 'function') reducedQuery.addListener(onMotion);   // Safari < 14
  }

  // ---------------------------------------------------------------- start
  renderer.resetRun(world);
  setAccent(1);
  beginMissionRun();   // swaps out missions finished in the last session
  showTitle();
  requestAnimationFrame(frame);
}
