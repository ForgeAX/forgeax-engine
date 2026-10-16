async page => {
  // Run with the visual wrapper's run-code --filename on the fixture URL.
  // Pause before the first frame; App's receipt-backed driver observes every
  // submission, including the asynchronous Skylight -> probe publication.
  const url = page.url();
  const run = await page.evaluate(() => new URL(location.href).searchParams.get('captureRun'));
  if (run === null || !/^[a-z0-9-]+$/.test(run)) throw new Error('A unique captureRun is required');
  const errors = [];
  const navigations = [];
  const onError = error => errors.push(String(error));
  const onConsole = message => {
    if (message.type() === 'error' ||
        (message.type() === 'warning' && /WebGPU|validation/i.test(message.text()))) errors.push(message.text());
  };
  const onNavigation = frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('framenavigated', onNavigation);
  await page.addInitScript(() => {
    const pause = () => {
      if (typeof globalThis.__setSsrEvidencePaused !== 'function') return requestAnimationFrame(pause);
      globalThis.__setSsrEvidencePaused(true);
      globalThis.__startupPaused = true;
    };
    requestAnimationFrame(pause);
  });
  const samples = [];
  const pictures = [];
  try {
    await page.goto(url);
    await page.waitForFunction(() => globalThis.__startupPaused === true);
    await page.waitForFunction(() => globalThis.__inspectSsrExecution().frame.inFlight === 0);
    let admitted = false;
    let sawSkylight = false;
    let sawProbe = false;
    for (let index = 0; index < 60; index++) {
      const before = await page.evaluate(() => globalThis.__inspectSsrExecution().frame);
      if (index === 0 && (before.submitted !== 0 || before.completed !== 0)) {
        throw new Error('Startup gate must precede every scene submit');
      }
      await page.evaluate(() => globalThis.__stepSsrEvidenceFrame());
      await page.waitForFunction(() => globalThis.__inspectSsrExecution().frame.inFlight === 0);
      const sample = await page.evaluate(() => {
        const a = globalThis.__inspectSsr();
        const b = globalThis.__inspectSsr();
        return { frame: a.frame, execution: globalThis.__inspectSsrExecution().frame,
          status: a.ssr.status, failure: a.ssrDependencies.failure,
          fallback: a.ssr.fallbackSource, history: a.ssr.history,
          temporal: a.temporal, repeatedTemporal: b.temporal,
          passes: a.perFramePassNames, probe: {
            facts: a.reflectionProbes.factCount,
            active: a.reflectionProbes.activeCount,
            filtered: a.reflectionProbes.filteredStepsCompleted,
            receiverRows: a.reflectionProbes.reflectionFallbacks.filter(row => row.source === 'probe').length,
          } };
      });
      samples.push(sample);
      if (index === 0 && (sample.status !== 'admitted' || !sample.passes.includes('ssr-trace') || !sample.passes.includes('ssr-compose'))) {
        errors.push('The first submitted frame has no spatial SSR');
      }
      if (sample.execution.completed !== before.completed + 1 || sample.execution.submitted !== before.submitted + 1) {
        errors.push(`Frame ${sample.frame.frameId}: not exactly one completed submit`);
      }
      if (JSON.stringify(sample.temporal) !== JSON.stringify(sample.repeatedTemporal)) errors.push('Inspection changed temporal state');
      const wasAdmitted = admitted;
      admitted ||= sample.status === 'admitted';
      sawSkylight ||= sample.status === 'admitted' && sample.fallback === 'skylight';
      sawProbe ||= sample.status === 'admitted' && sample.probe.receiverRows > 0;
      if (wasAdmitted && (sample.status !== 'admitted' || !sample.passes.includes('ssr-trace') || !sample.passes.includes('ssr-compose'))) {
        errors.push(`Frame ${sample.frame.frameId}: SSR disappeared after admission (${sample.failure?.code})`);
      }
      const previous = samples.at(-2);
      // Rows commit at submit completion; the preferred receipt is consumed
      // on the next draw. Its real source change may invalidate old lighting.
      if (previous?.probe.receiverRows > 0 && sample.probe.receiverRows === previous.probe.receiverRows
          && sample.fallback === previous.fallback && sample.temporal.mode === 'taa') {
        if (!sample.temporal.historyValid || sample.temporal.frameIndex !== previous.temporal.frameIndex + 1) {
          errors.push(`Frame ${sample.frame.frameId}: static TAA history restarted after probe publication`);
        }
      }
      if (index === 0 || sample.status !== previous.status || sample.fallback !== previous.fallback || sample.probe.receiverRows !== previous.probe.receiverRows) {
        const path = `apps/hello/ssr/.forgeax-debug/${run}-frame-${sample.frame.frameId}.png`;
        await page.locator('#app').screenshot({ path, scale: 'css' });
        pictures.push({ path, frame: sample.frame.frameId, status: sample.status, fallback: sample.fallback });
      }
    }
    if (!sawSkylight) errors.push('Did not exercise admitted Skylight fallback');
    if (samples.some(sample => sample.probe.facts > 0) && !sawProbe) {
      errors.push('Authored probe never reached admitted fallback');
    }
    if (navigations.length !== 1) errors.push(`Unexpected navigation count: ${navigations.length}`);
    const finalPath = `apps/hello/ssr/.forgeax-debug/${run}-final.png`;
    await page.locator('#app').screenshot({ path: finalPath, scale: 'css' });
    pictures.push({ path: finalPath, frame: samples.at(-1).frame.frameId,
      status: samples.at(-1).status, fallback: samples.at(-1).fallback });
    const result = { status: errors.length === 0 ? 'PASS' : 'FAIL', url,
      frames: samples.length, errors, navigations, pictures,
      transitions: samples.filter((x, i, a) => i === 0 || x.status !== a[i-1].status || x.fallback !== a[i-1].fallback || x.probe.receiverRows !== a[i-1].probe.receiverRows),
      final: samples.at(-1) };
    return result;
  } finally {
    page.off('pageerror', onError);
    page.off('console', onConsole);
    page.off('framenavigated', onNavigation);
    await page.evaluate(() => globalThis.__setSsrEvidencePaused?.(false));
  }
}
