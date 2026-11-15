// @ts-check
/**
 * Title / playing / paused / game over / resume / rotate screens (PLAN.md §7). Owned by stream D.
 *
 * All screens are built once in createScreens and switched with a class. Every interactive element
 * carries `data-ui`, so platform/input.js never starts a hold from it. Overlays that must swallow
 * taps (paused, game over, resume, rotate) are `data-ui` themselves; the title screen and the
 * playing layer are click-through except for their buttons, so the player can hold anywhere else.
 *
 * Buttons use `click`: input.js does not preventDefault touches on `data-ui` elements, so iOS
 * still synthesises the click. The #boot splash in index.html is faded out and removed the first
 * time a screen other than BOOT is shown.
 */
import { MODE, SCREEN } from '../contracts.js';
import { CONFIG, ZONES as ZONE_DEFS } from '../config.js';

/** Ignore game-over taps for this long after it appears, so a finger still down from play can't skip it. */
const GAMEOVER_TAP_GUARD_MS = CONFIG.GAMEOVER_TAP_GUARD_MS;

const SVG = Object.freeze({
  pause: '<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="1" width="3.6" height="12" rx="1.3" fill="#fff"/><rect x="8.4" y="1" width="3.6" height="12" rx="1.3" fill="#fff"/></svg>',
  soundOn: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="#fff"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.3 6.4a8 8 0 0 1 0 11.2"/></svg>',
  soundOff: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="#fff"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.8v16.4a1 1 0 0 0 1.5.86l13.7-8.2a1 1 0 0 0 0-1.72L7.5 2.94A1 1 0 0 0 6 3.8z" fill="#fff"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
  reload: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/></svg>',
});

/**
 * @param {string} tag @param {string} cls @param {HTMLElement | null} parent @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** @param {HTMLElement} parent @param {string} cls @param {string} label @returns {HTMLButtonElement} */
function button(parent, cls, label) {
  const b = /** @type {HTMLButtonElement} */ (el('button', cls, parent));
  b.type = 'button';
  b.setAttribute('data-ui', '');
  if (label) b.setAttribute('aria-label', label);
  return b;
}

/** @param {number} n */
function fmt(n) {
  const v = Math.max(0, Math.floor(n || 0));
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Mission list (title and game-over cards): a header with the star count and one row per mission.
 * Display only (no data-ui): on the title screen a hold that starts on it still plays.
 * @param {HTMLElement} parent @param {string} cls
 */
function missionList(parent, cls) {
  const box = el('div', 'missions ' + cls, parent);
  const head = el('div', 'missions-head', box);
  el('span', '', head, 'MISSIONS');
  const starsEl = el('span', 'missions-stars', head, '');
  /** @type {{ row: HTMLElement, text: HTMLElement, value: HTMLElement, bar: HTMLElement }[]} */
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = el('div', 'mission', box);
    el('span', 'mission-check', row);
    const text = el('span', 'mission-text', row, '');
    const value = el('span', 'mission-value', row, '');
    const track = el('span', 'mission-bar', row);
    const bar = el('span', '', track);
    rows.push({ row, text, value, bar });
  }
  return {
    /**
     * @param {import('../contracts.js').MissionView[] | undefined} list
     * @param {number | undefined} stars
     */
    set(list, stars) {
      const n = Array.isArray(list) ? list.length : 0;
      box.hidden = n === 0;
      starsEl.textContent = stars ? `★ ${fmt(stars)}` : '';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], m = i < n && list ? list[i] : null;
        r.row.hidden = !m;
        if (!m) continue;
        const target = Math.max(1, Number(m.target) || 1);
        const p = Math.max(0, Math.min(target, Number(m.progress) || 0));
        r.text.textContent = m.label;
        r.value.textContent = m.done ? (m.fresh ? '+1 ★' : 'done') : p > 0 ? `${fmt(p)} / ${fmt(target)}` : '';
        r.bar.style.width = `${Math.round((m.done ? 1 : p / target) * 100)}%`;
        r.row.classList.toggle('done', !!m.done);
        r.row.classList.toggle('fresh', !!m.fresh);
        r.row.classList.toggle('started', p > 0);
      }
    },
  };
}

/**
 * @param {HTMLElement} root
 * @param {import('../contracts.js').ScreenHandlers} handlers
 * @returns {import('../contracts.js').Screens}
 */
export function createScreens(root, handlers) {
  root.textContent = '';
  /** @type {string} */
  let mode = MODE.ENDLESS;
  let sound = true;
  let gameoverShownAt = 0;
  /** Mouse-and-keyboard device: hints name the click and the space bar instead of a tap. */
  const desktop = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  /** A play-again key went down on the armed game-over card; its keyup restarts. */
  let overKeyDown = false;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let guardTimer = 0;

  /** @param {HTMLElement} node @param {() => void} fn */
  const onTap = (node, fn) => node.addEventListener('click', (e) => {
    e.stopPropagation();
    if (node instanceof HTMLButtonElement) node.blur();
    fn();
  });

  /** @param {string} cls @param {boolean} [blocking] */
  const makeScreen = (cls, blocking = false) => {
    const s = el('div', 'screen ' + cls, root);
    if (blocking) s.setAttribute('data-ui', '');
    return s;
  };

  // ------------------------------------------------------------------ title
  const title = makeScreen('s-title');
  const titleSound = button(title, 'icon-btn sound-btn', 'Sound');
  const titleSoundIcon = el('span', '', titleSound);
  const titleTop = el('div', 'title-top', title);
  el('div', 'wordmark', titleTop, 'SLINGSTAR');
  el('div', 'wordmark-orbit', titleTop);
  const best = el('div', 'best', titleTop);
  const bestLabel = document.createTextNode('BEST');
  best.appendChild(bestLabel);
  const bestValue = el('b', '', best, '0');
  const chips = el('div', 'chips', titleTop);
  chips.setAttribute('role', 'radiogroup');
  const chipDaily = button(chips, 'chip', '');
  chipDaily.innerHTML = 'Daily<span class="chip-sub">today’s sky</span>';
  const chipDailySub = /** @type {HTMLElement} */ (chipDaily.lastElementChild);
  const chipEndless = button(chips, 'chip', '');
  chipEndless.innerHTML = 'Endless<span class="chip-sub">new every run</span>';
  chipDaily.setAttribute('role', 'radio');
  chipEndless.setAttribute('role', 'radio');
  const titleHint = el('div', 'title-hint', title, 'hold and release to play');
  if (desktop) el('small', '', titleHint, 'mouse button or space bar');
  const titleMissions = missionList(title, 'title-missions');

  // ------------------------------------------------------------------ playing
  const playing = makeScreen('s-playing');
  const pauseBtn = button(playing, 'icon-btn pause-btn', 'Pause');
  el('span', '', pauseBtn).innerHTML = SVG.pause;

  // ------------------------------------------------------------------ paused
  const paused = makeScreen('s-paused scrim', true);
  const panel = el('div', 'panel', paused);
  el('div', 'heading', panel, 'PAUSED');
  const resumeBtn = button(panel, 'btn primary', '');
  resumeBtn.innerHTML = SVG.play + 'Resume';
  const restartBtn = button(panel, 'btn', '');
  restartBtn.innerHTML = SVG.restart + 'Restart';
  const pausedSound = button(panel, 'btn sound-row', '');
  const pausedSoundIcon = el('span', '', pausedSound);
  pausedSoundIcon.style.display = 'flex';
  pausedSound.appendChild(document.createTextNode('Sound'));
  const pausedSoundState = el('span', 'state', pausedSound, 'On');
  const reloadBtn = button(panel, 'btn ghost', '');
  reloadBtn.innerHTML = SVG.reload + 'Reload app';
  const version = el('div', 'version', panel, '');

  // ------------------------------------------------------------------ game over
  const over = makeScreen('s-over', true);
  const overTop = el('div', 'over-top', over);
  el('div', 'label', overTop, 'SCORE');
  const overScore = el('div', 'over-score', overTop, '0');
  const newBest = el('div', 'newbest', overTop, 'NEW BEST');
  const overBest = el('div', 'over-best', overTop);
  const overBestLabel = document.createTextNode('BEST');
  overBest.appendChild(overBestLabel);
  const overBestValue = el('b', '', overBest, '0');
  const stats = el('div', 'stats', overTop);
  const zoneStat = el('div', 'stat', stats);
  el('div', 'label small', zoneStat, 'ZONE');
  const zoneValue = el('div', 'stat-v', zoneStat, '1');
  const zoneName = el('div', 'stat-s', zoneStat, ZONE_DEFS[0].name);
  const comboStat = el('div', 'stat', stats);
  el('div', 'label small', comboStat, 'BEST COMBO');
  const comboValue = el('div', 'stat-v', comboStat, '0');
  const comboSub = el('div', 'stat-s', comboStat, 'in a row');
  const overMissions = missionList(overTop, 'over-missions');
  el('div', 'over-hint', over, desktop ? 'click or press space to play again' : 'tap anywhere to play again');

  // ------------------------------------------------------------------ resume
  const resume = makeScreen('s-resume scrim', true);
  el('div', 'resume-ring', resume).innerHTML = SVG.play;
  el('div', 'big-text', resume, 'Tap to resume');
  el('div', 'sub-text', resume, 'paused while you were away');

  // ------------------------------------------------------------------ rotate
  const rotate = makeScreen('s-rotate', true);
  el('div', 'phone', rotate);
  el('div', 'big-text', rotate, 'Rotate your phone');
  el('div', 'sub-text', rotate, 'Slingstar plays in portrait');

  /** @type {Record<string, HTMLElement | null>} */
  const byName = {
    [SCREEN.BOOT]: null,
    [SCREEN.TITLE]: title,
    [SCREEN.PLAYING]: playing,
    [SCREEN.PAUSED]: paused,
    [SCREEN.GAMEOVER]: over,
    [SCREEN.RESUME]: resume,
    [SCREEN.ROTATE]: rotate,
  };

  // ------------------------------------------------------------------ reflect settings
  function reflectSound() {
    const icon = sound ? SVG.soundOn : SVG.soundOff;
    titleSoundIcon.innerHTML = icon;
    pausedSoundIcon.innerHTML = icon;
    pausedSoundState.textContent = sound ? 'On' : 'Off';
    titleSound.setAttribute('aria-pressed', String(sound));
    pausedSound.setAttribute('aria-pressed', String(sound));
    titleSound.setAttribute('aria-label', sound ? 'Sound on' : 'Sound off');
  }
  function reflectMode() {
    const daily = mode === MODE.DAILY;
    chipDaily.classList.toggle('sel', daily);
    chipEndless.classList.toggle('sel', !daily);
    chipDaily.setAttribute('aria-checked', String(daily));
    chipEndless.setAttribute('aria-checked', String(!daily));
    bestLabel.nodeValue = daily ? 'TODAY’S BEST' : 'BEST';
  }
  reflectSound();
  reflectMode();

  // ------------------------------------------------------------------ wiring
  const toggleSound = () => { sound = !sound; reflectSound(); handlers.onSound(sound); };
  onTap(titleSound, toggleSound);
  onTap(pausedSound, toggleSound);
  /** @param {string} m */
  const pickMode = (m) => { if (m === mode) return; mode = m; reflectMode(); handlers.onMode(m); };
  onTap(chipDaily, () => pickMode(MODE.DAILY));
  onTap(chipEndless, () => pickMode(MODE.ENDLESS));
  onTap(pauseBtn, () => handlers.onPause());
  onTap(resumeBtn, () => handlers.onResume());
  onTap(restartBtn, () => handlers.onRestart());
  onTap(reloadBtn, () => handlers.onReload());
  onTap(resume, () => handlers.onResume());
  onTap(over, () => {
    if (performance.now() - gameoverShownAt < GAMEOVER_TAP_GUARD_MS) return;
    handlers.onRestart();
  });
  onTap(rotate, () => {});

  // Keyboard (desktop): Space / Enter on the game-over card plays again (on keyup, so the key's own
  // keydown never reaches the new run as a press), Escape / P pauses and resumes.
  window.addEventListener('keydown', (e) => {
    const k = e.code;
    const play = k === 'Space' || k === 'Enter' || k === 'NumpadEnter';
    const pause = k === 'Escape' || k === 'KeyP';
    if (api.current === SCREEN.GAMEOVER && play) {
      e.preventDefault();
      if (!e.repeat && performance.now() - gameoverShownAt >= GAMEOVER_TAP_GUARD_MS) overKeyDown = true;
    } else if (api.current === SCREEN.PLAYING && pause && !e.repeat) {
      e.preventDefault();
      handlers.onPause();
    } else if ((api.current === SCREEN.PAUSED || api.current === SCREEN.RESUME) && (pause || k === 'Enter') && !e.repeat) {
      e.preventDefault();
      handlers.onResume();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.code;
    if (!overKeyDown || (k !== 'Space' && k !== 'Enter' && k !== 'NumpadEnter')) return;
    overKeyDown = false;
    if (api.current === SCREEN.GAMEOVER) { e.preventDefault(); handlers.onRestart(); }
  });

  let bootGone = false;
  function hideBoot() {
    bootGone = true;
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('out');
    setTimeout(() => boot.remove(), 320);
  }

  /** @type {import('../contracts.js').Screens} */
  const api = {
    current: SCREEN.BOOT,
    show(screen, data) {
      if (!(screen in byName)) throw new Error(`screens.show: unknown screen "${screen}"`);
      if (!bootGone && screen !== SCREEN.BOOT) hideBoot();
      const d = data || {};
      if (screen === SCREEN.TITLE) {
        if (typeof d.mode === 'string') mode = d.mode;
        if (typeof d.sound === 'boolean') sound = d.sound;
        reflectMode(); reflectSound();
        // TITLE data may carry `daily`: today's date for the Daily chip ("Nov 10"); same seed all day.
        if (typeof d.daily === 'string' && d.daily) {
          chipDailySub.textContent = d.daily;
          chipDaily.setAttribute('aria-label', `Daily, ${d.daily}`);
        }
        const b = Number(d.best) || 0;
        best.style.visibility = b > 0 ? 'visible' : 'hidden';
        bestValue.textContent = fmt(b);
        titleMissions.set(d.missions, d.stars);
      } else if (screen === SCREEN.PAUSED) {
        if (typeof d.sound === 'boolean') { sound = d.sound; reflectSound(); }
        version.textContent = d.version ? `build ${d.version}` : '';
      } else if (screen === SCREEN.GAMEOVER) {
        overScore.textContent = fmt(d.score);
        overBestValue.textContent = fmt(Math.max(Number(d.best) || 0, Number(d.score) || 0));
        newBest.hidden = !d.newBest;
        overBest.hidden = !!d.newBest;
        overBestLabel.nodeValue = d.mode === MODE.DAILY ? 'TODAY’S BEST' : 'BEST';
        const z = Math.max(1, Math.floor(Number(d.zone) || 1));
        const def = ZONE_DEFS[(z - 1) % ZONE_DEFS.length];
        zoneValue.textContent = String(z);
        zoneName.textContent = def.name;
        zoneStat.style.setProperty('--zone', def.accent);
        const c = Math.max(0, Math.floor(Number(d.bestCombo) || 0));
        comboValue.textContent = String(c);
        comboSub.textContent = c === 1 ? 'catch' : 'in a row';
        overMissions.set(d.missions, d.stars);
        gameoverShownAt = performance.now();
        overKeyDown = false;
        over.classList.add('armed');
        if (guardTimer) clearTimeout(guardTimer);
        guardTimer = setTimeout(() => { over.classList.remove('armed'); guardTimer = 0; }, GAMEOVER_TAP_GUARD_MS);
      }
      if (screen !== api.current) {
        const prev = byName[api.current];
        if (prev) prev.classList.remove('on');
        const next = byName[screen];
        if (next) next.classList.add('on');
        api.current = screen;
        root.setAttribute('data-screen', screen);
      }
    },
    setSettings(m, s) {
      mode = m; sound = s;
      reflectMode(); reflectSound();
    },
  };
  return api;
}
