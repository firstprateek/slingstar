// @ts-check
/**
 * Service-worker registration (PLAN.md §6). Owned by stream D.
 *
 * registerServiceWorker() registers ../../sw.js (resolved from this module, so it works from any
 * page) only on https: or a loopback host, never throws, and never blocks boot: it waits for the
 * window load event so precaching does not compete with the first frame. The game runs without it.
 *
 * reload() is the pause screen's "Reload" button: it checks for a new service worker, lets a
 * waiting one take over (SKIP_WAITING), then reloads the page.
 */

const SW_URL = new URL('../../sw.js', import.meta.url);
const SCOPE_URL = new URL('../../', import.meta.url);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether this origin may register a service worker (HTTPS or loopback). */
export function canUseServiceWorker() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    return location.protocol === 'https:' || LOOPBACK.has(location.hostname);
  } catch { return false; }
}

/** @returns {Promise<void>} */
function whenLoaded() {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('load', () => resolve(), { once: true }));
}

/** @param {number} ms @returns {Promise<void>} */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ strategy?: 'cache' | 'auto' }} [opts]
 *   strategy 'cache' forces cache-first even on a loopback host (tests); the default 'auto' makes
 *   sw.js use network-first on loopback hosts so development edits show up without a version bump.
 * @returns {Promise<ServiceWorkerRegistration | null>}
 */
export async function registerServiceWorker(opts = {}) {
  try {
    if (!canUseServiceWorker()) return null;
    await whenLoaded();
    const url = new URL(SW_URL);
    if (opts.strategy === 'cache') url.searchParams.set('strategy', 'cache');
    return await navigator.serviceWorker.register(url.href, { scope: SCOPE_URL.pathname });
  } catch (e) {
    try { console.warn('[slingstar] service worker not registered:', e && /** @type {Error} */ (e).message); } catch { /* */ }
    return null;
  }
}

/**
 * Wait until `worker` reaches 'activated' (or 'redundant'), up to `ms`.
 * @param {ServiceWorker} worker @param {number} ms
 */
function untilActive(worker, ms) {
  return Promise.race([
    delay(ms),
    new Promise((resolve) => {
      if (worker.state === 'activated' || worker.state === 'redundant') { resolve(undefined); return; }
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || worker.state === 'redundant') resolve(undefined);
      });
    }),
  ]);
}

/**
 * Hard reload for a home-screen app (no browser chrome). Checks for an updated service worker,
 * activates it if one is installed or waiting, then reloads. Never throws.
 * @returns {Promise<void>}
 */
export async function reload() {
  try {
    if (canUseServiceWorker()) {
      const reg = await Promise.race([navigator.serviceWorker.getRegistration(SCOPE_URL.href), delay(800)]);
      if (reg) {
        await Promise.race([reg.update().catch(() => {}), delay(2000)]);
        const pending = reg.waiting || reg.installing;
        if (pending) {
          pending.postMessage({ type: 'SKIP_WAITING' });
          await untilActive(pending, 3000);
        }
      }
    }
  } catch { /* offline or unsupported: just reload */ }
  location.reload();
}
