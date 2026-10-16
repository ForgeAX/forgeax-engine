async page => {
  const run = await page.evaluate(() => new URL(location.href).searchParams.get('captureRun'));
  if (run === null || !/^[a-z0-9-]+$/.test(run)) throw new Error('A unique captureRun is required');
  const count = await page.evaluate(() => Number(new URL(location.href).searchParams.get('captureCount') ?? 8));
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('captureCount must be 1..8');
  const motion = await page.evaluate(() => {
    const query = new URL(location.href).searchParams;
    return { step: Number(query.get('captureCameraStep') ?? 0),
      objectStep: Number(query.get('captureObjectStep') ?? 0),
      frames: Number(query.get('captureMoveFrames') ?? 5) };
  });
  if (!Number.isFinite(motion.step) || Math.abs(motion.step) > 0.1 ||
      !Number.isFinite(motion.objectStep) || Math.abs(motion.objectStep) > 0.1 ||
      !Number.isInteger(motion.frames) || motion.frames < 1 || motion.frames > 7) {
    throw new Error('Camera/object steps must be within [-0.1, 0.1] and move frames within [1, 7]');
  }
  const errors = [];
  const onConsole = message => {
    const text = message.text();
    if (message.type() === 'error' || (message.type() === 'warning' && /WebGPU|Invalid (?:ComputePipeline|RenderPipeline|CommandBuffer)|validation/i.test(text))) errors.push(text);
  };
  const onPageError = error => errors.push(String(error));
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  let paused = false;
  const artifacts = [];
  try {
    await page.evaluate(() => {
    const inspection = globalThis.__inspectSsr();
    const temporal = inspection.temporal;
    if (!temporal.historyValid || temporal.frameIndex < 64) throw new Error('Capture requires settled temporal history');
    if (inspection.ssr.status === 'admitted' && inspection.ssrDependencies.reflectionFallback.state !== 'active') throw new Error('Wait for the fixture Skylight publication before measuring convergence');
    globalThis.__setSsrEvidencePaused(true);
    });
    paused = true;
    for (let index = 0; index < count; index++) {
      const cameraOffset = Math.min(index, motion.frames) * motion.step;
      if (motion.step !== 0) await page.evaluate(offset => globalThis.__setSsrCameraOffset(offset), cameraOffset);
      const objectOffset = Math.min(index, motion.frames) * motion.objectStep;
      if (motion.objectStep !== 0) await page.evaluate(offset => globalThis.__setSsrObjectOffset(offset), objectOffset);
      const pending = page.waitForEvent('download');
      const receipt = await page.evaluate(async () => {
        const before = globalThis.__inspectSsr().temporal;
        const capture = await globalThis.__forgeax.captureFrame();
        if (!capture.ok) throw new Error(JSON.stringify(capture.error));
        // A binary POST is mirrored into the automation protocol and can
        // exceed Node's string limit. Download the canonical bytes directly.
        const url = URL.createObjectURL(new Blob([capture.value.bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'frame.rhitape';
        link.click();
        return { digest: capture.value.digest, url, before, after: globalThis.__inspectSsr().temporal };
      });
      const download = await pending;
      const path = `apps/hello/ssr/.forgeax-debug/${run}-${index}/frame.rhitape`;
      await download.saveAs(path);
      await page.evaluate(url => URL.revokeObjectURL(url), receipt.url);
      artifacts.push({ path, digest: receipt.digest,
        ...(motion.step === 0 ? {} : { cameraOffset }),
        ...(motion.objectStep === 0 ? {} : { objectOffset }),
        continuous: receipt.after.frameIndex === receipt.before.frameIndex + 1, before: receipt.before, after: receipt.after });
      if (errors.length) throw new Error(`Invalid runtime capture: ${JSON.stringify(errors)}`);
      if (!artifacts.at(-1).continuous) throw new Error('A history reset interrupted the requested stable cycle');
    }
    return artifacts;
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    if (paused) await page.evaluate(moving => {
      if (moving.step !== 0) globalThis.__setSsrCameraOffset(0);
      if (moving.objectStep !== 0) globalThis.__setSsrObjectOffset(0);
      globalThis.__setSsrEvidencePaused(false);
    }, motion);
  }
}
