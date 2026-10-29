/* Diagnostic Mini Game bootstrap. Native callback cadence is not Engine FPS. */
(() => {
  const display = wx.getWindowInfo();
  const pixelRatio = Math.min(display.pixelRatio, 2);
  const canvas = wx.createCanvas();
  canvas.width = Math.round(display.windowWidth * pixelRatio);
  canvas.height = Math.round(display.windowHeight * pixelRatio);
  const context = canvas.getContext('2d');
  context.fillStyle = '#172236';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#f5dc82';
  context.font = `${24 * pixelRatio}px sans-serif`;
  context.fillText('Native rAF cadence diagnostic', 24 * pixelRatio, 50 * pixelRatio);
  context.fillStyle = '#ffffff';
  context.font = `${14 * pixelRatio}px sans-serif`;
  context.fillText('No Engine frames or per-frame canvas drawing', 24 * pixelRatio, 80 * pixelRatio);

  const clock = wx.getPerformance();
  const frameLimit = 600;
  let callbacks = 0;
  let sequence = 0;
  let capture;
  function state() {
    if (!capture) return { status: 'not-started', callbacks };
    const times = capture.times;
    const gaps = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
    const elapsedMs = times.length > 1 ? times[times.length - 1] - times[0] : null;
    const percentile = fraction => gaps.length ? gaps[Math.floor((gaps.length - 1) * fraction)] : null;
    return {
      status: capture.active ? 'capturing' : times.length === frameLimit ? 'complete' : 'incomplete',
      scope: 'native-callback-cadence-only', callbacks, captureId: capture.id,
      preferredFramesPerSecond: capture.preferredFramesPerSecond ?? null,
      sampleCount: times.length, frameLimit, elapsedMs,
      callbackFps: elapsedMs > 0 ? (times.length - 1) * 1000 / elapsedMs : null,
      intervalMs: { count: gaps.length, mean: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: gaps.length ? gaps[gaps.length - 1] : null },
      display: { width: display.windowWidth, height: display.windowHeight, nativePixelRatio: display.pixelRatio,
        drawingWidth: canvas.width, drawingHeight: canvas.height, pixelRatio },
    };
  }
  globalThis.__forgeaxNativeScheduler = {
    start({ preferredFramesPerSecond } = {}) {
      if (capture?.active) return { ok: false, error: 'capture-active' };
      if (preferredFramesPerSecond !== undefined) {
        if (!Number.isInteger(preferredFramesPerSecond) || preferredFramesPerSecond < 1 || preferredFramesPerSecond > 60)
          throw new RangeError('Preferred native frame rate must be an integer in 1..60');
        if (typeof wx.setPreferredFramesPerSecond !== 'function') return { ok: false, error: 'preferred-fps-unavailable' };
        wx.setPreferredFramesPerSecond(preferredFramesPerSecond);
      }
      capture = { id: ++sequence, active: true, times: [], preferredFramesPerSecond };
      return { ok: true, captureId: capture.id, frameLimit };
    },
    stop() { if (capture) capture.active = false; return state(); },
    state,
    samples() { return capture?.times.slice() ?? []; },
  };
  function tick() {
    callbacks++;
    if (capture?.active) {
      capture.times.push(clock.now());
      if (capture.times.length === frameLimit) capture.active = false;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
