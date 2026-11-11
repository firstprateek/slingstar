// Smoke test: Playwright WebKit with an iPhone viewport (PLAN.md §8).
// `node tools/smoke.mjs` — starts its own static server on an ephemeral port, plays the game,
// asserts the basics and saves screenshots to artifacts/.
//   SMOKE_SKIP_GAMEPLAY=1  only check boot, WebGL2 and errors (used before integration).
import { webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { listShippedFiles, contentHash } from './build-precache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const SKIP_GAMEPLAY = process.env.SMOKE_SKIP_GAMEPLAY === '1';

const failures = [];
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

// ---------------------------------------------------------------- tiny PNG decoder (RGBA/RGB 8-bit)
function decodePng(buf) {
  let off = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp; const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0; const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0; let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, px };
}
/** Luminance stats over a sparse grid: mean, max, fraction of bright pixels, distinct colour buckets. */
function imageStats(buf) {
  const { width, height, bpp, px } = decodePng(buf);
  let sum = 0, max = 0, bright = 0, n = 0; const buckets = new Set();
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
    const i = (y * width + x) * bpp; const r = px[i], g = px[i + 1], b = px[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; sum += l; n++; if (l > max) max = l; if (l > 180) bright++;
    buckets.add((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4));
  }
  return { mean: sum / n, max, brightFrac: bright / n, colours: buckets.size };
}

// The service worker precache and the build version must describe the files being shipped.
{
  const shipped = listShippedFiles(ROOT);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const want = `${pkg.version || '0.0.0'}+${contentHash(ROOT, shipped).slice(0, 8)}`;
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const swVer = (sw.match(/^const VERSION = "(.*)";$/m) || [])[1];
  const swFiles = JSON.parse((sw.match(/^const FILES = (.*);$/m) || [])[1] || '[]');
  const ver = (fs.readFileSync(path.join(ROOT, 'src', 'version.js'), 'utf8').match(/^export const VERSION = "(.*)";$/m) || [])[1];
  const wantFiles = shipped.filter((f) => f !== 'sw.js');
  const sameFiles = swFiles.length === wantFiles.length && swFiles.every((f, i) => f === wantFiles[i]);
  check('sw.js + version.js match the shipped files (else run npm run precache)', swVer === want && ver === want && sameFiles,
    `want ${want}, sw.js ${swVer}, version.js ${ver}, files ${sameFiles ? 'same' : 'differ'}`);
}

const { server, port } = await startServer({ port: 0 });
const base = `http://127.0.0.1:${port}/`;
const browser = await webkit.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
});
const errors = [];
function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** In-page synthetic touch + pointer holds on the canvas, and a fake visibility change. */
const TOUCH_HELPERS = `window.__t = {
  ev(type, id) {
    const c = document.getElementById('game');
    let te;
    try {
      const t = new Touch({ identifier: id, target: c, clientX: 195, clientY: 600 });
      const live = type === 'touchend' ? [] : [t];
      te = new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: [t], bubbles: true, cancelable: true });
    } catch { te = new TouchEvent(type, { bubbles: true, cancelable: true }); }
    c.dispatchEvent(te);
  },
  down(id = 1) { this.ev('touchstart', id); document.getElementById('game').dispatchEvent(new PointerEvent('pointerdown', { pointerId: id, pointerType: 'touch', clientX: 195, clientY: 600, bubbles: true, cancelable: true, isPrimary: true, buttons: 1 })); },
  up(id = 1) { this.ev('touchend', id); document.getElementById('game').dispatchEvent(new PointerEvent('pointerup', { pointerId: id, pointerType: 'touch', clientX: 195, clientY: 600, bubbles: true, cancelable: true, isPrimary: true })); },
  vis(state) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  },
};`;
const shot = async (page, name) => { const b = await page.screenshot({ path: path.join(OUT, name) }); return b; };
/** Screenshot with #boot, #screens, #hud and #debug hidden, so only the WebGL canvas is measured. */
async function canvasOnly(page) {
  await page.evaluate(() => { for (const id of ['boot', 'screens', 'hud', 'debug']) { const e = document.getElementById(id); if (e) e.style.visibility = 'hidden'; } });
  try { return await page.screenshot(); }
  finally { await page.evaluate(() => { for (const id of ['boot', 'screens', 'hud', 'debug']) { const e = document.getElementById(id); if (e) e.style.visibility = ''; } }); }
}

try {
  // ------------------------------------------------------------ 1. title
  const page = await context.newPage(); watch(page, 'title');
  await page.goto(`${base}?seed=1`);
  await page.waitForFunction(() => window.__slingstar && window.__slingstar.frames > 30, null, { timeout: 15000 });
  await sleep(1200);
  const titleShot = await shot(page, 'title.png');
  const hasGl2 = await page.evaluate(() => !!(window.__slingstar.stats && document.getElementById('game').getContext('webgl2')));
  check('WebGL2 context exists', hasGl2);
  // Measure the canvas itself: hide the DOM overlays (boot splash, screens, HUD) for one capture so
  // their glowing text can't make a blank canvas look rendered.
  const canvasShot = await canvasOnly(page);
  const ts = imageStats(canvasShot);
  check('title canvas not blank', ts.colours > 20 && ts.max > 60, `colours=${ts.colours} max=${ts.max.toFixed(0)}`);
  check('boot splash dismissed (main showed a screen)', await page.evaluate(() => document.getElementById('boot') === null));
  void titleShot;
  // First run (fresh storage): one title instruction — the HUD prompt replaces the hint.
  const fr = await page.evaluate(() => {
    const p = document.querySelector('.hud-prompt');
    return { hint: getComputedStyle(document.querySelector('.title-hint')).display, prompt: p.classList.contains('on') ? p.textContent : null };
  });
  check('first-run title shows one instruction', fr.hint === 'none' && fr.prompt === 'RELEASE to fling', JSON.stringify(fr));
  const dailySub = await page.evaluate(() => document.querySelector('.chip .chip-sub').textContent);
  check('Daily chip shows today\'s date', /\d/.test(dailySub), dailySub);

  if (!SKIP_GAMEPLAY) {
    // ------------------------------------------------------------ 2. autoplay run
    const play = await context.newPage(); watch(play, 'autoplay');
    await play.goto(`${base}?seed=1&autoplay=1&debug=1`);
    await play.waitForFunction(() => window.__slingstar && window.__slingstar.frames > 10, null, { timeout: 15000 });
    await sleep(10000);
    const st = await play.evaluate(() => ({ score: window.__slingstar.world.score.score, draws: window.__slingstar.stats.drawCalls, zone: window.__slingstar.world.score.zone, screen: window.__slingstar.screen }));
    check('score > 0 after 10s autoplay', st.score > 0, `score=${st.score} screen=${st.screen}`);
    check('draw calls < 20', st.draws > 0 && st.draws < 20, `drawCalls=${st.draws}`);
    await shot(play, 'play.png');
    const ps = imageStats(await canvasOnly(play));
    check('play canvas not blank', ps.colours > 30 && ps.max > 120, `colours=${ps.colours} max=${ps.max.toFixed(0)} bright=${(ps.brightFrac * 100).toFixed(1)}%`);
    // zone 2+ moment
    try {
      await play.waitForFunction(() => window.__slingstar.world.score.zone >= 2 && window.__slingstar.screen === 'playing', null, { timeout: 90000 });
      await sleep(2500);
      await shot(play, 'zone2.png');
      check('autoplay reaches zone 2', true);
    } catch { check('autoplay reaches zone 2', false, 'timed out after 90s'); await shot(play, 'zone2.png'); }
    await play.close();

    // ------------------------------------------------------------ 3. touch run → game over → restart
    const tp = await context.newPage(); watch(tp, 'touch');
    await tp.goto(`${base}?seed=7`);
    await tp.waitForFunction(() => window.__slingstar && window.__slingstar.frames > 30, null, { timeout: 15000 });
    await tp.touchscreen.tap(195, 600);                         // release from the home planet starts the run
    await tp.waitForFunction(() => window.__slingstar.screen === 'playing', null, { timeout: 5000 }).catch(() => {});
    check('tap on title starts the run', await tp.evaluate(() => window.__slingstar.screen === 'playing'));
    // Long press via dispatched touch + pointer events (Playwright has no touch-hold API).
    const prevented = await tp.evaluate(() => {
      const c = document.getElementById('game');
      // Playwright's macOS WebKit has no Touch constructor; fall back to a TouchEvent without lists.
      let ev;
      try {
        const t = new Touch({ identifier: 1, target: c, clientX: 195, clientY: 600 });
        ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true });
      } catch { ev = new TouchEvent('touchstart', { bubbles: true, cancelable: true }); }
      c.dispatchEvent(ev);
      c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 195, clientY: 600, bubbles: true, cancelable: true, isPrimary: true, buttons: 1 }));
      return ev.defaultPrevented;
    });
    check('touchstart is preventDefault-ed (no loupe/callout)', prevented);
    await tp.waitForFunction(() => window.__slingstar.screen === 'gameover', null, { timeout: 30000 }).catch(() => {});
    const scroll = await tp.evaluate(() => ({ sy: window.scrollY, sx: window.scrollX, scale: window.visualViewport ? window.visualViewport.scale : 1, sel: String(window.getSelection()) }));
    check('no scroll, zoom or selection during hold', scroll.sy === 0 && scroll.sx === 0 && scroll.scale === 1 && scroll.sel === '', JSON.stringify(scroll));
    await tp.evaluate(() => {
      const c = document.getElementById('game');
      let ev;
      try {
        const t = new Touch({ identifier: 1, target: c, clientX: 195, clientY: 600 });
        ev = new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true });
      } catch { ev = new TouchEvent('touchend', { bubbles: true, cancelable: true }); }
      c.dispatchEvent(ev);
      c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 195, clientY: 600, bubbles: true, cancelable: true, isPrimary: true }));
    });
    const over = await tp.evaluate(() => window.__slingstar.screen);
    check('holding forever ends in game over', over === 'gameover', `screen=${over}`);
    await sleep(1500);
    await shot(tp, 'gameover.png');
    // restart latency: tap → screen 'playing' with a fresh world
    const t0 = Date.now();
    await tp.touchscreen.tap(195, 600);
    let restarted = false;
    try { await tp.waitForFunction(() => window.__slingstar.screen !== 'gameover' && window.__slingstar.world.score.score === 0, null, { timeout: 2000, polling: 16 }); restarted = true; } catch {}
    const ms = Date.now() - t0;
    check('tap restarts in under 300ms', restarted && ms < 300 + 150, `${ms}ms incl. Playwright round-trip`);
    await tp.close();

    // ------------------------------------------------------------ 4. pause / resume keeps the orbit
    const pr = await context.newPage(); watch(pr, 'pause');
    await pr.goto(`${base}?seed=7`);
    await pr.waitForFunction(() => window.__slingstar && window.__slingstar.frames > 30, null, { timeout: 15000 });
    await pr.evaluate(TOUCH_HELPERS);
    // Release from home exactly when the aim line is clear, then press (armed) once outside the home
    // ring, so the comet latches onto the next planet with the hold still down.
    await pr.evaluate(() => new Promise((res) => { const f = () => { if (window.__slingstar.world.aim.clear) { window.__t.down(); window.__t.up(); res(); } else requestAnimationFrame(f); }; f(); }));
    await pr.evaluate(() => new Promise((res) => {
      const f = () => {
        const w = window.__slingstar.world, b = w.bodies, c = w.comet;
        let home = -1; for (let i = 0; i < b.count; i++) if (b.alive[i] && b.pathIndex[i] === 0) home = i;
        if (c.state === 1 && (home < 0 || Math.hypot(c.x - b.x[home], c.y - b.y[home]) > b.rc[home] + 30)) res(); else requestAnimationFrame(f);
      };
      f();
    }));
    await pr.evaluate(() => window.__t.down());
    let orbiting = false;
    try { await pr.waitForFunction(() => window.__slingstar.world.started && window.__slingstar.world.comet.state === 0, null, { timeout: 8000 }); orbiting = true; } catch {}
    check('touch run: armed hold latches onto the next planet', orbiting);
    await sleep(250);
    const bodyBefore = await pr.evaluate(() => window.__slingstar.world.comet.bodyId);
    const pb = await pr.locator('.pause-btn').boundingBox();
    await pr.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await pr.waitForFunction(() => window.__slingstar.screen === 'paused', null, { timeout: 3000 }).catch(() => {});
    await sleep(400);   // let the overlay's fade-in finish before reading / capturing it
    const ver = await pr.evaluate(() => { const v = document.querySelector('.s-paused .version'); const r = v.getBoundingClientRect(); return { text: v.textContent, visible: r.height > 0 && getComputedStyle(v).visibility !== 'hidden' && Number(getComputedStyle(v).opacity) > 0.3 }; });
    check('pause screen shows a non-empty build version', ver.visible && /\S/.test(ver.text) && ver.text.includes(await pr.evaluate(() => window.__slingstar.version)), JSON.stringify(ver));
    await shot(pr, 'paused.png');
    await pr.evaluate(() => window.__t.up());     // the holding finger lifts while paused
    await sleep(600);
    const rb = await pr.locator('.s-paused .btn.primary').boundingBox();
    await pr.touchscreen.tap(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await sleep(700);
    const kept = await pr.evaluate(() => ({ screen: window.__slingstar.screen, state: window.__slingstar.world.comet.state, body: window.__slingstar.world.comet.bodyId, dead: window.__slingstar.world.dead }));
    check('Resume keeps the comet orbiting (no fling)', kept.screen === 'playing' && kept.state === 0 && kept.body === bodyBefore && !kept.dead, JSON.stringify({ ...kept, bodyBefore }));
    // Background mid-orbit → "Tap to resume" → still orbiting.
    await pr.evaluate(() => window.__t.vis('hidden'));
    await sleep(200);
    const hidScreen = await pr.evaluate(() => window.__slingstar.screen);
    await pr.evaluate(() => window.__t.vis('visible'));
    await sleep(200);
    await pr.touchscreen.tap(195, 420);
    await sleep(500);
    const kept2 = await pr.evaluate(() => ({ screen: window.__slingstar.screen, state: window.__slingstar.world.comet.state, body: window.__slingstar.world.comet.bodyId }));
    check('hide → Tap to resume keeps the comet orbiting', hidScreen === 'resume' && kept2.screen === 'playing' && kept2.state === 0 && kept2.body === bodyBefore, JSON.stringify({ hidScreen, ...kept2 }));
    // WebGL context lost mid-orbit (iOS memory pressure) → the run stops behind "Tap to resume";
    // after the context comes back, resuming keeps the orbit.
    const lost = await pr.evaluate(async () => {
      const h = window.__slingstar;
      const ext = document.getElementById('game').getContext('webgl2').getExtension('WEBGL_lose_context');
      if (!ext) return { ext: false };
      window.__loseExt = ext;
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 300));
      const steps0 = h.world.steps;
      await new Promise((r) => setTimeout(r, 500));
      const r = { ext: true, screen: h.screen, simAdvanced: h.world.steps - steps0 };
      ext.restoreContext();
      await new Promise((res) => setTimeout(res, 600));
      return r;
    });
    await pr.touchscreen.tap(195, 420);
    await sleep(500);
    const kept3 = await pr.evaluate(() => ({ screen: window.__slingstar.screen, state: window.__slingstar.world.comet.state, body: window.__slingstar.world.comet.bodyId, draws: window.__slingstar.stats.drawCalls }));
    check('context loss while playing → Tap to resume, sim stopped, orbit kept', lost.ext && lost.screen === 'resume' && lost.simAdvanced === 0
      && kept3.screen === 'playing' && kept3.state === 0 && kept3.body === bodyBefore && kept3.draws > 0, JSON.stringify({ ...lost, ...kept3 }));
    await pr.touchscreen.tap(195, 600);
    await sleep(150);
    const flung = await pr.evaluate(() => window.__slingstar.world.comet.state);
    check('after resume, the next real tap flings', flung === 1, `state=${flung}`);
    await pr.close();

    // ------------------------------------------------------------ 4b. sound off → no running AudioContext
    {
      const sp = await context.newPage(); watch(sp, 'sound');
      await sp.goto(`${base}?seed=7`);
      await sp.waitForFunction(() => window.__slingstar && window.__slingstar.frames > 30, null, { timeout: 15000 });
      const centre = async (sel) => { const r = await sp.locator(sel).boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
      const [sx, sy] = await centre('.s-title .sound-btn');
      const [cx, cy] = await centre('.s-title .chip.sel');   // re-picking the current mode: a gesture that changes nothing
      const state = () => sp.evaluate(() => window.__slingstar.audioState);
      await sp.touchscreen.tap(cx, cy); await sleep(300);
      const on1 = await state();                                // first gesture unlocks audio (sound on)
      await sp.touchscreen.tap(sx, sy); await sleep(600);
      const off1 = await state();                               // sound off: suspended after the fade
      await sp.touchscreen.tap(cx, cy); await sleep(300);
      const off2 = await state();                               // later gestures must not resume it
      await sp.touchscreen.tap(sx, sy); await sleep(400);
      const on2 = await state();                                // sound on again, resumed inside the tap
      await sp.touchscreen.tap(sx, sy); await sleep(300);      // off again (persisted)
      await sp.reload();
      await sp.waitForFunction(() => window.__slingstar && window.__slingstar.frames > 30, null, { timeout: 15000 });
      await sp.touchscreen.tap(cx, cy); await sleep(300);
      const offBoot = await state();                            // booted with sound off: no context at all
      check('sound off → AudioContext not running; on again resumes it in the tap',
        on1 === 'running' && off1 !== 'running' && off2 !== 'running' && on2 === 'running' && offBoot === 'none',
        JSON.stringify({ on1, off1, off2, on2, offBoot }));
      await sp.touchscreen.tap(sx, sy); await sleep(200);      // leave the shared storage with sound on
      await sp.close();
    }

    // ------------------------------------------------------------ 5. late zones (hazards), sim at 4×
    const zp = await context.newPage(); watch(zp, 'zone4');
    await zp.goto(`${base}?seed=1&autoplay=1&fast=4`);
    try {
      await zp.waitForFunction(() => window.__slingstar.world && window.__slingstar.world.score.zone >= 4 && window.__slingstar.screen === 'playing', null, { timeout: 150000, polling: 50 });
      await sleep(900);
      const hz = await zp.evaluate(() => { const b = window.__slingstar.world.bodies; let moons = 0, holes = 0; for (let i = 0; i < b.count; i++) if (b.alive[i]) { if (b.type[i] === 1) moons++; else if (b.type[i] === 2) holes++; } return { moons, holes, zone: window.__slingstar.world.score.zone }; });
      await shot(zp, 'zone4.png');
      check('autoplay reaches zone 4', true, `zone=${hz.zone}`);
      check('zone 4 field has hazards (moons / black holes)', hz.moons + hz.holes > 0, JSON.stringify(hz));
      // Zone 4 introduces black holes: wait for one well inside the view (clear of the HUD and the
      // screen edges) and capture it.
      // Back to real time first: at fast=4 the (real-time) camera trails the comet.
      await zp.evaluate(() => { window.__slingstar.fast = 1; });
      await sleep(1500);
      let holeSeen = false;
      try {
        await zp.waitForFunction(() => {
          const w = window.__slingstar.world, b = w.bodies, cy = w.comet.y;
          if (window.__slingstar.screen !== 'playing') return false;
          for (let i = 0; i < b.count; i++) {
            if (b.alive[i] && b.type[i] === 2 && b.y[i] > cy + 150 && b.y[i] < cy + 900 && b.x[i] > 150 && b.x[i] < 850) return true;
          }
          return false;
        }, null, { timeout: 90000, polling: 30 });
        holeSeen = true;
      } catch {}
      const hz2 = await zp.evaluate(() => ({ zone: window.__slingstar.world.score.zone, screen: window.__slingstar.screen }));
      if (holeSeen) await shot(zp, 'zone4-blackhole.png');
      check('zone 4+ shows a black hole in view (artifacts/zone4-blackhole.png)', holeSeen, JSON.stringify(hz2));
    } catch { check('autoplay reaches zone 4', false, 'timed out after 150s at fast=4'); await shot(zp, 'zone4.png'); }
    await zp.close();
  }
  await page.close();
} catch (e) {
  check('smoke run completed', false, String(e && e.stack || e));
} finally {
  check('no console or page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  server.close();
}

console.log(results.join('\n'));
console.log(`\nScreenshots in ${path.relative(process.cwd(), OUT) || OUT}/`);
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nSmoke test passed.');
