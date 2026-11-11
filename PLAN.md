# Slingstar — build plan

You are building **Slingstar**, a one-thumb orbital slingshot game that runs as an iPhone home-screen
web app (added from Safari). This file is the full brief. Follow it in order. Where it gives a
number, start from that number; where it says "tune", you have latitude.

**What "done" means:** a player can add the game to their iPhone home screen, open it full-screen,
and play run after run at a steady 60fps with glowing shader visuals, a reactive soundtrack and
instant restarts, including offline.

---

## 1. Decisions already made (do not reopen)

| Decision | Choice | Reason |
|---|---|---|
| Platform | iPhone Safari home-screen web app, portrait only | The user's request |
| Language | Plain JavaScript ES modules, JSDoc types, **no build step** | Static files deploy trivially; nothing to break |
| Runtime dependencies | **None.** No three.js, no frameworks, no web fonts, no image or audio assets | Instant load, small cache, full control of the frame |
| Graphics | Raw **WebGL2**. No WebGPU | WebGL2 is on every iPhone that matters; the game is 2D and fill-rate bound |
| Audio | WebAudio, fully synthesised | No assets; music can react to play |
| Simulation | Deterministic, fixed 120Hz step, pure logic with no DOM access | Fair daily seeds; testable headless in Node |
| UI text | DOM overlay above the canvas, system font (`ui-rounded, -apple-system, system-ui`) | Crisp text for free |
| Dev dependencies | `playwright` (WebKit smoke test) and `typescript` (`checkJs` only) are allowed | Verification only; never shipped |
| Project folder | `~/Documents/slingstar` (this folder) | — |

Out of scope for v1: accounts, leaderboards, sharing, ads, haptics, tilt input, landscape play,
wormholes, WebGPU. Do not build them.

---

## 2. The game

### 2.1 Core loop

The comet travels **up** an endless vertical field of planets. There is one input: the whole
screen is a button.

- **Hold** inside a planet's capture ring: the comet latches into a circular orbit around it.
- **Release**: the comet flies off along the tangent, in a straight line, at its current speed.
- Catch the next planet, repeat. A run lasts 30–90 seconds for a typical player.

Free flight is a **straight line at constant speed**. Planets do not pull on the comet (only black
holes do, section 2.5). This keeps flight readable and lets the aim line be exact.

### 2.2 Rules, precisely

World units: the playfield is **1000 units wide**; the screen width always maps to 1000 units, so
visible height is about 2160 units on an iPhone. +y is up.

**Latching**
- A planet has a body radius `R` and a capture radius `Rc`. The band between them is where orbits happen.
- On press, if the comet is inside a capture ring, it latches at once: orbit radius = current
  distance to the planet centre, speed unchanged, direction (clockwise or counter-clockwise) =
  sign of `cross(relativePosition, velocity)`.
- If pressed outside every ring, the hold stays **armed** and latches the instant the comet
  enters a ring. This makes the game forgiving for beginners.
- **Perfect catch:** the press happened inside the ring (not armed) and the comet's radial speed
  was under 15% of its speed, meaning it was near closest approach. Reward it.

**Orbiting**
- Orbit radius decays inward: `decay = 15 + 25 × lapsOnThisPlanet` units/s. Holding too long
  ends in a crash. Speed rises 6% per second while orbiting, up to the current speed cap.
- **Graze:** altitude above the surface under 45 units. Pays points per second and throws sparks.
- Altitude under 12 units is a crash.

**Releasing**
- The comet leaves along the tangent. Aim assist: if the tangent ray misses the nearest catchable
  ring ahead by under 3°, rotate the heading up to 3° toward it. Keep this subtle.
- While orbiting, draw a dotted **aim line** 600 units along the tangent. When that ray will enter
  another planet's capture ring without hitting anything, the line and that planet's ring light
  up in the accent colour. This is the main thing that makes the game learnable.

**Field edges**
- Left and right edges are glowing walls. The comet bounces (`vx = -vx`), loses 10% speed (never
  below base speed) and the combo resets. No side deaths.

**The collapse front**
- A wall of light chases from below. Start 1500 units under the comet at 220 units/s, add
  4 units/s every second, cap at 75% of the comet's base speed, and never let it fall more than
  2600 units behind the comet.

**Death**: touching a planet body, a moon, a black hole's core, or the collapse front.

### 2.3 Speed, score, combo

| Item | Starting value |
|---|---|
| Base speed | 800 units/s at start, rising with zone to a 1600 cap |
| Planet radius | 60–130 units |
| Capture radius | `R + 170` in zone 1, shrinking to `R + 110` by zone 6 |
| Path planet spacing (centre to centre) | 520–900 in zone 1, up to 1300 later |
| Planet centre x range | 180–820 |
| Catch a new planet | 100 × multiplier |
| Perfect catch | +150 × multiplier, and combo +2 instead of +1 |
| Graze | 60 points/s × multiplier |
| Height | 1 point per 10 units |
| Stardust mote | 10 × multiplier |
| Multiplier tiers by combo | ×1 (0–2), ×2 (3–5), ×3 (6–9), ×4 (10–14), ×5 (15+) |

The combo rises by one for each catch of a **new** planet. It resets on a wall bounce, on
re-catching the planet just left, or after 2.5 laps on one planet.

**Stardust:** the generator lays short lines of small motes along good flight lines between
planets. They score a little, chime on pickup with rising pitch, and quietly teach trajectories.

Every number in this section lives in `src/config.js` and nowhere else.

### 2.4 Zones

A zone is 10 path planets. Each zone changes palette and musical key, shows a short name banner,
and introduces **one** new element. After zone 5, mix elements and keep ramping.

| Zone | Name | New element | Background / nebula A / nebula B / accent |
|---|---|---|---|
| 1 | Home Drift | Plain planets | `#05060f` / `#1b2a6b` / `#4b1d6e` / `#6fe3ff` |
| 2 | Ember Reach | Moons | `#0d0507` / `#7a1f1f` / `#b3541e` / `#ffb347` |
| 3 | Verdant Deep | Drifting planets | `#030d0b` / `#0f5c4a` / `#1d3f7a` / `#7dffb0` |
| 4 | Violet Maw | Black holes | `#08040f` / `#4a1680` / `#a01e6e` / `#ff6ad5` |
| 5 | White Reach | Binary pairs | `#070a10` / `#2b4a6e` / `#8a93a8` / `#e8f4ff` |

### 2.5 Hazards

- **Moons:** small bodies circling a planet inside its capture band. Touching one is death. They
  block the aim line.
- **Drifting planets:** oscillate sideways ±150 units over 4–6 seconds.
- **Black holes:** cannot be orbited. Inside an influence radius they bend free flight
  (`accel = G / r²`, clamped). The core kills. Passing through the influence zone and surviving
  pays a slingshot bonus and a speed boost.
- **Binary pairs:** two planets circling a shared centre, each catchable.

### 2.6 Level generation

- Seeded PRNG (`mulberry32`). Same seed, same course, always.
- Generate in chunks ahead of the comet; recycle bodies the collapse front has passed. Fixed-size
  pools: at most 64 live bodies.
- **Solvability rule.** For every consecutive pair of path planets A→B there must be a release
  window on A's orbit (at mid-band radius), at least 14° wide in zone 1 narrowing to 7° by zone
  6, whose straight ray enters B's capture ring with 30 units of clearance from every body and
  hazard. Check by sampling a fan of rays at generation time. On failure re-roll (up to 20 tries),
  then fall back to a plain, safe placement.
- **Modes:** Daily (seed = local date as `YYYYMMDD`) and Endless (random seed). Best score kept
  per mode; the Daily best is keyed by date.

### 2.7 Feel

These are what make it fun. Treat them as requirements.

- **Camera:** comet sits about 35% up the screen, with look-ahead along its velocity and smooth
  spring follow. Zooms out up to 15% as speed rises.
- **Near miss:** free flight passing within 25 units of a surface triggers slow motion at 0.35×
  for 0.25s (real time), eased out.
- **Catch:** small screen shake, ring pulse, particle burst, a plucked note that climbs the scale
  with the combo.
- **Multiplier tier up:** the comet's colour changes (×1 cyan-white, ×2 gold, ×3 orange,
  ×4 magenta, ×5 white-hot), its tail lengthens, a music layer joins.
- **Death:** time drops to 0.15× for 0.7s, the comet bursts into about 2500 particles, the music
  is low-pass filtered, then the score card appears. Tap restarts in **under 300ms** with no
  loading.
- **First run:** there is no tutorial screen. The run starts with the comet already orbiting a
  home planet, so the player's first act is a safe release. Show "RELEASE to fling" there and
  "HOLD to catch" on the first approach, each only until done once (remember in storage).
- Respect `prefers-reduced-motion`: no shake, no chromatic aberration, weaker slow motion.

---

## 3. Architecture

```
slingstar/
  index.html  manifest.webmanifest  sw.js  package.json  README.md
  css/app.css
  icons/            icon.svg, icon-180.png, icon-192.png, icon-512.png
  src/
    main.js         boot, state machine (title/playing/paused/gameover), frame loop, wiring
    config.js       every tuning constant
    contracts.js    JSDoc typedefs for world state and events (frozen after Phase 0)
    core/           rng.js  math.js
    sim/            world.js  generator.js  hazards.js  scoring.js  bot.js
    render/         gl.js  renderer.js  background.js  bodies.js  particles.js  post.js  shaders/
    audio/          engine.js  music.js  sfx.js
    ui/             hud.js  screens.js
    platform/       input.js  lifecycle.js  storage.js  pwa.js
  tests/            *.test.js   (node --test)
  tools/            serve.mjs  smoke.mjs  make-icons.mjs  build-precache.mjs
  scripts/          deploy.sh
```

### 3.1 The contract between modules

- `sim/` is **pure**: no `window`, `document`, `performance` or `Math.random`. It must import and
  run under Node unchanged.
- `world.step(dt, input)` advances one fixed step. `input` is `{ held: boolean, pressedThisStep,
  releasedThisStep }`.
- The renderer, audio and HUD **read** world state directly (no copying) and never write to it.
  World state keeps previous-step positions so the renderer can interpolate.
- Bodies and motes are stored as struct-of-arrays typed arrays with a live count.
- The sim reports what happened through a preallocated **event queue**, drained once per frame by
  `main.js` and handed to renderer effects, audio and HUD. Events: `latch`, `perfect`, `release`,
  `graze`, `mote`, `nearMiss`, `bounce`, `comboUp`, `comboBreak`, `tierUp`, `zoneChange`,
  `slingshot`, `death`.

### 3.2 Frame loop

```js
frame(now) {
  const dtReal = Math.min((now - last) / 1000, 0.1);
  acc += dtReal * timeScale;                 // timeScale drives slow motion
  let steps = 0;
  while (acc >= STEP && steps++ < 8) { world.step(STEP, input); acc -= STEP; }
  dispatch(world.events);                    // to fx, audio, hud
  renderer.draw(world, acc / STEP, dtReal);  // interpolated
}
```

`STEP = 1/120`. iPhones run `requestAnimationFrame` at 60Hz, and at 30Hz in Low Power Mode; the
accumulator handles both.

---

## 4. Rendering

**Target:** 60fps on an iPhone 12 or newer. Budget: under 20 draw calls and under 4ms of
JavaScript per frame.

### 4.1 Context and resolution

- Create with `{ alpha: false, antialias: false, depth: false, stencil: false,
  powerPreference: 'high-performance' }`.
- Backing size = CSS size × `min(devicePixelRatio, 2)` × `renderScale`. iPhones report 3; full
  3× is wasted on a bloomed image.
- **Adaptive `renderScale`** between 1.0 and 0.6: if more than 10% of frames in the last second
  ran over 20ms, step down by 0.1. Step up only after 10 clean seconds, and at most twice a run.
  Remember the settled value in storage.

### 4.2 Frame passes

1. **Scene** into an offscreen target (`RGBA16F` when `EXT_color_buffer_half_float` exists,
   otherwise `RGBA8`):
   - **Background:** one full-screen triangle. Three parallax star layers from an integer hash,
     plus a nebula. Do **not** compute noise per pixel per frame: bake a tileable 512² nebula
     texture once per zone and scroll it with parallax. Cross-fade two textures on zone change.
   - **Bodies:** one instanced draw. The fragment shader shades each quad as a sphere: procedural
     bands or noise from a per-instance seed, lit limb, atmosphere rim glow, optional ring.
     Capture rings, moons, black holes (dark core, bright bent rim) and the collapse front can be
     further instanced draws or branches by type.
   - **Aim line and motes:** instanced.
   - **Particles:** additive, instanced quads. See 4.3.
   - **Comet head:** a glow sprite, HDR-bright so bloom picks it up.
2. **Bloom:** bright-pass to half resolution, downsample to 1/4, 1/8, 1/16, then upsample and add.
3. **Composite** to the screen: scene + bloom, tone map, vignette, slight chromatic aberration
   scaled by speed, gamma.

### 4.3 Particles: stateless ring buffer

Do not simulate particles on the CPU and do not use transform feedback. Each particle is written
**once** at spawn: spawn position, velocity, birth time, lifetime, size, colour seed. The vertex
shader computes where it is now from `uTime - birth`. Per frame, upload only the newly spawned
range with `bufferSubData` (two calls if the ring wraps). Dead particles collapse to zero size in
the vertex shader so they cost no fill.

Capacity 16,384. Tail emission 300–900 per second scaling with speed and tier; lifetime 0.6–1.4s;
size 3–10 pixels. Keep them small: fill rate is the budget.

### 4.4 Rules that matter on Apple GPUs

- `precision highp float` in fragment shaders. Hash with **integer** operations (`uint`), not
  `fract(sin(x) * 43758.5)`, which gives different results across GPUs.
- Clear every render target at the start of its pass and call `gl.invalidateFramebuffer` when
  finished with it. Tile-based GPUs otherwise pay to load and store each target.
- Compile and link every program at boot, then draw one hidden warm-up frame so first use never
  hitches.
- Handle `webglcontextlost` (`preventDefault`) and `webglcontextrestored` (rebuild every GL
  resource). iOS drops contexts when the app is backgrounded; without this the game returns as a
  black screen.
- Wrap background parallax offsets with a modulo in JavaScript (doubles) before upload, so the
  starfield does not jitter at great heights.
- **No allocation inside the frame loop.** No object or array literals, closures, `map`,
  `forEach` or string building per frame. Preallocate typed arrays and pools. HUD text is written
  only when its value changes.

---

## 5. Audio

- One `AudioContext`, created or resumed inside the first `pointerup` handler (iOS requires a
  user gesture). Resume again on any touch if the state is `suspended` or `interrupted`.
- Chain: voices → music bus and SFX bus → low-pass (for the death effect) → compressor → output.
  One small reverb from a generated noise impulse.
- **Music:** look-ahead scheduler (25ms timer, 100ms horizon), about 108 BPM, minor pentatonic,
  root note changes per zone. Five layers that join with the multiplier tier: pad, bass pulse,
  arpeggio, noise hats, sparkle lead. Dropping a tier removes layers.
- **SFX:** catch (pluck, pitch climbs the scale with combo), perfect (chime), release (filtered
  noise whoosh), graze (sizzle loop while grazing), mote (short blip, rising), bounce, tier up,
  zone change, death (noise burst, sub drop, music low-passed to 200Hz).
- Suspend the context when the page is hidden. A sound toggle is stored in settings.
- Note in the README: the iPhone's silent switch mutes web audio. That is expected.

---

## 6. iPhone home-screen app requirements

**`index.html` head**
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`
- `apple-mobile-web-app-capable` and `mobile-web-app-capable` = `yes`;
  `apple-mobile-web-app-status-bar-style` = `black-translucent`; `apple-mobile-web-app-title`.
- `<link rel="apple-touch-icon" href="icons/icon-180.png">`. iOS needs a **PNG**; it ignores SVG
  and manifest icons here.
- All URLs **relative**, so the app works from any path.

**Manifest:** `display: standalone`, `orientation: portrait`, dark `background_color` and
`theme_color`, 192 and 512 PNG icons.

**CSS:** `html, body { position: fixed; inset: 0; overflow: hidden; overscroll-behavior: none;
touch-action: none; -webkit-user-select: none; -webkit-touch-callout: none;
-webkit-tap-highlight-color: transparent; }`. Size with `100dvh`. Keep the HUD inside
`env(safe-area-inset-*)`.

**Input**
- Pointer events on the canvas. "Held" = at least one pointer down. Also listen for
  `pointercancel`. Space bar and mouse work too, for desktop testing.
- Register a **non-passive** `touchstart` listener that calls `preventDefault()`. This game is
  built on long presses, and without this iOS shows the text-selection loupe and callout mid-run.
- Buttons (pause, mode chips, sound) must not start a hold.

**Lifecycle**
- On `visibilitychange` to hidden or `pagehide`: pause the sim, suspend audio. On return show
  "Tap to resume" (the tap also re-unlocks audio).
- In landscape, pause and show a "rotate your phone" overlay.
- `localStorage` for best scores, settings, first-run flags and render scale, always in try/catch.

**Service worker**
- Precache every shipped file; cache-first; versioned cache name; delete old caches on activate.
  `tools/build-precache.mjs` writes the file list and a content hash into `sw.js` so the version
  bumps itself.
- It only registers on HTTPS or localhost. The game must run fully without it.
- The pause screen shows the build version and a **Reload** button, since a home-screen app has
  no browser reload.

**Icon:** design `icons/icon.svg` (a comet curving around a planet on deep space, no text), then
produce the PNGs with `tools/make-icons.mjs` by screenshotting it in Playwright. Commit the PNGs.

---

## 7. Screens

- **Title:** the live game behind it, comet circling the home planet. Game name, best score, two
  mode chips (Daily / Endless, remembered), sound toggle, "hold and release to play". Releasing
  starts the run. No separate loading screen beyond a brief boot splash.
- **Playing HUD:** score top centre, multiplier and combo beside it, zone banner on change, small
  pause button top right. Nothing else.
- **Paused:** resume, restart, sound, version, Reload.
- **Game over:** score, best (with "New best" when earned), zone reached, best combo. Tap
  anywhere to play again.

---

## 8. How to verify (run these yourself; do not assume)

`package.json` scripts:

| Script | What it does |
|---|---|
| `npm test` | `node --test tests/` — sim, generator, scoring, RNG |
| `npm run check` | `tsc --noEmit --allowJs --checkJs` over `src/` |
| `npm run serve` | `node tools/serve.mjs` — static server on `127.0.0.1:8791`, correct MIME types, `no-cache` on `index.html` and `sw.js` |
| `npm run smoke` | `node tools/smoke.mjs` — Playwright **WebKit**, iPhone viewport (390×844, scale 3, touch) |

**Required tests**
- Determinism: same seed and same input script give an identical state hash after 60 simulated seconds.
- Generator: for 200 seeds × 60 planets, every consecutive path pair passes the solvability rule.
- Fairness: `sim/bot.js` (holds in rings, releases when the aim ray is clear onto the next path
  planet) reaches zone 4 on at least 90 of 100 seeds. If it cannot, the level is unfair: fix the
  generator, not the bot's threshold.
- Rules: latch direction, armed hold, perfect catch, orbit decay to crash, wall bounce, combo
  reset cases, collapse front catch.

**Debug hooks (keep them in the shipped build)**
- `?debug=1`: overlay with frame ms, sim ms, draw calls, live particles, render scale.
- `?seed=N` fixes the seed. `?autoplay=1` lets the bot play (also used for the title screen).
- `window.__slingstar` exposes world state for the smoke test.

**Smoke test must assert:** no console errors or page errors; a WebGL2 context exists; after 10
seconds of `?seed=1&autoplay=1&debug=1` the score is above zero; the canvas is not blank; draw
calls under 20. It saves screenshots of title, play, a zone 2+ moment and game over to
`artifacts/`.

**Look at the screenshots.** Open them and judge them against section 4 and the palettes. Flat,
dim or muddy is a failure: iterate on shaders and bloom until planets glow, the tail reads as a
streak of light and the HUD is legible. Then check a simulated touch run: press and hold via
Playwright touch events, and confirm no page scroll, zoom or selection happens.

Playwright browsers are already cached at `~/Library/Caches/ms-playwright` (WebKit build 2104).
If the installed Playwright version wants a different build, run `npx playwright install webkit`.
Headless WebKit on the Mac does not predict iPhone frame rate, so performance is checked by the
budgets (draw calls, JS ms, zero allocations) and by the user on the device.

---

## 9. Phases

Initialise a git repository in this folder and commit at the end of each phase. No remote, no push.

**Phase 0 — Skeleton and contracts (one agent, serial).**
Folder layout, `package.json`, `config.js` with every constant from section 2, `contracts.js`
with the world state and event typedefs, stub modules exporting the agreed functions, static
server, a canvas that clears to the zone 1 background.
*Done when:* `npm test`, `npm run check` and `npm run serve` all work, and the contracts are
complete enough that four people could build against them without talking.

**Phase 1 — Four parallel workstreams. Each owns its folders and touches nothing else.**

| Stream | Owns | Done when |
|---|---|---|
| A. Simulation | `src/sim/`, `src/core/`, `tests/` | All required tests pass for zone 1 rules, generator and bot |
| B. Rendering | `src/render/` | Renders a hand-built fake world state: background, bodies, particles, bloom, under 20 draw calls |
| C. Audio | `src/audio/` | Music layers and every SFX are triggerable from a small test page |
| D. Shell | `index.html`, `css/`, `src/ui/`, `src/platform/`, manifest, `sw.js`, icons, `tools/` | Screens, HUD, input, lifecycle, storage and service worker work against stubs |

`contracts.js` and `config.js` are frozen in this phase. A stream that needs a change reports it;
the lead applies it.

**Phase 2 — Integration (one agent, serial).**
Wire everything in `main.js`. Play it through the bot and through simulated touch. Implement all
of section 2.7. Tune `config.js` until a bot run looks good and a new player's first three catches
are easy.
*Done when:* the full loop title → play → death → restart works, and the smoke test passes.

**Phase 3 — Content and polish (parallel, same ownership rules).**
- Sim: zones 2–5 hazards and their generator and bot support; fairness test green.
- Render: visuals for each hazard and zone, zone cross-fade, adaptive render scale, context
  loss recovery, warm-up frame.
- Audio and shell: zone key changes, banner, first-run prompts, pause screen, Daily mode.

**Phase 4 — Independent review, then fix.** Three reviewers who did not write the code, each given
this file and the repository, each reporting concrete defects with file and line:
1. **iPhone compatibility:** everything in section 6 and 4.4, line by line.
2. **Performance:** allocations in the frame loop, draw calls, per-pixel cost, particle fill.
3. **Fairness and feel:** bot statistics across 200 seeds, death causes by zone, anything in 2.7
   that is missing or weak.

Fix what they find, rerun every script in section 8, and commit.

**Phase 5 — Deploy script. Write it; do not run it without the user's go-ahead.**
The phone reaches this Mac over Tailscale. Follow the pattern in
`~/Documents/emotion-checkin/scripts/deploy.sh` (read it first):
- Copy the shipped files to `~/apps/slingstar`. **Never serve from `~/Documents`**: macOS blocks
  background services from reading it and the server hangs silently.
- A launch agent `local.slingstar.server` runs `node tools/serve.mjs` on `127.0.0.1:8791`.
- `tailscale serve --bg --https=10000 http://127.0.0.1:8791`. Ports 443 and 8443 and local ports
  8787, 8788 and 8790 belong to other apps. Do not change them.
- The script runs `tools/build-precache.mjs` first so the service worker version changes.

Running the script changes the machine's services and Tailscale config, so stop and ask the user
before the first run. Then give them the URL and the steps: open in Safari, Share, Add to Home
Screen.

---

## 10. Final report

End with a short report to the user: what was built, the output of each script in section 8, what
you could not verify (real-device frame rate, audio on the phone, the feel of touch), and a
checklist for their first session on the iPhone:

1. Hold for three seconds mid-run: no loupe, no selection, no scroll.
2. Sound starts after the first tap.
3. Switch to another app and back: the game is paused, not black.
4. Airplane mode, reopen: it still loads.
5. Open with `?debug=1`: frame time stays near 16.7ms and the render scale it settled on.
