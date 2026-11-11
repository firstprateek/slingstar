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
import { EV, BODY_FLAG } from '../src/contracts.js';
import { createWorld } from '../src/sim/world.js';
import { createGenerator, releaseWaitSeconds } from '../src/sim/generator.js';

const N = Number(process.argv[2] ?? 200);
const CAUSE = ['planet', 'moon', 'blackhole', 'front'];
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n, d = N) => `${((100 * n) / d).toFixed(1)}%`;

/** "z2: planet 5, moon 3 | z3: …" from { zone: { cause: n } }. */
/**
 * Binary catch counter for onEvent hooks (Phase 4: real pairs). Member 0 is the one the generator
 * committed first (lower id). `deaths` counts deaths on a binary body.
 */
function binaryCounter() {
  const c = { member: [0, 0], notNew: 0, deaths: 0 };
  c.onEvent = (w, type, x, y, a, b) => {
    const bd = w.bodies;
    if (type === EV.LATCH && (bd.flags[a | 0] & BODY_FLAG.BINARY)) {
      const i = a | 0, p = bd.parent[i];
      c.member[p >= 0 && bd.id[p] < bd.id[i] ? 1 : 0]++;
      if (b === 0) c.notNew++;
    } else if (type === EV.DEATH && b >= 0 && (bd.flags[b | 0] & BODY_FLAG.BINARY)) c.deaths++;
  };
  c.text = () => `binary catches ${c.member[0]} + ${c.member[1]} (first + second member; ${c.notNew} not new), deaths on a binary body ${c.deaths}`;
  return c;
}

function byZone(t) {
  return Object.keys(t).sort((a, b) => a - b)
    .map((z) => `z${z}: ${Object.entries(t[z]).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    .join(' | ');
}

// ---------------------------------------------------------------- generator: binary pairs
{
  // Zones 1–12. Binary rates are shares of path planets (config.js HAZARD_BINARY_*).
  const PATH = 120, pairsByZone = {}, pathByZone = {};
  let fallbacks = 0, rerolls = 0, fromBinary = 0, longest = 0, waitSum = 0, eclipsed = 0;
  for (let seed = 1; seed <= N; seed++) {
    const w = createWorld({ seed, generate: false });
    const gen = createGenerator(w);
    gen.reset(seed);
    let checked = 1, y = 0;
    while (checked <= PATH) {
      w.comet.y = y; w.front.y = y - CONFIG.FRONT_MAX_LAG;
      gen.update(4);
      while (checked <= PATH && gen.pathCount > checked + 4) {
        const a = gen.slotOfPath(checked - 1), b = gen.slotOfPath(checked), bd = w.bodies;
        pathByZone[bd.zone[b]] = (pathByZone[bd.zone[b]] ?? 0) + 1;
        if (bd.flags[b] & BODY_FLAG.BINARY) pairsByZone[bd.zone[b]] = (pairsByZone[bd.zone[b]] ?? 0) + 1;
        if (bd.flags[a] & BODY_FLAG.BINARY) {
          const s = releaseWaitSeconds(w, a, b);
          fromBinary++; waitSum += s; if (s > 0) eclipsed++; if (s > longest) longest = s;
        }
        checked++;
      }
      y += 250;
    }
    fallbacks += gen.fallbacks; rerolls += gen.rerolls;
  }
  const share = Object.keys(pairsByZone).sort((a, b) => a - b).map((z) => `z${z} ${pairsByZone[z]} (${pct(pairsByZone[z], pathByZone[z])})`).join(', ');
  console.log(`generator (${N} seeds × ${PATH} path planets): binary pairs by zone ${share}; fallbacks ${fallbacks}, re-rolls ${rerolls}; ` +
    `pairs leaving a binary ${fromBinary}: with a partner eclipse ${eclipsed}, mean ${(waitSum / Math.max(1, fromBinary)).toFixed(2)} s, longest ${longest.toFixed(2)} s (max ${CONFIG.BINARY_MAX_WAIT_S} s)`);
}

// ---------------------------------------------------------------- perfect bot
let z4 = 0, z4time = 0, slings = 0, nearP = 0, timeP = 0;
const perfectPath90 = [], perfectSpeed = [];
const perfectDeaths = {};
const perfectBin = binaryCounter();
for (let seed = 1; seed <= N; seed++) {
  const r = botRun(seed, { stopAt: 30, maxTime: 180 });
  if (r.pathReached >= 30) { z4++; z4time += r.time; }
  const r90 = botRun(seed, { maxTime: 90, onEvent(w, type, x, y, a, b) {
    if (type === EV.SLINGSHOT) slings++; else if (type === EV.NEAR_MISS) nearP++;
    perfectBin.onEvent(w, type, x, y, a, b);
  } });
  timeP += r90.time;
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
  `slingshots ${slings}, near misses ${(60 * nearP / timeP).toFixed(2)}/min; speed at zone 2 ≈ ${(perfectSpeed.reduce((a, b) => a + b, 0) / perfectSpeed.length).toFixed(2)}× start; ` +
  perfectBin.text());

// ---------------------------------------------------------------- human-like bots
humanReport('planner (optimistic)', {});
humanReport('reactive (honest)', { honest: true });

function humanReport(label, opts) {
  const times = [], zones = [], scores = [], paths = [];
  const causes = {}, deaths = {};
  let first3 = 0, alive = 0, near = 0, slings = 0, total = 0;
  const bin = binaryCounter();
  for (let seed = 1; seed <= N; seed++) {
    const r = humanRun(seed, { maxTime: 300, opts, onEvent: bin.onEvent });
    times.push(r.time); zones.push(r.zone); scores.push(r.score); paths.push(r.pathReached);
    near += r.nearMisses; slings += r.slingshots; total += r.time;
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
  console.log(`  near misses ${(60 * near / total).toFixed(2)}/min; slingshots ${slings}; ${bin.text()}`);
}
