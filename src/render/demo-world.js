// @ts-check
/**
 * Render demo (stream B): a hand-made fake world driven by a tiny kinematic script, since the sim
 * may still be a stub. Uses createWorld() only for the state shape, then fills bodies, motes, the
 * aim line, the comet and the front itself, and calls renderer.onEvent to show every effect.
 *
 * URL params: ?zone=N fixed zone (else cycles every 6 s) · ?tier=N fixed tier · ?seed=N ·
 * ?death=T fire a death at T seconds · ?rs=0.6..1 render scale · ?adaptive=1 · ?reduced=1 ·
 * ?scene=title|gameover · ?stats=1 · ?speed=N comet speed · ?front=N front distance below the comet.
 * window.__demo exposes { world, renderer, time, pause, fire(type) } for Playwright.
 */
import { CONFIG, STEP } from '../config.js';
import { BODY, BODY_FLAG, COMET, EV, SCREEN } from '../contracts.js';
import { createWorld } from '../sim/world.js';
import { createRng } from '../core/rng.js';
import { rayCircle } from '../core/math.js';
import { createRenderer } from './renderer.js';

const q = new URLSearchParams(location.search);
const num = (/** @type {string} */ k, /** @type {number} */ d) => (q.has(k) ? Number(q.get(k)) : d);
const FIXED_ZONE = q.has('zone') ? num('zone', 1) : 0;
const FIXED_TIER = q.has('tier') ? num('tier', 1) : 0;
const DEATH_AT = num('death', -1);
const FRONT_GAP = num('front', 640);
const rng = createRng(num('seed', 7));

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('c'));
const statsEl = /** @type {HTMLElement} */ (document.getElementById('stats'));
const scoreEl = /** @type {HTMLElement} */ (document.getElementById('score'));
const subEl = /** @type {HTMLElement} */ (document.getElementById('sub'));
statsEl.hidden = !q.has('stats');

const world = createWorld({ seed: 1 });
const renderer = createRenderer(canvas, {
  renderScale: num('rs', 1),
  reducedMotion: q.has('reduced'),
  adaptive: q.get('adaptive') === '1',
  onRenderScale: (s) => console.log('renderScale', s),
});
if (q.get('scene') === 'title') renderer.setScene(SCREEN.TITLE);
if (q.get('scene') === 'gameover') renderer.setScene(SCREEN.GAMEOVER);

const b = world.bodies;
const c = world.comet;
let nextId = 1;
let zone = FIXED_ZONE || 1;
let pathCount = 0;     // path planets generated
let topY = 0;          // y of the last path planet
let lastX = 500;
/** Slots of path planets in order. */
const path = /** @type {number[]} */ ([]);
let cur = 0;           // index in `path` of the planet being orbited / approached
let speed = num('speed', 820);
let catches = 0;
let combo = 0;

// Orbit / flight script state.
let mode = 0;          // 0 orbit, 1 free
let theta = 0, orbitR = 0, dir = 1, sweepLeft = 0;
let relTheta = 0, arrTheta = 0;
let p1x = 0, p1y = 0, p2x = 0, p2y = 0, segLen = 0, segS = 0, tx = 0, ty = 0;
let lineId = 0;

function freeSlot() {
  for (let i = 0; i < b.count; i++) if (!b.alive[i]) return i;
  if (b.count < CONFIG.MAX_BODIES) return b.count++;
  return -1;
}

/**
 * @param {number} type @param {number} x @param {number} y @param {number} r @param {number} rc
 * @param {number} flags
 */
function addBody(type, x, y, r, rc, flags) {
  const i = freeSlot();
  if (i < 0) return -1;
  b.alive[i] = 1; b.id[i] = nextId++; b.type[i] = type; b.flags[i] = flags;
  b.x[i] = b.px[i] = x; b.y[i] = b.py[i] = y; b.r[i] = r; b.rc[i] = rc;
  b.seed[i] = (rng.next() * 4294967296) >>> 0; b.zone[i] = zone; b.pathIndex[i] = -1; b.parent[i] = -1;
  b.m0[i] = b.m1[i] = b.m2[i] = b.m3[i] = b.m4[i] = 0;
  return i;
}

function addPathPlanet() {
  const first = pathCount === 0;
  const y = first ? 0 : topY + rng.range(640, 860);
  let x = first ? 500 : rng.range(210, 790);
  if (!first && Math.abs(x - lastX) < 160) x = x < 500 ? Math.min(790, x + 260) : Math.max(210, x - 260);
  const r = first ? 90 : rng.range(CONFIG.PLANET_R_MIN, CONFIG.PLANET_R_MAX);
  const ringed = !first && (pathCount % 3 === 1 || rng.next() < 0.15);
  const flags = (first ? BODY_FLAG.HOME : 0) | (ringed ? BODY_FLAG.RINGED : 0);
  const i = addBody(BODY.PLANET, x, y, r, r + 150, flags);
  b.pathIndex[i] = pathCount;
  path.push(i);
  // Hazards for the preview: a moon on some planets.
  if (pathCount % 3 === 2) {
    const m = addBody(BODY.MOON, x, y, rng.range(CONFIG.MOON_RADIUS_MIN, CONFIG.MOON_RADIUS_MAX), 0, 0);
    b.parent[m] = i; b.m0[m] = r + 150 * 0.86; b.m1[m] = rng.range(0.8, 1.4) * (rng.next() < 0.5 ? -1 : 1); b.m2[m] = rng.next() * 6.28;
  }
  // Side decorations between this planet and the previous one.
  if (!first && pathCount % 6 === 3) {
    const bx = lastX > 500 && x > 500 ? 150 : lastX < 500 && x < 500 ? 850 : (x > 500 ? 130 : 870);
    addBody(BODY.BLACKHOLE, bx, (y + topY) / 2, CONFIG.BLACKHOLE_CORE_RADIUS, CONFIG.BLACKHOLE_INFLUENCE_RADIUS, 0);
  } else if (!first && pathCount % 6 === 5) {
    const cx = x > 500 ? 215 : 785, cy = (y + topY) / 2;
    const a = addBody(BODY.PLANET, cx, cy, 46, 46 + 110, BODY_FLAG.BINARY);
    const a2 = addBody(BODY.PLANET, cx, cy, 40, 40 + 110, BODY_FLAG.BINARY);
    const ph = rng.next() * 6.28;
    for (const [k, partner, phase] of [[a, a2, ph], [a2, a, ph + Math.PI]]) {
      b.parent[k] = partner; b.m0[k] = 120; b.m1[k] = 0.6; b.m2[k] = phase; b.m3[k] = cx; b.m4[k] = cy;
    }
  }
  topY = y; lastX = x;
  pathCount++;
}

/**
 * Common tangent between orbit circles A (dirA) and B (dirB): sets p1/p2, tangent, angles.
 * @param {number} ia @param {number} ra @param {number} dA @param {number} ib @param {number} rb @param {number} dB
 */
function solveTangent(ia, ra, dA, ib, rb, dB) {
  const ax = b.x[ia], ay = b.y[ia], bx = b.x[ib], by = b.y[ib];
  const Dx = bx - ax, Dy = by - ay, d = Math.hypot(Dx, Dy);
  const ux = Dx / d, uy = Dy / d;
  for (const s1 of [1, -1]) for (const s2 of [1, -1]) for (const sg of [1, -1]) {
    const k = s1 * ra - s2 * rb;
    if (Math.abs(k) > d) continue;
    const co = k / d, si = sg * Math.sqrt(1 - co * co);
    const nx = co * ux - si * uy, ny = co * uy + si * ux;
    const P1x = ax + s1 * ra * nx, P1y = ay + s1 * ra * ny;
    const P2x = bx + s2 * rb * nx, P2y = by + s2 * rb * ny;
    let ttx = P2x - P1x, tty = P2y - P1y;
    const L = Math.hypot(ttx, tty); ttx /= L; tty /= L;
    const cA = Math.sign(s1 * (nx * tty - ny * ttx));
    const cB = Math.sign(s2 * (nx * tty - ny * ttx));
    if (cA !== dA || cB !== dB || ttx * Dx + tty * Dy <= 0) continue;
    p1x = P1x; p1y = P1y; p2x = P2x; p2y = P2y; tx = ttx; ty = tty; segLen = L;
    relTheta = Math.atan2(P1y - ay, P1x - ax);
    arrTheta = Math.atan2(P2y - by, P2x - bx);
    return true;
  }
  return false;
}

function orbitRadiusFor(/** @type {number} */ i, /** @type {number} */ k) {
  return k % 4 === 3 ? b.r[i] + 34 : b.r[i] + 150 * 0.55;
}

function planNext() {
  while (pathCount < cur + 4) addPathPlanet();
  const a = path[cur], nb = path[cur + 1];
  const rb = orbitRadiusFor(nb, cur + 1);
  if (!solveTangent(a, orbitR, dir, nb, rb, -dir)) solveTangent(a, orbitR, dir, nb, rb, dir);
  let sweep = ((relTheta - theta) * dir) % (Math.PI * 2);
  if (sweep < 0) sweep += Math.PI * 2;
  if (sweep < 1.2) sweep += Math.PI * 2;
  sweepLeft = sweep;
  // Stardust along the flight line.
  lineId++;
  const n = 5;
  for (let k = 0; k < n; k++) {
    const s = segLen * (0.3 + 0.4 * k / (n - 1));
    const m = world.motes;
    let slot = -1;
    for (let j = 0; j < m.count; j++) if (!m.alive[j]) { slot = j; break; }
    if (slot < 0 && m.count < CONFIG.MAX_MOTES) slot = m.count++;
    if (slot < 0) break;
    m.alive[slot] = 1; m.x[slot] = p1x + tx * s; m.y[slot] = p1y + ty * s; m.line[slot] = lineId; m.order[slot] = k;
  }
}

function resetDemo() {
  b.alive.fill(0); b.count = 0; world.motes.alive.fill(0); world.motes.count = 0;
  path.length = 0; pathCount = 0; cur = 0; topY = 0; lastX = 500;
  addPathPlanet();
  const h = path[0];
  orbitR = orbitRadiusFor(h, 0); theta = -Math.PI / 2; dir = 1; mode = 0;
  c.state = COMET.ORBIT; c.body = h; c.bodyId = b.id[h];
  world.dead = false; world.deathTime = -1; world.started = true;
  planNext();
  placeOrbit();
  c.px = c.x; c.py = c.y;
  world.front.y = world.front.py = c.y - FRONT_GAP;
  world.score.zone = zone;
}

function placeOrbit() {
  const i = path[cur];
  c.x = b.x[i] + Math.cos(theta) * orbitR;
  c.y = b.y[i] + Math.sin(theta) * orbitR;
  c.vx = -Math.sin(theta) * dir * speed; c.vy = Math.cos(theta) * dir * speed;
  c.speed = speed; c.heading = Math.atan2(c.vy, c.vx);
  c.orbitRadius = orbitR; c.orbitDir = dir; c.orbitAngle = theta;
  c.altitude = orbitR - b.r[i];
  c.grazing = c.altitude < CONFIG.GRAZE_ALTITUDE;
}

/** @param {number} type @param {number} x @param {number} y @param {number} a @param {number} bb */
function fire(type, x, y, a, bb) { renderer.onEvent(type, x, y, a, bb); }

let deadTimer = 0;
let zoneTimer = 0;
let bounceTimer = 4;
let deathFired = false;

/** One fixed step of the fake world. @param {number} dt */
function step(dt) {
  world.time += dt; world.steps++;
  c.px = c.x; c.py = c.y;
  for (let i = 0; i < b.count; i++) { b.px[i] = b.x[i]; b.py[i] = b.y[i]; }
  world.front.py = world.front.y;
  const t = world.time;
  // Moving bodies.
  for (let i = 0; i < b.count; i++) {
    if (!b.alive[i]) continue;
    if (b.type[i] === BODY.MOON) {
      const p = b.parent[i];
      const th = b.m2[i] + b.m1[i] * t;
      b.x[i] = b.x[p] + b.m0[i] * Math.cos(th); b.y[i] = b.y[p] + b.m0[i] * Math.sin(th);
    } else if (b.flags[i] & BODY_FLAG.BINARY) {
      const th = b.m2[i] + b.m1[i] * t;
      b.x[i] = b.m3[i] + b.m0[i] * Math.cos(th); b.y[i] = b.m4[i] + b.m0[i] * Math.sin(th);
    }
  }

  // Zone cycling.
  if (!FIXED_ZONE) {
    zoneTimer += dt;
    if (zoneTimer > 6) {
      zoneTimer = 0;
      const prev = zone;
      zone = zone % 5 + 1;
      world.score.zone = zone;
      // Re-palette what is on screen so each zone reads clearly in the demo.
      for (let i = 0; i < b.count; i++) b.zone[i] = zone;
      fire(EV.ZONE_CHANGE, c.x, c.y, zone, prev);
    }
  }
  world.score.tier = FIXED_TIER || 1 + (Math.floor(catches / 2) % 5);
  world.score.multiplier = world.score.tier;

  if (world.dead) {
    deadTimer += dt;
    if (deadTimer > 2.6) { deadTimer = 0; resetDemo(); renderer.resetRun(world); }
    return;
  }
  if (DEATH_AT >= 0 && !deathFired && t >= DEATH_AT) {
    deathFired = true;
    world.dead = true; world.deathTime = t; c.state = COMET.DEAD; c.grazing = false;
    world.aim.active = false;
    fire(EV.DEATH, c.x, c.y, 0, -1);
    return;
  }

  const w = speed / orbitR;
  if (mode === 0) {
    const da = w * dt;
    sweepLeft -= da;
    if (sweepLeft <= 0) {
      theta = relTheta;
      placeOrbit();
      mode = 1; segS = 0; c.state = COMET.FREE; c.body = -1; c.grazing = false;
      c.x = p1x; c.y = p1y; c.vx = tx * speed; c.vy = ty * speed; c.heading = Math.atan2(ty, tx);
      c.altitude = Infinity;
      world.aim.active = false;
      fire(EV.RELEASE, c.x, c.y, speed, c.heading);
    } else {
      theta += dir * da;
      placeOrbit();
      const aim = world.aim;
      aim.active = true; aim.x0 = c.x; aim.y0 = c.y;
      aim.dx = c.vx / speed; aim.dy = c.vy / speed; aim.length = CONFIG.AIM_LINE_LENGTH;
      const nb = path[cur + 1];
      const hit = rayCircle(c.x, c.y, aim.dx, aim.dy, b.x[nb], b.y[nb], b.rc[nb]);
      aim.target = hit > 0 ? nb : -1; aim.clear = hit > 0;
    }
  } else {
    segS += speed * dt;
    if (segS >= segLen) {
      cur++;
      const i = path[cur];
      dir = -dir; orbitR = orbitRadiusFor(i, cur); theta = arrTheta;
      mode = 0; c.state = COMET.ORBIT; c.body = i; c.bodyId = b.id[i];
      speed = Math.min(1500, speed + 25);
      placeOrbit();
      catches++; combo++;
      world.score.combo = combo; world.score.catches = catches;
      fire(EV.LATCH, c.x, c.y, i, combo);
      if (catches % 3 === 0) fire(EV.PERFECT, c.x, c.y, i, 150);
      if (catches % 2 === 0) fire(EV.TIER_UP, c.x, c.y, world.score.tier, world.score.tier - 1);
      world.score.score += 100 * world.score.multiplier;
      planNext();
    } else {
      c.x = p1x + tx * segS; c.y = p1y + ty * segS;
    }
    // Mote pickups.
    const m = world.motes;
    for (let j = 0; j < m.count; j++) {
      if (!m.alive[j]) continue;
      const dx = m.x[j] - c.x, dy = m.y[j] - c.y;
      if (dx * dx + dy * dy < CONFIG.MOTE_RADIUS * CONFIG.MOTE_RADIUS * 2) {
        m.alive[j] = 0;
        world.score.score += 10;
        fire(EV.MOTE, m.x[j], m.y[j], m.order[j], 10);
      }
    }
  }
  world.score.maxHeight = Math.max(world.score.maxHeight, c.y);

  // Wall bounce flash every few seconds (the scripted path never touches a wall).
  bounceTimer -= dt;
  if (bounceTimer <= 0) {
    bounceTimer = 5;
    const side = c.x < 500 ? -1 : 1;
    fire(EV.BOUNCE, side < 0 ? 0 : 1000, c.y + 120, side, speed);
  }

  // Front: low on the screen, creeping.
  world.front.y = c.y - FRONT_GAP - 40 * Math.sin(t * 0.7);
  world.front.speed = 300;

  // Recycle what the front has passed.
  for (let i = 0; i < b.count; i++) {
    if (b.alive[i] && b.y[i] + b.rc[i] < world.front.y - 900) b.alive[i] = 0;
  }
  const m = world.motes;
  for (let j = 0; j < m.count; j++) if (m.alive[j] && m.y[j] < world.front.y - 200) m.alive[j] = 0;
}

resetDemo();
renderer.resetRun(world);

const demo = {
  world, renderer, pause: false, frames: 0,
  /** @param {number} type */
  fire(type) { fire(type, c.x, c.y, type === EV.BOUNCE ? -1 : path[cur], 0); },
  /** Advance the demo by `sec` seconds of fixed steps right now (for deterministic screenshots). */
  advance(/** @type {number} */ sec) { for (let s = 0; s < sec / STEP; s++) step(STEP); },
};
/** @type {any} */ (window).__demo = demo;

let last = performance.now();
let acc = 0;
let statT = 0;
let lastScore = -1;
/** @param {number} now */
function frame(now) {
  const dt = Math.min((now - last) / 1000, CONFIG.MAX_FRAME_DT);
  last = now;
  if (!demo.pause) {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n++ < CONFIG.MAX_STEPS_PER_FRAME) { step(STEP); acc -= STEP; }
    if (acc > STEP) acc = 0;
  }
  renderer.draw(world, demo.pause ? 1 : acc / STEP, dt);
  demo.frames++;
  if (world.score.score !== lastScore) {
    lastScore = world.score.score;
    scoreEl.textContent = String(lastScore);
    subEl.textContent = `×${world.score.multiplier} · combo ${world.score.combo}`;
  }
  statT += dt;
  if (!statsEl.hidden && statT > 0.25) {
    statT = 0;
    const s = renderer.stats;
    statsEl.textContent = `draws ${s.drawCalls}  particles ${s.particles}  cpu ${s.cpuMs.toFixed(2)}ms\n` +
      `${s.width}x${s.height} scale ${s.renderScale} ${s.halfFloat ? 'RGBA16F' : 'RGBA8'}  zone ${zone}`;
  }
  requestAnimationFrame(frame);
}
window.addEventListener('resize', () => renderer.resize());
requestAnimationFrame(frame);
