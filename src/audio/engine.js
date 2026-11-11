// @ts-check
/** WebAudio engine (PLAN.md §5). Owned by stream C. PHASE 0 STUB: silent. */

/** @returns {import('../contracts.js').Audio} */
export function createAudio() {
  return {
    enabled: true,
    state: 'none',
    unlock() {}, suspend() {}, resume() {},
    setEnabled(on) { this.enabled = on; },
    onEvent() {}, update() {}, setScene() {}, resetRun() {},
  };
}
