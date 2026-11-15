import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { BrowserFrameSubmitted } from '@forgeax/engine/app';
import type {
  FrameReceipt, GpuPassTimingEntry, GpuPassTimingObservation, Renderer, RendererState,
} from '@forgeax/engine/render';
import { observeCloudRenderer, type ReadyCloudFrame } from '../cloud-controls.ts';

type Observed = Awaited<ReturnType<Renderer['observe']>>;

function submitted(frameId: number, worldIdentity = 'world-a', deviceGeneration = 1): BrowserFrameSubmitted {
  const graphGeneration = 2;
  return {
    frameId, worldIdentity, deviceGeneration, graphGeneration,
    receipt: { frameId, deviceGeneration, graphGeneration, presentation: 'ready',
      completed: Promise.resolve({ ok: true } as Awaited<FrameReceipt['completed']>) },
  };
}

function completion(frame: BrowserFrameSubmitted): ReadyCloudFrame {
  return { frameId: frame.frameId, deviceGeneration: frame.deviceGeneration, worldIdentity: frame.worldIdentity! };
}

function harness() {
  let time = 0;
  let deviceGeneration = 1;
  let count = 0;
  let state: RendererState = 'alive';
  let rendererEvent: Parameters<Renderer['subscribe']>[0] | undefined;
  const invalidations: string[] = [];
  const requests = new Map<FrameReceipt, { resolve: (value: Observed) => void; reject: () => void }>();
  const renderer = {
    state: () => state,
    subscribe: (listener: Parameters<Renderer['subscribe']>[0]) => {
      rendererEvent = listener;
      return () => { rendererEvent = undefined; };
    },
    inspect: () => ({ frame: { deviceGeneration } }),
    observe: (receipt: FrameReceipt, request: { include: readonly string[] }) => {
      assert.deepEqual(request.include, ['timings']);
      count++;
      return new Promise<Observed>((resolve, reject) =>
        requests.set(receipt, { resolve, reject: () => reject(new Error('late timestamp rejection')) }));
    },
  } as unknown as Renderer;
  const evidence = observeCloudRenderer(renderer, () => time, reason => invalidations.push(reason));
  const settle = async (submission: BrowserFrameSubmitted, timing: GpuPassTimingObservation | 'reject') => {
    const request = requests.get(submission.receipt!);
    assert.ok(request);
    requests.delete(submission.receipt!);
    if (timing === 'reject') request.reject();
    else request.resolve({
      ok: true, value: { frameId: submission.frameId, deviceGeneration: submission.deviceGeneration,
        include: ['timings'], timings: timing },
    } as Observed);
    await setImmediate();
  };
  return {
    evidence, invalidations, settle, queries: () => count, tick: () => { time += 500; },
    generation: (next: number) => { deviceGeneration = next; },
    setState: (next: RendererState) => {
      const previous = state;
      state = next;
      rendererEvent?.({ kind: 'state-changed', previous, current: next });
    },
  };
}

function measured(submission: BrowserFrameSubmitted, cloudMs: number | null): GpuPassTimingObservation {
  const pass = (passName: string, end: number, executionIndex: number): GpuPassTimingEntry => ({
    passName, executionIndex, viewId: 1, passKind: 'raster', status: 'measured',
    measurementSource: 'pass-boundary', beginningTick: '0', endTick: String(end), durationNanoseconds: end * 1e6,
  });
  const passes = [pass('atmosphere-background', 1, 0)];
  if (cloudMs !== null) passes.push(pass('cloud-sampled-trace', cloudMs, 1));
  return {
    status: 'complete',
    frame: {
      schemaVersion: '1.0', frameId: submission.frameId, deviceGeneration: submission.deviceGeneration,
      graphGeneration: submission.graphGeneration!, backendKind: 'webgpu', timestampPeriodNanoseconds: 1e6,
      passCapacity: 256, executedPassCount: passes.length, measuredPassCount: passes.length,
      droppedPassCount: 0, passes, measuredPassNanoseconds: (1 + (cloudMs ?? 0)) * 1e6,
    },
  };
}

it('uses only completed distinct receipts for bounded P95 and clears the window on a cloud gap', async () => {
  const h = harness();
  for (let frameId = 1; frameId <= 66; frameId++) {
    const frame = submitted(frameId);
    h.tick();
    h.evidence.submit(frame);
    await h.settle(frame, measured(frame, frameId));
    assert.notEqual(h.evidence.read(completion(submitted(frameId - 1))).gpu.sourceFrame?.frameId, frameId);
    const { gpu } = h.evidence.read(completion(frame));
    assert.equal(gpu.sourceFrame?.frameId, frameId);
    assert.deepEqual(gpu.completeSky, { status: 'ready', milliseconds: frameId, passCount: 2 });
    assert.equal(gpu.frameTiming.milliseconds, frameId);
    assert.equal(gpu.cloudBudget.sampleCount, Math.min(frameId, 60));
    assert.equal(gpu.cloudBudget.status, frameId < 5 ? 'warming-up' : 'ready');
    const window = Math.min(frameId, 60);
    assert.equal(gpu.cloudBudget.p95GpuMs, frameId < 5 ? null : frameId - window + Math.ceil(0.95 * window));
    assert.equal(gpu.frameTiming.sampleCount, window);
    assert.equal(gpu.frameTiming.p50Milliseconds, frameId - (window - 1) / 2);
    h.tick();
    h.evidence.submit(frame);
    assert.equal(h.queries(), frameId);
    assert.equal(h.evidence.read(completion(frame)).gpu.cloudBudget.sampleCount, Math.min(frameId, 60));
  }
  const cloudOff = submitted(67);
  h.evidence.submit(cloudOff);
  await h.settle(cloudOff, measured(cloudOff, null));
  const { gpu } = h.evidence.read(completion(cloudOff));
  assert.equal(gpu.completeSky.status, 'ready');
  assert.equal(gpu.cloudBudget.status, 'unavailable');
  assert.equal(gpu.cloudBudget.p95GpuMs, null);
  assert.equal(gpu.cloudBudget.sampleCount, 0);
  assert.equal(gpu.frameTiming.milliseconds, 1);
  assert.equal(gpu.frameTiming.sampleCount, 60);
});

it('uses a complete pass envelope across gaps and rejects incomplete frame coverage', async () => {
  const h = harness();
  const submission = submitted(1);
  const observation = measured(submission, 2);
  assert.equal(observation.status, 'complete');
  const period = observation.frame.timestampPeriodNanoseconds;
  const opaque: GpuPassTimingEntry = {
    passName: 'opaque', executionIndex: 2, passKind: 'raster', status: 'measured',
    measurementSource: 'pass-boundary', beginningTick: '8', endTick: '9', durationNanoseconds: period,
  };
  h.evidence.submit(submission);
  await h.settle(submission, { ...observation, frame: {
    ...observation.frame, passes: [...observation.frame.passes, opaque],
    executedPassCount: 3, measuredPassCount: 3, measuredPassNanoseconds: 4 * period,
  } });
  assert.equal(h.evidence.read(completion(submission)).gpu.frameTiming.milliseconds, 9);

  const next = submitted(2);
  const incomplete = measured(next, 2);
  assert.equal(incomplete.status, 'complete');
  h.tick();
  h.evidence.submit(next);
  await h.settle(next, { ...incomplete, frame: { ...incomplete.frame, droppedPassCount: 1 } });
  const { gpu } = h.evidence.read(completion(next));
  assert.equal(gpu.completeSky.status, 'unavailable');
  assert.deepEqual(gpu.frameTiming, {
    status: 'unavailable', reason: 'no-complete-pass-coverage',
    milliseconds: null, p50Milliseconds: null, sampleCount: 0,
  });
});

it('fences late success and rejection from retired Worlds and device generations', async () => {
  const h = harness();
  const worldA = submitted(10);
  h.evidence.submit(worldA);
  const worldB = submitted(1, 'world-b');
  h.evidence.submit(worldB);
  assert.deepEqual(h.invalidations, ['epoch-changed']);
  await h.settle(worldA, measured(worldA, 40));
  assert.equal(h.evidence.read(completion(worldA)).gpu.sourceFrame, null);
  await h.settle(worldB, measured(worldB, 2));
  assert.equal(h.evidence.read(completion(worldB)).gpu.cloudBudget.sampleCount, 1);
  h.tick();
  const staleDevice = submitted(2, 'world-b');
  h.evidence.submit(staleDevice);
  h.generation(2);
  const currentDevice = submitted(1, 'world-b', 2);
  h.evidence.submit(currentDevice);
  assert.deepEqual(h.invalidations, ['epoch-changed', 'epoch-changed']);
  await h.settle(staleDevice, 'reject');
  assert.equal(h.evidence.read(completion(staleDevice)).gpu.sourceFrame, null);
  await h.settle(currentDevice, measured(currentDevice, 3));
  const { gpu } = h.evidence.read(completion(currentDevice));
  assert.deepEqual(gpu.sourceFrame, { ...completion(currentDevice), graphGeneration: 2 });
  assert.equal(gpu.cloudBudget.sampleCount, 1);
  assert.equal(gpu.cloudBudget.latestGpuMs, 3);
  assert.equal(gpu.cloudBudget.p95GpuMs, null);
  assert.equal(gpu.frameTiming.sampleCount, 1);
  assert.equal(gpu.frameTiming.p50Milliseconds, 3);
  h.setState('device-lost');
  assert.equal(h.invalidations.at(-1), 'renderer-not-alive');
  assert.equal(h.evidence.read(completion(currentDevice)).gpu.sourceFrame, null);
  h.setState('alive');
  h.evidence.acceptCompletedEpoch(completion(submitted(1, 'world-c')));
  assert.equal(h.invalidations.at(-1), 'epoch-changed');
});
