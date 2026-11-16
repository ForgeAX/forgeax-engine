import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const cloudRead = 'vc-ue5.cloud';
const groundRead = 'vc-ue5.ground';

async function recordRenderer(play, directory, checkpoint) {
  const renderer = await play.page.evaluate(() => {
    const snapshot = globalThis.__forgeaxGameInspection.renderer();
    const errorChain = [];
    for (let error = snapshot.lastError, depth = 0; error && depth < 8; error = error.detail?.cause, depth += 1) {
      errorChain.push({
        code: error.code,
        message: error.message,
        expected: error.expected,
        hint: error.hint,
        detail: error.detail ? { ...error.detail, cause: undefined } : undefined,
      });
    }
    return { frame: snapshot.frame, rendererError: snapshot.rendererError, errorChain };
  });
  await writeFile(resolve(directory, `${checkpoint}-renderer.json`), JSON.stringify(renderer, null, 2));
}

export default async function playthroughC(play) {
  const checkpoints = [];
  const videoDir = resolve(process.env.VC_C_VIDEO_DIR ?? '/private/tmp/vc-ue5-c-route-video');
  await play.page.locator('[data-ui-part="frame"]').filter({ hasText: /#\d+/ }).waitFor();
  const deviceAndFrames = await play.step('C actual renderer and sixty completed frames', () => play.page.evaluate(async () => {
    const roots = [document];
    for (const root of roots) for (const node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    const huds = roots.flatMap((root) => [...root.querySelectorAll('[data-ui-part="frame"]')]);
    if (huds.length !== 1) throw new Error('Expected one actual frame HUD');
    const hud = huds[0];
    const world = hud.dataset.worldIdentity;
    const generation = Number(hud.dataset.deviceGeneration);
    const canvases = roots.flatMap((root) => [...root.querySelectorAll('canvas')]).filter((canvas) => canvas.forgeaxFrameProgress?.completed?.worldIdentity === world && canvas.forgeaxFrameProgress?.completed?.deviceGeneration === generation);
    if (!world || canvases.length !== 1 || !Number.isSafeInteger(generation)) throw new Error('Expected one completed owner canvas');
    const canvas = canvases[0];
    const owner = globalThis.__forgeaxGameInspection;
    if (typeof owner?.inspectRenderer !== 'function') throw new Error('Public Renderer inspection unavailable');
    const result = await owner.inspectRenderer();
    if (globalThis.__forgeaxGameInspection !== owner || result?.ok !== true) throw new Error('Renderer owner changed or inspection failed');
    const inspection = result.value;
    if (inspection.state !== 'alive' || inspection.deviceInfo?.adapterInfo?.isFallbackAdapter !== false || inspection.deviceInfo.deviceGeneration !== generation || inspection.frame?.deviceGeneration !== generation) throw new Error('Actual non-fallback device and epoch must be proven');
    const actualFrames = await new Promise((resolve, reject) => {
      const seen = new Set();
      const finish = (error) => { clearTimeout(timer); canvas.removeEventListener('forgeax:frame-completed', onFrame); if (error) reject(error); else resolve([...seen]); };
      const onFrame = (event) => {
        const frame = event.detail;
        const current = canvas.forgeaxFrameProgress?.completed;
        if (globalThis.__forgeaxGameInspection !== owner || hud.dataset.worldIdentity !== world || Number(hud.dataset.deviceGeneration) !== generation || current?.worldIdentity !== world || current?.deviceGeneration !== generation || frame.worldIdentity !== world || frame.deviceGeneration !== generation) { finish(new Error('Completed-frame owner changed')); return; }
        if (Number.isSafeInteger(frame.frameId)) seen.add(frame.frameId);
        if (seen.size === 60) finish();
      };
      const timer = setTimeout(() => finish(new Error(`Only ${seen.size} completed frames`)), 120000);
      canvas.addEventListener('forgeax:frame-completed', onFrame);
    });
    return { inspection, actualFrames, world, generation };
  }));
  await mkdir(videoDir, { recursive: true });
  await writeFile(resolve(videoDir, 'device-and-frames.json'), JSON.stringify(deviceAndFrames, null, 2));
  await play.page.locator('details').evaluateAll((elements) => { for (const element of elements) element.open = true; });
  await play.step('C material and instance identity', async () => {
    await play.page.locator('[data-ui-part="cloud-band"]').click();
    const narrow = await play.waitFor((state) => state.mode === 'band', { read: cloudRead });
    assert.equal(narrow.instanceGuid, null);
    assert.equal(narrow.halfWidthMeters, 800);
    assert.deepEqual(narrow.textureGuids, {});
    await recordRenderer(play, videoDir, 'band-narrow');
    await play.page.locator('[data-ui-part="cloud-band-wide"]').click();
    const wide = await play.waitFor((state) => state.mode === 'band-wide', { read: cloudRead });
    assert.equal(wide.materialGuid, narrow.materialGuid);
    assert.equal(wide.programIdentity, narrow.programIdentity);
    assert.equal(wide.halfWidthMeters, 1600);
    assert.ok(wide.instanceGuid);
    await recordRenderer(play, videoDir, 'band-wide');
    checkpoints.push({ narrow, wide });
  });
  await play.step('C independent light and shadow controls', async () => {
    await play.page.locator('[data-ui-part="sun-elevation"]').evaluate(input => { input.value = '8'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await play.waitFor(state => Math.abs(state.sunElevation - 8) < 1e-4, { read: cloudRead });
    await play.page.locator('[data-ui-part="ms-octaves"]').fill('0');
    await play.page.locator('[data-ui-part="ground-shadow"]').uncheck();
    await play.page.locator('[data-ui-part="atmosphere-shadow"]').uncheck();
    await play.page.locator('[data-ui-part="self-shadow"]').check();
    await play.page.locator('[data-ui-part="shadow-mode"]').selectOption('1');
    const before = await play.state(cloudRead);
    await play.page.locator('[data-ui-action="cloud-initialize"]').click();
    const applied = await play.waitFor((state) => state.initializationRevision === before.initializationRevision + 1, { read: cloudRead });
    assert.ok(Math.abs(applied.sunElevation - 8) < 1e-4);
    assert.equal(applied.multiScatteringOctaves, 0);
    assert.equal(applied.selfShadow, true);
    assert.equal(applied.castCloudShadows, false);
    assert.equal(applied.groundShadowEnabled, false);
    assert.equal(applied.atmosphereShadowEnabled, false);
    assert.equal(applied.effectiveSurfaceShadowStrength, 0);
    assert.equal(applied.effectiveAtmosphereShadowStrength, 0);
    assert.equal(applied.shadowMode, 1);
    checkpoints.push({ applied });
  });
  await play.step('C continuous wind, fixed ground route and explicit cut', async () => {
    const screencast = await play.page.context().newCDPSession(play.page);
    const frames = [];
    let writing = Promise.resolve();
    let captureFailure;
    const rememberFailure = (error) => { captureFailure ??= error; };
    const acknowledgments = new Set();
    const onFrame = (frame) => {
      const filename = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
      frames.push({ filename, timestamp: frame.metadata.timestamp });
      writing = writing
        .then(() => writeFile(resolve(videoDir, filename), Buffer.from(frame.data, 'base64')))
        .catch(rememberFailure);
      const ack = screencast.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
        .catch(rememberFailure)
        .finally(() => acknowledgments.delete(ack));
      acknowledgments.add(ack);
    };
    screencast.on('Page.screencastFrame', onFrame);
    try {
    await screencast.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    await play.page.locator('[data-ui-part="cloud-shape"]').click();
    await play.waitFor((state) => state.mode === 'shape', { read: cloudRead });
    const reference = await play.state(cloudRead);
    assert.equal(reference.windX, 0);
    assert.equal(reference.windY, 0);
    assert.equal(reference.windZ, 0);
    await play.page.locator('[data-ui-part="cloud-wind-x"]').fill('5');
    await play.page.locator('[data-ui-action="cloud-initialize"]').click();
    const initial = await play.waitFor((state) => state.windX === 5, { read: cloudRead });
    const beforeRoute = await play.state(groundRead);
    await play.page.locator('[data-ui-action="route"]').click();
    const routeStart = await play.waitFor((state) => state.routeTime !== null && state.routeTime > 0, { read: groundRead });
    assert.equal(routeStart.historyVersion, beforeRoute.historyVersion + 1);
    const moved = await play.waitFor((state) => state.routeTime !== null && state.routeTime >= 3, { read: groundRead });
    const wind = await play.state(cloudRead);
    assert.equal(moved.historyVersion, routeStart.historyVersion);
    assert.equal(wind.initializationRevision, initial.initializationRevision);
    assert.ok(wind.windOffsetMeters[0] > initial.windOffsetMeters[0]);
    await play.page.locator('[data-ui-action="cut"]').click();
    const cut = await play.waitFor((state) => state.routeTime === null, { read: groundRead });
    assert.equal(cut.historyVersion, moved.historyVersion + 1);
    assert.ok(Math.abs(cut.yaw - moved.yaw) > 0.5);
    checkpoints.push({ reference, initial, moved, wind, cut });
    assert.ok((await play.screenshot('c-route-cut')).rendered);
    } finally {
      await screencast.send('Page.stopScreencast').catch(rememberFailure);
      screencast.off('Page.screencastFrame', onFrame);
      await Promise.all(acknowledgments);
      await screencast.detach().catch(rememberFailure);
      await writing;
      await writeFile(resolve(videoDir, 'frames.json'), JSON.stringify(frames, null, 2)).catch(rememberFailure);
    }
    if (captureFailure !== undefined) throw captureFailure;
    assert.ok(frames.length > 2, 'Continuous route requires actual compositor frames');
    const concat = frames.map((frame, index) => `file '${frame.filename}'\nduration ${Math.max(0.001, (frames[index + 1]?.timestamp ?? frame.timestamp + 1 / 30) - frame.timestamp)}\n`).join('');
    await writeFile(resolve(videoDir, 'frames.ffconcat'), concat);
    await promisify(execFile)('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'route.mp4'], { cwd: videoDir });
    checkpoints.push({ videoDir, compositorFrames: frames.length });
  });
  await play.step('C parameter apply resets accumulated wind at the same reference time', async () => {
    const route = checkpoints.find((checkpoint) => 'reference' in checkpoint);
    assert.ok(route);
    const accumulated = await play.state(cloudRead);
    assert.ok(accumulated.windOffsetMeters[0] > route.reference.windOffsetMeters[0]);
    await play.page.locator('[data-ui-part="cloud-wind-x"]').fill('0');
    await play.page.locator('[data-ui-action="cloud-initialize"]').click();
    const reset = await play.waitFor((state) => state.initializationRevision === accumulated.initializationRevision + 1, { read: cloudRead });
    assert.equal(reset.referenceTimeSeconds, accumulated.referenceTimeSeconds);
    assert.equal(reset.windX, 0);
    assert.deepEqual(reset.windOffsetMeters, route.reference.windOffsetMeters);
    await recordRenderer(play, videoDir, 'wind-initialization');
    const evidence = { reference: route.reference, accumulated, reset };
    await writeFile(resolve(videoDir, 'wind-initialization.json'), JSON.stringify(evidence, null, 2));
    checkpoints.push(evidence);
  });
  await play.step('C odd resize and no-cloud path', async () => {
    await play.page.setViewportSize({ width: 913, height: 617 });
    await play.waitFor((state) => Math.abs(state.aspect - 913 / 617) < 1e-6, { read: groundRead });
    await play.page.locator('[data-ui-part="cloud-off"]').click();
    await play.waitFor((state) => !state.enabled, { read: cloudRead });
    try {
      assert.ok((await play.screenshot('c-odd-no-cloud')).rendered);
    } catch (error) {
      await recordRenderer(play, videoDir, 'odd-no-cloud-failed').catch((cause) => console.error('Could not retain Renderer failure details:', cause));
      throw error;
    }
    await play.page.setViewportSize({ width: 390, height: 844 });
    const overlap = await play.page.evaluate(() => {
      const host = [...document.querySelectorAll('*')].find((node) => node.shadowRoot?.querySelector('.properties'));
      const panel = host?.shadowRoot?.querySelector('.properties');
      return panel ? panel.scrollWidth > panel.clientWidth : true;
    });
    assert.equal(overlap, false);
    assert.ok((await play.screenshot('c-mobile')).rendered);
  });
  return { deviceAndFrames, evidenceScope: 'Actual device and completed events plus Demo control requests/component readback; Renderer cloud adoption/history and RHI values require separate evidence', checkpoints };
}
