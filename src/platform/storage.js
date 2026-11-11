// @ts-check
/** localStorage wrapper: JSON values, `slingstar:` prefix, every access in try/catch. Owned by stream D. */
const PREFIX = 'slingstar:';

/** @template T @param {string} key @param {T} fallback @returns {T} */
export function get(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

/** @param {string} key @param {any} value */
export function set(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode, quota */ }
}

/** @type {import('../contracts.js').Storage} */
export const storage = { get, set };
