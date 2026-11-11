// @ts-check
/** Score, combo and multiplier rules (PLAN.md §2.3). Pure. Owned by stream A. */
import { CONFIG } from '../config.js';

/** Multiplier tier (1..5) for a combo. @param {number} combo */
export function tierForCombo(combo) {
  const t = CONFIG.TIER_COMBO;
  for (let i = t.length - 1; i >= 0; i--) if (combo >= t[i]) return i + 1;
  return 1;
}
