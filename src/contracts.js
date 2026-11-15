// @ts-check
/**
 * Slingstar module contracts. FROZEN after Phase 0: a workstream that needs a change reports it
 * to the lead, who applies it. This file holds the shared enums (runtime values) and JSDoc
 * typedefs for world state, events, input and every cross-module API.
 *
 * Ownership of state:
 *   - `src/sim/` creates and is the only writer of World. Everyone else reads it directly
 *     (no copying) and never writes to it.
 *   - `main.js` drains `world.events` once per frame and hands each event to renderer, audio and
 *     HUD via their `onEvent(type, x, y, a, b)` methods, then calls `clearEvents`.
 *
 * Coordinates: world units, playfield 0..1000 wide (x), +y is up, unbounded height.
 * Angles: radians, measured counter-clockwise from +x.
 * Body / mote arrays are struct-of-arrays with a live `count`; slots 0..count-1 are live,
 * but a slot may be dead (`alive[i] === 0`) until compacted, so always check `alive`.
 */

// ============================================================================ enums

/** Body types stored in `bodies.type`. */
export const BODY = Object.freeze({
  PLANET: 0,     // catchable (rc > r)
  MOON: 1,       // small lethal body circling `parent`; blocks the aim line; not catchable (rc = 0)
  BLACKHOLE: 2,  // r = lethal core radius, rc = influence radius; not catchable
});

/** Bit flags stored in `bodies.flags`. */
export const BODY_FLAG = Object.freeze({
  RINGED: 1,     // render a planetary ring (visual only)
  DRIFTING: 2,   // oscillates sideways: x = baseX + amp * sin(2π t / period + phase)
  BINARY: 4,     // one member of a binary pair: circles the pair's shared centre (m3, m4) opposite its partner (`parent`)
  HOME: 8,       // the home planet the run starts on
});

/** Comet states stored in `comet.state`. */
export const COMET = Object.freeze({
  ORBIT: 0,
  FREE: 1,
  DEAD: 2,
});

/** Event types stored in `events.type` (PLAN.md §3.1). */
export const EV = Object.freeze({
  LATCH: 1,        // x,y = comet; a = body index; b = combo after this catch (0 if re-catch / not new)
  PERFECT: 2,      // x,y = comet; a = body index; b = bonus points awarded
  RELEASE: 3,      // x,y = comet; a = speed; b = heading (radians, after aim assist)
  GRAZE: 4,        // x,y = comet; a = 1 when grazing starts, 0 when it ends
  MOTE: 5,         // x,y = mote; a = pickup index within the current streak (0,1,2… for rising pitch); b = points
  NEAR_MISS: 6,    // x,y = closest point on the surface; a = body index; b = distance to surface
  BOUNCE: 7,       // x,y = comet; a = -1 left wall, +1 right wall; b = speed after
  COMBO_UP: 8,     // a = new combo; b = increment (1 normal, 2 perfect)
  COMBO_BREAK: 9,  // a = combo before the break; b = COMBO_BREAK_REASON
  TIER_UP: 10,     // a = new tier (1..5); b = previous tier
  ZONE_CHANGE: 11, // a = new zone (1-based); b = previous zone
  SLINGSHOT: 12,   // x,y = comet; a = body index of the black hole; b = bonus points
  DEATH: 13,       // x,y = comet; a = DEATH_CAUSE; b = body index (-1 for the front)
  IMPACT: 14,      // x,y = contact point; a = DEATH_CAUSE it would be; b = body index. The brace window opens.
  BRACE: 15,       // x,y = comet after the bounce; a = comet size after; b = body index
});

/** Readable names for debug overlays and logs, indexed by EV value. */
export const EV_NAME = Object.freeze([
  '', 'latch', 'perfect', 'release', 'graze', 'mote', 'nearMiss', 'bounce', 'comboUp',
  'comboBreak', 'tierUp', 'zoneChange', 'slingshot', 'death', 'impact', 'brace',
]);

export const COMBO_BREAK_REASON = Object.freeze({
  WALL: 0,
  RECATCH: 1,   // caught the planet just left
  LAPS: 2,      // stayed for COMBO_BREAK_LAPS laps
  BRACE: 3,     // braced off a body
});

export const DEATH_CAUSE = Object.freeze({
  PLANET: 0,     // hit a planet body (free flight) or orbit decayed below CRASH_ALTITUDE
  MOON: 1,
  BLACKHOLE: 2,
  FRONT: 3,      // the collapse front caught the comet
});

/** Game modes. */
export const MODE = Object.freeze({
  DAILY: 'daily',
  ENDLESS: 'endless',
});

/** App-level screens, owned by main.js and shown by ui/screens.js. */
export const SCREEN = Object.freeze({
  BOOT: 'boot',
  TITLE: 'title',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
  RESUME: 'resume',   // "Tap to resume" after returning from background
  ROTATE: 'rotate',   // landscape overlay
});

/**
 * localStorage keys. All values are JSON. Every access goes through platform/storage.js,
 * which prefixes them with `slingstar:` and wraps them in try/catch.
 */
export const STORAGE = Object.freeze({
  BEST_ENDLESS: 'best.endless',         // number
  BEST_DAILY_PREFIX: 'best.daily.',     // + 'YYYYMMDD' → number
  SETTINGS: 'settings',                 // Settings
  FIRST_RUN: 'firstRun',                // FirstRunFlags
  RENDER_SCALE: 'renderScale',          // number 0.6..1.0
  MISSIONS: 'missions',                 // meta/missions.js toJSON()
});

// ============================================================================ typedefs

/**
 * @typedef {Object} SimInput  Input for one fixed step. main.js fills it from platform/input.js
 *   (or from the bot). Edges are true on the FIRST step of the frame in which they happened only.
 * @property {boolean} held              At least one pointer / space is down.
 * @property {boolean} pressedThisStep   A press began since the previous step.
 * @property {boolean} releasedThisStep  A release happened since the previous step.
 *   A tap shorter than a frame gives pressed=true, released=true, held=false in one step: the
 *   sim treats it as a press followed by a release.
 */

/**
 * @typedef {Object} Bodies  Struct-of-arrays pool, capacity CONFIG.MAX_BODIES.
 * @property {number} count          Slots 0..count-1 are in use (check `alive`).
 * @property {Uint8Array} alive      1 = live.
 * @property {Uint32Array} id        Unique, ever-increasing id (slots get recycled; ids do not).
 * @property {Uint8Array} type       BODY.*
 * @property {Uint8Array} flags      BODY_FLAG bits.
 * @property {Float64Array} x        Current centre.
 * @property {Float64Array} y
 * @property {Float64Array} px       Centre at the previous step (renderer interpolates px→x).
 * @property {Float64Array} py
 * @property {Float32Array} r        Body radius (BLACKHOLE: lethal core radius).
 * @property {Float32Array} rc       Capture radius (PLANET), influence radius (BLACKHOLE), 0 (MOON).
 * @property {Uint32Array} seed      Per-body visual seed (style, bands, colours, ring tilt).
 * @property {Uint8Array} zone       Zone (1-based) the body was generated in; picks the palette.
 * @property {Int32Array} pathIndex  Order along the path (0 = home), -1 for hazards / side bodies.
 * @property {Int32Array} parent     MOON: slot index of its planet. BINARY: slot of its partner (the
 *                                   partners point at each other; -1 once the partner is recycled). Else -1.
 * Motion params (position is a pure function of world.time, so it is deterministic):
 *   DRIFTING:  x = m0 + m1 * sin(2π t / m2 + m3)            (m0 baseX, m1 amplitude, m2 period s, m3 phase)
 *   MOON:      pos = parent pos + m0 * (cos θ, sin θ), θ = m2 + m1 t   (m0 orbit r, m1 rad/s signed, m2 phase)
 *   BINARY:    pos = (m3, m4) + m0 * (cos θ, sin θ), θ = m2 + m1 t     (partner has phase + π)
 * Binary pairs (Phase 4): two real PLANET slots, both flagged BINARY, with the same m0, m1, m3, m4,
 * phases m2 π apart, `parent` pointing at each other and the SAME pathIndex: catching either member
 * is catching that path step (the other is then no new planet: catching it neither scores nor
 * changes the combo, and it never counts as re-catching the planet just left). Each has its own
 * radius, capture ring, seed and RINGED flag. From one member the aim line looks
 * past the partner's ring (not a target) but its body blocks the line; after a release on a lit
 * line the partner cannot be latched until the flight bends or bounces. The partner can hide the
 * next planet for up to CONFIG.BINARY_MAX_WAIT_S of the pair's turn (the generator guarantees it).
 * @property {Float64Array} m0
 * @property {Float64Array} m1
 * @property {Float64Array} m2
 * @property {Float64Array} m3
 * @property {Float64Array} m4
 */

/**
 * @typedef {Object} Motes  Stardust, struct-of-arrays pool, capacity CONFIG.MAX_MOTES.
 * @property {number} count
 * @property {Uint8Array} alive
 * @property {Float64Array} x
 * @property {Float64Array} y
 * @property {Uint16Array} line      Which mote line (streak) it belongs to.
 * @property {Uint8Array} order      Position within its line (0..n-1).
 */

/**
 * @typedef {Object} Comet
 * @property {number} x
 * @property {number} y
 * @property {number} px             Previous-step position (for interpolation).
 * @property {number} py
 * @property {number} vx
 * @property {number} vy
 * @property {number} speed          |v|.
 * @property {number} heading        atan2(vy, vx).
 * @property {number} state          COMET.*
 * @property {number} body           Slot index of the body being orbited, -1 when free.
 * @property {number} bodyId         bodies.id of that body, 0 when free.
 * @property {number} lastBodyId     bodies.id of the planet most recently left (re-catch rule).
 * @property {number} orbitRadius
 * @property {number} orbitDir       +1 counter-clockwise, -1 clockwise.
 * @property {number} orbitAngle     Angle of comet around the body centre.
 * @property {number} laps           Laps completed on this planet (fractional).
 * @property {number} altitude       Distance from the body surface when orbiting, else Infinity.
 * @property {boolean} armed         Hold is down outside every ring; latches on ring entry.
 * @property {boolean} grazing       Altitude < GRAZE_ALTITUDE this step.
 * @property {boolean} wasHeld       `held` at the previous step (sim-internal edge tracking).
 * @property {number} size           1 = full; each brace costs BRACE_SIZE_LOSS, stardust regrows it.
 * @property {number} impact         Seconds since the comet hit a body and stopped (the brace window), -1 otherwise.
 */

/**
 * @typedef {Object} Aim  The dotted aim line, valid while orbiting (`active`).
 * @property {boolean} active
 * @property {number} x0             Start (comet position).
 * @property {number} y0
 * @property {number} dx             Unit direction at the start (tangent, after aim assist) = release heading.
 * @property {number} dy
 * @property {number} length         Drawn length, measured ALONG the path (arc length): AIM_LINE_LENGTH of
 *                                   flight, or shorter if the flight would hit a body (moons, drifting and
 *                                   binary planets at their PREDICTED positions when the comet gets there,
 *                                   black-hole cores) — the end of `points`.
 * @property {Float32Array} points   The drawn path as a polyline (Phase 4). Preallocated, length
 *                                   2 × CONFIG.AIM_PATH_MAX_POINTS, interleaved [x, y, x, y, …]; each vertex
 *                                   is an OFFSET in world units from (x0, y0) (so vertex 0 is always (0, 0)).
 *                                   Only the first `pointCount` vertices are valid; the rest is stale.
 *                                   Free flight is straight except inside a black hole's influence radius,
 *                                   where the sim forecasts the bent path exactly (same fixed step and
 *                                   pull as the flight): a straight line is 2 vertices (start, end); a bent
 *                                   one has a vertex per sim step through the influence (~6–13 units
 *                                   apart). The polyline's total length is `length`. Draw dots along it.
 * @property {number} pointCount     Valid vertices in `points`: >= 2 while `active`, 0 otherwise.
 * @property {number} target         Slot index of the planet whose ring the forecast flight ENTERS cleanly
 *                                   at least CONFIG.AIM_MIN_ENTRY_S after a release (sooner, or already
 *                                   inside it, only if a latch anywhere until AIM_SAFE_PRESS_S is safe)
 *                                   within CONFIG.AIM_TARGET_RANGE
 *                                   of flight (not limited to the drawn length), else -1. Through a black
 *                                   hole's influence this follows the bent path (a lit slingshot).
 * @property {boolean} clear         true when `target >= 0` — draw the line and that ring in the accent colour.
 */

/**
 * @typedef {Object} Front  The collapse front: a horizontal wall of light at height `y`.
 * @property {number} y
 * @property {number} py
 * @property {number} speed
 */

/**
 * @typedef {Object} Score
 * @property {number} score          Total integer score (catches + perfects + graze + height + motes + slingshots).
 * @property {number} combo
 * @property {number} bestCombo
 * @property {number} tier           1..5.
 * @property {number} multiplier     1..5 (same as tier).
 * @property {number} zone           1-based, from path planets caught (10 per zone).
 * @property {number} maxHeight      Highest comet y reached (height points = floor(maxHeight / 10)).
 * @property {number} catches        New planets caught this run.
 * @property {number} perfects
 * @property {number} pathReached    Highest pathIndex caught.
 */

/**
 * @typedef {Object} EventQueue  Preallocated; capacity 128; extra events in a step are dropped.
 *   The sim only appends; the consumer (main.js) must zero `count` once per frame after dispatch.
 * @property {number} count
 * @property {Uint8Array} type       EV.*
 * @property {Float64Array} x
 * @property {Float64Array} y
 * @property {Float64Array} a
 * @property {Float64Array} b
 */

/**
 * @typedef {Object} WorldState  Everything the sim owns. Read-only for everyone else.
 * @property {number} seed
 * @property {string} mode           MODE.*
 * @property {number} time           Simulated seconds since reset.
 * @property {number} steps          Steps since reset.
 * @property {boolean} started       false until the first release from the home planet. While
 *                                   false the home orbit neither decays nor speeds up, the front is
 *                                   still, and the comet stays latched with or without a hold. A
 *                                   release lets go only on a step where the aim line is lit onto a
 *                                   path planet; otherwise it is queued until the line lights
 *                                   (holding again cancels it), so the RELEASE event can come up to
 *                                   ~1.6 s after the finger lifts.
 * @property {boolean} dead          Set on death; the world keeps stepping (bodies move) but the comet is inert.
 * @property {number} deathTime      world.time at death, or -1.
 * @property {number} baseSpeed      Current base speed (rises with zone).
 * @property {Comet} comet
 * @property {Bodies} bodies
 * @property {Motes} motes
 * @property {Aim} aim
 * @property {Front} front
 * @property {Score} score
 * @property {EventQueue} events
 */

/**
 * @typedef {Object} World  WorldState plus methods (src/sim/world.js `createWorld`).
 * @property {(dt: number, input: SimInput) => void} step  Advance one fixed step (dt = STEP).
 * @property {(seed: number, mode?: string) => void} reset  Restart in place without allocating.
 * @property {() => number} hash  32-bit FNV-1a hash of the comet, score and live bodies (determinism tests).
 */
/** @typedef {WorldState & World} WorldT */

/**
 * @typedef {Object} Bot  src/sim/bot.js `createBot()`. Pure; decides a hold state per step.
 * @property {(world: WorldT) => boolean} decide   Returns whether the bot holds this step.
 * @property {() => void} reset
 */

/**
 * @typedef {Object} RenderStats  Filled by the renderer each frame (for ?debug=1 and smoke).
 * @property {number} drawCalls
 * @property {number} particles      Live particles (approximate).
 * @property {number} renderScale
 * @property {number} cpuMs          JS time spent in draw().
 * @property {number} width          Backing-store size in pixels.
 * @property {number} height
 * @property {boolean} halfFloat     RGBA16F scene target in use.
 */

/**
 * @typedef {Object} Renderer  src/render/renderer.js `createRenderer(canvas, opts)`.
 *   opts: { renderScale?: number, reducedMotion?: boolean, onRenderScale?: (s: number) => void, adaptive?: boolean }
 *   adaptive (default true): false pins renderScale (demo/tests).
 *   draw() never reads layout; main.js must call resize() on window resize / orientation change /
 *   visualViewport resize. Call resetRun(world) after every world.reset().
 * @property {(world: WorldT, alpha: number, dtReal: number) => void} draw  Interpolated draw (alpha 0..1).
 * @property {(type: number, x: number, y: number, a: number, b: number) => void} onEvent  Effects (particles, shake, ring pulse).
 * @property {() => void} resize     Call on window resize / orientation change.
 * @property {(world: WorldT) => void} resetRun   Clear particles/camera state for a new run (no GL reallocation).
 * @property {(on: boolean) => void} setReducedMotion
 * @property {(scene: string) => void} setScene   SCREEN.* — e.g. title zooms slightly, gameover dims.
 * @property {() => boolean} isContextLost
 * @property {RenderStats} stats
 * @property {WebGL2RenderingContext | null} gl
 */

/**
 * @typedef {Object} Audio  src/audio/engine.js `createAudio()`.
 * @property {() => void} unlock     Create / resume the AudioContext. Call from a pointerup handler.
 * @property {() => void} suspend    Page hidden.
 * @property {() => void} resume     Page visible again (after a gesture).
 * @property {(on: boolean) => void} setEnabled   Sound toggle (mutes master, stops scheduling).
 * @property {(type: number, x: number, y: number, a: number, b: number) => void} onEvent  SFX & music reactions.
 * @property {(world: WorldT, dtReal: number) => void} update  Per frame: tier layers, graze loop, zone key.
 * @property {(scene: string) => void} setScene   SCREEN.* — title plays a sparse pad; gameover keeps the low-pass.
 * @property {() => void} resetRun   New run: clear low-pass, reset layers to tier 1 and zone 1 key.
 * @property {boolean} enabled
 * @property {string} state          AudioContext state, or 'none' before unlock.
 */

/**
 * @typedef {Object} Settings
 * @property {boolean} sound
 * @property {string} mode           MODE.*
 */

/**
 * @typedef {Object} FirstRunFlags
 * @property {boolean} released      Has released at least once ("RELEASE to fling" done).
 * @property {boolean} caught        Has caught a planet at least once ("HOLD to catch" done).
 */

/**
 * @typedef {Object} Storage  src/platform/storage.js (module singleton functions re-exported as an object).
 * @property {<T>(key: string, fallback: T) => T} get
 * @property {(key: string, value: any) => void} set
 */

/**
 * @typedef {Object} InputSource  src/platform/input.js `createInput(target, opts)`.
 *   opts: { onGesture?: () => void }  — onGesture fires inside every pointerup/touchend/keyup
 *   (the audio unlock hook). Elements with `data-ui` (buttons, chips) never start a hold.
 * @property {(out: SimInput) => void} sample  Write held + edges accumulated since the last sample,
 *   then clear the edges. main.js calls it once per frame before stepping and clears edges for the
 *   remaining steps of that frame.
 * @property {boolean} held
 * @property {(enabled: boolean) => void} setEnabled  Disable while paused / overlays so taps don't steer.
 * @property {() => void} reset   Forget held state (e.g. after resume).
 */

/**
 * @typedef {Object} Hud  src/ui/hud.js `createHud(root)`. Writes DOM only when a value changes.
 * @property {(world: WorldT) => void} update     Score, multiplier, combo.
 * @property {(type: number, x: number, y: number, a: number, b: number) => void} onEvent  e.g. zone banner, combo pop.
 * @property {(label: string) => void} mission   "Mission complete" toast for a finished mission.
 * @property {(text: string | null) => void} prompt  First-run prompt ("RELEASE to fling", "HOLD to catch"); null hides.
 * @property {(visible: boolean) => void} setVisible
 * @property {() => void} resetRun
 */

/**
 * @typedef {Object} GameOverData
 * @property {number} score
 * @property {number} best
 * @property {boolean} newBest
 * @property {number} zone
 * @property {number} bestCombo
 * @property {string} mode
 * @property {MissionView[]} [missions]
 * @property {number} [stars]       Stars earned from missions, all time.
 */

/**
 * @typedef {Object} MissionView  One row of the mission list (title and game-over screens).
 * @property {string} label
 * @property {number} progress
 * @property {number} target
 * @property {boolean} done
 * @property {boolean} fresh        Finished during the run that just ended.
 */

/**
 * @typedef {Object} ScreenHandlers  Callbacks main.js gives to ui/screens.js.
 *   The GAMEOVER overlay ('tap anywhere') calls onRestart and the RESUME overlay calls onResume
 *   themselves, via click on a data-ui overlay; main.js must not also restart or resume from input
 *   edges on those screens.
 * @property {(mode: string) => void} onMode
 * @property {(on: boolean) => void} onSound
 * @property {() => void} onPause
 * @property {() => void} onResume
 * @property {() => void} onRestart
 * @property {() => void} onReload
 */

/**
 * @typedef {Object} Screens  src/ui/screens.js `createScreens(root, handlers)`.
 * @property {(screen: string, data?: any) => void} show
 *   TITLE data: { best: number, mode: string, sound: boolean, daily?: string, missions?: MissionView[], stars?: number }
 *   PAUSED data: { sound: boolean, version: string }
 *   GAMEOVER data: GameOverData
 *   RESUME / ROTATE / PLAYING / BOOT: no data.
 * @property {string} current
 * @property {(mode: string, sound: boolean) => void} setSettings  Reflect current settings in chips/toggles.
 */

/**
 * @typedef {Object} Lifecycle  src/platform/lifecycle.js `createLifecycle(handlers)`.
 *   handlers: { onHide: () => void, onShow: () => void, onOrientation: (landscape: boolean) => void }
 *   onOrientation fires only on change, plus once in a microtask at startup if the page opens in
 *   landscape. Landscape only counts on a touch-first device ((hover: none) and (pointer: coarse)).
 * @property {boolean} hidden
 * @property {boolean} landscape
 */

/**
 * @typedef {Object} DebugOverlay  src/ui/debug.js `createDebug(root)` (only when ?debug=1).
 * @property {(frameMs: number, simMs: number, stats: RenderStats) => void} update  Throttled to ~4Hz internally.
 */

/**
 * @typedef {Object} SlingstarDebugHandle  `window.__slingstar`, used by tools/smoke.mjs.
 * @property {WorldT} world
 * @property {string} screen         SCREEN.*
 * @property {RenderStats} stats
 * @property {string} version
 * @property {number} frames         Frames drawn since boot.
 * @property {() => void} restart
 */

export {};
