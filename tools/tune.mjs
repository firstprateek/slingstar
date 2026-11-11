// Tuning report: plays many seeds with the perfect fairness bot (src/sim/bot.js) and the two
// human-like bots (tests/humanbot.js: the optimistic window planner and the honest reactive player)
// and prints the statistics config.js is tuned against.
//   node tools/tune.mjs [seeds=200]
// Targets (PLAN.md §2.1, §8, Phase 3): perfect bot reaches zone 4 on >= 90/100 seeds; the honest
// human-like bot's median run lasts roughly 30–90 s; deaths are spread across causes; the first
// three catches succeed on >= 95% of seeds.
import { botRun } from '../tests/helpers.js';
import { humanRun } from '../tests/humanbot.js';
import { CONFIG } from '../src/config.js';
import { EV } from '../src/contracts.js';

const N = Number(process.argv[2] ?? 200);
const CAUSE = ['planet', 'moon', 'blackhole', 'front'];
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n, d = N) => `${((100 * n) / d).toFixed(1)}%`;

/** "z2: planet 5, moon 3 | z3: …" from { zone: { cause: n } }. */
function byZone(t) {
  return Object.keys(t).sort((a, b) => a - b)
    .map((z) => `z${z}: ${Object.entries(t[z]).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    .join(' | ');
}

// ---------------------------------------------------------------- perfect bot
let z4 = 0, z4time = 0, slings = 0;
const perfectPath90 = [], perfectSpeed = [];
const perfectDeaths = {};
for (let seed = 1; seed <= N; seed++) {
  const r = botRun(seed, { stopAt: 30, maxTime: 180 });
  if (r.pathReached >= 30) { z4++; z4time += r.time; }
  const r90 = botRun(seed, { maxTime: 90, onEvent(w, type) { if (type === EV.SLINGSHOT) slings++; } });
  perfectPath90.push(r90.pathReached);
  if (r90.dead) {
    const t = (perfectDeaths[r90.zone] ??= {});
    t[CAUSE[r90.cause]] = (t[CAUSE[r90.cause]] ?? 0) + 1;
  }
  if (seed <= 20) {
    const r2 = botRun(seed, { stopAt: 11, maxTime: 180 });
    perfectSpeed.push(r2.w.comet.speed / CONFIG.BASE_SPEED_START);
  }
}
console.log(`perfect bot: zone 4 on ${z4}/${N} (${pct(z4)}), mean time to zone 4 ${(z4time / Math.max(1, z4)).toFixed(1)}s; ` +
  `90 s runs: median path ${q(perfectPath90, 0.5)} (min ${Math.min(...perfectPath90)}), deaths ${byZone(perfectDeaths) || 'none'}, ` +
  `slingshots ${slings}; speed at zone 2 ≈ ${(perfectSpeed.reduce((a, b) => a + b, 0) / perfectSpeed.length).toFixed(2)}× start`);

// ---------------------------------------------------------------- human-like bots
humanReport('planner (optimistic)', {});
humanReport('reactive (honest)', { honest: true });

function humanReport(label, opts) {
  const times = [], zones = [], scores = [], paths = [];
  const causes = {}, deaths = {};
  let first3 = 0, alive = 0;
  for (let seed = 1; seed <= N; seed++) {
    const r = humanRun(seed, { maxTime: 300, opts });
    times.push(r.time); zones.push(r.zone); scores.push(r.score); paths.push(r.pathReached);
    if (r.dead) {
      const k = CAUSE[r.cause];
      causes[k] = (causes[k] ?? 0) + 1;
      const t = (deaths[r.zone] ??= {});
      t[k] = (t[k] ?? 0) + 1;
    } else alive++;
    if (r.firstThree) first3++;
  }
  const dead = N - alive;
  console.log(`human-like ${label}: run time median ${q(times, 0.5).toFixed(1)}s (p25 ${q(times, 0.25).toFixed(1)}, p75 ${q(times, 0.75).toFixed(1)}, ` +
    `p10 ${q(times, 0.1).toFixed(1)}, p90 ${q(times, 0.9).toFixed(1)}); zone median ${q(zones, 0.5)} (p25 ${q(zones, 0.25)}, p75 ${q(zones, 0.75)}, p90 ${q(zones, 0.9)}); ` +
    `path median ${q(paths, 0.5)}; score median ${q(scores, 0.5)}; reaches path 3 on ${pct(first3)}`);
  console.log(`  deaths ${dead}/${N}: ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n} (${pct(n, dead)})`).join(', ')}` +
    `${alive ? `; alive at 300 s: ${alive}` : ''}`);
  console.log(`  deaths by zone: ${byZone(deaths)}`);
}
