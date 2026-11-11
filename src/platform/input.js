// @ts-check
/** Pointer / touch / space input (PLAN.md §6). Owned by stream D. PHASE 0 STUB. */

/**
 * @param {HTMLElement} _target @param {{ onGesture?: () => void }} [_opts]
 * @returns {import('../contracts.js').InputSource}
 */
export function createInput(_target, _opts = {}) {
  return {
    held: false,
    sample(out) { out.held = false; out.pressedThisStep = false; out.releasedThisStep = false; },
    setEnabled() {}, reset() {},
  };
}
