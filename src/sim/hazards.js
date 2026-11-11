// @ts-check
/** Moons, drifting planets, black holes, binary pairs (PLAN.md §2.5). Pure. Owned by stream A. PHASE 0 STUB. */

/** Move every body whose position is a function of time. @param {import('../contracts.js').WorldT} _world */
export function updateBodyMotion(_world) {}

/**
 * Black-hole acceleration on a free comet; writes into out[0], out[1].
 * @param {import('../contracts.js').WorldT} _world @param {Float64Array} out
 */
export function blackHoleAccel(_world, out) { out[0] = 0; out[1] = 0; }
