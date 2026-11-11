import assert from 'node:assert/strict';

// A pending/navigating iframe is not ready; frame completion remains the caller's gate.
export async function assertNoRuntimeFailure(frame, label, errors, consoleErrors) {
  assert.deepEqual(consoleErrors, [], `${label} must have no browser console errors`);
  assert.deepEqual(errors, [], `${label} must have no uncaught browser errors`);
  const root = frame.locator('html');
  if (await root.isVisible()) {
    const startup = await root.evaluate(() => globalThis.__forgeaxStartup?.inspect?.());
    if (startup?.phase === 'failed' && startup.recovery !== 'retrying') {
      assert.fail(`${label} must have no retained startup failure: ${(startup.diagnostics || startup.message).slice(0, 16000)}`);
    }
    if (startup !== undefined) return;
  }
  const diagnostic = frame.locator('#forgeax-fatal');
  if (await diagnostic.isVisible()) {
    const detail = await diagnostic.textContent({ timeout: 1000 }).catch(() =>
      'Visible fatal diagnostic disappeared during document replacement');
    assert.fail(`${label} must have no visible fatal diagnostic: ${detail?.trim().slice(0, 16000)}`);
  }
}
export function assertRenderBudget(size, label, budget) {
  if (!budget) return;
  assert.ok(
    Math.max(size.width, size.height) <= Math.max(budget.width, budget.height)
      && Math.min(size.width, size.height) <= Math.min(budget.width, budget.height),
    `${label} must honor the drawing-buffer budget: ${JSON.stringify({ size, budget })}`,
  );
}
export async function assertScenePixels(page, png, label, budget) {
  const pixels = await page.evaluate(async png => {
    const image = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Uint32Array(4096);
      let minimum = 255, maximum = 0, dominant = 0;
      for (let index = 0; index < data.length; index += 4) {
        const r = data[index], g = data[index + 1], b = data[index + 2];
        minimum = Math.min(minimum, r, g, b);
        maximum = Math.max(maximum, r, g, b);
        const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        dominant = Math.max(dominant, ++colors[bucket]);
      }
      return { width: image.width, height: image.height, range: maximum - minimum,
        nonDominantRatio: 1 - dominant / (data.length / 4) };
    } finally { image.close(); }
  }, png);
  assertRenderBudget(pixels, label, budget);
  assert.ok(pixels.range >= 16 && pixels.nonDominantRatio >= 0.01,
    `${label} must show the authored multi-mesh scene, rather than a flat canvas: ${JSON.stringify(pixels)}`);
  return pixels;
}

// The header can show connection or restoration; the retained owners decide readiness.
export function nativeViewProjectReady({ projectId, targetId }) {
  const ready = globalThis.__forgeaxViewReady;
  if (ready?.error) throw new Error('The native View Host failed during activation');
  const mounted = ready?.mounted;
  const client = mounted?.frontendHost?.context?.get('viewOperationClient', false);
  const state = client?.projectSession?.getSnapshot();
  if (state?.error) throw new Error('The native View project failed during restoration');
  const target = state?.snapshot?.projectTarget;
  if (state?.snapshot?.projectPhase === 'failed' || state?.snapshot?.workspaceTargetLost)
    throw new Error('The native View project target failed or was lost');
  if (target?.targetId !== targetId)
    throw new Error('The native View project target changed during startup');
  return mounted?.transport?.connected === true && state?.busy === false &&
    state?.restoring === false && state?.error === null &&
    state.snapshot.projectPhase === 'running' &&
    state.snapshot.project?.id === projectId &&
    typeof target?.targetId === 'string' && target.targetId.length > 0 &&
    typeof target.url === 'string' && target.url.length > 0;
}

// A published target can still be starting. Cold Pack/server production belongs
// before this boundary; the browser then has its own fixed readiness budget.
export function nativeViewProjectTarget(projectId) {
  const ready = globalThis.__forgeaxViewReady;
  if (ready?.error) throw new Error('The native View Host failed during activation');
  const mounted = ready?.mounted;
  const state = mounted?.frontendHost?.context?.get('viewOperationClient', false)
    ?.projectSession?.getSnapshot();
  if (state?.error) throw new Error('The native View project failed during restoration');
  const snapshot = state?.snapshot;
  if (snapshot?.projectPhase === 'failed' || snapshot?.workspaceTargetLost)
    throw new Error('The native View project target failed or was lost');
  const target = snapshot?.projectTarget;
  return mounted?.transport?.connected === true && snapshot?.project?.id === projectId &&
    typeof target?.targetId === 'string' && target.targetId.length > 0 &&
    typeof target.url === 'string' && target.url.length > 0 ? target.targetId : false;
}

export async function waitForViewProjectReady(view, projectId, deadline,
  { startupTimeoutMs, onStage } = {}) {
  if (startupTimeoutMs !== undefined)
    assert.ok(Number.isFinite(startupTimeoutMs) && startupTimeoutMs > 0);
  const started = performance.now();
  let stage = 'project-target';
  await onStage?.({ stage, projectId, elapsedMs: 0 });
  const owner = await view.owner().elementHandle({ timeout: Math.max(1, deadline - performance.now()) });
  try {
    const frame = await owner.contentFrame();
    assert.ok(frame, 'The native View document must remain attached');
    const published = await frame.waitForFunction(nativeViewProjectTarget, projectId,
      { polling: 25, timeout: Math.max(1, deadline - performance.now()) });
    let targetId;
    try { targetId = await published.jsonValue(); }
    finally { await published.dispose(); }
    stage = 'project-startup';
    const readyDeadline = startupTimeoutMs === undefined ? deadline : performance.now() + startupTimeoutMs;
    await onStage?.({ stage, projectId, targetId, elapsedMs: performance.now() - started });
    // Never restart this deadline after detach/starting or adopt another target.
    await frame.waitForFunction(nativeViewProjectReady, { projectId, targetId },
      { polling: 25, timeout: Math.max(1, readyDeadline - performance.now()) });
    await onStage?.({ stage: 'project-ready', projectId, targetId, elapsedMs: performance.now() - started });
  } catch (error) {
    await onStage?.({ stage: `${stage}-failed`, projectId, elapsedMs: performance.now() - started });
    throw error;
  } finally { await owner.dispose(); }
}
