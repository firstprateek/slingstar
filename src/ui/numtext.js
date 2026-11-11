// @ts-check
/**
 * Allocation-free number display. A number is shown as a fixed set of DOM Text nodes, one per
 * digit, each assigned an interned single-character string. Updating it never builds a string,
 * so the HUD and debug overlay can write every frame without feeding the garbage collector.
 * Owned by stream D.
 */

const DIGITS = Object.freeze(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const POW10 = Object.freeze([1, 10, 100, 1000, 10000]);

/**
 * @typedef {Object} NumText
 * @property {(value: number) => void} set   Non-negative; clamps to the largest displayable value.
 * @property {() => void} invalidate         Force the next set() to rewrite every node.
 */

/**
 * @param {HTMLElement} el          Container; its children are replaced.
 * @param {number} intDigits        Maximum integer digits (1..15).
 * @param {{ decimals?: number, group?: boolean }} [opts]  decimals 0..4; group = thousands commas.
 * @returns {NumText}
 */
export function createNumText(el, intDigits, opts = {}) {
  const decimals = Math.max(0, Math.min(4, opts.decimals ?? 0));
  const group = !!opts.group;
  const total = intDigits + decimals;
  const scale = POW10[decimals];
  const maxValue = (10 ** intDigits - 1) + (scale - 1) / scale;
  el.textContent = '';
  /** digit[i]: i = 0 is the least significant (last fraction digit when decimals > 0). */
  const digit = new Array(total);
  const shown = new Int8Array(total).fill(-2);   // -2 unknown, -1 empty, 0..9 digit
  const sep = new Array(group ? Math.floor((intDigits - 1) / 3) : 0);
  const sepShown = new Int8Array(sep.length).fill(-1);
  for (let i = total - 1; i >= 0; i--) {
    const intIndex = i - decimals;
    const t = document.createTextNode('');
    digit[i] = t; el.appendChild(t);
    if (group && intIndex >= 3 && intIndex % 3 === 0) {
      const s = document.createTextNode('');
      sep[intIndex / 3 - 1] = s; el.appendChild(s);
    }
    if (decimals > 0 && i === decimals) el.appendChild(document.createTextNode('.'));
  }
  let last = NaN;

  return {
    set(value) {
      if (!(value >= 0)) value = 0;
      if (value > maxValue) value = maxValue;
      let n = Math.round(value * scale);
      if (n === last) return;
      last = n;
      // Number of integer digits actually in use (at least 1).
      let intPart = Math.floor(n / scale);
      let used = 1;
      while (intPart >= 10 && used < intDigits) { intPart = Math.floor(intPart / 10); used++; }
      const lastVisible = decimals + used;   // digits [0, lastVisible) are shown
      for (let i = 0; i < total; i++) {
        const d = n % 10; n = Math.floor(n / 10);
        const want = i < lastVisible ? d : -1;
        if (shown[i] !== want) { shown[i] = want; digit[i].nodeValue = want < 0 ? '' : DIGITS[want]; }
      }
      for (let k = 0; k < sep.length; k++) {
        const want = used > (k + 1) * 3 ? 1 : 0;
        if (sepShown[k] !== want) { sepShown[k] = want; sep[k].nodeValue = want ? ',' : ''; }
      }
    },
    invalidate() { last = NaN; shown.fill(-2); sepShown.fill(-1); },
  };
}
