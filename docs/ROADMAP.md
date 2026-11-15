# Slingstar roadmap

Next steps for whoever (person or coding agent) picks the game up. Read `README.md` first, then
`src/config.js` (every tuning constant) and `src/contracts.js` (shared types, events, storage keys).
`PLAN.md` is the original design document; this file covers what came after it.

## Where things stand (November 2026)

Shipped and live at https://firstprateek.github.io/slingstar/:

- **Gentler start:** base speed 580 (+70 per zone), wider capture bands ramped over zones 1–8,
  slower collapse front. Tuned with the human-like bots in `tests/humanbot.js` to roughly double
  the median run.
- **Run missions** (`src/meta/missions.js`): three goals at a time, a star for each, swapped for a
  harder goal on the next run, stored in `localStorage`. Off under `?autoplay=1`.
- **Desktop:** mouse button or Space to hold, Escape/P to pause, Space/Enter to play again. Wide
  windows on mouse-and-keyboard devices show a centred portrait column with a how-to-play card.
- **Brace:** flying into a body stops the comet for `BRACE_WINDOW_S` (0.2 s). A press in that
  window, or up to 0.2 s before the hit, bounces it off for `BRACE_SIZE_LOSS` (10%) of its size.
  Five braces from full size; stardust regrows 1% per mote. The same single button is used, so a
  phone stays one-thumb. Sim: `impact()` and `brace()` in `src/sim/world.js`. Tests:
  `tests/brace.test.js`.

## Next steps, in priority order

### 1. Steer (one nudge per flight)

**Goal:** give the player one small course correction per flight. The main way braced runs still
end is a bounce that sends the comet backwards into the collapse front, and a steer answers that.

**Open design question: the input.** Every input is currently one button (hold to orbit; a press
near a hit braces). Options, to decide before building:
- A double-tap in free flight (two presses within ~250 ms) nudges toward the next lit planet or
  straight up. One-thumb, but it must not collide with the armed hold or the brace press.
- Desktop arrow keys plus an on-screen left/right swipe on phones. Clearer, but it adds a second
  gesture.
- A press-and-drag while free: the drag direction steers. Natural on touch, awkward with Space.

**Constraints:**
- `src/sim/` stays pure and deterministic. `tests/purity.test.js` forbids allocation,
  `Math.random` and DOM access, and replays must stay identical (`tests/determinism.test.js`).
- Steering must not break the aim-line promise. A lit aim line means "releasing now reaches the
  next planet", so steer only after release, and never in a way that makes the aim forecast lie.
- Give it a cap (for example `STEER_MAX_DEG` and a cooldown) in `src/config.js` with the other
  tunables.

**Done when:**
- A test covers one steer per flight, the angle cap and the reset on latch.
- The human-like bot measurement (see "Measuring" below) shows the effect.
- The README and the desktop how-to-play card (`src/ui/screens.js`) explain it.

### 2. Refill power-ups

**Goal:** rare pickups that restore hull (size), so a run that has spent its braces can recover
faster than stardust's 1% per mote.

**Design notes:**
- Place them in the level generator (`src/sim/generator.js`), seeded like motes, so Daily courses
  are identical for everyone.
- Placement must not affect path solvability. Keep them off the solvability rays, or place them
  after the path is fixed, as motes are.
- Suggested tunables: `REFILL_CHANCE` per path segment, `REFILL_AMOUNT` (e.g. 0.2 = two braces)
  and a minimum zone.
- New event (for example `EV.REFILL`) plus renderer, audio and HUD hull-meter feedback.

**Done when:** generator tests prove refills are deterministic per seed and never make a pair
unsolvable, and rule tests cover pickup and the size cap at 1.

### 3. Difficulty modes

Every brace and ramp constant is in `src/config.js` (`BRACE_*`, `BASE_SPEED_*`, `CAPTURE_BAND_*`,
`RAMP_END_ZONE`, `FRONT_*`). A mode is a set of overrides of those values.

**Suggested modes:**
- **Relaxed:** wider brace window, more braces.
- **Classic:** today's values.
- **Hard:** a 0.1 s window, 3 braces, the old 700/+140 speed ramp.

**Implementation notes:**
- `CONFIG` is frozen and imported everywhere, so a mode needs a small refactor: pass the mode's
  values into `createWorld`, or read them through a per-world config object. Do this without
  breaking determinism.
- Best scores (`STORAGE.BEST_*` in `src/contracts.js`) and the Daily course should be kept per
  mode.

### 4. Smaller follow-ups found in reviews

- **Stars buy nothing yet.** Comet unlocks (colours and trails picked on the title screen, stored
  locally) would give missions a payoff.
- **The hull meter misleads near the floor.** It fills by `(size - 0.5) / 0.5`, so at a size of
  0.50–0.59 it shows a sliver of hull while the next brace is fatal. Show whole braces instead, or
  mark the last segment as empty.
- **Small phones:** on 320×568 screens the hull meter touches the zone banner's top line.
- **Desktop wording goes stale:** the `desktop` flag in `src/ui/screens.js` is read once at boot,
  so the wording doesn't change if the pointer type changes mid-session.
- **Brace balance is unconfirmed:** the brace has not been checked on a real phone. A 0.2 s window
  with 5 braces may be generous, since the bots' median run went to about 75–90 s. Tune after
  play-testing.
- **README screenshots are phone-only:** add one of the desktop column layout.

## How to land a change

1. Branch from `main`. Use the GitHub noreply address as the commit author, and never commit
   hostnames, home-folder paths or personal emails.
2. Run `npm test`, `npm run check` and `npm run smoke` (WebKit with an iPhone viewport). All must
   pass.
3. Run `npm run precache` after changing any shipped file, so the service worker version changes
   and returning players get the update.
4. Open a PR. Get an adversarial review from a fresh reviewer: give it the diff and the goal, not
   your conclusions. Fix what holds up, then merge.
5. GitHub Pages deploys `main` automatically. Check the live `sw.js` version matches. If the
   tailnet copy is in use, re-run `scripts/deploy.sh`.

## Measuring

`tests/humanbot.js` has two human-like bots: a "planner" that anticipates release windows and a
"reactive" one that reacts late. To see what a gameplay change does to run length, play 50–60
seeds with each and compare p10/median/p90 run time and death causes before and after. The PRs for
the gentler start and the brace include the numbers they were tuned against.
