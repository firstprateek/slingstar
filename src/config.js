// @ts-check
/**
 * Every tuning constant in Slingstar lives here and nowhere else (PLAN.md §2.3).
 * Units: world units (playfield is 1000 wide, +y is up), seconds, radians unless named *_DEG.
 *
 * FROZEN during Phase 1. A workstream that needs a new or changed constant reports it to the lead.
 */

/** Fixed simulation step, seconds (120Hz). */
export const STEP = 1 / 120;

export const CONFIG = Object.freeze({
  // ---------------------------------------------------------------- field
  FIELD_WIDTH: 1000,
  /** Comet bounces off x = WALL_MARGIN and x = FIELD_WIDTH - WALL_MARGIN (centre of comet). */
  WALL_MARGIN: 0,
  COMET_RADIUS: 8,

  // ---------------------------------------------------------------- frame loop
  MAX_STEPS_PER_FRAME: 8,
  MAX_FRAME_DT: 0.1,

  // ---------------------------------------------------------------- speed
  /** Tuned 800 → 700 (Phase 2): a human-timed late press (~0.2 s) must still land inside the band.
   * Gentler start (2026-11): 700 → 580 and BASE_SPEED_PER_ZONE 140 → 70, with the wider capture band,
   * slower front and stretched ramp below. Most human-like bot deaths were flying into a planet
   * before a press landed; together these doubled the median run (tests/humanbot.js: planner
   * 25 → 52 s, reactive 34 → 61 s) while later zones still reach the speed cap. */
  BASE_SPEED_START: 580,
  BASE_SPEED_CAP: 1600,
  /** Base speed added per zone after zone 1, until the cap. */
  BASE_SPEED_PER_ZONE: 70,
  /** Current speed cap = base speed × this. Orbiting speed growth stops here. Tuned 1.45 → 1.3
   * (Phase 2): at 1.45 the comet hit the cap within a handful of zone 1 catches. */
  SPEED_CAP_FACTOR: 1.3,
  /** Fractional speed gain per second while orbiting (6%). */
  ORBIT_SPEED_GAIN: 0.06,

  // ---------------------------------------------------------------- latching
  /** Perfect catch: |radial speed| < this × speed at the moment of a non-armed press. */
  PERFECT_RADIAL_FRACTION: 0.15,

  // ---------------------------------------------------------------- orbiting
  ORBIT_DECAY_BASE: 15,
  ORBIT_DECAY_PER_LAP: 25,
  GRAZE_ALTITUDE: 45,
  CRASH_ALTITUDE: 12,
  /** Combo resets after this many laps on one planet. */
  COMBO_BREAK_LAPS: 2.5,

  // ---------------------------------------------------------------- release & aim
  AIM_ASSIST_DEG: 3,
  AIM_LINE_LENGTH: 600,
  /** Spacing of the dotted aim line, units. */
  AIM_DOT_SPACING: 24,
  /** aim.target / aim.clear look this far along the ray (later zones space planets > 600 apart). */
  AIM_TARGET_RANGE: 2400,
  /** The aim ray must get this far inside a ring to count as clear; assist aims 1.5× this inside. */
  AIM_RING_MARGIN: 12,
  LATCH_EPSILON: 0.5,

  // ---------------------------------------------------------------- walls
  WALL_SPEED_LOSS: 0.10,

  // ---------------------------------------------------------------- collapse front
  FRONT_START_BELOW: 1500,
  /** Gentler start (2026-11): 220 → 180 and accel 4 → 2.5 u/s². */
  FRONT_SPEED_START: 180,
  FRONT_ACCEL: 2.5,
  /** Front speed never exceeds this fraction of the comet's base speed. */
  FRONT_SPEED_CAP_FRACTION: 0.75,
  FRONT_MAX_LAG: 2600,

  // ---------------------------------------------------------------- bodies
  PLANET_R_MIN: 60,
  PLANET_R_MAX: 130,
  /** Capture band width (Rc - R) in zone 1 … and at/after zone RAMP_END_ZONE. Linear in between.
   * Zone 1 tuned 170 → 200 (Phase 2) so a new player's first catches are forgiving; gentler start
   * (2026-11): 200 → 260, late 110 → 130. */
  CAPTURE_BAND_Z1: 260,
  CAPTURE_BAND_Z6: 130,
  /** Zone at which the capture band and solve window reach their late (…_Z6) values, linear from
   * zone 1 (gentler start, 2026-11: 6 → 8, with PATH_SPACING_LATE_ZONE). */
  RAMP_END_ZONE: 8,
  PATH_SPACING_MIN: 520,
  PATH_SPACING_MAX_Z1: 900,
  PATH_SPACING_MAX_LATE: 1300,
  /** Zone at which PATH_SPACING_MAX_LATE is reached (linear from zone 1). */
  PATH_SPACING_LATE_ZONE: 8,
  PLANET_X_MIN: 180,
  PLANET_X_MAX: 820,
  /** Fraction of planets that get a visual ring (render only; seeded). */
  RINGED_FRACTION: 0.3,

  // ---------------------------------------------------------------- hazards (zones 2-5)
  MOON_RADIUS_MIN: 14,
  MOON_RADIUS_MAX: 22,
  /** Moon orbit radius as fraction of the way from R to Rc. */
  MOON_ORBIT_BAND_FRACTION: 0.55,
  MOON_ANGULAR_SPEED_MIN: 0.8,
  MOON_ANGULAR_SPEED_MAX: 1.6,
  DRIFT_AMPLITUDE: 150,
  DRIFT_PERIOD_MIN: 4,
  DRIFT_PERIOD_MAX: 6,
  BLACKHOLE_CORE_RADIUS: 34,
  BLACKHOLE_INFLUENCE_RADIUS: 300,
  /** accel = G / r², units³/s². */
  BLACKHOLE_G: 2.4e7,
  BLACKHOLE_MAX_ACCEL: 5200,
  BLACKHOLE_SLINGSHOT_POINTS: 250,
  /** Multiplicative speed boost on surviving a pass through the influence zone. */
  BLACKHOLE_SPEED_BOOST: 1.12,
  /** Centre-to-centre distance of a binary pair's members. Phase 4: 340–440 → 440–520 with real
   * pairs (see BINARY_MAX_WAIT_S): a farther partner hides the next planet for less of the turn. */
  BINARY_SEPARATION_MIN: 440,
  BINARY_SEPARATION_MAX: 520,
  /** rad/s. Phase 4: 0.35 → 1.2 with real pairs. From one member, the partner swings through the
   * line to the next planet once a turn and hides it (a partner eclipse) for ~40–70° of the turn:
   * at 0.35 rad/s a 2–3.5 s dark spell, at 1.2 about a second. Pairs whose next planet is in zone
   * 5 or 6; later ones turn faster (BINARY_SPIN_RAMP). */
  BINARY_ANGULAR_SPEED: 1.2,
  /** After zone 6 the spin ramps by this per zone (rad/s), up to BINARY_ANGULAR_SPEED_MAX (zone 7
   * 1.35, zone 8+ 1.5; scoring.binaryAngularSpeed, by the zone of the pair's next planet). The time
   * rule's speed keeps rising to zone 8, so from a member the next planet's window narrows at the
   * edges of a partner eclipse: there the eclipse spans ~75-85° of the turn, more than
   * BINARY_MAX_WAIT_S allows at 1.2 rad/s (72°), and from zone 7 on every pair was rejected. A
   * faster turn keeps the same eclipse under BINARY_MAX_WAIT_S. */
  BINARY_SPIN_RAMP: 0.15,
  BINARY_ANGULAR_SPEED_MAX: 1.5,
  /** Longest partner eclipse the generator allows from a binary member, s (generator.js
   * eclipseMaxRun; with 36 sampled phases at 1.2 rad/s: at most 6 blocked phases, under 70° ≈ 1.02 s). */
  BINARY_MAX_WAIT_S: 1.05,

  // ---------------------------------------------------------------- Phase 3 stream SIM: hazard generation
  // (append-only block owned by the sim stream; rates are per path planet unless noted)
  /** Chance a path planet gets moons in the zone that introduces them (2), and in later zones. */
  HAZARD_MOON_INTRO: 0.5,
  HAZARD_MOON_LATER: 0.3,
  /** Zone 6+: chance a mooned planet gets a second moon (opposite phase). */
  HAZARD_MOON_SECOND: 0.35,
  /** Chance a path planet drifts, in zone 3 and later (never two moving path planets in a row). */
  HAZARD_DRIFT_INTRO: 0.5,
  HAZARD_DRIFT_LATER: 0.25,
  /** Chance a path segment gets a black hole beside it, in zone 4 and later. */
  HAZARD_BLACKHOLE_INTRO: 0.6,
  HAZARD_BLACKHOLE_LATER: 0.3,
  /** Chance a path planet is a binary pair, in zone 5 and later: a share of ALL path planets (the
   * generator raises its roll to make up for the planets right after a mover, which cannot move;
   * generator.js rollMover). Targets: 45% in zone 5, 23% in zone 6 rising 3 points a zone. */
  HAZARD_BINARY_INTRO: 0.45,
  HAZARD_BINARY_LATER: 0.2,
  /** Zone 6+: every later-zone rate rises by this per zone, up to HAZARD_RATE_MAX. */
  HAZARD_RAMP_PER_ZONE: 0.03,
  HAZARD_RATE_MAX: 0.55,
  /** After this many failed tries a hazardous path placement is re-rolled as a plain planet. */
  HAZARD_PLAIN_AFTER_TRIES: 12,
  /** Binary members are small so both rings fit the separation with BODY_GAP. Phase 4: 85 → 70 (a
   * smaller partner hides the next planet for less of the turn). */
  BINARY_R_MAX: 70,
  /** Black-hole centres stay inside this x range; placement tries per segment. */
  BLACKHOLE_X_MIN: 70,
  BLACKHOLE_X_MAX: 930,
  BLACKHOLE_TRIES: 24,
  /** A rolled black hole with no room beside its segment carries to the next ones (at most this many pending). */
  BLACKHOLE_CARRY: 2,
  /** A pass this deep (closest approach as a fraction of the influence radius) or deeper pays the
   * full slingshot; any shallower survived pass pays less (BLACKHOLE_SLINGSHOT_MIN_SCALE, Phase 4). */
  BLACKHOLE_SLINGSHOT_DEPTH: 0.8,
  /** Solvability on a planet with moons measures the window on the orbit band that starts this far
   * (comet surface to moon surface) above the moons, or SOLVE_CLEARANCE (comet centre) if larger. */
  MOON_SAFE_GAP: 10,
  /** Solvability phases sampled for a moving path planet (drift positions / binary angles). */
  SOLVE_DRIFT_PHASES: 13,
  SOLVE_BINARY_PHASES: 36,
  /** Aim line: moving bodies are checked at their predicted positions every this many units. */
  AIM_MARCH_STEP: 6,
  /** After a release the planet just left cannot be re-latched (unless the comet heads back toward
   * it) until the comet is this far outside its ring. */
  LEFT_RING_CLEAR: 40,
  // ---------------------------------------------------------------- end stream SIM block

  // ---------------------------------------------------------------- sim rules (Phase 4)
  /** The aim line lights a ring the comet enters at least this long after a release (a human
   * re-press, finger up then down, takes ~120-150 ms: pressed before the entry, the armed hold
   * latches at the ring edge). A ring it enters sooner, or is already inside, lights only if the
   * comet stays inside it, above the safe latch floor, until AIM_SAFE_PRESS_S after the release. */
  AIM_MIN_ENTRY_S: 0.15,
  AIM_SAFE_PRESS_S: 0.25,
  /** Lowest safe latch: altitude above the planet surface (the graze band, so an orbit has time). */
  AIM_LATCH_FLOOR: 45,
  /** Safe latch radius clears the outer edge of the planet's moon lane by this (comet surface to moon surface). */
  AIM_LATCH_MOON_GAP: 20,
  /** world.aim.points capacity (vertices). The drawn line is AIM_LINE_LENGTH of flight; through a
   * black hole's influence it gets one vertex per sim step (>= 600 / (700 u/s × STEP) + 2 = 105). */
  AIM_PATH_MAX_POINTS: 128,
  /** The aim forecast follows the bent flight through at most this many influence passes and this
   * many fixed steps of bent (stepped) flight in total; beyond either it does not light. */
  AIM_MAX_BENDS: 3,
  AIM_BEND_MAX_STEPS: 1024,
  /** A bent aim path that comes nearer than this (comet surface to core surface) to a black hole's
   * core does not light: a release a few ms off a razor-thin pass would die. */
  AIM_CORE_CLEARANCE: 30,
  /** A pass that only skims the influence edge pays this fraction of the slingshot points and
   * boost; the fraction rises linearly to 1 at BLACKHOLE_SLINGSHOT_DEPTH × influence and deeper. */
  BLACKHOLE_SLINGSHOT_MIN_SCALE: 0.4,
  // ---------------------------------------------------------------- end sim rules (Phase 4)

  // ---------------------------------------------------------------- generation
  MAX_BODIES: 64,
  MAX_MOTES: 256,
  PATH_PLANETS_PER_ZONE: 10,
  /** Generate bodies until this far above the comet. */
  GENERATE_AHEAD: 4000,
  /** Solvability: release window on A's mid-band orbit whose ray enters B's ring. */
  SOLVE_WINDOW_DEG_Z1: 14,
  SOLVE_WINDOW_DEG_Z6: 7,
  SOLVE_CLEARANCE: 30,
  /** Rays sampled around the orbit when checking solvability. */
  SOLVE_RAY_SAMPLES: 720,
  SOLVE_MAX_TRIES: 20,
  MOTES_PER_LINE_MIN: 4,
  MOTES_PER_LINE_MAX: 7,
  MOTE_SPACING: 60,
  MOTE_RADIUS: 18,
  /** Solvability rays must get this far inside B's ring. */
  SOLVE_RING_MARGIN: 15,
  /** The window is also required on the orbit at Rc - this (armed latches happen at the ring edge). */
  SOLVE_OUTER_INSET: 8,
  /** Max horizontal step between path planets as a fraction of the vertical spacing. */
  PATH_DX_FRACTION: 0.85,
  /** Minimum surface-to-surface gap between bodies. */
  BODY_GAP: 40,
  SIDE_PLANET_CHANCE: 0.3,
  SIDE_R_MIN: 45,
  SIDE_R_MAX: 85,
  MOTE_LINE_CHANCE: 0.85,
  MOTE_START: 40,
  /** Recycle bodies and motes this far below the front. */
  RECYCLE_BELOW: 300,
  FALLBACK_SPACING: 600,
  FALLBACK_R: 70,
  /** Home planet (first path planet, comet starts orbiting it). */
  HOME_X: 500,
  HOME_Y: 0,
  HOME_R: 90,

  // ---------------------------------------------------------------- generator (Phase 4)
  /** Generation work per world.step, in generator work units (about one ray-obstacle test each).
   * Placement is a resumable job; the budget is counted in work, not time, so it stays deterministic. */
  GEN_STEP_BUDGET: 30000,
  /** Catch-up: once the generated course ends less than GEN_CATCHUP_AHEAD above the comet, the
   * step budget ramps up linearly to GEN_CATCHUP_MAX × at GEN_URGENT_AHEAD; below that the budget
   * is lifted for the step (a safety net just above AIM_TARGET_RANGE and the visible height). */
  GEN_CATCHUP_AHEAD: 3400,
  GEN_CATCHUP_MAX: 4,
  GEN_URGENT_AHEAD: 2500,
  /** Solvability time rule: the release window must also last this long at the assumed speed
   * (base speed × SOLVE_WINDOW_SPEED_FACTOR) on the orbit checked, besides the degree rule. */
  SOLVE_WINDOW_MIN_S: 0.025,
  SOLVE_WINDOW_SPEED_FACTOR: 1.3,
  /** Placement keeps B near enough (spacing) that its ring spans this multiple of the required
   * window from A, before obstacles; the exact scan then confirms it. */
  SOLVE_WINDOW_SHAPE_MARGIN: 1.25,
  // ---------------------------------------------------------------- end generator (Phase 4)

  // ---------------------------------------------------------------- scoring
  POINTS_CATCH: 100,
  POINTS_PERFECT: 150,
  POINTS_GRAZE_PER_S: 60,
  /** 1 point per this many units of height. */
  HEIGHT_UNITS_PER_POINT: 10,
  POINTS_MOTE: 10,
  /** Combo thresholds for multiplier ×1..×5: tier i applies when combo >= TIER_COMBO[i]. */
  TIER_COMBO: Object.freeze([0, 3, 6, 10, 15]),

  // ---------------------------------------------------------------- feel (main.js / render)
  CAMERA_COMET_SCREEN_Y: 0.35,
  CAMERA_LOOKAHEAD_S: 0.22,
  CAMERA_SPRING: 7,
  CAMERA_MAX_ZOOM_OUT: 0.15,
  /** Orbits near a wall reach past it: the view slides sideways to keep the comet this far inside the screen. */
  CAMERA_EDGE_PAD: 90,
  /** Near miss: free flight passing within this of a surface (comet centre to the surface of a
   * planet, moon or black-hole core). Phase 4: 25 → 60. At 25 (below the generator's 30-unit ray
   * clearance) it fired ~0.2/min for human-like play and never for the bot; at 60 it is ~1-2/min
   * for human-like bots (mostly moons) and ~6/min for the perfect bot. */
  NEAR_MISS_DISTANCE: 60,
  NEAR_MISS_TIMESCALE: 0.35,
  NEAR_MISS_DURATION: 0.25,
  /** After NEAR_MISS_DURATION of real time at NEAR_MISS_TIMESCALE, ease back to 1× over this long (real s). */
  NEAR_MISS_EASE_S: 0.2,
  /** A near-miss pass re-arms once the comet is NEAR_MISS_DISTANCE + this from the surface. */
  NEAR_MISS_HYSTERESIS: 40,
  DEATH_TIMESCALE: 0.15,
  DEATH_DURATION: 0.7,
  DEATH_PARTICLES: 2500,
  /** Reduced motion: slow-motion strength is scaled toward 1 by this factor. */
  REDUCED_MOTION_SLOWMO: 0.5,
  RESTART_MAX_MS: 300,
  /** ?autoplay=1: the bot restarts this long (real s) after the game-over card appears. */
  AUTOPLAY_RESTART_S: 1.6,
  /** Ignore taps on the game-over card for this long so a death-time hold doesn't skip it. */
  GAMEOVER_TAP_GUARD_MS: 380,
  /** Comet colours per tier ×1..×5 (linear-ish RGB 0..1, may exceed 1 for HDR). */
  TIER_COLORS: Object.freeze([
    Object.freeze([0.75, 0.95, 1.0]),
    Object.freeze([1.0, 0.82, 0.3]),
    Object.freeze([1.0, 0.55, 0.2]),
    Object.freeze([1.0, 0.35, 0.85]),
    Object.freeze([1.6, 1.6, 1.6]),
  ]),
  /** Tail length (seconds of history) per tier. */
  TIER_TAIL: Object.freeze([0.25, 0.32, 0.4, 0.5, 0.62]),

  // ---------------------------------------------------------------- render
  MAX_DPR: 2,
  RENDER_SCALE_MAX: 1.0,
  RENDER_SCALE_MIN: 0.6,
  RENDER_SCALE_STEP: 0.1,
  SLOW_FRAME_MS: 20,
  SLOW_FRAME_FRACTION: 0.1,
  RENDER_SCALE_UP_AFTER_S: 10,
  RENDER_SCALE_MAX_UPS_PER_RUN: 2,
  MAX_DRAW_CALLS: 20,
  PARTICLE_CAPACITY: 16384,
  TAIL_RATE_MIN: 300,
  TAIL_RATE_MAX: 900,
  PARTICLE_LIFE_MIN: 0.6,
  PARTICLE_LIFE_MAX: 1.4,
  PARTICLE_SIZE_MIN_PX: 3,
  PARTICLE_SIZE_MAX_PX: 10,
  NEBULA_TEXTURE_SIZE: 512,

  // ---------------------------------------------------------------- audio
  BPM: 108,
  SCHEDULER_INTERVAL_MS: 25,
  SCHEDULER_HORIZON_S: 0.1,
  DEATH_LOWPASS_HZ: 200,
  /** Minor pentatonic intervals in semitones. */
  SCALE: Object.freeze([0, 3, 5, 7, 10]),
  AUDIO_MASTER_LEVEL: 0.8,
  AUDIO_LOWPASS_OPEN_HZ: 18000,
  DEATH_LOWPASS_S: 0.3,
  DEATH_MUSIC_DUCK: 0.6,
  AUDIO_MOTE_VOICES: 4,
  AUDIO_SFX_VOICES: 14,

  // ---------------------------------------------------------------- render (Phase 4)
  /** Nebula / wall / accent cross-fade on a zone change (s). Every palette's nebula is pre-baked,
   * so the fade starts on the zone-change frame and finishes while the zone banner is showing. */
  NEBULA_CROSSFADE_S: 0.55,
  /** Peak catch shake in CSS px (the renderer converts to world units). */
  CATCH_SHAKE_PX: 5,
  /** Peak shake on a perfect catch, CSS px. */
  PERFECT_SHAKE_PX: 8,
  /** Longest a streaked particle may stretch along its velocity (× its diameter). */
  PARTICLE_STRETCH_MAX: 3,
  /** The death burst is spawned over this many frames (back-dated births) to spread the JS cost. */
  DEATH_SPAWN_FRAMES: 4,
  // ---------------------------------------------------------------- end render (Phase 4)
});

/**
 * Zone definitions (PLAN.md §2.4). Zone numbers are 1-based; zone z > 5 uses
 * ZONES[(z - 1) % 5] for palette and key, and mixes all elements.
 * `root` is the MIDI note of the musical key's root.
 */
export const ZONES = Object.freeze([
  Object.freeze({ name: 'Home Drift', element: 'plain', bg: '#05060f', nebulaA: '#1b2a6b', nebulaB: '#4b1d6e', accent: '#6fe3ff', root: 45 }),
  Object.freeze({ name: 'Ember Reach', element: 'moons', bg: '#0d0507', nebulaA: '#7a1f1f', nebulaB: '#b3541e', accent: '#ffb347', root: 48 }),
  Object.freeze({ name: 'Verdant Deep', element: 'drift', bg: '#030d0b', nebulaA: '#0f5c4a', nebulaB: '#1d3f7a', accent: '#7dffb0', root: 43 }),
  Object.freeze({ name: 'Violet Maw', element: 'blackholes', bg: '#08040f', nebulaA: '#4a1680', nebulaB: '#a01e6e', accent: '#ff6ad5', root: 46 }),
  Object.freeze({ name: 'White Reach', element: 'binaries', bg: '#070a10', nebulaA: '#2b4a6e', nebulaB: '#8a93a8', accent: '#e8f4ff', root: 50 }),
]);

/** Debug / URL flags live in main.js; storage keys in contracts.js. */
