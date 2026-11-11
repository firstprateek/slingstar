// @ts-check
/**
 * Adaptive render scale (PLAN.md §4.1), pure and allocation-free so it can be tested headlessly.
 *
 *   - Scale lives in [RENDER_SCALE_MIN, RENDER_SCALE_MAX] in steps of RENDER_SCALE_STEP.
 *   - Step DOWN when more than SLOW_FRAME_FRACTION of the frames in the last second (a sliding
 *     window over frame durations) took longer than SLOW_FRAME_MS.
 *   - Step UP only after RENDER_SCALE_UP_AFTER_S clean seconds in a row (measured time since the
 *     last change in which the sliding window never met the step-down condition), and at most
 *     RENDER_SCALE_MAX_UPS_PER_RUN per run.
 *   - After any change (or a resize) the window is emptied and the next IGNORE_AFTER_CHANGE frames
 *     are skipped: they pay for re-allocating the render targets, not for drawing. A decision is
 *     therefore always made on a full second of frames at the current size.
 *   - At boot / context restore the first BOOT_SETTLE_MS are not measured (JIT warm-up, first-use
 *     driver work, service worker install), so a slow startup does not cost a permanent step.
 *   - Frames longer than PAUSE_MS are pauses (app switch, debugger), not render cost: skipped.
 *   - Slowness is judged against the display cadence (Phase 4): the cadence is the 10th percentile
 *     of the frame intervals in the window (the vsync interval the display is actually delivering).
 *     At 60 Hz (cadence <= SLOW_FRAME_MS) a frame is slow above SLOW_FRAME_MS, as PLAN §4.1 says.
 *     When the display itself runs slower (Low Power Mode: rAF at 30 Hz, cadence ~33 ms) a frame is
 *     slow only when it misses that cadence (> CADENCE_SLACK × cadence), so a throttled display
 *     never costs resolution. A GPU that cannot hold 60 Hz shows a mix of 16.7 and 33 ms frames:
 *     its cadence stays at 16.7 ms and the 33 ms frames count as slow.
 */
import { CONFIG } from '../config.js';

const CAP = 512;                 // > frames in one second at 240 Hz
const IGNORE_AFTER_CHANGE = 2;
const BOOT_SETTLE_MS = 1000;
const PAUSE_MS = 250;
const WINDOW_MS = 1000;
const BUCKETS = 256;             // 1 ms histogram buckets of the window's intervals (> PAUSE_MS)
const CADENCE_PCT = 0.1;
const CADENCE_SLACK = 1.25;

/**
 * @param {number} initial starting scale (rounded to a step and clamped)
 */
export function createScaler(initial) {
  const dur = new Float32Array(CAP);
  const bucketOf = new Uint8Array(CAP);
  const hist = new Uint16Array(BUCKETS);
  let head = 0, n = 0, sum = 0, slow = 0;
  let cadence = 0;
  let ignore = 0;
  let settleMs = BOOT_SETTLE_MS;
  let cleanMs = 0;
  let ups = 0;

  const self = {
    scale: quantize(initial),
    /** Step-ups used this run. */
    get ups() { return ups; },
    /** Clean time accumulated toward the next step up (ms). */
    get cleanMs() { return cleanMs; },
    /** Frames in the current window, and how many were slow (debug / tests). */
    get windowFrames() { return n; },
    get windowSlow() { return slow; },
    /** Display cadence (ms) detected in the current window, 0 before a full window. */
    get cadence() { return cadence; },

    /** Forget the window and skip the next frames (after a resize / scale change). */
    clear() {
      head = 0; n = 0; sum = 0; slow = 0; cleanMs = 0; cadence = 0;
      hist.fill(0);
      ignore = IGNORE_AFTER_CHANGE;
    },

    /** Boot / context restore: also skip the first second. */
    settle() { self.clear(); settleMs = BOOT_SETTLE_MS; },

    /** New run: the step-up budget refills. */
    newRun() { ups = 0; },

    /**
     * Record one frame. Returns true when `scale` changed (caller re-sizes and persists).
     * @param {number} ms real duration of the frame (rAF to rAF)
     */
    frame(ms) {
      if (!(ms > 0) || ms > PAUSE_MS) return false;
      if (settleMs > 0) { settleMs -= ms; return false; }
      if (ignore > 0) { ignore--; return false; }
      // Push, then drop the oldest frames while the rest still cover a full second.
      if (n === CAP) { const o = (head - n + CAP) % CAP; sum -= dur[o]; hist[bucketOf[o]]--; n--; }
      const bk = ms < BUCKETS - 1 ? ms | 0 : BUCKETS - 1;
      dur[head] = ms; bucketOf[head] = bk; hist[bk]++;
      head = (head + 1) % CAP;
      n++; sum += ms;
      for (;;) {
        const o = (head - n + CAP) % CAP;
        if (n > 1 && sum - dur[o] >= WINDOW_MS) { sum -= dur[o]; hist[bucketOf[o]]--; n--; } else break;
      }
      cleanMs += ms;                        // measured time since the last slow verdict / change
      if (sum < WINDOW_MS) return false;   // not a full second of data yet

      // Display cadence = 10th percentile interval; slow = over the limit for that cadence.
      const want = Math.ceil(n * CADENCE_PCT);
      let b = 0;
      for (let acc = 0; b < BUCKETS; b++) { acc += hist[b]; if (acc >= want) break; }
      cadence = b + 0.5;
      const limit = cadence > CONFIG.SLOW_FRAME_MS ? cadence * CADENCE_SLACK : CONFIG.SLOW_FRAME_MS;
      slow = 0;
      for (let k = Math.ceil(limit); k < BUCKETS; k++) slow += hist[k];

      if (slow > CONFIG.SLOW_FRAME_FRACTION * n) {
        cleanMs = 0;
        if (self.scale > CONFIG.RENDER_SCALE_MIN + 1e-6) {
          self.scale = quantize(self.scale - CONFIG.RENDER_SCALE_STEP);
          self.clear();
          return true;
        }
        return false;
      }
      if (cleanMs >= CONFIG.RENDER_SCALE_UP_AFTER_S * 1000) {
        cleanMs = 0;
        if (self.scale < CONFIG.RENDER_SCALE_MAX - 1e-6 && ups < CONFIG.RENDER_SCALE_MAX_UPS_PER_RUN) {
          ups++;
          self.scale = quantize(self.scale + CONFIG.RENDER_SCALE_STEP);
          self.clear();
          return true;
        }
      }
      return false;
    },
  };
  return self;
}

/** Round to a 0.1 step and clamp to the allowed range. @param {number} s */
export function quantize(s) {
  const v = Math.round((Number.isFinite(s) ? s : CONFIG.RENDER_SCALE_MAX) * 10) / 10;
  return v < CONFIG.RENDER_SCALE_MIN ? CONFIG.RENDER_SCALE_MIN : v > CONFIG.RENDER_SCALE_MAX ? CONFIG.RENDER_SCALE_MAX : v;
}
