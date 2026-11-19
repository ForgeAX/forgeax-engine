import assert from 'node:assert/strict';
import { summarizeSkyGpuPassTiming } from '@forgeax/engine/render';

const read = 'vc-ue5.cloud';
const part = (play, key) => play.page.locator(`[data-ui-part="${key}"]`);
const action = (play, key) => play.page.locator(`[data-ui-action="${key}"]`);
const apply = async (play, edit, predicate) => {
  const before = await play.state(read);
  for (const [key, value] of Object.entries(edit)) {
    const control = part(play, key);
    if (typeof value === 'boolean') await control.setChecked(value);
    else await control.fill(String(value));
  }
  return play.waitFor(state => state.request?.id > (before.request?.id ?? 0) && predicate(state), { read });
};
const readyAfterCpuAck = async (play, cpu) => {
  assert.equal(cpu.request.status, 'cpu-applied');
  assert.equal(cpu.activeRequest?.id, cpu.request.id);
  assert.equal(cpu.activeRequest.requestRevision, cpu.requestRevision);
  const atAck = cpu.completed;
  assert.ok(atAck, 'The CPU acknowledgment sample needs an observed ready completion');
  // Also fence the browser directly: its report can be newer than the last host-to-source relay.
  const browserCompletion = await play.page.evaluate(expected =>
    [...document.querySelectorAll('canvas')]
      .map(canvas => canvas.forgeaxFrameProgress?.completed)
      .find(frame => frame && (frame.worldIdentity ?? null) === expected.worldIdentity &&
        frame.deviceGeneration === expected.deviceGeneration)?.frameId ?? null, atAck);
  assert.ok(Number.isSafeInteger(browserCompletion), 'The browser completion source must match the CPU sample epoch');
  const completionFence = { ...atAck, frameId: Math.max(atAck.frameId, browserCompletion) };
  // This fence waits for a later presentation before inspecting the HUD or taking screenshots.
  const next = await play.waitFor(state => state.request?.id === cpu.request.id &&
    state.completed && state.completed.worldIdentity === completionFence.worldIdentity &&
    state.completed.deviceGeneration === completionFence.deviceGeneration &&
    state.completed.frameId > completionFence.frameId, { read });
  return { completionFence, next };
};
const snapshotText = (play) => part(play, 'snapshot-json');

async function readReadyHud(play, minimum) {
  const hud = await play.page.waitForFunction(expected => {
    const frame = [...document.querySelectorAll('canvas')]
      .map(canvas => canvas.forgeaxFrameProgress?.completed)
      .find(completion => completion?.presentation === 'ready' &&
        (completion.worldIdentity ?? null) === expected.worldIdentity &&
        completion.deviceGeneration === expected.deviceGeneration &&
        completion.frameId >= expected.frameId);
    if (!frame) return null;
    const shadow = [...document.querySelectorAll('#game-ui *')]
      .map(node => node.shadowRoot)
      .find(root => root?.querySelector('[data-ui-part="fps"]'));
    const shownFrame = shadow?.querySelector('[data-ui-part="frame"]');
    const shownFps = shadow?.querySelector('[data-ui-part="fps"]')?.textContent ?? '';
    const count = Number(shownFrame?.dataset.count);
    if (shownFrame?.textContent !== `#${frame.frameId}` ||
      shownFrame.dataset.worldIdentity !== (frame.worldIdentity ?? '') ||
      Number(shownFrame.dataset.deviceGeneration) !== frame.deviceGeneration ||
      !Number.isSafeInteger(count) || count < 2 || !/^\d+\.\d$/.test(shownFps) || Number(shownFps) <= 0) return null;
    return { frameId: frame.frameId, deviceGeneration: frame.deviceGeneration,
      worldIdentity: frame.worldIdentity ?? null, count, fps: Number(shownFps), presentation: frame.presentation };
  }, minimum, { timeout: 10000 });
  try { return await hud.jsonValue(); } finally { await hud.dispose(); }
}

async function readMeasuredGpuHud(play) {
  const timing = part(play, 'render-timing');
  assert.equal(await timing.evaluate(node => node.open), true);
  await timing.locator(':scope > summary').click();
  assert.equal(await part(play, 'cpu-frame').isVisible(), false);
  assert.equal(await part(play, 'fps').isVisible(), true);
  await timing.locator(':scope > summary').click();
  await part(play, 'gpu-details').locator('summary').click({ timeout: 10000 });
  const capture = await play.page.waitForFunction(async () => {
    const state = await globalThis.__forgeaxGameInspection.read('vc-ue5.cloud');
    const source = state.gpu.sourceFrame;
    if (!source || state.gpu.frameTiming.status !== 'ready' ||
      state.gpu.completeSky.status !== 'ready' || state.gpu.cloudBudget.status !== 'ready' ||
      !(state.gpu.raw?.observation?.frame?.measuredPassCount > 0)) return null;
    const shadow = [...document.querySelectorAll('#game-ui *')].map(node => node.shadowRoot)
      .find(root => root?.querySelector('[data-ui-part="gpu"]'));
    const rows = ['gpu-frame', 'gpu-p50', 'gpu', 'cloud-budget', 'gpu-raw']
      .map(key => shadow?.querySelector(`[data-ui-part="${key}"]`));
    if (!rows.every(row => row?.dataset.frameId === String(source.frameId) &&
      row.dataset.deviceGeneration === String(source.deviceGeneration) &&
      row.dataset.worldIdentity === source.worldIdentity &&
      row.dataset.graphGeneration === String(source.graphGeneration))) return null;
    const details = shadow.querySelector('[data-ui-part="gpu-details"]');
    if (!details.open || details.hidden) return null;
    const cpu = shadow.querySelector('[data-ui-part="cpu-frame"]');
    if (cpu.dataset.status !== 'ready' || cpu.dataset.worldIdentity !== source.worldIdentity ||
      cpu.dataset.deviceGeneration !== String(source.deviceGeneration)) return null;
    const passes = [...details.querySelectorAll('li')].map(entry => ({
      index: Number(entry.dataset.passIndex), status: entry.dataset.status, text: entry.textContent,
    }));
    return { state, hud: rows.map(row => row.textContent), cpu: cpu.textContent, passes };
  }, undefined, { timeout: 10000 });
  try { return await capture.jsonValue(); } finally { await capture.dispose(); }
}

/** @param {import('@forgeax/engine/devkit').PlayContext} play */
export default async function playthroughD(play) {
  const rawRequested = process.env.VC_UE5_D_RAW_TIMINGS === '1';
  if (rawRequested) {
    await play.page.evaluate(() => {
      const url = new URL(location.href);
      url.searchParams.set('forgeax-gpu-pass-timing', '1');
      history.replaceState(history.state, '', url);
    });
    await play.reload();
  }
  await play.page.locator('.properties details').evaluateAll(items => items.forEach(item => { item.open = true; }));
  const initial = await play.waitFor(state => state.mode === 'shape' && state.completed !== null, { read });
  if (rawRequested) {
    await play.step('R6 correlate the startup snapshot with a completed cloud request', async () => {
      const ready = await play.waitFor(state => {
        const snapshot = state.snapshotHistory.entries.find(entry => entry.kind === 'initial');
        return snapshot?.frame && Object.values(state.renderer.layer ?? {}).some(({ completedAdoption }) =>
          completedAdoption?.requestRevision === state.requestRevision &&
          completedAdoption.frameId === snapshot.frame.frameId &&
          completedAdoption.worldIdentity === snapshot.frame.worldIdentity &&
          completedAdoption.deviceGeneration === snapshot.frame.deviceGeneration);
      }, { read, timeoutMs: 10000 });
      assert.equal(ready.activeRequest.action, 'initial-configuration');
      assert.deepEqual(ready.snapshotHistory.entries.find(entry => entry.kind === 'initial').config.parameters,
        initial.configuration.parameters);
    });
  }
  const samples = await play.step('R6 validate dynamic geometry, density, sun, optical, cloud shadow and trace edits', async () => {
    const samples = [];
    for (const [partName, field, value] of [
      ['cloud-thickness', 'thicknessMeters', 4200],
      ['cloud-coverage', 'coverageBias', 0.2],
      ['sun-illuminance', 'sunIlluminanceLux', 90000],
      ['phase-g', 'phaseG', 0.4],
      ['cloud-samples', 'viewSampleCountScale', 0.75],
    ]) {
      const before = await play.state(read);
      const cpu = await apply(play, { [partName]: value }, state =>
        state.request.status === 'cpu-applied' && Math.abs(state[field] - value) < 1e-6);
      assert.equal(cpu.programIdentity, before.programIdentity);
      const completed = await readyAfterCpuAck(play, cpu);
      assert.ok((await play.screenshot(`r6-${field}`)).rendered);
      samples.push({ field, before, cpu, ...completed });
    }
    const before = await play.state(read);
    const cpu = await apply(play, { 'atmosphere-shadow': !before.atmosphereShadowEnabled },
      state => state.atmosphereShadowEnabled !== before.atmosphereShadowEnabled);
    const completed = await readyAfterCpuAck(play, cpu);
    samples.push({ field: 'atmosphereShadowEnabled', before, cpu, ...completed });
    return samples;
  });
  const staticEdit = await play.step('R6 select an existing Cook variant', async () => {
    const before = await play.state(read);
    const after = await apply(play, { 'cloud-detail': !before.useDetail }, state => state.useDetail !== before.useDetail);
    assert.notEqual(after.programIdentity, before.programIdentity);
    assert.equal(after.cookIdentity, before.cookIdentity);
    assert.equal(after.authoring.selectedCookStaticValues.useDetail, after.useDetail);
    const completed = await readyAfterCpuAck(play, after);
    assert.ok((await play.screenshot('r6-cooked-variant')).rendered);
    return { before, after, ...completed };
  });
  const rejection = await play.step('R6 reject range and blank input without changing CPU state', async () => {
    const before = await play.state(read);
    const attempts = [];
    for (const value of [0, '']) {
      await part(play, 'cloud-thickness').fill(String(value));
      await play.page.locator('[data-ui-part="cloud-status"][data-state="invalid"]').waitFor();
      const after = await play.state(read);
      assert.equal(after.thicknessMeters, before.thicknessMeters);
      assert.equal(after.programIdentity, before.programIdentity);
      assert.equal(after.initializationRevision, before.initializationRevision);
      assert.equal(after.requestRevision, before.requestRevision);
      assert.deepEqual(after.activeRequest, before.activeRequest);
      assert.equal(after.request.id, before.request.id);
      assert.equal(await part(play, 'cloud-thickness').inputValue(), String(value));
      attempts.push({ value, accepted: after.thicknessMeters });
    }
    await part(play, 'cloud-thickness').fill(String(before.thicknessMeters));
    await play.waitFor(state => state.request.id > before.request.id, { read });
    return attempts;
  });
  const saved = await play.step('R6 pause the same time owner, save, inspect, reset and reload', async () => {
    await action(play, 'cloud-pause').click();
    await play.waitFor(state => state.paused === true, { read });
    const initialized = await apply(play, { 'cloud-time': 13, 'cloud-wind-x': 5 }, state =>
      state.referenceTimeSeconds === 13 && state.windX === 5);
    await readyAfterCpuAck(play, initialized);
    const still = await play.state(read);
    assert.deepEqual(still.windOffsetMeters, initialized.windOffsetMeters);
    assert.equal(still.elapsedSeconds, initialized.elapsedSeconds);
    await action(play, 'cloud-snapshot-save').click();
    const state = await play.waitFor(value => value.snapshot?.version === 1, { read });
    await play.page.waitForFunction(() => {
      const host = [...document.querySelectorAll('*')].find(item => item.shadowRoot?.querySelector('[data-ui-part="snapshot-json"]'));
      return Boolean(host?.shadowRoot.querySelector('[data-ui-part="snapshot-json"]').value);
    });
    const json = await snapshotText(play).inputValue();
    assert.deepEqual(JSON.parse(json), state.snapshot);
    assert.deepEqual((await play.state(read)).configuration, state.snapshot.config);
    assert.equal(state.requestRevision, initialized.requestRevision);
    const firstRecord = state.snapshotHistory.entries.find(entry => entry.kind === 'saved');
    assert.ok(firstRecord?.frame);
    assert.deepEqual(firstRecord.config, state.snapshot.config);
    assert.deepEqual(firstRecord.frame, state.snapshot.frame);
    assert.deepEqual(state.weatherCatalog.entries.map(({ id, version }) => [id, version]),
      [['clear', 1], ['backlit', 1], ['overcast', 1]]);
    const edited = await apply(play, { 'cloud-thickness': 5900 }, value => value.thicknessMeters === 5900);
    await readyAfterCpuAck(play, edited);
    await action(play, 'cloud-snapshot-save').click();
    const secondSave = await play.waitFor(value => value.request?.action === 'cloud-snapshot-save' &&
      value.request.id > state.request.id, { read });
    assert.equal(secondSave.requestRevision, edited.requestRevision);
    const [secondRecord, priorRecord] = secondSave.snapshotHistory.entries.filter(entry => entry.kind === 'saved');
    assert.notEqual(secondRecord.id, firstRecord.id);
    assert.deepEqual(priorRecord, firstRecord);
    assert.equal(secondRecord.config.parameters.thicknessMeters, 5900);
    await action(play, 'cloud-reset').click();
    const reset = await play.waitFor(value => value.request?.action === 'cloud-reset', { read });
    assert.equal(reset.thicknessMeters, initial.thicknessMeters);
    assert.equal(reset.programIdentity, initial.programIdentity);
    assert.equal(reset.paused, false);
    assert.deepEqual(reset.snapshot, secondSave.snapshot);
    assert.deepEqual(reset.snapshotHistory, secondSave.snapshotHistory);
    await play.page.locator('[data-ui-action="cloud-preset"][data-preset="reference"]').click();
    const reference = await play.waitFor(value => value.preset === 'reference', { read });
    assert.equal(reference.cookIdentity, initial.cookIdentity);
    await play.reload();
    await play.page.locator('.properties details').evaluateAll(items => items.forEach(item => { item.open = true; }));
    await snapshotText(play).fill(json);
    await action(play, 'cloud-snapshot-load').click();
    const reloaded = await play.waitFor(value => value.request?.action === 'cloud-snapshot-load' &&
      value.request.status === 'cpu-applied', { read });
    assert.deepEqual(reloaded.configuration, state.snapshot.config);
    assert.deepEqual(reloaded.snapshot.frame, state.snapshot.frame);
    assert.equal(reloaded.activeRequest?.id, reloaded.request.id);
    assert.ok(reloaded.snapshotHistory.entries.every(entry => entry.kind !== 'saved' && entry.id !== firstRecord.id));
    await readyAfterCpuAck(play, reloaded);
    assert.ok((await play.screenshot('r6-reloaded-snapshot')).rendered);
    return { snapshot: state.snapshot, reset: reset.request, reference: reference.request, reloaded };
  });
  const timing = await play.step('R6 match GPU HUD measurements to a completed Renderer receipt', async () => {
    const ready = await play.waitFor(value => value.completed !== null, { read });
    const hud = await readReadyHud(play, ready.completed);
    if (!rawRequested) {
      const state = await play.state(read);
      assert.equal(state.renderer.parameterAdoption, null);
      return { completion: state.completed, hud, rawRequested, renderer: state.renderer, gpu: state.gpu };
    }
    await play.waitFor(state => state.gpu.completeSky.status === 'ready' && state.gpu.cloudBudget.status === 'ready',
      { read, timeoutMs: 10000 });
    const capture = await readMeasuredGpuHud(play);
    const { state } = capture;
    assert.equal(state.renderer.parameterAdoption, null);
    const { raw, sourceFrame, completeSky, cloudBudget, frameTiming } = state.gpu;
    const { frame } = raw.observation;
    assert.equal(raw.worldIdentity, state.completed.worldIdentity);
    assert.equal(raw.deviceGeneration, state.completed.deviceGeneration);
    assert.ok(raw.frameId <= state.completed.frameId);
    assert.deepEqual(sourceFrame, {
      frameId: frame.frameId, deviceGeneration: frame.deviceGeneration, graphGeneration: frame.graphGeneration,
      worldIdentity: state.completed.worldIdentity,
    });
    assert.equal(raw.frameId, sourceFrame.frameId);
    assert.equal(raw.graphGeneration, sourceFrame.graphGeneration);
    const engine = summarizeSkyGpuPassTiming(frame);
    assert.equal(engine.completeSky.status, 'ready');
    assert.equal(engine.cloud.status, 'ready');
    assert.ok(Number.isFinite(engine.completeSky.milliseconds) && engine.completeSky.milliseconds > 0);
    assert.ok(Number.isFinite(engine.cloud.milliseconds) && engine.cloud.milliseconds > 0);
    assert.deepEqual(completeSky, engine.completeSky);
    assert.equal(cloudBudget.latestGpuMs, engine.cloud.milliseconds);
    assert.equal(cloudBudget.passCount, engine.cloud.passCount);
    assert.ok(Number.isFinite(cloudBudget.p95GpuMs) && cloudBudget.p95GpuMs > 0);
    assert.ok(cloudBudget.sampleCount >= cloudBudget.minimumSamples && cloudBudget.sampleCount <= cloudBudget.capacity);
    assert.ok(cloudBudget.firstFrameId < frame.frameId);
    assert.ok(frame.measuredPassCount > 0 && frame.measuredPassCount <= frame.executedPassCount);
    assert.ok(frame.passes.some(pass => pass.status === 'measured' && pass.durationNanoseconds > 0));
    assert.equal(frame.measuredPassCount, frame.executedPassCount);
    const begins = frame.passes.map(pass => BigInt(pass.beginningTick)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const ends = frame.passes.map(pass => BigInt(pass.endTick)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    assert.equal(frameTiming.milliseconds, Number(ends.at(-1) - begins[0]) * frame.timestampPeriodNanoseconds / 1e6);
    assert.ok(frameTiming.p50Milliseconds > 0 && frameTiming.sampleCount > 0 && frameTiming.sampleCount <= 60);
    assert.match(capture.cpu, /^\d+\.\d{2} ms · #\d+$/);
    assert.ok(Number.parseFloat(capture.cpu) > 0);
    const suffix = ` · #${frame.frameId}`;
    assert.deepEqual(capture.hud, [
      `${frameTiming.milliseconds.toFixed(2)} ms${suffix}`,
      `${frameTiming.p50Milliseconds.toFixed(2)} ms${suffix}`,
      `${completeSky.milliseconds.toFixed(2)} ms${suffix}`,
      `P95 ${cloudBudget.p95GpuMs.toFixed(2)} ms${suffix}`,
      `${frame.measuredPassCount}/${frame.executedPassCount} 个${suffix}`,
    ]);
    assert.deepEqual(capture.passes, frame.passes.map(pass => ({
      index: pass.executionIndex, status: pass.status,
      text: `${pass.passName}${pass.viewId === undefined ? '' : `（视图 ${pass.viewId}）`}：${pass.status === 'measured'
        ? `${(pass.durationNanoseconds / 1e6).toFixed(3)} ms` : '未测量'}`,
    })));
    assert.ok((await play.screenshot('r6-gpu-pass-details')).rendered);
    return { completion: state.completed, hud, gpuHud: capture.hud, rawRequested, renderer: state.renderer, gpu: state.gpu };
  });
  return { initial, samples, staticEdit, rejection, saved, timing };
}
