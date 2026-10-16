async page => {
  // Passive inspection only: never pause, step, capture, or await the GPU queue.
  const errors = [];
  const onConsole = message => {
    if (message.type() === 'error' ||
        (message.type() === 'warning' && /WebGPU|validation|Invalid (?:RenderPipeline|CommandBuffer)/i.test(message.text()))) {
      errors.push(message.text());
    }
  };
  const onError = error => errors.push(String(error));
  page.on('console', onConsole);
  page.on('pageerror', onError);
  try {
    await page.waitForFunction(() => {
      const value = globalThis.__inspectSsr?.();
      return value?.ssrDependencies.reflectionFallback.state === 'active' && value.temporal.frameIndex >= 64;
    },
      undefined, { timeout: 90000 });
    const initial = await page.evaluate(() => {
      const value = globalThis.__inspectSsr();
      return { temporal: value.temporal, fallback: value.ssrDependencies.reflectionFallback };
    });
    const samples = [initial];
    for (let i = 0; i < 6; i++) {
      const frame = samples.at(-1).temporal.frameIndex;
      await page.waitForFunction(previous => {
        const current = globalThis.__inspectSsr().temporal.frameIndex;
        if (current < previous) throw new Error('Temporal frame counter reset during live observation');
        return current >= previous + 30;
      },
        frame, { timeout: 30000 });
      samples.push(await page.evaluate(() => {
        const value = globalThis.__inspectSsr();
        return { temporal: value.temporal, fallback: value.ssrDependencies.reflectionFallback };
      }));
    }
    for (const sample of samples) {
      if (!sample.temporal.historyValid || sample.fallback.state !== 'active' ||
          sample.fallback.sourceGeneration !== initial.fallback.sourceGeneration ||
          sample.fallback.projectionGeneration !== initial.fallback.projectionGeneration) {
        throw new Error(`Unstable publication: ${JSON.stringify(samples)}`);
      }
    }
    if (errors.length) throw new Error(JSON.stringify(errors));
    return { mode: 'uninterrupted-live-inspection', samples, errors };
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onError);
  }
}
