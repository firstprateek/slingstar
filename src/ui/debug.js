// @ts-check
/**
 * ?debug=1 overlay (PLAN.md §8): frame ms, sim ms, draw ms, draw calls, live particles, render
 * scale. update() is called every frame; it only accumulates, and writes the DOM about 4 times a
 * second through allocation-free digit nodes. Owned by stream D.
 */
import { CONFIG } from '../config.js';
import { createNumText } from './numtext.js';

const INTERVAL_MS = 250;

/** @param {HTMLElement} root @returns {import('../contracts.js').DebugOverlay} */
export function createDebug(root) {
  root.textContent = '';
  root.hidden = false;

  /** @param {string} label @returns {HTMLElement} */
  const line = (label) => {
    const l = document.createElement('div');
    l.appendChild(document.createTextNode(label));
    root.appendChild(l);
    return l;
  };
  /** @param {HTMLElement} l @param {string} text */
  const txt = (l, text) => { l.appendChild(document.createTextNode(text)); };
  /** @param {HTMLElement} l @param {number} digits @param {number} decimals */
  const num = (l, digits, decimals) => {
    const s = document.createElement('span');
    l.appendChild(s);
    return createNumText(s, digits, { decimals });
  };

  const lFrame = line('frame ');
  const frameAvg = num(lFrame, 3, 1); txt(lFrame, ' ms  max ');
  const frameMax = num(lFrame, 3, 1); txt(lFrame, '  fps ');
  const fps = num(lFrame, 3, 0);
  const lSim = line('sim   ');
  const simAvg = num(lSim, 3, 2); txt(lSim, ' ms  draw ');
  const drawMs = num(lSim, 3, 2); txt(lSim, ' ms');
  const lDraws = line('calls ');
  const draws = num(lDraws, 3, 0); txt(lDraws, '  particles ');
  const particles = num(lDraws, 5, 0);
  const lScale = line('scale ');
  const scale = num(lScale, 1, 2); txt(lScale, '  ');
  const width = num(lScale, 4, 0); txt(lScale, '×');
  const height = num(lScale, 4, 0);

  let n = 0, frameSum = 0, frameHi = 0, simSum = 0, drawSum = 0;
  let lastWrite = 0;
  let frameWarn = false, drawWarn = false;

  return {
    update(frameMs, simMs, stats) {
      n++;
      frameSum += frameMs;
      if (frameMs > frameHi) frameHi = frameMs;
      simSum += simMs;
      drawSum += stats ? stats.cpuMs : 0;
      const now = performance.now();
      if (now - lastWrite < INTERVAL_MS) return;
      lastWrite = now;
      const avg = frameSum / n;
      frameAvg.set(avg);
      frameMax.set(frameHi);
      fps.set(avg > 0 ? 1000 / avg : 0);
      simAvg.set(simSum / n);
      drawMs.set(drawSum / n);
      const fw = avg > CONFIG.SLOW_FRAME_MS;
      if (fw !== frameWarn) { frameWarn = fw; lFrame.classList.toggle('warn', fw); }
      if (stats) {
        draws.set(stats.drawCalls);
        particles.set(stats.particles);
        scale.set(stats.renderScale);
        width.set(stats.width);
        height.set(stats.height);
        const dw = stats.drawCalls >= CONFIG.MAX_DRAW_CALLS;
        if (dw !== drawWarn) { drawWarn = dw; lDraws.classList.toggle('warn', dw); }
      }
      n = 0; frameSum = 0; frameHi = 0; simSum = 0; drawSum = 0;
    },
  };
}
