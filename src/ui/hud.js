// @ts-check
/**
 * Playing HUD (PLAN.md §7): score top centre with multiplier and combo beside it, zone banner,
 * combo pop, PERFECT / SLINGSHOT flashes and the first-run prompt. Owned by stream D.
 *
 * Every DOM node is created once in createHud. update() runs every frame but touches the DOM only
 * when a displayed value changes (the score at most ~12 times a second), and never allocates: digits are written as interned
 * single-character strings (numtext.js), other labels are precomputed. Animations restart by
 * swapping between two identical CSS classes, so no forced layout is needed.
 */
import { CONFIG, ZONES } from '../config.js';
import { EV } from '../contracts.js';
import { createNumText } from './numtext.js';

const MULT_TEXT = Object.freeze(['×1', '×1', '×2', '×3', '×4', '×5']);
/** CSS colours for multiplier tiers 1..5 (index 0 unused), from CONFIG.TIER_COLORS. */
const TIER_CSS = Object.freeze(['#fff'].concat(CONFIG.TIER_COLORS.map((c) => {
  const k = (/** @type {number} */ v) => Math.round(255 * Math.min(1, v));
  return `rgb(${k(c[0])}, ${k(c[1])}, ${k(c[2])})`;
})));
const ZONE_LABELS = Object.freeze(Array.from({ length: 100 }, (_, i) => `ZONE ${i}`));
/** Scores from here on (7+ digits) use a smaller font so they never reach the side badges. */
const LONG_SCORE = 1000000;
/**
 * Minimum time between score repaints (~12 Hz). Height scoring changes the score on nearly every
 * frame, and each repaint redraws the score's blurred glow at device resolution. Catches, death
 * and a new run still show the exact value at once.
 */
const SCORE_INTERVAL_MS = 80;
/** Combo is shown from this value up (a "combo" of 1 is just a catch). */
const COMBO_SHOW_MIN = 2;
const HULL_SEGMENTS = Math.round((1 - CONFIG.BRACE_MIN_SIZE) / CONFIG.BRACE_SIZE_LOSS);

/**
 * @param {string} tag @param {string} cls @param {HTMLElement} [parent] @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Restart a one-shot CSS animation without forcing layout: alternate between class `a` and `b`
 * (the stylesheet gives both the same animation under two names).
 */
class Retrigger {
  /** @param {HTMLElement} node @param {string} cls */
  constructor(node, cls) { this.node = node; this.a = cls; this.b = cls + '2'; this.flip = false; }
  fire() {
    const l = this.node.classList;
    if (this.flip) { l.remove(this.b); l.add(this.a); } else { l.remove(this.a); l.add(this.b); }
    this.flip = !this.flip;
  }
  stop() { this.node.classList.remove(this.a, this.b); this.flip = false; }
}

/** @param {HTMLElement} root @returns {import('../contracts.js').Hud} */
export function createHud(root) {
  root.textContent = '';
  root.classList.add('hud');

  const top = el('div', 'hud-top', root);
  const mult = el('div', 'hud-mult t1', top, MULT_TEXT[1]);
  const scoreEl = el('div', 'hud-score', top);
  const combo = el('div', 'hud-combo off', top);
  const comboN = el('div', 'hud-combo-n', combo);
  el('div', 'hud-combo-l', combo, 'COMBO');
  const perfect = el('div', 'hud-perfect', root, 'PERFECT');
  const braceCue = el('div', 'hud-perfect hud-brace-cue', root, 'BRACE!');
  const braced = el('div', 'hud-perfect hud-braced', root, 'BRACED');
  // Hull: how many braces are left (size above BRACE_MIN_SIZE, in BRACE_SIZE_LOSS steps). Shown
  // once the comet has taken a hit.
  const hull = el('div', 'hud-hull off', root);
  el('span', 'hud-hull-l', hull, 'HULL');
  const hullTrack = el('span', 'hud-hull-track', hull);
  const hullFill = el('span', 'hud-hull-fill', hullTrack);
  for (let i = 1; i < HULL_SEGMENTS; i++) el('span', 'hud-hull-tick', hullTrack).style.left = `${(100 * i) / HULL_SEGMENTS}%`;
  const sling = el('div', 'hud-perfect hud-sling', root, 'SLINGSHOT');
  const missionEl = el('div', 'hud-mission', root);
  el('div', 'hud-mission-k', missionEl, '★ MISSION COMPLETE');
  const missionText = el('div', 'hud-mission-t', missionEl, '');
  const zone = el('div', 'hud-zone', root);
  const zoneN = el('div', 'hud-zone-n', zone, ZONE_LABELS[1]);
  const zoneName = el('div', 'hud-zone-name', zone, ZONES[0].name);
  el('div', 'hud-zone-rule', zone);
  const promptEl = el('div', 'hud-prompt', root);
  const promptB = el('b', '', promptEl);
  const promptRest = document.createTextNode('');
  promptEl.appendChild(promptRest);
  promptEl.setAttribute('aria-live', 'polite');

  const score = createNumText(scoreEl, 9, { group: true });
  const comboNum = createNumText(comboN, 3);
  score.set(0);
  comboNum.set(0);
  mult.style.color = TIER_CSS[1];

  const comboPop = new Retrigger(combo, 'pop');
  const perfectFlash = new Retrigger(perfect, 'on');
  const slingFlash = new Retrigger(sling, 'on');
  const zoneBanner = new Retrigger(zone, 'on');
  const missionToast = new Retrigger(missionEl, 'on');
  const braceFlash = new Retrigger(braceCue, 'on');
  const bracedFlash = new Retrigger(braced, 'on');
  /** Hull fill shown, in hundredths (-1 = not yet written). */
  let shownHull = -1;
  let hullOn = false;

  let longScore = false;
  /** Score shown in the DOM, when it was written (performance.now ms), and "write the next change at once". */
  let shownScore = 0;
  let scoreAt = -1e9;
  let scoreNow = false;
  let lastMult = 1;
  let lastCombo = 0;
  let comboVisible = false;
  /** @type {string | null} */
  let lastPrompt = null;
  let visible = true;

  /** @param {number} m */
  function setMult(m) {
    if (m < 1) m = 1; else if (m > 5) m = 5;
    if (m === lastMult) return;
    if (lastMult === 1) mult.classList.remove('t1');
    lastMult = m;
    mult.firstChild.nodeValue = MULT_TEXT[m];
    mult.style.color = TIER_CSS[m];
    if (m === 1) mult.classList.add('t1');
  }

  /** @param {number} c */
  function setCombo(c) {
    if (c === lastCombo) return;
    lastCombo = c;
    comboNum.set(c);
    const show = c >= COMBO_SHOW_MIN;
    if (show !== comboVisible) { comboVisible = show; combo.classList.toggle('off', !show); }
  }

  /** @param {number} z 1-based */
  function showZone(z) {
    if (!(z >= 1)) return;
    const def = ZONES[(z - 1) % ZONES.length];
    zoneN.firstChild.nodeValue = z < ZONE_LABELS.length ? ZONE_LABELS[z] : `ZONE ${z}`;
    zoneName.firstChild.nodeValue = def.name;
    zone.style.setProperty('--zone', def.accent);
    zoneBanner.fire();
  }

  return {
    update(world) {
      const s = world.score;
      if (s.score !== shownScore) {
        const now = performance.now();
        if (scoreNow || world.dead || now - scoreAt >= SCORE_INTERVAL_MS) {
          shownScore = s.score;
          scoreAt = now;
          scoreNow = false;
          score.set(shownScore);
          const long = shownScore >= LONG_SCORE;
          if (long !== longScore) { longScore = long; scoreEl.classList.toggle('long', long); }
        }
      }
      setMult(s.multiplier);
      setCombo(s.combo);
      const size = world.comet.size;
      const h = Math.round(Math.max(0, Math.min(1, (size - CONFIG.BRACE_MIN_SIZE) / (1 - CONFIG.BRACE_MIN_SIZE))) * 100);
      if (h !== shownHull) {
        shownHull = h;
        hullFill.style.width = `${h}%`;
        hull.classList.toggle('low', h <= 100 / HULL_SEGMENTS + 0.5);
        if (!hullOn && h < 100) { hullOn = true; hull.classList.remove('off'); }
      }
    },
    onEvent(type, _x, _y, a, _b) {
      if (type === EV.ZONE_CHANGE) showZone(a);
      else if (type === EV.COMBO_UP) { setCombo(a); if (a >= COMBO_SHOW_MIN) comboPop.fire(); }
      else if (type === EV.PERFECT) { perfectFlash.fire(); scoreNow = true; }
      else if (type === EV.LATCH) scoreNow = true;
      else if (type === EV.SLINGSHOT) slingFlash.fire();
      else if (type === EV.IMPACT) braceFlash.fire();
      else if (type === EV.BRACE) { braceFlash.stop(); bracedFlash.fire(); }
    },
    mission(label) {
      missionText.textContent = label;
      missionToast.fire();
    },
    prompt(text) {
      if (text === lastPrompt) return;
      lastPrompt = text;
      if (text == null || text === '') { promptEl.classList.remove('on'); return; }
      // First word is emphasised: "RELEASE to fling" → <b>RELEASE</b> to fling.
      const sp = text.indexOf(' ');
      promptB.textContent = sp < 0 ? text : text.slice(0, sp);
      promptRest.nodeValue = sp < 0 ? '' : text.slice(sp);
      promptEl.classList.add('on');
    },
    setVisible(v) {
      if (v === visible) return;
      visible = v;
      root.classList.toggle('off', !v);
    },
    resetRun() {
      score.set(0);
      shownScore = 0; scoreAt = -1e9; scoreNow = false;
      if (longScore) { longScore = false; scoreEl.classList.remove('long'); }
      lastMult = 0; setMult(1);
      lastCombo = -1; setCombo(0);
      comboPop.stop(); perfectFlash.stop(); slingFlash.stop(); zoneBanner.stop(); missionToast.stop();
      braceFlash.stop(); bracedFlash.stop();
      shownHull = -1; hullOn = false; hull.classList.add('off');
    },
  };
}
