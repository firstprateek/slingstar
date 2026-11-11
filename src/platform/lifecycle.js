// @ts-check
/** Visibility, pagehide, orientation (PLAN.md §6). Owned by stream D. PHASE 0 STUB. */

/**
 * @param {{ onHide: () => void, onShow: () => void, onOrientation: (landscape: boolean) => void }} _h
 * @returns {import('../contracts.js').Lifecycle}
 */
export function createLifecycle(_h) { return { hidden: false, landscape: false }; }
