// @ts-check
/**
 * Fairness bot (PLAN.md §8): holds while in rings, releases when the aim ray is clear onto the next
 * path planet. Pure. Used by tests, ?autoplay=1 and the title screen. Owned by stream A. PHASE 0 STUB.
 */

/** @returns {import('../contracts.js').Bot} */
export function createBot() {
  return { decide: () => true, reset: () => {} };
}
