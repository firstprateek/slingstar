// @ts-check
/**
 * WebGL2 renderer (PLAN.md §4). Owns the context, the camera, every GL resource and the effects
 * driven by sim events. Frame passes:
 *   [nebula bake on zone change] → scene target: background, bodies, collapse front, comet trail,
 *   particles, sprites → bloom (bright 1/2, down 1/4 1/8 1/16, up ×3) → composite.
 * draw() is allocation-free. All GL resource creation lives in rebuild(), which also runs on
 * webglcontextrestored.
 */
import { CONFIG, STEP } from '../config.js';
import { COMET, EV, SCREEN } from '../contracts.js';
import { createGfx, initGfx } from './gl.js';
import { createCamera, resetCamera, updateCamera, addShake } from './camera.js';
import { createBackground, paletteIndex, PALETTE } from './background.js';
import { createBodiesPass } from './bodies.js';
import { createParticles } from './particles.js';
import { createFx } from './fx.js';
import { createPost } from './post.js';

const TIERS = CONFIG.TIER_COLORS;
const TAILS = CONFIG.TIER_TAIL;
const SPEED_REF_LO = CONFIG.BASE_SPEED_START;
const SPEED_REF_HI = CONFIG.BASE_SPEED_CAP * CONFIG.SPEED_CAP_FACTOR;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** @param {number} a @param {number} b */
const rand = (a, b) => a + (b - a) * Math.random();

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ renderScale?: number, reducedMotion?: boolean, onRenderScale?: (s: number) => void, adaptive?: boolean }} [opts]
 *   `adaptive` (render-local extension, default true): set false to pin renderScale (demo / tests).
 * @returns {import('../contracts.js').Renderer}
 */
export function createRenderer(canvas, opts = {}) {
  let reducedMotion = !!opts.reducedMotion;
  const adaptive = opts.adaptive !== false;
  let renderScale = clamp(Math.round((opts.renderScale ?? 1) * 10) / 10,
    CONFIG.RENDER_SCALE_MIN, CONFIG.RENDER_SCALE_MAX);

  /** @type {import('../contracts.js').RenderStats} */
  const stats = { drawCalls: 0, particles: 0, renderScale, cpuMs: 0, width: 0, height: 0, halfFloat: false };

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance',
    premultipliedAlpha: true, preserveDrawingBuffer: false,
  });
  const gfx = gl ? createGfx(gl) : null;
  const cam = createCamera();
  const background = createBackground();
  const bodies = createBodiesPass();
  const particles = createParticles();
  const fx = createFx();
  const post = createPost();

  let lost = !gl;
  let ready = false;
  let cssW = 0, cssH = 0;
  let width = 1, height = 1;
  let pxClipX = 0.001, pxClipY = 0.001;   // reference px (CSS px × 2) → clip

  // Clocks: ambient = real seconds (twinkle, spin); effect = interpolated sim time (particles, trail,
  // pulses), so effects slow down in slow motion and freeze while paused.
  let ambient = 0;
  let effect = 0;
  let lastSimTime = -1;
  let effectDt = 0;

  // Comet colour / tail state.
  const tierCol = new Float32Array([TIERS[0][0], TIERS[0][1], TIERS[0][2]]);
  const accent = new Float32Array(3);
  let tailLen = TAILS[0];
  let emitCarry = 0;
  let grazeCarry = 0;
  let lastCX = 0, lastCY = 0, haveLast = false;
  let lastTier = 1;

  // Screen state.
  let dim = 0, dimTarget = 0;
  let flash = 0;
  let firstFrame = true;
  let palForce = true;

  // Adaptive render scale.
  let winTime = 0, winFrames = 0, winSlow = 0, cleanSeconds = 0, upsThisRun = 0, settle = 2;

  function readCssSize() {
    cssW = canvas.clientWidth || window.innerWidth || 390;
    cssH = canvas.clientHeight || window.innerHeight || 844;
  }

  function applySize() {
    readCssSize();
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR) * renderScale;
    width = Math.max(1, Math.round(cssW * dpr));
    height = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    pxClipX = 2 / (cssW * 2);
    pxClipY = 2 / (cssH * 2);
    stats.width = width; stats.height = height; stats.renderScale = renderScale;
    if (gfx && !lost) {
      post.resize(gfx, width, height);
      stats.halfFloat = post.halfFloat;
    }
    settle = 2;
  }

  /** Create (or re-create after context loss) every GL resource, then draw a hidden warm-up frame. */
  function rebuild() {
    if (!gfx || !gl) return;
    ready = false;
    initGfx(gfx);
    background.init(gfx);
    bodies.init(gfx);
    particles.init(gfx);
    fx.init(gfx);
    post.init(gfx);
    applySize();
    if (gl.isContextLost()) return;
    passes(true);
    // Hide the warm-up frame.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(Math.pow(background.bg[0], 1 / 2.2), Math.pow(background.bg[1], 1 / 2.2), Math.pow(background.bg[2], 1 / 2.2), 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    ready = true;
  }

  /**
   * Every GL pass of a frame. CPU-side instance data was built beforehand.
   * @param {boolean} force warm-up: draw every program at least once
   */
  function passes(force) {
    if (!gfx) return;
    const g = gfx.gl;
    background.bakeIfNeeded(gfx);
    post.beginScene(gfx, background.bg);
    background.draw(gfx, cam, width, height, ambient, force ? 0 : effectDtReal);
    const upp = cam.viewW / width;
    bodies.draw(gfx, cam.sx, cam.sy, background.palette, ambient, upp, force ? 1 : 0);
    fx.drawFront(gfx, frontRel, cam, width, height, accent, ambient, force);
    fx.drawTrail(gfx, cam.sx, cam.sy, force);
    particles.draw(gfx, effect, cam.x + cam.shakeX, cam.y + cam.shakeY, cam.sx, cam.sy, pxClipX, pxClipY, force ? 1 : 0);
    fx.drawSprites(gfx, cam.sx, cam.sy, force);
    const sf = clamp((cam.speed - SPEED_REF_LO) / (SPEED_REF_HI - SPEED_REF_LO), 0, 1);
    const ca = reducedMotion ? 0 : 0.0012 + 0.0055 * sf;
    post.finish(gfx, ca, dim, flash);
    g.bindVertexArray(null);
  }
  let frontRel = -1e6;
  let effectDtReal = 0;

  // ------------------------------------------------------------------ effects helpers
  /**
   * Radial burst of particles.
   * @param {number} x @param {number} y @param {number} n
   * @param {number} vmin @param {number} vmax @param {number} lmin @param {number} lmax
   * @param {number} smin @param {number} smax @param {number} drag
   * @param {number} r @param {number} g @param {number} b @param {number} whiteFrac @param {number} stretch
   */
  function burst(x, y, n, vmin, vmax, lmin, lmax, smin, smax, drag, r, g, b, whiteFrac, stretch) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random();
      const v = vmin + (vmax - vmin) * u * u;
      const k = rand(0.8, 1.6);
      const white = Math.random() < whiteFrac;
      particles.spawn(x, y, Math.cos(a) * v, Math.sin(a) * v, effect, rand(lmin, lmax), rand(smin, smax), drag,
        white ? 1.8 : r * k, white ? 1.7 : g * k, white ? 1.6 : b * k, stretch);
    }
  }

  /** Tail emission and graze sparks for this frame. @param {import('../contracts.js').WorldT} world */
  function emit(world) {
    const c = world.comet;
    const alive = c.state !== COMET.DEAD;
    const cx = cam.cometX, cy = cam.cometY;
    if (!alive || effectDt <= 0) { haveLast = alive; lastCX = cx; lastCY = cy; return; }
    if (!haveLast) { lastCX = cx; lastCY = cy; haveLast = true; }
    const tier = clamp(world.score.tier | 0, 1, 5);
    const sf = clamp((c.speed - 500) / 1500, 0, 1);
    const f = clamp(0.55 * sf + 0.45 * (tier - 1) / 4, 0, 1);
    const rate = CONFIG.TAIL_RATE_MIN + (CONFIG.TAIL_RATE_MAX - CONFIG.TAIL_RATE_MIN) * f;
    emitCarry += rate * effectDt;
    let n = emitCarry | 0;
    emitCarry -= n;
    if (n > 64) n = 64;
    const lifeK = TAILS[tier - 1] / TAILS[4];
    const sp = c.speed > 1 ? c.speed : 1;
    const ux = c.vx / sp, uy = c.vy / sp;
    for (let i = 0; i < n; i++) {
      const s = (i + Math.random()) / n;
      const jx = rand(-4, 4), jy = rand(-4, 4);
      const px = lastCX + (cx - lastCX) * s + jx, py = lastCY + (cy - lastCY) * s + jy;
      const side = rand(-45, 45), back = rand(0.03, 0.12) * sp;
      const white = Math.random() < 0.22;
      const k = rand(0.9, 1.8);
      const sz = CONFIG.PARTICLE_SIZE_MIN_PX + (CONFIG.PARTICLE_SIZE_MAX_PX - CONFIG.PARTICLE_SIZE_MIN_PX) * Math.random() * Math.random();
      particles.spawn(px, py, -ux * back - uy * side, -uy * back + ux * side,
        effect - (1 - s) * effectDt, rand(CONFIG.PARTICLE_LIFE_MIN, CONFIG.PARTICLE_LIFE_MAX) * lifeK, sz, 1.8,
        white ? 1.5 : tierCol[0] * k, white ? 1.45 : tierCol[1] * k, white ? 1.4 : tierCol[2] * k, 0);
    }
    // Graze sparks: thrown off where the comet skims the surface.
    if (c.grazing && c.state === COMET.ORBIT && c.body >= 0) {
      const b = world.bodies;
      const bx = b.x[c.body], by = b.y[c.body];
      let rx = cx - bx, ry = cy - by;
      const rl = Math.sqrt(rx * rx + ry * ry) || 1;
      rx /= rl; ry /= rl;
      grazeCarry += 320 * effectDt;
      let m = grazeCarry | 0;
      grazeCarry -= m;
      if (m > 24) m = 24;
      for (let i = 0; i < m; i++) {
        const out = rand(60, 420), along = rand(-0.5, 0.1) * sp, tang = rand(-80, 80);
        particles.spawn(cx - rx * 6, cy - ry * 6,
          rx * out + ux * along - ry * tang, ry * out + uy * along + rx * tang,
          effect, rand(0.25, 0.6), rand(3, 7), 3.5, 2.4, rand(0.9, 1.4), 0.35, 1.2);
      }
    }
    lastCX = cx; lastCY = cy;
  }

  /** Adaptive renderScale (PLAN.md §4.1). @param {number} dt */
  function adapt(dt) {
    if (!adaptive) return;
    if (settle > 0) { settle -= dt; return; }
    if (dt >= 0.099) return;  // clamped hitch (backgrounded tab etc.)
    winTime += dt;
    winFrames++;
    if (dt * 1000 > CONFIG.SLOW_FRAME_MS) winSlow++;
    if (winTime < 1) return;
    const slow = winSlow / winFrames > CONFIG.SLOW_FRAME_FRACTION;
    winTime = 0; winFrames = 0; winSlow = 0;
    if (slow) {
      cleanSeconds = 0;
      if (renderScale > CONFIG.RENDER_SCALE_MIN + 1e-6) setScale(renderScale - CONFIG.RENDER_SCALE_STEP);
    } else if (++cleanSeconds >= CONFIG.RENDER_SCALE_UP_AFTER_S) {
      cleanSeconds = 0;
      if (renderScale < CONFIG.RENDER_SCALE_MAX - 1e-6 && upsThisRun < CONFIG.RENDER_SCALE_MAX_UPS_PER_RUN) {
        upsThisRun++;
        setScale(renderScale + CONFIG.RENDER_SCALE_STEP);
      }
    }
  }
  /** @param {number} s */
  function setScale(s) {
    renderScale = clamp(Math.round(s * 10) / 10, CONFIG.RENDER_SCALE_MIN, CONFIG.RENDER_SCALE_MAX);
    applySize();
    if (opts.onRenderScale) opts.onRenderScale(renderScale);
  }

  if (gl) {
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; ready = false; }, false);
    canvas.addEventListener('webglcontextrestored', () => { lost = false; rebuild(); }, false);
    try {
      rebuild();
    } catch (err) {
      if (!gl.isContextLost()) throw err;
    }
  } else {
    readCssSize();
  }

  /** @type {import('../contracts.js').Renderer} */
  const renderer = {
    gl,
    stats,

    draw(world, alpha, dtReal) {
      const t0 = performance.now();
      if (gfx) gfx.drawCalls = 0;
      if (!gfx || lost || !ready || gfx.gl.isContextLost()) { stats.drawCalls = 0; return; }
      const dt = dtReal > 0 ? (dtReal < 0.1 ? dtReal : 0.1) : 0;
      ambient += dt;
      effectDtReal = dt;

      // Effect clock follows interpolated sim time.
      const simT = world.time - (1 - alpha) * STEP;
      let d = lastSimTime < 0 ? 0 : simT - lastSimTime;
      if (d < 0) d = 0;
      if (d > 0.1) d = 0.1;
      lastSimTime = simT;
      effect += d;
      effectDt = d;
      particles.beginFrame(effect);

      // Palette / zone.
      const pal = paletteIndex(world.score.zone);
      if (pal !== background.palette || palForce) { background.setPalette(pal, palForce || firstFrame); palForce = false; }
      accent[0] = PALETTE[pal * 12 + 9]; accent[1] = PALETTE[pal * 12 + 10]; accent[2] = PALETTE[pal * 12 + 11];

      // Comet tier colour and tail length, eased.
      const tier = clamp(world.score.tier | 0, 1, 5);
      const tc = TIERS[tier - 1];
      const kc = firstFrame ? 1 : 1 - Math.exp(-dt * 6);
      tierCol[0] += (tc[0] - tierCol[0]) * kc;
      tierCol[1] += (tc[1] - tierCol[1]) * kc;
      tierCol[2] += (tc[2] - tierCol[2]) * kc;
      tailLen += (TAILS[tier - 1] - tailLen) * kc;
      lastTier = tier;
      firstFrame = false;

      // Camera.
      updateCamera(cam, world, alpha, dt, height / width, ambient, reducedMotion);
      const vx = cam.x + cam.shakeX, vy = cam.y + cam.shakeY;

      // Screen effects.
      dim += (dimTarget - dim) * (1 - Math.exp(-dt * 3));
      flash *= Math.exp(-dt * 6);
      if (flash < 0.002) flash = 0;

      // CPU-side instance data.
      emit(world);
      if (world.comet.state !== COMET.DEAD && d > 0) fx.record(cam.cometX, cam.cometY, effect);
      fx.trailColor[0] = tierCol[0]; fx.trailColor[1] = tierCol[1]; fx.trailColor[2] = tierCol[2];
      fx.buildTrail(vx, vy, effect, tailLen, 13);
      bodies.build(world, alpha, vx, vy, cam.viewH * 0.5, dt);
      fx.buildSprites(world, cam, vx, vy, effect, ambient, accent, tierCol);
      const fy = world.front.py + (world.front.y - world.front.py) * alpha;
      frontRel = fy - vy;

      passes(false);

      stats.drawCalls = gfx.drawCalls;
      stats.particles = particles.live(effect);
      stats.cpuMs = performance.now() - t0;
      adapt(dtReal);
    },

    onEvent(type, x, y, a, b) {
      if (!gfx) return;
      const reduced = reducedMotion;
      switch (type) {
        case EV.LATCH: {
          bodies.pulse(a | 0);
          burst(x, y, 56, 80, 420, 0.4, 0.9, 3, 8, 3.2, tierCol[0], tierCol[1], tierCol[2], 0.25, 1);
          fx.addPulse(x, y, effect, 0.45, 130, tierCol[0] * 1.6, tierCol[1] * 1.6, tierCol[2] * 1.6);
          if (!reduced) addShake(cam, CONFIG.CATCH_SHAKE * 0.6);
          break;
        }
        case EV.PERFECT: {
          bodies.pulse(a | 0);
          burst(x, y, 150, 150, 700, 0.5, 1.2, 3, 9, 2.6, accent[0] * 1.8, accent[1] * 1.8, accent[2] * 1.8, 0.35, 1.2);
          fx.addPulse(x, y, effect, 0.6, 240, accent[0] * 2.2, accent[1] * 2.2, accent[2] * 2.2);
          if (!reduced) addShake(cam, CONFIG.CATCH_SHAKE);
          break;
        }
        case EV.RELEASE: {
          const hx = Math.cos(b), hy = Math.sin(b);
          for (let i = 0; i < 22; i++) {
            const v = rand(60, 320), s = rand(-110, 110);
            particles.spawn(x, y, -hx * v - hy * s, -hy * v + hx * s, effect, rand(0.25, 0.55), rand(3, 6), 3,
              tierCol[0] * 1.4, tierCol[1] * 1.4, tierCol[2] * 1.4, 0.8);
          }
          break;
        }
        case EV.MOTE: {
          burst(x, y, 20, 40, 260, 0.35, 0.8, 3, 6, 3, 1.8, 1.5, 0.8, 0.4, 0.5);
          fx.addPulse(x, y, effect, 0.3, 46, 1.6, 1.4, 0.9);
          break;
        }
        case EV.NEAR_MISS: {
          burst(x, y, 26, 100, 380, 0.25, 0.5, 3, 6, 4, 2.0, 1.6, 1.2, 0.5, 1.2);
          break;
        }
        case EV.BOUNCE: {
          background.flash(a);
          const dir = a < 0 ? 1 : -1;
          for (let i = 0; i < 70; i++) {
            const v = rand(80, 600), s = rand(-500, 500);
            particles.spawn(x, y, dir * v, s, effect, rand(0.3, 0.8), rand(3, 8), 3,
              accent[0] * 2.2, accent[1] * 2.2, accent[2] * 2.2, 1.2);
          }
          fx.addPulse(x, y, effect, 0.35, 110, accent[0] * 1.5, accent[1] * 1.5, accent[2] * 1.5);
          if (!reduced) addShake(cam, 3);
          break;
        }
        case EV.TIER_UP: {
          const tc = TIERS[clamp(a | 0, 1, 5) - 1];
          burst(x || cam.cometX, y || cam.cometY, 90, 120, 560, 0.5, 1.1, 3, 8, 2.5, tc[0] * 1.6, tc[1] * 1.6, tc[2] * 1.6, 0.3, 1);
          fx.addPulse(x || cam.cometX, y || cam.cometY, effect, 0.6, 280, tc[0] * 2, tc[1] * 2, tc[2] * 2);
          break;
        }
        case EV.ZONE_CHANGE: {
          background.setPalette(paletteIndex(a | 0), false);
          break;
        }
        case EV.SLINGSHOT: {
          burst(x, y, 130, 150, 760, 0.5, 1.2, 3, 8, 2.2, accent[0] * 2, accent[1] * 2, accent[2] * 2, 0.3, 1.5);
          fx.addPulse(x, y, effect, 0.7, 320, accent[0] * 2.2, accent[1] * 2.2, accent[2] * 2.2);
          if (!reduced) addShake(cam, 5);
          break;
        }
        case EV.DEATH: {
          const n = CONFIG.DEATH_PARTICLES;
          for (let i = 0; i < n; i++) {
            const ang = Math.random() * Math.PI * 2;
            const u = Math.random();
            const v = 40 + 1100 * u * u * u + rand(0, 120);
            const pick = Math.random();
            let r = tierCol[0], g = tierCol[1], bb = tierCol[2];
            if (pick < 0.25) { r = 2.2; g = 2.0; bb = 1.8; } else if (pick < 0.42) { r = accent[0] * 2; g = accent[1] * 2; bb = accent[2] * 2; }
            const k = rand(0.9, 2.0);
            particles.spawn(x, y, Math.cos(ang) * v, Math.sin(ang) * v, effect, rand(0.8, 2.2), rand(3, 10),
              rand(1.0, 2.6), r * k, g * k, bb * k, 1.4);
          }
          fx.addPulse(x, y, effect, 0.9, 620, 0.5 + accent[0] * 1.1, 0.5 + accent[1] * 1.1, 0.5 + accent[2] * 1.1);
          fx.addPulse(x, y, effect, 1.4, 360, tierCol[0] * 2, tierCol[1] * 2, tierCol[2] * 2);
          flash = reduced ? 0.12 : 0.28;
          if (!reduced) addShake(cam, 22);
          haveLast = false;
          break;
        }
        default:
          break;
      }
    },

    resize() { applySize(); },

    resetRun(world) {
      resetCamera(cam);
      particles.clear(Math.round(world ? world.comet.y : 0));
      bodies.reset();
      fx.reset();
      background.resetFx();
      haveLast = false; emitCarry = 0; grazeCarry = 0;
      flash = 0;
      lastSimTime = -1;
      upsThisRun = 0;
      firstFrame = true;
      palForce = true;
      lastTier = 1;
    },

    setReducedMotion(on) { reducedMotion = !!on; },

    setScene(scene) {
      dimTarget = scene === SCREEN.GAMEOVER ? 1 : scene === SCREEN.PAUSED ? 0.6 : 0;
      cam.sceneZoom = scene === SCREEN.TITLE ? 0.92 : 1;
    },

    isContextLost: () => !gl || lost || gl.isContextLost(),
  };
  return renderer;
}
