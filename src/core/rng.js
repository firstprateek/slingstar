// @ts-check
/**
 * mulberry32 seeded PRNG. Deterministic across platforms (32-bit integer math only).
 * @param {number} seed
 * @returns {{ next: () => number, range: (min: number, max: number) => number, int: (min: number, maxInclusive: number) => number, state: () => number, setState: (s: number) => void }}
 */
export function createRng(seed) {
  let s = seed >>> 0;
  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, maxInclusive) => min + Math.floor(next() * (maxInclusive - min + 1)),
    state: () => s,
    setState: (v) => { s = v >>> 0; },
  };
}

/** 32-bit integer hash (for seeds derived from a seed + index). */
export function hash32(x) {
  x = x >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
