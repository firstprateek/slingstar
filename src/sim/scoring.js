// @ts-check
/**
 * Score, combo, multiplier and zone rules (PLAN.md §2.3–2.4). Pure, allocation-free.
 * Every function that changes the combo or tier also emits the matching events. Owned by stream A.
 */
import { CONFIG } from '../config.js';
import { EV } from '../contracts.js';
import { pushEvent } from '../core/events.js';

/** @typedef {import('../contracts.js').WorldT} WorldT */

/** Multiplier tier (1..5) for a combo. @param {number} combo */
export function tierForCombo(combo) {
  const t = CONFIG.TIER_COMBO;
  for (let i = t.length - 1; i >= 0; i--) if (combo >= t[i]) return i + 1;
  return 1;
}

/** Zone (1-based) for the highest path index caught. @param {number} pathReached */
export function zoneForPath(pathReached) {
  return 1 + Math.floor(pathReached / CONFIG.PATH_PLANETS_PER_ZONE);
}

/** Zone a path planet belongs to (the zone you are in when it is the next target). @param {number} pathIndex */
export function zoneOfPathIndex(pathIndex) {
  return 1 + Math.floor(Math.max(0, pathIndex - 1) / CONFIG.PATH_PLANETS_PER_ZONE);
}

/** Base speed for a zone. @param {number} zone */
export function baseSpeedForZone(zone) {
  const v = CONFIG.BASE_SPEED_START + CONFIG.BASE_SPEED_PER_ZONE * (zone - 1);
  return v > CONFIG.BASE_SPEED_CAP ? CONFIG.BASE_SPEED_CAP : v;
}

/** Linear 0..1 progress from zone 1 to zone 6 (used by band width and solve window). @param {number} zone */
export function zoneT(zone) {
  const t = (zone - 1) / 5;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Capture band width (Rc - R) for a zone. @param {number} zone */
export function captureBand(zone) {
  return CONFIG.CAPTURE_BAND_Z1 + (CONFIG.CAPTURE_BAND_Z6 - CONFIG.CAPTURE_BAND_Z1) * zoneT(zone);
}

/** Minimum solvability window in degrees for a zone. @param {number} zone */
export function solveWindowDeg(zone) {
  return CONFIG.SOLVE_WINDOW_DEG_Z1 + (CONFIG.SOLVE_WINDOW_DEG_Z6 - CONFIG.SOLVE_WINDOW_DEG_Z1) * zoneT(zone);
}

/** Max centre-to-centre path spacing for a zone. @param {number} zone */
export function pathSpacingMax(zone) {
  let t = (zone - 1) / (CONFIG.PATH_SPACING_LATE_ZONE - 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return CONFIG.PATH_SPACING_MAX_Z1 + (CONFIG.PATH_SPACING_MAX_LATE - CONFIG.PATH_SPACING_MAX_Z1) * t;
}

/** Add integer points (already multiplied). @param {WorldT} w @param {number} pts */
export function addPoints(w, pts) {
  w.score.score += pts;
}

/** Recompute tier/multiplier from the combo; emits TIER_UP on increases only. @param {WorldT} w */
function updateTier(w) {
  const s = w.score;
  const t = tierForCombo(s.combo);
  if (t > s.tier) pushEvent(w.events, EV.TIER_UP, w.comet.x, w.comet.y, t, s.tier);
  s.tier = t;
  s.multiplier = t;
}

/** Raise the combo by `inc` (1 normal, 2 perfect). Emits COMBO_UP and maybe TIER_UP. @param {WorldT} w @param {number} inc */
export function comboUp(w, inc) {
  const s = w.score;
  s.combo += inc;
  if (s.combo > s.bestCombo) s.bestCombo = s.combo;
  pushEvent(w.events, EV.COMBO_UP, w.comet.x, w.comet.y, s.combo, inc);
  updateTier(w);
}

/** Reset the combo (COMBO_BREAK_REASON). Emits COMBO_BREAK only when there was a combo to lose. @param {WorldT} w @param {number} reason */
export function comboBreak(w, reason) {
  const s = w.score;
  if (s.combo > 0) pushEvent(w.events, EV.COMBO_BREAK, w.comet.x, w.comet.y, s.combo, reason);
  s.combo = 0;
  updateTier(w);
}

/**
 * Record that a path planet was caught. Updates pathReached, zone and base speed; emits
 * ZONE_CHANGE when the zone rises.
 * @param {WorldT} w @param {number} pathIndex
 */
export function reachPath(w, pathIndex) {
  const s = w.score;
  if (pathIndex <= s.pathReached) return;
  s.pathReached = pathIndex;
  const z = zoneForPath(pathIndex);
  if (z > s.zone) {
    pushEvent(w.events, EV.ZONE_CHANGE, w.comet.x, w.comet.y, z, s.zone);
    s.zone = z;
    w.baseSpeed = baseSpeedForZone(z);
    if (w.comet.speed < w.baseSpeed) w.comet.speed = w.baseSpeed;
  }
}

/** Height points: 1 per HEIGHT_UNITS_PER_POINT of new max height (comet y). @param {WorldT} w */
export function updateHeight(w) {
  const s = w.score, y = w.comet.y;
  if (y <= s.maxHeight) return;
  const u = CONFIG.HEIGHT_UNITS_PER_POINT;
  s.score += Math.floor(y / u) - Math.floor(s.maxHeight / u);
  s.maxHeight = y;
}
