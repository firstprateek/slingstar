// @ts-check
/** Preallocated event queue (contracts.js EventQueue). Written by sim, drained by main.js. */

export const EVENT_CAPACITY = 128;

/** @returns {import('../contracts.js').EventQueue} */
export function createEventQueue() {
  return {
    count: 0,
    type: new Uint8Array(EVENT_CAPACITY),
    x: new Float64Array(EVENT_CAPACITY),
    y: new Float64Array(EVENT_CAPACITY),
    a: new Float64Array(EVENT_CAPACITY),
    b: new Float64Array(EVENT_CAPACITY),
  };
}

/**
 * @param {import('../contracts.js').EventQueue} q
 * @param {number} type @param {number} x @param {number} y @param {number} a @param {number} b
 */
export function pushEvent(q, type, x, y, a, b) {
  const i = q.count;
  if (i >= EVENT_CAPACITY) return;
  q.type[i] = type; q.x[i] = x; q.y[i] = y; q.a[i] = a; q.b[i] = b;
  q.count = i + 1;
}

/** @param {import('../contracts.js').EventQueue} q */
export function clearEvents(q) { q.count = 0; }
