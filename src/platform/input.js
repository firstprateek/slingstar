// @ts-check
/**
 * One-button input (PLAN.md §6): pointer events on the canvas, Space bar and mouse for desktop.
 * Owned by stream D.
 *
 * - "Held" = at least one pointer down on the target (or Space down). Pointer ids are tracked, so
 *   multi-touch works and a second finger lifting does not release the hold.
 * - Edges (pressed / released) accumulate between samples: a tap shorter than one frame reports
 *   pressed = released = true with held = false (contracts.js SimInput).
 * - A NON-PASSIVE document touchstart listener calls preventDefault() so iOS never shows the
 *   loupe, callout or selection during long presses. Touches on `[data-ui]` elements are left
 *   alone so buttons still get their click; those elements never start a hold either.
 * - touchmove / gesture* / contextmenu / dblclick / selectstart are cancelled so nothing scrolls,
 *   zooms or selects.
 * - opts.onGesture runs inside every pointerup / touchend / keyup (the iOS audio-unlock hook),
 *   including on `[data-ui]` elements and while input is disabled.
 * - Blur, visibility hidden and pagehide drop every tracked pointer, so held can never stick.
 *
 * No allocation per event beyond what the browser hands us.
 */

const MAX_POINTERS = 10;

/** @param {EventTarget | null} t */
function isUi(t) {
  return t instanceof Element && t.closest('[data-ui]') !== null;
}

/**
 * @param {HTMLElement} target   The element whose presses count (main.js: document.body, so the whole window).
 * @param {{ onGesture?: () => void, keyboard?: boolean }} [opts]
 *   keyboard (default true): Space bar holds.
 * @returns {import('../contracts.js').InputSource & { pointerCount: number, dispose: () => void }}
 */
export function createInput(target, opts = {}) {
  const onGesture = opts.onGesture;
  const keyboard = opts.keyboard !== false;
  const ids = new Int32Array(MAX_POINTERS);
  let count = 0;
  let space = false;
  let enabled = true;
  let pressed = false;
  let released = false;

  function refresh() {
    const h = count > 0 || space;
    if (h === api.held) return;
    api.held = h;
    if (h) pressed = true; else released = true;
  }

  /** @param {number} id */
  function indexOf(id) {
    for (let i = 0; i < count; i++) if (ids[i] === id) return i;
    return -1;
  }
  /** @param {number} id @returns {boolean} whether it was tracked */
  function removePointer(id) {
    const i = indexOf(id);
    if (i < 0) return false;
    ids[i] = ids[count - 1];
    count--;
    return true;
  }
  /** Drop everything that is down. `edge`: report a release if a hold was active. */
  function dropAll(edge) {
    count = 0; space = false;
    if (edge) refresh();
    else api.held = false;
  }

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (!enabled || isUi(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (indexOf(e.pointerId) >= 0) return;
    if (count < MAX_POINTERS) ids[count++] = e.pointerId;
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
    if (e.cancelable && e.pointerType !== 'touch') e.preventDefault();   // no text selection on desktop drags
    refresh();
  }
  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    if (onGesture && e.type === 'pointerup') onGesture();
    if (removePointer(e.pointerId)) refresh();
  }
  /** Mouse released outside the window while not captured: the next move shows no buttons. @param {PointerEvent} e */
  function onPointerMove(e) {
    if (e.pointerType === 'mouse' && e.buttons === 0 && removePointer(e.pointerId)) refresh();
  }

  /**
   * Capture is also lost after a normal pointerup; only act if the pointer is somehow still
   * tracked and the browser reports no buttons for it.
   * @param {PointerEvent} e
   */
  function onLostCapture(e) {
    if (e.buttons === 0 && removePointer(e.pointerId)) refresh();
  }

  /** @param {TouchEvent} e */
  function onTouchStart(e) {
    if (!isUi(e.target) && e.cancelable) e.preventDefault();
  }
  /** @param {TouchEvent} e */
  function onTouchMove(e) {
    if (e.cancelable) e.preventDefault();
  }
  /** @param {TouchEvent} e */
  function onTouchEnd(e) {
    if (onGesture) onGesture();
    // Cancelling touchend off-UI stops the synthesised mouse events and double-tap zoom.
    if (!isUi(e.target) && e.cancelable) e.preventDefault();
  }
  /** @param {Event} e */
  function prevent(e) { if (e.cancelable) e.preventDefault(); }
  /** @param {Event} e */
  function preventOffUi(e) { if (!isUi(e.target) && e.cancelable) e.preventDefault(); }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();     // no page scroll, no button activation
    if (e.repeat || !enabled || space) return;
    space = true;
    refresh();
  }
  /** @param {KeyboardEvent} e */
  function onKeyUp(e) {
    if (onGesture) onGesture();
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();
    if (!space) return;
    space = false;
    refresh();
  }

  function onLost() { if (api.held || count) dropAll(true); }
  function onVisibility() { if (document.visibilityState === 'hidden') onLost(); }

  const nonPassive = { passive: false };
  const doc = document;
  target.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerUp, true);
  window.addEventListener('pointermove', onPointerMove, true);
  target.addEventListener('lostpointercapture', onLostCapture);
  doc.addEventListener('touchstart', onTouchStart, nonPassive);
  doc.addEventListener('touchmove', onTouchMove, nonPassive);
  doc.addEventListener('touchend', onTouchEnd, nonPassive);
  doc.addEventListener('touchcancel', onTouchMove, nonPassive);
  doc.addEventListener('gesturestart', prevent, nonPassive);
  doc.addEventListener('gesturechange', prevent, nonPassive);
  doc.addEventListener('gestureend', prevent, nonPassive);
  doc.addEventListener('contextmenu', prevent);
  doc.addEventListener('dblclick', preventOffUi, nonPassive);
  doc.addEventListener('selectstart', prevent);
  if (keyboard) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }
  window.addEventListener('blur', onLost);
  window.addEventListener('pagehide', onLost);
  doc.addEventListener('visibilitychange', onVisibility);

  const api = {
    held: false,
    pointerCount: 0,
    /** @param {import('../contracts.js').SimInput} out */
    sample(out) {
      out.held = api.held;
      out.pressedThisStep = pressed;
      out.releasedThisStep = released;
      pressed = false;
      released = false;
      api.pointerCount = count;
    },
    /** @param {boolean} on */
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) { dropAll(false); pressed = false; released = false; }
    },
    reset() {
      dropAll(false);
      pressed = false;
      released = false;
    },
    dispose() {
      target.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      doc.removeEventListener('touchstart', onTouchStart);
      doc.removeEventListener('touchmove', onTouchMove);
      doc.removeEventListener('touchend', onTouchEnd);
      doc.removeEventListener('touchcancel', onTouchMove);
      target.removeEventListener('lostpointercapture', onLostCapture);
      doc.removeEventListener('gesturestart', prevent);
      doc.removeEventListener('gesturechange', prevent);
      doc.removeEventListener('gestureend', prevent);
      doc.removeEventListener('contextmenu', prevent);
      doc.removeEventListener('dblclick', preventOffUi);
      doc.removeEventListener('selectstart', prevent);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onLost);
      window.removeEventListener('pagehide', onLost);
      doc.removeEventListener('visibilitychange', onVisibility);
    },
  };
  return api;
}
