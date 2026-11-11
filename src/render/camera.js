// @ts-check
/**
 * Render-owned camera (PLAN.md §2.7): the 1000-unit field width maps to the screen width, the comet
 * sits about 35% up the screen with a smoothed look-ahead along its velocity, a critically damped
 * spring follows it, zoom-out grows with speed (up to 15%), and events add screen shake.
 * Pure JS, allocation-free per frame.
 */
import { CONFIG } from '../config.js';
import { COMET } from '../contracts.js';

/**
 * @typedef {Object} Camera
 * @property {number} x          Centre of the view, world units (double precision).
 * @property {number} y
 * @property {number} vy         Spring velocity.
 * @property {number} zoom       1 = 1000 units across; >1 shows more.
 * @property {number} viewW      Visible world width.
 * @property {number} viewH      Visible world height.
 * @property {number} sx         World → clip scale (2 / viewW).
 * @property {number} sy
 * @property {number} lookX      Smoothed look-ahead offset.
 * @property {number} lookY
 * @property {number} shake      Current shake amplitude, world units.
 * @property {number} shakeX     Shake offset applied this frame.
 * @property {number} shakeY
 * @property {number} sceneZoom  Scene multiplier (title zooms in slightly).
 * @property {boolean} snapped   False until the first update (or after reset): snap instead of spring.
 * @property {number} cometX     Interpolated comet position this frame.
 * @property {number} cometY
 * @property {number} cometVx    Comet velocity this frame.
 * @property {number} cometVy
 * @property {number} speed
 */

/** @returns {Camera} */
export function createCamera() {
  return {
    x: CONFIG.FIELD_WIDTH / 2, y: 0, vy: 0, zoom: 1, viewW: CONFIG.FIELD_WIDTH, viewH: 2160,
    sx: 0.002, sy: 0.001, lookX: 0, lookY: 0, shake: 0, shakeX: 0, shakeY: 0, sceneZoom: 1,
    snapped: false, cometX: 0, cometY: 0, cometVx: 0, cometVy: 0, speed: 0,
  };
}

/** @param {Camera} cam */
export function resetCamera(cam) {
  cam.snapped = false;
  cam.shake = 0; cam.shakeX = 0; cam.shakeY = 0;
  cam.vy = 0; cam.lookX = 0; cam.lookY = 0;
}

/** @param {Camera} cam @param {number} amount world units */
export function addShake(cam, amount) {
  if (amount > cam.shake) cam.shake = amount;
}

const SPEED_LO = CONFIG.BASE_SPEED_START;
const SPEED_HI = CONFIG.BASE_SPEED_CAP * CONFIG.SPEED_CAP_FACTOR;

/**
 * @param {Camera} cam
 * @param {import('../contracts.js').WorldT} world
 * @param {number} alpha  Interpolation factor 0..1 between previous and current step.
 * @param {number} dt     Real seconds since the last frame.
 * @param {number} aspect Backing height / width.
 * @param {number} time   Renderer clock (for shake noise).
 * @param {boolean} reducedMotion
 */
export function updateCamera(cam, world, alpha, dt, aspect, time, reducedMotion) {
  const c = world.comet;
  cam.cometX = c.px + (c.x - c.px) * alpha;
  cam.cometY = c.py + (c.y - c.py) * alpha;
  const dead = c.state === COMET.DEAD;
  cam.cometVx = dead ? 0 : c.vx;
  cam.cometVy = dead ? 0 : c.vy;
  cam.speed = dead ? 0 : c.speed;

  // Zoom out with speed, eased.
  let sf = (cam.speed - SPEED_LO) / (SPEED_HI - SPEED_LO);
  sf = sf < 0 ? 0 : sf > 1 ? 1 : sf;
  const zTarget = (1 + CONFIG.CAMERA_MAX_ZOOM_OUT * sf * sf * (3 - 2 * sf)) * cam.sceneZoom;
  const kz = 1 - Math.exp(-dt * 2.5);
  cam.zoom = cam.snapped ? cam.zoom + (zTarget - cam.zoom) * kz : zTarget;
  cam.viewW = CONFIG.FIELD_WIDTH * cam.zoom;
  cam.viewH = cam.viewW * aspect;

  // Look-ahead along velocity, low-passed so a fast orbit does not swing the view around.
  const la = CONFIG.CAMERA_LOOKAHEAD_S;
  const kl = cam.snapped ? 1 - Math.exp(-dt * 2.2) : 1;
  cam.lookX += (cam.cometVx * la - cam.lookX) * kl;
  cam.lookY += (cam.cometVy * la - cam.lookY) * kl;

  // Comet sits CAMERA_COMET_SCREEN_Y up the screen → view centre is (0.5 - that) × viewH above it.
  const targetY = cam.cometY + cam.lookY * 0.8 + (0.5 - CONFIG.CAMERA_COMET_SCREEN_Y) * cam.viewH;
  if (!cam.snapped || Math.abs(targetY - cam.y) > 4000) {
    cam.y = targetY; cam.vy = cam.cometVy; cam.snapped = true;
  } else {
    // Critically damped spring with velocity feed-forward (no steady lag at constant speed).
    const k = CONFIG.CAMERA_SPRING;
    let rem = dt;
    while (rem > 1e-6) {
      const h = rem > 1 / 120 ? 1 / 120 : rem;
      const acc = k * k * (targetY - cam.y) + 2 * k * (cam.cometVy - cam.vy);
      cam.vy += acc * h;
      cam.y += cam.vy * h;
      rem -= h;
    }
  }
  cam.x = CONFIG.FIELD_WIDTH / 2;

  // Shake: decaying amplitude × smooth pseudo-noise.
  cam.shake *= Math.exp(-dt * 7);
  if (reducedMotion || cam.shake < 0.05) {
    cam.shakeX = 0; cam.shakeY = 0;
  } else {
    cam.shakeX = cam.shake * (0.6 * Math.sin(time * 61.3) + 0.4 * Math.sin(time * 37.9 + 1.7));
    cam.shakeY = cam.shake * (0.6 * Math.sin(time * 53.1 + 0.5) + 0.4 * Math.sin(time * 29.3 + 2.9));
  }
  cam.sx = 2 / cam.viewW;
  cam.sy = 2 / cam.viewH;
}

/** View centre including shake. @param {Camera} cam */
export const viewX = (cam) => cam.x + cam.shakeX;
/** @param {Camera} cam */
export const viewY = (cam) => cam.y + cam.shakeY;
