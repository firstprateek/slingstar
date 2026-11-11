// @ts-check
/** Title / paused / game over / resume / rotate screens (PLAN.md §7). Owned by stream D. PHASE 0 STUB. */

/**
 * @param {HTMLElement} _root @param {import('../contracts.js').ScreenHandlers} _handlers
 * @returns {import('../contracts.js').Screens}
 */
export function createScreens(_root, _handlers) {
  return { current: 'boot', show(s) { this.current = s; }, setSettings() {} };
}
