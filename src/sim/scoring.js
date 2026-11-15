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

/** Linear 0..1 progress from zone 1 to zone RAMP_END_ZONE (used by band width and solve window). @param {number} zone */
export function zoneT(zone) {
  const t = (zone - 1) / (CONFIG.RAMP_END_ZONE - 1);
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

/**
 * Speed the solvability time rule assumes on the planet being left (Phase 4): the zone's base speed
 * × SOLVE_WINDOW_SPEED_FACTOR (by default the speed cap, the fastest the comet can orbit there).
 * The zone is the target's (the zone you are in while it is the next target). @param {number} zone
 */
export function solveWindowSpeed(zone) {
  return baseSpeedForZone(zone) * CONFIG.SOLVE_WINDOW_SPEED_FACTOR;
}

/**
 * Required release window in degrees on an orbit of radius `rho` (Phase 4): the zone's degree rule
 * (solveWindowDeg) or, if wider, SOLVE_WINDOW_MIN_S of orbiting at solveWindowSpeed — the window
 * is guaranteed in time as well as in angle, since angular speed (speed / radius) keeps rising.
 * @param {number} zone @param {number} rho
 */
export function solveWindowReqDeg(zone, rho) {
  const deg = solveWindowDeg(zone);
  const t = (CONFIG.SOLVE_WINDOW_MIN_S * solveWindowSpeed(zone) / rho) * (180 / Math.PI);
  return t > deg ? t : deg;
}

/**
 * Turn rate (rad/s, unsigned) of a binary pair generated in a zone: BINARY_ANGULAR_SPEED through
 * zone 6, then BINARY_SPIN_RAMP more per zone up to BINARY_ANGULAR_SPEED_MAX. @param {number} zone
 */
export function binaryAngularSpeed(zone) {
  const w = CONFIG.BINARY_ANGULAR_SPEED + (zone > 6 ? CONFIG.BINARY_SPIN_RAMP * (zone - 6) : 0);
  return w > CONFIG.BINARY_ANGULAR_SPEED_MAX ? CONFIG.BINARY_ANGULAR_SPEED_MAX : w;
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
 * Record that a path planet was caught. Updates pathReached, zone and base speed (raising the
 * comet's speed, and its velocity with it, to the new base speed); emits ZONE_CHANGE when the zone rises.
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
    const c = w.comet;
    if (c.speed < w.baseSpeed) {
      // Keep the velocity in step with the speed (Phase 4: c.v / c.speed must stay a unit vector).
      const k = c.speed > 0 ? w.baseSpeed / c.speed : 0;
      c.vx *= k; c.vy *= k;
      c.speed = w.baseSpeed;
    }
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
