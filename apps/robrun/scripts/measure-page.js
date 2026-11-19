async page => {
  const config = __CONFIG__;
  const errors = [], consoleErrors = [], failedRequests = [];
  const onError = error => errors.push(String(error));
  const onConsole = event => { if (event.type() === 'error') consoleErrors.push(event.text().slice(0, 2000)); };
  const onRequest = request => failedRequests.push({ url: request.url(), failure: request.failure() });
  page.on('pageerror', onError); page.on('console', onConsole); page.on('requestfailed', onRequest);
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.addInitScript(() => { performance.setResourceTimingBufferSize(12000); });
  const navigationAt = Date.now();
  try {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__looty?.ready || window.__looty?.errors?.length, undefined, { timeout: 180000 });
    const initial = await page.evaluate(() => ({ ready: window.__looty.ready, errors: window.__looty.errors }));
    if (!initial.ready || initial.errors.length) throw new Error(JSON.stringify(initial));
    const firstReadyMs = Date.now() - navigationAt;
    // Hide both marker implementations in this matched rendering workload.
    await page.keyboard.press('KeyN');
    await page.waitForFunction(() => window.__looty.stats().pending === 0 || window.__looty.errors.length, undefined, { timeout: 120000 });
    await page.evaluate(() => {
      const d = window.__looty;
      d.teleport(30, 50, -40); d.player.fly = true;
      d.view.yaw = 0.6; d.view.pitch = 0.25; d.view.dist = d.view.cur = 7;
      window.__robrunMeasure = { enabled: false, draws: [], ready: [], intervals: [], positions: [], longTasks: [] };
      const m = window.__robrunMeasure;
      const target = d.native ? d.native.app.renderer : d.renderer;
      const method = d.native ? 'draw' : 'render';
      const original = target[method].bind(target);
      target[method] = (...args) => { const at = performance.now(); const result = original(...args); if (m.enabled) m.draws.push(performance.now() - at); return result; };
      d.native?.domElement.addEventListener('forgeax:frame-completed', event => { if (m.enabled && event.detail.presentation === 'ready') m.ready.push(performance.now()); });
      try { new PerformanceObserver(list => { if (m.enabled) for (const entry of list.getEntries()) m.longTasks.push({ at: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: false }); } catch {}
      let previous;
      function sample(at) {
        if (m.enabled) {
          if (previous !== undefined) m.intervals.push(at - previous);
          previous = at;
          m.positions.push({ at, position: Array.from(d.player.pos) });
        } else previous = undefined;
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    if (config.warmMotion) {
      try {
        await page.keyboard.down('ShiftLeft');
        for (let i = 0; i < config.roundTrips; i++) {
          await page.keyboard.down('KeyW'); await page.waitForTimeout(3000); await page.keyboard.up('KeyW');
          await page.keyboard.down('KeyS'); await page.waitForTimeout(3000); await page.keyboard.up('KeyS');
        }
      } finally { for (const key of ['KeyW', 'KeyS', 'ShiftLeft']) await page.keyboard.up(key); }
      await page.evaluate(() => {
        const d = window.__looty;
        d.teleport(30, 50, -40); d.player.fly = true;
        d.view.yaw = 0.6; d.view.pitch = 0.25; d.view.dist = d.view.cur = 7;
      });
    }
    // Warm at the measurement pose after texture demand settles.
    await page.waitForTimeout(5000);
    await page.waitForFunction(() => window.__looty.stats().pending === 0 && (!window.__looty.native || window.__looty.native.stats().completed >= 60), undefined, { timeout: 120000 });
    const windows = [];
    const start = async name => page.evaluate(name => {
      const m = window.__robrunMeasure;
      for (const field of ['draws', 'ready', 'intervals', 'positions', 'longTasks']) m[field] = [];
      m.enabled = true; m.name = name; m.startedAt = performance.now();
    }, name);
    const finish = async () => page.evaluate(() => {
      const m = window.__robrunMeasure; m.enabled = false;
      const d = window.__looty;
      return { ...m, elapsedMs: performance.now() - m.startedAt, stats: d.stats(), errors: d.errors.slice(),
        completedTotal: d.native?.stats().completed, cpuUpdateSamples: d.native?.stats().cpuFrames.slice(-m.draws.length),
        heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null };
    });
    await start('stationary'); await page.waitForTimeout(config.staticMs); windows.push(await finish());
    await page.screenshot({ path: config.screenshot });
    await start('forward-return-flight');
    try {
      await page.keyboard.down('ShiftLeft');
      for (let i = 0; i < config.roundTrips; i++) {
        await page.keyboard.down('KeyW'); await page.waitForTimeout(3000); await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyS'); await page.waitForTimeout(3000); await page.keyboard.up('KeyS');
      }
    } finally { for (const key of ['KeyW', 'KeyS', 'ShiftLeft']) await page.keyboard.up(key); }
    windows.push(await finish());
    const metrics = await cdp.send('Performance.getMetrics');
    const details = await page.evaluate(async () => {
      const d = window.__looty;
      const adapter = await navigator.gpu?.requestAdapter();
      return { title: document.title, userAgent: navigator.userAgent, dpr: devicePixelRatio,
        canvas: { width: document.querySelector('canvas').width, height: document.querySelector('canvas').height },
        adapter: adapter ? { ...adapter.info, vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null,
        nativeRenderer: d.native?.inspect(), assetRepairs: d.assetRepairs, resources: performance.getEntriesByType('resource').map(e => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, duration: e.duration })),
      };
    });
    return { config, firstReadyMs, windows, details, metrics: metrics.metrics, errors, consoleErrors, failedRequests };
  } catch (error) {
    await page.screenshot({ path: config.screenshot.replace('.png', '-failed.png') });
    return { config, failed: String(error), errors, consoleErrors, failedRequests,
      state: await page.evaluate(() => ({ ready: window.__looty?.ready, errors: window.__looty?.errors, stage: document.querySelector('#stage')?.textContent })) };
  } finally {
    page.off('pageerror', onError); page.off('console', onConsole); page.off('requestfailed', onRequest);
    await cdp.detach();
  }
}
