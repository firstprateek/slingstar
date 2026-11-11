// Tuning report (Phase 2): plays many seeds with the perfect fairness bot (src/sim/bot.js) and the
// human-like bot (tests/humanbot.js) and prints the statistics config.js is tuned against.
//   node tools/tune.mjs [seeds=200]
// Targets (PLAN.md §2.1, §8): perfect bot reaches zone 4 on >= 90/100 seeds; the human-like bot's
// median run lasts roughly 30–90 s; its first three catches succeed on >= 95% of seeds.
import { botRun } from '../tests/helpers.js';
import { humanRun, HUMAN_DEFAULTS } from '../tests/humanbot.js';
import { CONFIG } from '../src/config.js';

const N = Number(process.argv[2] ?? 200);
const CAUSE = ['planet', 'moon', 'blackhole', 'front'];
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n) => `${((100 * n) / N).toFixed(1)}%`;

// Perfect bot.
let z4 = 0, z4time = 0;
const perfectPath90 = [];
const perfectSpeed = [];
for (let seed = 1; seed <= N; seed++) {
  const r = botRun(seed, { stopAt: 30, maxTime: 180 });
  if (r.pathReached >= 30) { z4++; z4time += r.time; }
  const r90 = botRun(seed, { maxTime: 90 });
  perfectPath90.push(r90.pathReached);
  if (seed <= 20) {
    const r2 = botRun(seed, { stopAt: 11, maxTime: 180 });
    perfectSpeed.push(r2.w.comet.speed / CONFIG.BASE_SPEED_START);
  }
}
console.log(`perfect bot: zone 4 on ${z4}/${N} (${pct(z4)}), mean time to zone 4 ${(z4time / Math.max(1, z4)).toFixed(1)}s; ` +
  `90 s runs: median path ${q(perfectPath90, 0.5)} (min ${Math.min(...perfectPath90)}); speed at zone 2 ≈ ${(perfectSpeed.reduce((a, b) => a + b, 0) / perfectSpeed.length).toFixed(2)}× start`);

// Human-like bot: the default player, then a sloppier new player who presses late twice as often.
for (const pLate of [HUMAN_DEFAULTS.pLate, 0.1]) humanReport(pLate);

function humanReport(pLate) {
const times = [], zones = [], scores = [], paths = [];
const causes = {};
let first3 = 0, first3direct = 0;
for (let seed = 1; seed <= N; seed++) {
  const r = humanRun(seed, { maxTime: 300, opts: { pLate } });
  times.push(r.time); zones.push(r.zone); scores.push(r.score); paths.push(r.pathReached);
  const k = r.dead ? CAUSE[r.cause] : 'alive@300s';
  causes[k] = (causes[k] ?? 0) + 1;
  if (r.firstThree) first3++;
  if (r.firstThreeDirect) first3direct++;
}
console.log(`human-like bot (late presses ${(pLate * 100).toFixed(0)}%): run time median ${q(times, 0.5).toFixed(1)}s (p25 ${q(times, 0.25).toFixed(1)}, p75 ${q(times, 0.75).toFixed(1)}, p10 ${q(times, 0.1).toFixed(1)}, p90 ${q(times, 0.9).toFixed(1)}); ` +
  `zone median ${q(zones, 0.5)} (p90 ${q(zones, 0.9)}); path median ${q(paths, 0.5)}; score median ${q(scores, 0.5)}`);
console.log(`  reaches path 3 on ${first3}/${N} (${pct(first3)}); first three flights each caught the intended planet on ${first3direct}/${N} (${pct(first3direct)}); outcomes ${JSON.stringify(causes)}`);
}
