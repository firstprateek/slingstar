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
  BASE_SPEED_START: 800,
  BASE_SPEED_CAP: 1600,
  /** Base speed added per zone after zone 1, until the cap. */
  BASE_SPEED_PER_ZONE: 140,
  /** Current speed cap = base speed × this. Orbiting speed growth stops here. */
  SPEED_CAP_FACTOR: 1.45,
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

  // ---------------------------------------------------------------- walls
  WALL_SPEED_LOSS: 0.10,

  // ---------------------------------------------------------------- collapse front
  FRONT_START_BELOW: 1500,
  FRONT_SPEED_START: 220,
  FRONT_ACCEL: 4,
  /** Front speed never exceeds this fraction of the comet's base speed. */
  FRONT_SPEED_CAP_FRACTION: 0.75,
  FRONT_MAX_LAG: 2600,

  // ---------------------------------------------------------------- bodies
  PLANET_R_MIN: 60,
  PLANET_R_MAX: 130,
  /** Capture band width (Rc - R) in zone 1 … and at/after zone 6. Linear in between. */
  CAPTURE_BAND_Z1: 170,
  CAPTURE_BAND_Z6: 110,
  PATH_SPACING_MIN: 520,
  PATH_SPACING_MAX_Z1: 900,
  PATH_SPACING_MAX_LATE: 1300,
  /** Zone at which PATH_SPACING_MAX_LATE is reached (linear from zone 1). */
  PATH_SPACING_LATE_ZONE: 6,
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
  BINARY_SEPARATION_MIN: 340,
  BINARY_SEPARATION_MAX: 440,
  BINARY_ANGULAR_SPEED: 0.35,

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
  /** Home planet (first path planet, comet starts orbiting it). */
  HOME_X: 500,
  HOME_Y: 0,
  HOME_R: 90,

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
  NEAR_MISS_DISTANCE: 25,
  NEAR_MISS_TIMESCALE: 0.35,
  NEAR_MISS_DURATION: 0.25,
  DEATH_TIMESCALE: 0.15,
  DEATH_DURATION: 0.7,
  DEATH_PARTICLES: 2500,
  /** Reduced motion: slow-motion strength is scaled toward 1 by this factor. */
  REDUCED_MOTION_SLOWMO: 0.5,
  CATCH_SHAKE: 6,
  RESTART_MAX_MS: 300,
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
  ZONE_CROSSFADE_S: 1.5,

  // ---------------------------------------------------------------- audio
  BPM: 108,
  SCHEDULER_INTERVAL_MS: 25,
  SCHEDULER_HORIZON_S: 0.1,
  DEATH_LOWPASS_HZ: 200,
  /** Minor pentatonic intervals in semitones. */
  SCALE: Object.freeze([0, 3, 5, 7, 10]),
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
