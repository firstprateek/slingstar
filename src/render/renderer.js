// @ts-check
/**
 * WebGL2 renderer (PLAN.md §4). Owned by stream B.
 * PHASE 0 STUB: creates the context and clears to the zone 1 background.
 */
import { CONFIG, ZONES } from '../config.js';
import { hexToRgb } from '../core/math.js';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ renderScale?: number, reducedMotion?: boolean, onRenderScale?: (s: number) => void }} [opts]
 * @returns {import('../contracts.js').Renderer}
 */
export function createRenderer(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance',
  });
  const bg = hexToRgb(ZONES[0].bg);
  /** @type {import('../contracts.js').RenderStats} */
  const stats = { drawCalls: 0, particles: 0, renderScale: opts.renderScale ?? 1, cpuMs: 0, width: 0, height: 0, halfFloat: false };
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR) * stats.renderScale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    stats.width = w; stats.height = h;
  }
  resize();
  return {
    gl,
    stats,
    draw() {
      if (!gl) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      stats.drawCalls = 0;
    },
    onEvent() {},
    resize,
    resetRun() {},
    setReducedMotion() {},
    setScene() {},
    isContextLost: () => !gl || gl.isContextLost(),
  };
}
