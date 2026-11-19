async page => {
  const config = __CONFIG__;
  const errors = [];
  const onError = error => errors.push(String(error));
  page.on('pageerror', onError);
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__looty?.ready || window.__looty?.errors.length, undefined, { timeout: 120000 });
    const state = await page.evaluate(() => ({ native: !!window.__looty.native, errors: window.__looty.errors }));
    if (!state.native || state.errors.length) throw new Error(JSON.stringify(state));
    await page.keyboard.press('KeyN');
    await page.evaluate(() => {
      const d = window.__looty;
      d.teleport(30, 50, -40); d.player.fly = true;
      d.view.yaw = 0.6; d.view.pitch = 0.25; d.view.dist = d.view.cur = 7;
    });
    await page.waitForTimeout(5000);
    await page.waitForFunction(() => window.__looty.stats().pending === 0 && window.__looty.native.stats().completed >= 60, undefined, { timeout: 120000 });
    const states = [];
    const snapshot = async phase => states.push(await page.evaluate(phase => ({
      phase, stats: window.__looty.stats(), inspect: window.__looty.native.inspect().renderScene,
    }), phase));
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await snapshot('static-start');
    await cdp.send('Profiler.start');
    await page.waitForTimeout(config.staticMs);
    const staticProfile = await cdp.send('Profiler.stop');
    await snapshot('static-end');
    await page.screenshot({ path: config.screenshot });
    await cdp.send('Profiler.start');
    try {
      await page.keyboard.down('ShiftLeft');
      for (let i = 0; i < config.roundTrips; i++) {
        await page.keyboard.down('KeyW'); await page.waitForTimeout(3000); await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyS'); await page.waitForTimeout(3000); await page.keyboard.up('KeyS');
      }
    } finally { for (const key of ['KeyW', 'KeyS', 'ShiftLeft']) await page.keyboard.up(key); }
    const movingProfile = await cdp.send('Profiler.stop');
    await snapshot('moving-end');
    await page.waitForFunction(() => window.__looty.stats().pending === 0, undefined, { timeout: 90000 });
    const gpu = await page.evaluate(() => new Promise(resolve => {
      const d = window.__looty, observations = [];
      let pending = false, ticks = 0, ended = false, completeCount = 0;
      let unsubscribe;
      const finish = timeout => {
        if (ended) return;
        ended = true; unsubscribe?.(); clearTimeout(timer);
        resolve({ observations, ticks, completeCount, timeout });
      };
      const timer = setTimeout(() => finish(true), 15000);
      unsubscribe = d.native.app.renderer.subscribe(async event => {
        if (ended || event.kind !== 'frame-submitted' || event.receipt.presentation !== 'ready') return;
        ticks++;
        if (pending) return;
        pending = true;
        try {
          const observed = await d.native.app.renderer.observe(event.receipt, { include: ['timings'] });
          observations.push(observed);
          if (observed.ok && observed.value.timings?.status === 'complete') completeCount++;
        } catch (error) { observations.push({ failed: String(error) }); }
        pending = false;
        if (completeCount >= 12 || observations.length >= 48) finish(false);
      });
    }));
    const runtimeErrors = await page.evaluate(() => window.__looty.errors.slice());
    const failed = errors.length || runtimeErrors.length ? 'Runtime errors during profiling'
      : gpu.completeCount < 12 ? 'Fewer than 12 complete GPU timing observations' : undefined;
    return { config, staticProfile, movingProfile, states, gpu, errors, runtimeErrors, failed };
  } catch (error) { return { config, failed: String(error), errors }; }
  finally { page.off('pageerror', onError); await cdp.detach(); }
}
