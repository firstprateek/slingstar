// @ts-check
/**
 * Visibility, pagehide and orientation (PLAN.md §6). Owned by stream D.
 *
 * - visibilitychange → hidden, or pagehide: onHide() (once per hide).
 * - visibilitychange → visible, or pageshow after a hide (bfcache restore): onShow() (once).
 * - Orientation: landscape is `(orientation: landscape)` on a touch-first device (coarse pointer,
 *   no hover), so a wide desktop window never counts as "rotate your phone". Watched through
 *   matchMedia change events plus resize/orientationchange. onOrientation(landscape) fires only
 *   when the value changes, and once (in a microtask) at startup if the page opens in landscape.
 *   `?landscape=1` forces landscape detection on desktop for testing.
 */

/** @param {string} q @returns {MediaQueryList | null} */
function mq(q) {
  try { return typeof matchMedia === 'function' ? matchMedia(q) : null; } catch { return null; }
}

/**
 * @param {MediaQueryList | null} list @param {() => void} fn
 */
function onChange(list, fn) {
  if (!list) return;
  if (typeof list.addEventListener === 'function') list.addEventListener('change', fn);
  else if (typeof list.addListener === 'function') list.addListener(fn);   // Safari < 14
}

/**
 * @param {{ onHide: () => void, onShow: () => void, onOrientation: (landscape: boolean) => void }} handlers
 * @returns {import('../contracts.js').Lifecycle}
 */
export function createLifecycle(handlers) {
  const landscapeQ = mq('(orientation: landscape)');
  const touchQ = mq('(hover: none) and (pointer: coarse)');
  let forceTouch = false;
  try { forceTouch = new URLSearchParams(location.search).get('landscape') === '1'; } catch { /* no location */ }

  const readLandscape = () => {
    const land = landscapeQ ? landscapeQ.matches : innerWidth > innerHeight;
    const touch = forceTouch || (touchQ ? touchQ.matches : 'ontouchstart' in window);
    return land && touch;
  };

  /** @type {import('../contracts.js').Lifecycle} */
  const state = { hidden: document.visibilityState === 'hidden', landscape: readLandscape() };

  const hide = () => {
    if (state.hidden) return;
    state.hidden = true;
    handlers.onHide();
  };
  const show = () => {
    if (!state.hidden) return;
    state.hidden = false;
    handlers.onShow();
  };
  const orient = () => {
    const l = readLandscape();
    if (l === state.landscape) return;
    state.landscape = l;
    handlers.onOrientation(l);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hide(); else show();
  });
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted || state.hidden) { state.hidden = true; show(); }
  });
  onChange(landscapeQ, orient);
  onChange(touchQ, orient);
  window.addEventListener('resize', orient);
  window.addEventListener('orientationchange', orient);

  if (state.landscape) queueMicrotask(() => { if (state.landscape) handlers.onOrientation(true); });
  return state;
}
