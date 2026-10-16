async page => {
  const run = await page.evaluate(() => new URL(location.href).searchParams.get('captureRun'));
  if (!run || !/^[a-z0-9-]+$/.test(run)) throw new Error('captureRun required');
  await page.addInitScript(() => {
    const pause = () => {
      if (typeof globalThis.__setSsrEvidencePaused !== 'function') return requestAnimationFrame(pause);
      globalThis.__setSsrEvidencePaused(true);
      globalThis.__startupPaused = true;
    };
    requestAnimationFrame(pause);
  });
  await page.reload();
  await page.waitForFunction(() => globalThis.__startupPaused === true);
  const before = await page.evaluate(() => globalThis.__inspectSsrExecution().frame);
  if (before.submitted !== 0 || before.inFlight !== 0) throw new Error('Capture must precede every scene submit');
  try {
    const pending = page.waitForEvent('download');
    const result = await page.evaluate(async () => {
      const captured = await globalThis.__forgeax.captureFrame();
      if (!captured.ok) throw new Error(JSON.stringify(captured.error));
      const url = URL.createObjectURL(new Blob([captured.value.bytes], { type: 'application/octet-stream' }));
      const a = document.createElement('a'); a.href = url; a.download = 'frame.rhitape'; a.click();
      const v = globalThis.__inspectSsr();
      return { digest: captured.value.digest, url, frame: v.frame, ssr: v.ssr,
        temporal: v.temporal, execution: globalThis.__inspectSsrExecution().frame, passes: v.perFramePassNames };
    });
    const path = `apps/hello/ssr/.forgeax-debug/${run}/frame.rhitape`;
    await (await pending).saveAs(path);
    await page.evaluate(url => URL.revokeObjectURL(url), result.url);
    await page.waitForFunction(() => globalThis.__inspectSsrExecution().frame.inFlight === 0);
    result.execution = await page.evaluate(() => globalThis.__inspectSsrExecution().frame);
    if (result.execution.submitted !== 1 || result.execution.completed !== 1) throw new Error(`Capture did not execute exactly the first frame: ${JSON.stringify(result)}`);
    const screenshot = `apps/hello/ssr/.forgeax-debug/${run}-first-captured.png`;
    await page.locator('#app').screenshot({ path: screenshot, scale: 'css' });
    return { before, ...result, path, screenshot };
  } finally {
    await page.evaluate(() => globalThis.__setSsrEvidencePaused(false));
  }
}
