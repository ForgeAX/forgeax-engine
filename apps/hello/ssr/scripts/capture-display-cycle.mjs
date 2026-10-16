async page => {
  const run = await page.evaluate(() => new URL(location.href).searchParams.get('captureRun'));
  if (run === null || !/^[a-z0-9-]+$/.test(run)) throw new Error('A unique captureRun is required');
  const options = await page.evaluate(() => {
    const query = new URL(location.href).searchParams;
    return { cameraStep: Number(query.get('captureCameraStep') ?? 0), ssr: query.get('captureSsr') ?? 'on' };
  });
  if (!Number.isFinite(options.cameraStep) || Math.abs(options.cameraStep) > 0.1
      || !['on', 'off'].includes(options.ssr)) throw new Error('Invalid display journey options');
  const errors = [];
  const onError = error => errors.push(String(error));
  const onConsole = message => {
    if (message.type() === 'error' || (message.type() === 'warning' && /WebGPU|validation/i.test(message.text()))) {
      errors.push(message.text());
    }
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  let paused = false;
  let cameraMoved = false;
  let priorSsrEnabled;
  try {
    await page.waitForFunction(() => typeof globalThis.__setSsrEnabled === 'function');
    priorSsrEnabled = await page.locator('#ssr-toggle').getAttribute('aria-pressed');
    await page.evaluate(enabled => globalThis.__setSsrEnabled(enabled), options.ssr === 'on');
    await page.waitForFunction(enabled => {
      const state = globalThis.__inspectSsr?.();
      return state?.temporal.historyValid && state.temporal.frameIndex >= 128
        && (state.ssr.status === 'admitted') === enabled
        && (!enabled || state.ssrDependencies.reflectionFallback.state === 'active');
    }, options.ssr === 'on');
    const initial = await page.evaluate(() => {
      globalThis.__setSsrEvidencePaused(true);
      return globalThis.__inspectSsr().temporal;
    });
    paused = true;
    await page.waitForFunction(() => globalThis.__inspectSsrExecution().frame.inFlight === 0);
    if (!initial.historyValid) throw new Error('Display capture requires valid settled history');
    const geometry = await page.locator('#app').evaluate(canvas => {
      const bounds = canvas.getBoundingClientRect();
      const style = getComputedStyle(canvas);
      return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        intrinsic: [canvas.width, canvas.height], devicePixelRatio,
        border: [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth] };
    });
    const step = async () => {
      await page.waitForFunction(() => globalThis.__inspectSsrExecution().frame.inFlight === 0);
      const before = await page.evaluate(() => globalThis.__inspectSsr().temporal);
      const submittedBefore = await page.evaluate(() => globalThis.__inspectSsrExecution().frame);
      await page.evaluate(() => {
        globalThis.__stepSsrEvidenceFrame();
      });
      // App's submitted/completed projection is backed by FrameReceipt.
      // One animation callback does not guarantee GPU completion or credit.
      await page.waitForFunction(() => globalThis.__inspectSsrExecution().frame.inFlight === 0);
      const after = await page.evaluate(() => globalThis.__inspectSsr().temporal);
      const submittedAfter = await page.evaluate(() => globalThis.__inspectSsrExecution().frame);
      if (submittedAfter.submitted !== submittedBefore.submitted + 1
          || submittedAfter.completed !== submittedBefore.completed + 1) {
        throw new Error(`Display capture did not complete one receipt: ${JSON.stringify({ submittedBefore, submittedAfter })}`);
      }
      if (!after.historyValid || after.frameIndex !== before.frameIndex + 1
          || after.epoch !== before.epoch + 1 || after.resetReason !== undefined
          || after.viewIdentity !== before.viewIdentity || after.deviceGeneration !== before.deviceGeneration) {
        throw new Error(`Display capture lost continuity: ${JSON.stringify({ before, after })}`);
      }
      if (errors.length) throw new Error(JSON.stringify(errors));
      return { before, after, execution: { before: submittedBefore, after: submittedAfter } };
    };
    const screenshot = async name => {
      const before = await page.evaluate(() => globalThis.__inspectSsr().temporal);
      const path = `apps/hello/ssr/.forgeax-debug/${run}-${name}.png`;
      await page.locator('#app').screenshot({ path, scale: 'css' });
      const verified = await page.evaluate(() => globalThis.__inspectSsr().temporal);
      if (verified.frameIndex !== before.frameIndex) throw new Error('Renderer advanced during screenshot');
      if (errors.length) throw new Error(JSON.stringify(errors));
      return path;
    };
    const journey = [];
    if (options.cameraStep !== 0) {
      // Keep a before-interaction image and all actual receipt transitions.
      // No tape replay or TAA-only history splice substitutes for this path.
      journey.push({ stage: 'baseline', path: await screenshot('baseline'), after: initial });
      for (let index = 1; index <= 7; index++) {
        const cameraOffset = index * options.cameraStep;
        await page.evaluate(offset => globalThis.__setSsrCameraOffset(offset), cameraOffset);
        cameraMoved = true;
        const receipt = await step();
        journey.push({ stage: 'motion', cameraOffset, ...receipt,
          ...(index === 7 ? { path: await screenshot('motion-end') } : {}) });
      }
      // Initial 128 + seven moving + 160 held + nine final frames exceeds
      // the 60-submitted-frame smoke boundary even on the earliest start.
      for (let index = 1; index <= 160; index++) {
        const receipt = await step();
        journey.push({ stage: 'recovery', heldFrames: index, ...receipt,
          ...([8, 32, 64, 128].includes(index) ? { path: await screenshot(`recovery-${index}`) } : {}) });
      }
    }
    const frames = [];
    // Nine images contain all eight adjacent Halton transitions, including
    // the wrap. Eight images alone would omit one transition.
    for (let index = 0; index < 9; index++) {
      const receipt = await step();
      frames.push({ path: await screenshot(`frame-${index}`), ...receipt });
    }
    const ssr = await page.evaluate(() => globalThis.__inspectSsr().ssr);
    if (options.ssr === 'on' && ssr.status !== 'admitted') throw new Error('SSR journey was not admitted');
    if (options.ssr === 'off' && ssr.status === 'admitted') throw new Error('SSR off control still admitted');
    return { mode: 'browser-display-only', domain: 'css-composited-screenshot',
      url: page.url(), geometry, options, ssr, journey, frames, errors };
  } finally {
    page.off('pageerror', onError);
    page.off('console', onConsole);
    if (cameraMoved) await page.evaluate(() => globalThis.__setSsrCameraOffset(0));
    if (priorSsrEnabled !== undefined) await page.evaluate(enabled => globalThis.__setSsrEnabled(enabled), priorSsrEnabled === 'true');
    if (paused) await page.evaluate(() => globalThis.__setSsrEvidencePaused(false));
  }
}
