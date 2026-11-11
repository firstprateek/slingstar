// @ts-check
/**
 * Fairness bot (PLAN.md §8): holds while in rings, releases when the aim ray is clear onto the next
 * path planet. Pure, allocation-free, reads only world state (no lookahead simulation beyond the
 * aim line the player also sees). Through a black hole's influence that line is the exact bent
 * flight (Phase 4), so the bot also takes lit slingshots. Binary pairs need nothing special: both
 * members carry the next path index, and from a member the line looks past its partner's ring (a
 * press there after a lit release arms for the lit ring). Used by tests, ?autoplay=1 and the title
 * screen. Owned by stream A.
 *
 * Usage: each step, `held = bot.decide(world)`; turn it into a SimInput (pressed/released edges
 * from the previous held value) and call world.step. Call `bot.reset()` with world.reset().
 */
import { COMET } from '../contracts.js';

/** @returns {import('../contracts.js').Bot} */
export function createBot() {
  // Before the run starts the home orbit only lets go on a release edge, so the bot presses once first.
  let pressedHome = false;

  /** @param {import('../contracts.js').WorldT} w */
  function decide(w) {
    const c = w.comet, b = w.bodies, aim = w.aim;
    if (w.dead || c.state === COMET.DEAD) return false;

    if (c.state === COMET.ORBIT) {
      if (!w.started && !pressedHome) { pressedHome = true; return true; }
      const cur = b.pathIndex[c.body];
      const want = (cur >= 0 ? cur : w.score.pathReached) + 1;
      if (aim.clear && aim.target >= 0 && b.pathIndex[aim.target] === want) return false;
      return true;
    }

    // Free flight: keep an armed hold; otherwise press as soon as a press cannot re-catch the
    // planet just left (outside its ring, or also inside another ring, which latch prefers).
    if (c.armed) return true;
    let inLast = false, inOther = false;
    for (let i = 0, n = b.count; i < n; i++) {
      if (!b.alive[i] || b.rc[i] <= 0) continue;
      const dx = c.x - b.x[i], dy = c.y - b.y[i];
      if (dx * dx + dy * dy >= b.rc[i] * b.rc[i]) continue;
      if (b.id[i] === c.lastBodyId) inLast = true; else inOther = true;
    }
    return !inLast || inOther;
  }

  return { decide, reset: () => { pressedHome = false; } };
}
