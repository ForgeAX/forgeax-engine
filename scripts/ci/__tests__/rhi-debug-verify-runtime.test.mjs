import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeBrowserBounded,
  evaluatePixelVerdict,
  requestReplayDeviceForTape,
  runCaptureLiveUploadTransaction,
  selectCaptureWorkIndex,
  VerifyFailure,
} from '../../../apps/shared/scripts/rhi-debug-verify.mjs';

test('pixel capture selects the swapchain writer even when probe work follows it', () => {
  const model = {
    resources: [
      { resourceId: 'canvas', descriptor: { kind: 'createTexture', origin: 'swapchain' } },
      { resourceId: 'probe', descriptor: { kind: 'createTexture' } },
      {
        resourceId: 'canvas-view',
        descriptor: { kind: 'createTextureView', sourceHandleId: 'canvas' },
      },
      {
        resourceId: 'probe-view',
        descriptor: { kind: 'createTextureView', sourceHandleId: 'probe' },
      },
    ],
    works: [
      { workIndex: 0, attachments: { colorViewHandleIds: ['probe-view'] } },
      { workIndex: 1, attachments: { colorViewHandleIds: ['canvas-view'] } },
      { workIndex: 2, attachments: { colorViewHandleIds: ['canvas-view'] } },
      { workIndex: 3, attachments: { colorViewHandleIds: ['probe-view'] } },
      { workIndex: 4, attachments: { colorViewHandleIds: [] } },
    ],
  };
  assert.equal(selectCaptureWorkIndex(model, 'pixel'), 2);
  assert.equal(selectCaptureWorkIndex(model, 'structural'), 0);
  assert.equal(selectCaptureWorkIndex(model, 'pixel', 3), 3);
  assert.equal(selectCaptureWorkIndex({ ...model, resources: [] }, 'pixel'), 4);
});

test('rhi-debug verify runtime bindings expose typed failures and bounded browser cleanup', async () => {
  const cause = new Error('capture failed');
  const failure = new VerifyFailure(1, 'adapter request failed', cause);
  assert(failure instanceof Error);
  assert(failure instanceof VerifyFailure);
  assert.equal(failure.name, 'VerifyFailure');
  assert.equal(failure.code, 1);
  assert.equal(failure.message, 'adapter request failed');
  assert.equal(failure.cause, cause);

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const closeCalls = [];
  let clearCalls = 0;
  globalThis.setTimeout = (...args) => originalSetTimeout(...args);
  globalThis.clearTimeout = (timer) => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  };
  try {
    await closeBrowserBounded(
      {
        contexts: () => [
          {
            pages: () => [
              {
                close: async (options) => {
                  assert.deepEqual(options, { runBeforeUnload: false });
                  closeCalls.push('page');
                },
              },
            ],
          },
        ],
        close: async () => {
          closeCalls.push('browser');
        },
      },
      50,
    );
    assert.deepEqual(closeCalls, ['page', 'browser']);
    assert.equal(clearCalls, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('rhi-debug verify browser cleanup reports a bounded timeout and clears its timer', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCalls = 0;
  globalThis.setTimeout = (...args) => originalSetTimeout(...args);
  globalThis.clearTimeout = (timer) => {
    clearCalls += 1;
    return originalClearTimeout(timer);
  };
  try {
    await assert.rejects(
      closeBrowserBounded({ contexts: () => [], close: () => new Promise(() => {}) }, 20),
      /browser close timed out after 20ms/,
    );
    assert.equal(clearCalls, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('rhi-debug replay device request follows adapter limits without masking failures', async () => {
  const tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  };
  let requested;
  const adapter = {
    features: new Set(),
    limits: { maxUniformBufferBindingSize: 65_536, maxTextureDimension2D: 4_096 },
    requestDevice: async (descriptor) => {
      requested = descriptor;
      if (descriptor.requiredLimits.maxUniformBufferBindingSize > 65_536) {
        return { ok: false, error: { code: 'limit-exceeded' } };
      }
      return { ok: true, value: { id: 'fresh-device' } };
    },
  };
  const result = await requestReplayDeviceForTape(adapter, tape);
  assert.equal(result.ok, true);
  assert.deepEqual(requested.requiredLimits, adapter.limits);

  const expected = { ok: false, error: { code: 'limit-exceeded' } };
  const rejected = await requestReplayDeviceForTape(
    { ...adapter, requestDevice: async () => expected },
    tape,
  );
  assert.equal(rejected, expected);
});

test('rhi-debug snapshots submitted pixels before capture completion can expire the canvas', async () => {
  let canvas = 'submitted pixels';
  const events = [];
  const result = await runCaptureLiveUploadTransaction(
    { mode: 'pixel', rawTapeRoute: '/tape', tapeMime: 'application/x-test-tape' },
    {
      capture: async (onSubmitted) => {
        onSubmitted?.();
        await Promise.resolve();
        canvas = 'expired canvas';
        events.push('completed');
        return { bytes: new Uint8Array([1]) };
      },
      readLive: async () => {
        events.push('snapshot');
        return { live: canvas, dims: { width: 1, height: 1 } };
      },
      upload: async () => {
        events.push('upload');
        return { artifact: {}, runId: 'submitted-pixels' };
      },
    },
  );
  assert.equal(result.live, 'submitted pixels');
  assert.deepEqual(events, ['snapshot', 'completed', 'upload']);
});

test('rhi-debug pixel capture reads live pixels before tape upload', async () => {
  const events = [];
  let resolveLive;
  const liveStarted = new Promise((resolve) => {
    resolveLive = resolve;
  });
  const resultPromise = runCaptureLiveUploadTransaction(
    {
      mode: 'pixel',
      rawTapeRoute: '/tape',
      tapeMime: 'application/x-test-tape',
    },
    {
      prepare: async () => {
        events.push('prepare');
        return { preparationMs: 3, completedFrames: 7 };
      },
      capture: async (onSubmitted) => {
        events.push('capture');
        onSubmitted?.();
        return { bytes: new Uint8Array([1, 2, 3]) };
      },
      readLive: async () => {
        events.push('live:start');
        resolveLive();
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.push('live:end');
        return { live: 'AQI=', dims: { width: 2, height: 1 } };
      },
      upload: async () => {
        events.push('upload');
        return { artifact: { tape: 'ok' }, runId: 'test-run' };
      },
      transmissionInspection: () => ({ frames: 7 }),
    },
  );
  await liveStarted;
  assert.deepEqual(events, ['prepare', 'capture', 'live:start']);
  const result = await resultPromise;
  assert.deepEqual(events, ['prepare', 'capture', 'live:start', 'live:end', 'upload']);
  assert.deepEqual(result, {
    artifact: { tape: 'ok', runId: 'test-run' },
    live: 'AQI=',
    dims: { width: 2, height: 1 },
    preparationMs: 3,
    completedFrames: 7,
    transmissionInspection: { frames: 7 },
  });
});

test('rhi-debug producer report is snapshotted before upload and missing reports stay explicit', async () => {
  const reportHook = '__rhiDebugTestProducerReport';
  const report = { frame: 12, state: 'active' };
  globalThis[reportHook] = report;
  try {
    const result = await runCaptureLiveUploadTransaction(
      {
        mode: 'structural',
        reportHook,
        rawTapeRoute: '/tape',
        tapeMime: 'application/x-test-tape',
      },
      {
        capture: async () => ({ bytes: new Uint8Array([5]) }),
        upload: async () => {
          globalThis[reportHook] = { frame: 13, state: 'late' };
          return { artifact: {}, runId: 'report-run' };
        },
      },
    );
    assert.deepEqual(result.producerReport, report);

    delete globalThis[reportHook];
    const missing = await runCaptureLiveUploadTransaction(
      {
        mode: 'structural',
        reportHook,
        rawTapeRoute: '/tape',
        tapeMime: 'application/x-test-tape',
      },
      {
        capture: async () => ({ bytes: new Uint8Array([6]) }),
        upload: async () => ({ artifact: {}, runId: 'missing-report-run' }),
      },
    );
    assert.equal(missing.producerReport, null);
  } finally {
    delete globalThis[reportHook];
  }
});

test('rhi-debug structural capture uploads without a live readback', async () => {
  const events = [];
  const result = await runCaptureLiveUploadTransaction(
    { mode: 'structural', rawTapeRoute: '/tape', tapeMime: 'application/x-test-tape' },
    {
      prepare: async () => {
        events.push('prepare');
        return {};
      },
      capture: async (onSubmitted) => {
        events.push('capture');
        onSubmitted?.();
        return { bytes: new Uint8Array([4]) };
      },
      readLive: async () => {
        events.push('live');
        return { live: 'never', dims: { width: 1, height: 1 } };
      },
      upload: async () => {
        events.push('upload');
        return { artifact: {}, runId: 'structural-run' };
      },
    },
  );
  assert.deepEqual(events, ['prepare', 'capture', 'upload']);
  assert.equal(result.live, null);
  assert.equal(result.dims, null);
});

test('rhi-debug optional browser replay uses the captured bytes before upload', async () => {
  const events = [];
  const result = await runCaptureLiveUploadTransaction(
    {
      mode: 'pixel',
      browserReplayHook: '__replay',
      rawTapeRoute: '/tape',
      tapeMime: 'application/x-test-tape',
    },
    {
      capture: async (onSubmitted) => {
        events.push('capture');
        onSubmitted?.();
        return { bytes: new Uint8Array([1, 2, 3]) };
      },
      readLive: async () => {
        events.push('live');
        return { live: 'AQI=', dims: { width: 2, height: 1 } };
      },
      replay: async (bytes) => {
        events.push(`browser-replay:${Array.from(bytes).join(',')}`);
        return { pixels: new Uint8Array([9, 8, 7, 6]), width: 2, height: 1, workIndex: 4 };
      },
      upload: async () => {
        events.push('upload');
        return { artifact: {}, runId: 'browser-replay-run' };
      },
    },
  );
  assert.deepEqual(events, ['capture', 'live', 'browser-replay:1,2,3', 'upload']);
  assert.deepEqual(result.browserReplay, {
    pixels: 'CQgHBg==',
    dims: { width: 2, height: 1 },
    workIndex: 4,
  });
});

test('rhi-debug capture failure is fail-closed before live readback and upload', async () => {
  const events = [];
  await assert.rejects(
    runCaptureLiveUploadTransaction(
      { mode: 'pixel', rawTapeRoute: '/tape', tapeMime: 'application/x-test-tape' },
      {
        capture: async () => {
          events.push('capture');
          throw new Error('capture red');
        },
        readLive: async () => {
          events.push('live');
          return { live: '', dims: { width: 0, height: 0 } };
        },
        upload: async () => {
          events.push('upload');
          return { artifact: {}, runId: 'never' };
        },
      },
    ),
    /capture red/,
  );
  assert.deepEqual(events, ['capture']);
});

test('rhi-debug pixel verdict defaults to Node Dawn ownership', () => {
  const nodeDawn = {
    best: { delta: 0.11, name: 'identity' },
    local: { maxDelta: 0.2, coveredMean: 0.04 },
  };
  const browserFresh = {
    best: { delta: 0, name: 'identity' },
    local: { maxDelta: 0, coveredMean: 0 },
  };
  const verdict = evaluatePixelVerdict({
    nodeDawn,
    browserFresh,
    epsilon: 0.02,
    maxChannelEpsilon: 0.1,
    coveredEpsilon: 0.03,
  });
  assert.equal(verdict.owner, 'node-dawn');
  assert.equal(verdict.selected, nodeDawn);
  assert.equal(verdict.failures.length, 3);
});

test('rhi-debug browser-fresh ownership requires a successful browser replay result', () => {
  assert.throws(
    () => evaluatePixelVerdict({ owner: 'browser-fresh', nodeDawn: {} }),
    /requires a successful browser replay hook result/,
  );
});

test('rhi-debug browser-fresh ownership gates browser pixels and ignores Node numeric divergence', () => {
  const verdict = evaluatePixelVerdict({
    owner: 'browser-fresh',
    nodeDawn: {
      best: { delta: 0.11, name: 'identity' },
      local: { maxDelta: 0.2, coveredMean: 0.04 },
    },
    browserFresh: {
      best: { delta: 0, name: 'identity' },
      local: { maxDelta: 0, coveredMean: 0 },
    },
    epsilon: 0.02,
    maxChannelEpsilon: 0.1,
    coveredEpsilon: 0.03,
  });
  assert.equal(verdict.owner, 'browser-fresh');
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.nodeDawn.best.delta, 0.11);
  assert.equal(verdict.selected.best.delta, 0);
});

test('rhi-debug browser-fresh ownership fails on browser threshold divergence', () => {
  const verdict = evaluatePixelVerdict({
    owner: 'browser-fresh',
    nodeDawn: {
      best: { delta: 0, name: 'identity' },
      local: { maxDelta: 0, coveredMean: 0 },
    },
    browserFresh: {
      best: { delta: 0.03, name: 'identity' },
      local: { maxDelta: 0.11, coveredMean: 0.04 },
    },
    epsilon: 0.02,
    maxChannelEpsilon: 0.1,
    coveredEpsilon: 0.03,
  });
  assert.equal(verdict.failures.length, 3);
  assert(verdict.failures.every((failure) => failure.startsWith('browser fresh')));
});

test('rhi-debug pixel verdict exposes truthful selected and diagnostic metrics', () => {
  const nodeDawn = {
    best: { delta: 0.00009, name: 'identity' },
    local: { maxDelta: 0.22745, coveredMean: 0.00009 },
  };
  const browserFresh = {
    best: { delta: 0, name: 'identity' },
    local: { maxDelta: 0, coveredMean: 0 },
  };
  const verdict = evaluatePixelVerdict({
    owner: 'browser-fresh',
    nodeDawn,
    browserFresh,
    epsilon: 0.02,
    maxChannelEpsilon: 0.1,
    coveredEpsilon: 0.03,
  });
  assert.equal(verdict.selected, browserFresh);
  assert.equal(verdict.nodeDawn, nodeDawn);
  assert.equal(verdict.browserFresh, browserFresh);
});

test('browser tape upload keeps binary bytes out of inline protocol messages', async () => {
  const oldFetch = globalThis.fetch;
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const storage = new Uint8Array([99, 0, 127, 255, 88]);
  const capturedBytes = storage.subarray(1, 4);
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://capture.test' },
  });
  globalThis.fetch = async (url, options) => {
    assert.match(url, /^http:\/\/capture\.test\/tape\?runId=/);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/x-forgeax-rhitape');
    // Chromium serializes a TypedArray upload into Network.requestWillBeSent;
    // a Blob body retains native binary transfer without that unbounded copy.
    assert(options.body instanceof Blob);
    assert.deepEqual(new Uint8Array(await options.body.arrayBuffer()), capturedBytes);
    return Response.json({ kind: 'rhi-tape', digest: 'sha256:bytes', path: 'frame.rhitape' });
  };
  try {
    const result = await runCaptureLiveUploadTransaction(
      { mode: 'structural', rawTapeRoute: '/tape', tapeMime: 'application/x-forgeax-rhitape' },
      { capture: async () => ({ bytes: capturedBytes }) },
    );
    assert.equal(result.artifact.path, 'frame.rhitape');
    assert.equal(result.artifact.digest, 'sha256:bytes');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', oldLocation);
  }
});
