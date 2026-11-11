// @ts-check
/**
 * Moons, drifting planets, black holes, binary pairs (PLAN.md §2.5). Pure. Owned by stream A.
 *
 * Phase 1: the generator places only plain planets, but the motion rules below already follow the
 * contracts.js motion params so Phase 3 hazards only need generator support. Positions are pure
 * functions of world.time, which keeps the sim deterministic. No allocation.
 */
import { CONFIG } from '../config.js';
import { BODY, BODY_FLAG } from '../contracts.js';
import { TAU } from '../core/math.js';

/**
 * Move every body whose position is a function of time. Called once per step, after the previous
 * positions were stored. Parents are updated before moons by doing moons in a second pass.
 * @param {import('../contracts.js').WorldT} world
 */
export function updateBodyMotion(world) {
  const b = world.bodies, t = world.time, n = b.count;
  for (let i = 0; i < n; i++) {
    if (!b.alive[i] || b.type[i] === BODY.MOON) continue;
    const f = b.flags[i];
    if (f & BODY_FLAG.BINARY) {
      const th = b.m2[i] + b.m1[i] * t;
      b.x[i] = b.m3[i] + b.m0[i] * Math.cos(th);
      b.y[i] = b.m4[i] + b.m0[i] * Math.sin(th);
    } else if (f & BODY_FLAG.DRIFTING) {
      b.x[i] = b.m0[i] + b.m1[i] * Math.sin(TAU * t / b.m2[i] + b.m3[i]);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.MOON) continue;
    const p = b.parent[i];
    if (p < 0 || !b.alive[p]) continue;
    const th = b.m2[i] + b.m1[i] * t;
    b.x[i] = b.x[p] + b.m0[i] * Math.cos(th);
    b.y[i] = b.y[p] + b.m0[i] * Math.sin(th);
  }
}

/**
 * Black-hole acceleration on a free comet; writes into out[0], out[1]. accel = G / r², clamped,
 * only inside each hole's influence radius (rc).
 * @param {import('../contracts.js').WorldT} world @param {Float64Array} out
 */
export function blackHoleAccel(world, out) {
  out[0] = 0; out[1] = 0;
  const b = world.bodies, c = world.comet, n = b.count;
  for (let i = 0; i < n; i++) {
    if (!b.alive[i] || b.type[i] !== BODY.BLACKHOLE) continue;
    const dx = b.x[i] - c.x, dy = b.y[i] - c.y;
    const d2 = dx * dx + dy * dy;
    const rc = b.rc[i];
    if (d2 > rc * rc || d2 < 1) continue;
    const d = Math.sqrt(d2);
    let a = CONFIG.BLACKHOLE_G / d2;
    if (a > CONFIG.BLACKHOLE_MAX_ACCEL) a = CONFIG.BLACKHOLE_MAX_ACCEL;
    out[0] += (dx / d) * a;
    out[1] += (dy / d) * a;
  }
}
