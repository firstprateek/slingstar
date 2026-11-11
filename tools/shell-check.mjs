// Shell check (stream D): drives src/ui/demo.html in Playwright WebKit with an iPhone context.
// `node tools/shell-check.mjs`  → screenshots in artifacts/shell/, PASS/FAIL lines, exit 1 on failure.
// Run `node tools/build-precache.mjs` first so the service worker has a file list.
import { webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'shell');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const failures = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server, port } = await startServer({ port: 0 });
const base = `http://127.0.0.1:${port}/`;
const demoUrl = (q = '') => `${base}src/ui/demo.html${q ? `?${q}` : ''}`;
const browser = await webkit.launch();
const IPHONE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const errors = [];
function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
}

// In-page helpers for synthetic touch + pointer sequences on an element.
const HELPERS = `
window.__t = {
  el(sel) { return typeof sel === 'string' ? document.querySelector(sel) : sel; },
  touch(type, sel, id = 1, x = 195, y = 600) {
    const el = this.el(sel);
    // Playwright's macOS WebKit has no Touch constructor; fall back to a TouchEvent without lists.
    let ev;
    try {
      const t = new Touch({ identifier: id, target: el, clientX: x, clientY: y });
      const live = type === 'touchend' || type === 'touchcancel' ? [] : [t];
      ev = new TouchEvent(type, { touches: live, targetTouches: live, changedTouches: [t], bubbles: true, cancelable: true });
    } catch { ev = new TouchEvent(type, { bubbles: true, cancelable: true }); }
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  },
  pointer(type, sel, id = 1, x = 195, y = 600) {
    const el = this.el(sel);
    const ev = new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: id === 1, button: 0, buttons: type === 'pointerdown' ? 1 : 0 });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  },
  down(sel, id = 1) { const p = this.touch('touchstart', sel, id); this.pointer('pointerdown', sel, id); return p; },
  up(sel, id = 1) { const p = this.touch('touchend', sel, id); this.pointer('pointerup', sel, id); return p; },
};`;

async function openDemo(context, q, label) {
  const page = await context.newPage(); watch(page, label);
  await page.addInitScript(HELPERS);
  await page.goto(demoUrl(q));
  await page.waitForFunction(() => window.__demo && document.getElementById('boot') === null, null, { timeout: 10000 });
  return page;
}
const calls = (page, name) => page.evaluate((n) => window.__demo.calls.filter((c) => c.name === n).map((c) => c.args), name);

try {
  // ============================================================== 1. screenshots of every screen
  {
    const context = await browser.newContext(IPHONE);
    const shots = [
      ['boot', 'screen=boot&debug=0', 400],
      ['title', 'screen=title&debug=0', 900],
      ['title-best', 'screen=title&debug=0&best=18420', 900],
      ['playing', 'screen=playing&debug=0', 700],
      ['playing-prompt', 'screen=playing&debug=0&events=0&prompt=RELEASE%20to%20fling', 3200],
      ['playing-debug', 'screen=playing&events=0', 3200],
      ['paused', 'screen=paused&debug=0', 900],
      ['gameover', 'screen=gameover&debug=0', 900],
      ['gameover-newbest', 'screen=gameover&newbest=1&debug=0', 900],
      ['resume', 'screen=resume&debug=0', 900],
      ['rotate', 'screen=rotate&debug=0', 900],
    ];
    for (const [name, q, wait] of shots) {
      const page = await context.newPage(); watch(page, name);
      await page.goto(demoUrl(q + '&sw=0'));
      await page.waitForFunction(() => !!window.__demo, null, { timeout: 10000 });
      await sleep(wait);
      if (name !== 'boot') {
        const cur = await page.evaluate(() => window.__demo.screens.current);
        check(`screen ${name} shown`, cur === q.match(/screen=(\w+)/)[1], `current=${cur}`);
      }
      await page.screenshot({ path: path.join(OUT, `${name}.png`) });
      await page.close();
    }
    // Live flow: zone banner + combo pop + PERFECT mid-animation over the bright scene.
    const page = await openDemo(context, 'sw=0&debug=0&events=0', 'hud-events');
    await page.evaluate(() => { const d = window.__demo; d.startRun(); d.world.score.score = 123456; for (let i = 0; i < 6; i++) d.comboUp(1); d.zoneUp(); d.perfect(); });
    await sleep(450);
    await page.screenshot({ path: path.join(OUT, 'hud-events.png') });
    const hudText = await page.evaluate(() => ({ score: document.querySelector('.hud-score').textContent, mult: document.querySelector('.hud-mult').textContent, combo: document.querySelector('.hud-combo-n').textContent, zone: document.querySelector('.hud-zone-name').textContent }));
    check('HUD writes score/multiplier/combo/zone', hudText.score.startsWith('123,') && hudText.mult === '×3' && hudText.combo === '8' && hudText.zone === 'Ember Reach', JSON.stringify(hudText));
    await page.close();
    // Landscape on a phone → rotate overlay (lifecycle orientation).
    const lp = await openDemo(context, 'sw=0&debug=0', 'landscape');
    await lp.setViewportSize({ width: 844, height: 390 });
    await lp.waitForFunction(() => window.__demo.screens.current === 'rotate', null, { timeout: 3000 }).catch(() => {});
    check('landscape shows ROTATE', await lp.evaluate(() => window.__demo.screens.current === 'rotate' && window.__demo.lifecycle.landscape));
    await sleep(500);
    await lp.screenshot({ path: path.join(OUT, 'rotate-landscape.png') });
    await lp.setViewportSize({ width: 390, height: 844 });
    await lp.waitForFunction(() => window.__demo.screens.current === 'title', null, { timeout: 3000 }).catch(() => {});
    check('portrait again restores TITLE', await lp.evaluate(() => window.__demo.screens.current === 'title' && !window.__demo.lifecycle.landscape));
    await lp.close();
    await context.close();
  }

  // ============================================================== 2. input semantics
  {
    const context = await browser.newContext(IPHONE);
    const page = await openDemo(context, 'sw=0&events=0', 'input');
    await page.evaluate(() => { window.__demo.autoSample = false; window.__demo.sample(); });

    const prevented = await page.evaluate(() => window.__t.down('#game'));
    check('touchstart on canvas is defaultPrevented', prevented === true);
    let s = await page.evaluate(() => ({ held: window.__demo.input.held, ...window.__demo.sample() }));
    check('long press: held + pressed edge', s.held && s.pressed && !s.released, JSON.stringify(s));
    await sleep(700);
    s = await page.evaluate(() => window.__demo.sample());
    check('long press: still held, no new edges after 700ms', s.held && !s.pressed && !s.released, JSON.stringify(s));
    const scroll = await page.evaluate(() => ({ sy: scrollY, sx: scrollX, scale: visualViewport ? visualViewport.scale : 1, sel: String(getSelection()) }));
    check('no scroll / zoom / selection during hold', scroll.sy === 0 && scroll.sx === 0 && scroll.scale === 1 && scroll.sel === '', JSON.stringify(scroll));
    const g0 = await page.evaluate(() => window.__demo.gestures);
    const upPrevented = await page.evaluate(() => window.__t.up('#game'));
    s = await page.evaluate(() => ({ heldNow: window.__demo.input.held, ...window.__demo.sample() }));
    check('release: held cleared + released edge', !s.heldNow && !s.held && s.released && !s.pressed, JSON.stringify(s));
    check('touchend on canvas is defaultPrevented', upPrevented === true);
    const g1 = await page.evaluate(() => window.__demo.gestures);
    check('onGesture fired in touchend/pointerup', g1 > g0, `gestures ${g0}→${g1}`);
    s = await page.evaluate(() => window.__demo.sample());
    check('edges clear after sampling', !s.held && !s.pressed && !s.released, JSON.stringify(s));

    // Tap within one frame.
    s = await page.evaluate(() => { window.__t.down('#game'); window.__t.up('#game'); return window.__demo.sample(); });
    check('tap within a frame: pressed & released, not held', s.pressed && s.released && !s.held, JSON.stringify(s));

    // Multi-touch: second finger lifting does not release.
    s = await page.evaluate(() => {
      const t = window.__t, d = window.__demo;
      t.down('#game', 1); t.down('#game', 2); const a = d.sample();
      t.up('#game', 1); const b = d.sample();
      t.up('#game', 2); const c = d.sample();
      return { a, b, c };
    });
    check('multi-touch: held until last pointer up', s.a.held && s.a.pressed && s.b.held && !s.b.released && !s.c.held && s.c.released, JSON.stringify(s));

    // pointercancel clears.
    s = await page.evaluate(() => { const t = window.__t, d = window.__demo; t.down('#game'); d.sample(); t.pointer('pointercancel', '#game'); return d.sample(); });
    check('pointercancel releases', !s.held && s.released, JSON.stringify(s));

    // Blur / pagehide must not leave held stuck.
    s = await page.evaluate(() => { const t = window.__t, d = window.__demo; t.down('#game'); d.sample(); window.dispatchEvent(new Event('blur')); return { held: d.input.held, ...d.sample() }; });
    check('window blur drops a held pointer', !s.held && s.released, JSON.stringify(s));
    await page.evaluate(() => window.__t.up('#game'));   // stale up after blur is harmless
    s = await page.evaluate(() => window.__demo.sample());
    check('stale pointerup after blur is ignored', !s.held && !s.pressed && !s.released, JSON.stringify(s));

    // setEnabled(false) clears held and ignores input; reset() forgets.
    s = await page.evaluate(() => {
      const t = window.__t, d = window.__demo;
      t.down('#game'); d.sample();
      d.input.setEnabled(false); const a = { held: d.input.held, ...d.sample() };
      t.up('#game'); t.down('#game', 3); const b = { held: d.input.held, ...d.sample() };
      t.up('#game', 3); d.input.setEnabled(true); d.sample();
      t.down('#game', 4); d.input.reset(); const c = { held: d.input.held, ...d.sample() };
      t.up('#game', 4); const e = d.sample();
      return { a, b, c, e };
    });
    check('setEnabled(false) clears held, no edges', !s.a.held && !s.a.pressed && !s.a.released, JSON.stringify(s.a));
    check('disabled input ignores presses', !s.b.held && !s.b.pressed, JSON.stringify(s.b));
    check('reset() forgets held and edges', !s.c.held && !s.c.pressed && !s.c.released && !s.e.released, JSON.stringify(s));

    // Space bar (desktop).
    await page.keyboard.down('Space');
    s = await page.evaluate(() => window.__demo.sample());
    const gA = await page.evaluate(() => window.__demo.gestures);
    await page.keyboard.up('Space');
    const s2 = await page.evaluate(() => window.__demo.sample());
    const gB = await page.evaluate(() => window.__demo.gestures);
    check('Space holds and releases', s.held && s.pressed && !s2.held && s2.released, JSON.stringify({ s, s2 }));
    check('onGesture fired on keyup', gB > gA);

    // Real Playwright touchscreen tap on the canvas (WebKit generates touch + pointer events).
    await page.touchscreen.tap(60, 420);
    await sleep(50);
    s = await page.evaluate(() => window.__demo.sample());
    check('Playwright touchscreen.tap on canvas gives press+release', s.pressed && s.released && !s.held, JSON.stringify(s));

    // data-ui: a mode chip tap calls its handler but never starts a hold.
    const uiPrevented = await page.evaluate(() => window.__t.touch('touchstart', '.chip:not(.sel)'));
    await page.evaluate(() => window.__t.touch('touchend', '.chip:not(.sel)'));
    check('touchstart on a data-ui chip is NOT prevented (click still fires)', uiPrevented === false);
    await page.evaluate(() => window.__demo.sample());
    const chip = await page.locator('.chip', { hasText: 'Daily' }).boundingBox();
    await page.touchscreen.tap(chip.x + chip.width / 2, chip.y + chip.height / 2);
    await sleep(80);
    s = await page.evaluate(() => window.__demo.sample());
    const modeCalls = await calls(page, 'onMode');
    check('tap on Daily chip calls onMode("daily")', modeCalls.length === 1 && modeCalls[0][0] === 'daily', JSON.stringify(modeCalls));
    check('tap on chip does not start a hold', !s.held && !s.pressed && !s.released, JSON.stringify(s));
    check('Daily chip selected', await page.evaluate(() => document.querySelector('.chip.sel').textContent.startsWith('Daily')));
    // synthetic down on the chip: no hold either
    s = await page.evaluate(() => { const t = window.__t; t.pointer('pointerdown', '.chip'); const r = window.__demo.sample(); t.pointer('pointerup', '.chip'); return r; });
    check('pointerdown on data-ui element never holds', !s.held && !s.pressed, JSON.stringify(s));
    // sound toggle
    const sb = await page.locator('.s-title .sound-btn').boundingBox();
    await page.touchscreen.tap(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await sleep(80);
    const soundCalls = await calls(page, 'onSound');
    check('sound toggle calls onSound(false)', soundCalls.length === 1 && soundCalls[0][0] === false, JSON.stringify(soundCalls));

    // Pause button while playing.
    await page.evaluate(() => { window.__demo.startRun(); window.__demo.sample(); });
    const pb = await page.locator('.pause-btn').boundingBox();
    check('pause button hit area >= 44pt', pb.width >= 44 && pb.height >= 44, `${pb.width}x${pb.height}`);
    await page.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2);
    await sleep(80);
    s = await page.evaluate(() => window.__demo.sample());
    check('pause button calls onPause, screen PAUSED', (await calls(page, 'onPause')).length === 1 && await page.evaluate(() => window.__demo.screens.current === 'paused'));
    check('pause tap does not start a hold', !s.pressed && !s.held, JSON.stringify(s));
    // Paused: buttons
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.s-paused .btn')].map((b) => b.getBoundingClientRect().height));
    check('paused buttons >= 44pt tall', sizes.every((h) => h >= 44), sizes.join(','));
    const rb = await page.locator('.s-paused .btn.primary').boundingBox();
    await page.touchscreen.tap(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await sleep(80);
    check('Resume button calls onResume', (await calls(page, 'onResume')).length === 1 && await page.evaluate(() => window.__demo.screens.current === 'playing'));
    await page.evaluate(() => window.__demo.go('paused'));
    const reloadBox = await page.locator('.s-paused .btn.ghost').boundingBox();
    await page.evaluate(() => { window.__demo.calls.length = 0; });
    // onReload in the demo calls pwa.reload() → a real reload; check the handler fires via a click.
    await page.evaluate(() => { const u = new URL(location.href); u.searchParams.set('noreload', '1'); history.replaceState(null, '', u); });
    await page.touchscreen.tap(reloadBox.x + reloadBox.width / 2, reloadBox.y + reloadBox.height / 2);
    await sleep(150);
    const reloadCalls = await calls(page, 'onReload');
    check('Reload button calls onReload', reloadCalls.length === 1, `calls=${reloadCalls.length}`);
    await page.close();

    // Game over: tap anywhere restarts (after the guard), and its touchstart is not prevented.
    const go = await openDemo(context, 'sw=0&events=0', 'gameover');
    await go.evaluate(() => { window.__demo.autoSample = false; window.__demo.startRun(); window.__demo.world.score.score = 999; window.__demo.go('gameover'); });
    await go.touchscreen.tap(195, 500);
    const early = (await calls(go, 'onRestart')).length;
    await sleep(500);
    await go.touchscreen.tap(195, 500);
    await sleep(80);
    const late = (await calls(go, 'onRestart')).length;
    const s3 = await go.evaluate(() => window.__demo.sample());
    check('game over ignores a tap inside the guard window', early === 0, `early=${early}`);
    check('game over: tap anywhere calls onRestart', late === 1 && await go.evaluate(() => window.__demo.screens.current === 'playing'), `late=${late}`);
    check('restart tap does not start a hold', !s3.pressed && !s3.held, JSON.stringify(s3));
    // Resume screen tap.
    await go.evaluate(() => window.__demo.go('resume'));
    await go.touchscreen.tap(195, 300);
    await sleep(80);
    check('RESUME: tap anywhere calls onResume', (await calls(go, 'onResume')).length === 1);
    // Lifecycle: pagehide → onHide; pageshow(persisted) → onShow → RESUME.
    await go.evaluate(() => { window.__demo.go('playing'); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
    const hid = await go.evaluate(() => ({ hidden: window.__demo.lifecycle.hidden, screen: window.__demo.screens.current }));
    await go.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    const shown = await go.evaluate(() => ({ hidden: window.__demo.lifecycle.hidden, screen: window.__demo.screens.current }));
    check('pagehide → onHide (paused)', hid.hidden && hid.screen === 'paused', JSON.stringify(hid));
    check('pageshow after hide → onShow → RESUME', !shown.hidden && shown.screen === 'resume', JSON.stringify(shown));
    await go.close();

    // ============================================================== 3. storage survives reload
    const sp = await openDemo(context, 'sw=0', 'storage');
    await sp.evaluate(() => window.__demo.storage.set('shellcheck', { n: 42, s: 'ok' }));
    await sp.reload();
    await sp.waitForFunction(() => !!window.__demo);
    const got = await sp.evaluate(() => ({ v: window.__demo.storage.get('shellcheck', null), raw: localStorage.getItem('slingstar:shellcheck'), mode: window.__demo.settings.mode, sound: window.__demo.settings.sound, missing: window.__demo.storage.get('nope', 7) }));
    check('storage value survives reload', got.v && got.v.n === 42 && got.v.s === 'ok' && got.raw === '{"n":42,"s":"ok"}', JSON.stringify(got));
    check('settings from chip/toggle taps persisted', got.mode === 'daily' && got.sound === false, JSON.stringify(got));
    check('storage.get falls back for missing keys', got.missing === 7);
    await sp.waitForFunction(() => document.querySelector('.chip.sel') && document.querySelector('.chip.sel').textContent.startsWith('Daily'), null, { timeout: 3000 }).catch(() => {});
    check('title reflects stored mode after reload', await sp.evaluate(() => document.querySelector('.chip.sel').textContent.startsWith('Daily')));
    await sp.close();
    await context.close();
  }

  // ============================================================== 4. service worker + offline
  for (const strategy of ['auto', 'cache']) {
    const context = await browser.newContext({ ...IPHONE, serviceWorkers: 'allow' });
    const page = await context.newPage(); watch(page, `sw-${strategy}`);
    await page.goto(demoUrl(`sw=${strategy}`));
    await page.waitForFunction(() => !!window.__demo);
    const reg = await page.evaluate(async () => { const r = await window.__demo.swReady; return r ? r.scope : null; });
    check(`[${strategy}] service worker registers on 127.0.0.1`, !!reg && reg === base, String(reg));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => {});
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    check(`[${strategy}] page is controlled after activation (clients.claim)`, controlled);
    const cacheInfo = await page.evaluate(async () => {
      const keys = await caches.keys();
      const c = await caches.open(keys.find((k) => k.startsWith('slingstar-')));
      const reqs = await c.keys();
      return { keys, n: reqs.length, hasIndex: reqs.some((r) => r.url.endsWith('/index.html')), hasMain: reqs.some((r) => r.url.endsWith('/src/main.js')) };
    });
    check(`[${strategy}] precache populated`, cacheInfo.n > 10 && cacheInfo.hasIndex && cacheInfo.hasMain, JSON.stringify(cacheInfo));
    // Reload once online so the demo page itself goes through the SW (runtime cache).
    await page.reload();
    await page.waitForFunction(() => !!window.__demo);
    await sleep(300);
    await context.setOffline(true);
    await page.reload();
    const offlineDemo = await page.waitForFunction(() => !!window.__demo && !!document.querySelector('.s-title'), null, { timeout: 8000 }).then(() => true, () => false);
    check(`[${strategy}] demo page loads offline`, offlineDemo);
    const ip = await context.newPage(); watch(ip, `offline-index-${strategy}`);
    let indexOk = false;
    try {
      await ip.goto(`${base}?seed=5`, { timeout: 8000 });
      indexOk = await ip.evaluate(() => document.title === 'Slingstar' && !!document.getElementById('game') && !!document.querySelector('link[rel="apple-touch-icon"]'));
      await sleep(500);
    } catch (e) { indexOk = false; }
    check(`[${strategy}] index.html?seed=5 loads offline (navigation → cached index.html)`, indexOk);
    const iconOk = await ip.evaluate(async () => { try { const r = await fetch('icons/icon-180.png'); return r.ok && (await r.blob()).size > 1000; } catch { return false; } });
    check(`[${strategy}] icon served offline from cache`, iconOk);
    await context.setOffline(false);
    await context.close();
  }
  // Negative control: without a service worker the same offline reload must fail, proving the
  // offline loads above really came from the SW cache.
  {
    const context = await browser.newContext({ ...IPHONE, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(demoUrl('sw=0'));
    await page.waitForFunction(() => !!window.__demo);
    await context.setOffline(true);
    let loaded = false;
    try { await page.reload({ timeout: 5000 }); loaded = await page.evaluate(() => !!window.__demo).catch(() => false); } catch { loaded = false; }
    check('control: without the SW the page does NOT load offline', !loaded);
    await context.close();
  }
} catch (e) {
  check('shell check ran to completion', false, String(e && e.stack || e));
} finally {
  // main.js is still the Phase 0 skeleton; its own errors (e.g. a stub renderer) are not the shell's.
  const relevant = errors.filter((e) => !/offline-index/.test(e) && !/Failed to load resource/.test(e));
  check('no console / page errors on shell pages', relevant.length === 0, relevant.slice(0, 6).join(' | '));
  await browser.close();
  server.close();
}

console.log(results.join('\n'));
console.log(`\nScreenshots in ${path.relative(process.cwd(), OUT) || OUT}/`);
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nShell check passed.');
