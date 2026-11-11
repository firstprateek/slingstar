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
