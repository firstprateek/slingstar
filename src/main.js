// @ts-check
/**
 * Boot, state machine (title / playing / paused / gameover), frame loop, wiring (PLAN.md §3.2).
 * PHASE 0 SKELETON: fixed-step loop driving the stub world and a renderer that clears to the
 * zone 1 background. Phase 2 (integration) owns this file.
 */
import { CONFIG, STEP } from './config.js';
import { SCREEN } from './contracts.js';
import { clearEvents } from './core/events.js';
import { createWorld } from './sim/world.js';
import { createRenderer } from './render/renderer.js';
import { VERSION } from './version.js';

const params = new URLSearchParams(location.search);
const seedParam = params.get('seed');
const seed = seedParam != null ? Number(seedParam) >>> 0 : 1;

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const world = createWorld({ seed });
const renderer = createRenderer(canvas);
/** @type {import('./contracts.js').SimInput} */
const input = { held: false, pressedThisStep: false, releasedThisStep: false };

let last = performance.now();
let acc = 0;
let timeScale = 1;
let frames = 0;

/** @type {import('./contracts.js').SlingstarDebugHandle} */
const handle = { world, screen: SCREEN.TITLE, stats: renderer.stats, version: VERSION, frames: 0, restart() { world.reset(seed); } };
/** @type {any} */ (window).__slingstar = handle;

/** @param {number} now */
function frame(now) {
  const dtReal = Math.min((now - last) / 1000, CONFIG.MAX_FRAME_DT);
  last = now;
  acc += dtReal * timeScale;
  let steps = 0;
  while (acc >= STEP && steps++ < CONFIG.MAX_STEPS_PER_FRAME) { world.step(STEP, input); acc -= STEP; }
  if (acc > STEP) acc = 0;
  clearEvents(world.events);
  renderer.draw(world, acc / STEP, dtReal);
  handle.frames = ++frames;
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());
requestAnimationFrame(frame);
