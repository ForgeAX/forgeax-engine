import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEATURE_ID,
  REQUIRED_RESOLUTIONS,
  TIMING_SAMPLING,
  capabilityPreflight,
  collectRendererPassTiming,
  createTimingReport,
  nearestRankP95,
} from '../auto-exposure-gpu-pass-timing-host.mjs';
import {
  childRunReady,
  createRendererObservationQueue,
  workloadPassNames,
} from '../auto-exposure-gpu-pass-timing-producer.mjs';

const hash = (letter) => letter.repeat(64);
const revision = 'a'.repeat(40);
const source = { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') };
const build = { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') };
const fixture = {
  id: 'auto-exposure-lut-fixture',
  asset: 'asset-v1',
  camera: 'camera-v1',
  light: 'light-v1',
  input: 'input-v1',
};
const backend = {
  kind: 'webgpu',
  adapter: 'Apple M4 Pro',
  driver: 'Metal 4',
  browser: 'chrome',
  physicalGpu: true,
  timestampQuery: true,
  timestampPeriodNanoseconds: 100,
};
const context = {
  source,
  build,
  runner: { kind: 'playwright', id: 'chrome-152' },
  fixture,
  backend,
};

function ticks(offset, duration = 1000) {
  const beginTicks = Array.from({ length: TIMING_SAMPLING.framesPerWindow }, (_, index) =>
    String(offset + index * 10_000),
  );
  return {
    beginTicks,
    endTicks: beginTicks.map((value) => String(Number(value) + duration)),
  };
}

function frame(generation, firstFrame) {
  return { generation, firstFrame, lastFrame: firstFrame + TIMING_SAMPLING.framesPerWindow - 1 };
}

function workload(kind, generation, firstFrame, offset, duration = 1000) {
  const names = kind === 'auto' ? ['meter'] : ['lut'];
  return {
    frame: frame(generation, firstFrame),
    passes: names.map((passName, passIndex) => ({
      passName,
      passIdentity: `standard-output/${passName}`,
      windows: REQUIRED_RESOLUTIONS.map((resolution, resolutionIndex) => ({
        width: resolution.width,
        height: resolution.height,
        measurementSource: 'gpu-timestamp',
        captureGeneration: generation,
        firstFrame,
        lastFrame: firstFrame + TIMING_SAMPLING.framesPerWindow - 1,
        ...ticks(offset + passIndex * 4_000_000 + resolutionIndex * 1_000_000, duration),
      })),
    })),
  };
}

function validInput(overrides = {}) {
  return {
    ...context,
    frame: frame('device-3:graph-8', 120),
    workloads: {
      auto: workload('auto', 'device-3:graph-auto', 120, 100_000),
      'positive-lut': workload('positive-lut', 'device-3:graph-lut', 120, 200_000),
    },
    manual: { executed: true, zeroCost: true, timestampSlots: 0, receipt: { frameId: 179 } },
    ...overrides,
  };
}

test('nearest-rank p95 keeps the exact rank and refuses invalid values', () => {
  assert.equal(nearestRankP95([1, 2, 3, 4]), 4);
  assert.equal(nearestRankP95([1, 2, 3, 4, 5]), 5);
  assert.equal(nearestRankP95([1, Number.NaN, 3]), null);
});

test('renderer producer queue preserves receipt-bound timing frames without wall-time projection', () => {
  const first = { frameId: 1, backendKind: 'webgpu', passes: [] };
  const second = { frameId: 2, backendKind: 'webgpu', passes: [] };
  const queue = createRendererObservationQueue({ report: { frames: [first, second, { frameId: 3 }] } });
  assert.deepEqual(queue, [first, second, { frameId: 3 }]);
  assert.notEqual(queue[0], undefined);
});

test('renderer producer keeps auto meter and positive-LUT timing workloads separate', () => {
  assert.deepEqual(workloadPassNames('auto'), ['meter']);
  assert.deepEqual(workloadPassNames('positive-lut'), ['lut']);
  assert.throws(() => workloadPassNames('manual'), /unsupported timing workload/);
});

test('renderer producer refuses a ready report from a non-zero child', () => {
  assert.equal(childRunReady({ report: { status: 'ready' }, exitCode: 0 }), true);
  assert.equal(childRunReady({ report: { status: 'ready' }, exitCode: 2 }), false);
  assert.equal(childRunReady({ report: { status: 'ready' }, exitCode: null }), false);
  assert.equal(childRunReady({ report: { status: 'blocked' }, exitCode: 0 }), false);
});

test('the previous split clear/histogram/adapt topology cannot qualify as meter timing', () => {
  const legacy = validInput();
  legacy.workloads.auto.passes = ['clear', 'histogram', 'adapt'].map((passName, passIndex) => ({
    passName,
    passIdentity: `standard-output/${passName}`,
    windows: REQUIRED_RESOLUTIONS.map((resolution, resolutionIndex) => ({
      width: resolution.width,
      height: resolution.height,
      measurementSource: 'gpu-timestamp',
      captureGeneration: 'device-3:graph-auto',
      firstFrame: 120,
      lastFrame: 179,
      ...ticks(600_000 + passIndex * 4_000_000 + resolutionIndex * 1_000_000),
    })),
  }));
  const report = createTimingReport(legacy);
  assert.equal(report.status, 'blocked');
  assert.ok(
    report.errors.some(
      (entry) => entry.code === 'pass-invalid' && entry.path.includes('/auto/'),
    ),
  );
  assert.notDeepEqual(report.timing.passes, ['clear', 'histogram', 'adapt', 'lut']);
});

test('capability preflight refuses fallback, nonphysical, and timestamp-less lanes', () => {
  assert.equal(capabilityPreflight(backend).status, 'ready');
  for (const mutation of [
    { physicalGpu: false },
    { timestampQuery: false },
    { timestampPeriodNanoseconds: 0 },
    { adapter: 'SwiftShader' },
    { adapter: 'AppleParavirtualGPU' },
  ]) {
    assert.equal(capabilityPreflight({ ...backend, ...mutation }).status, 'blocked');
  }
});

test('complete auto and positive-LUT raw windows remain observation-only candidates', () => {
  const report = createTimingReport(validInput());
  assert.equal(report.featureId, FEATURE_ID);
  assert.equal(report.status, 'observation');
  assert.equal(report.qualification.status, 'eligible-candidate');
  assert.deepEqual(report.timing.passes, ['meter', 'lut']);
  assert.deepEqual(report.timing.logicalStages, ['clear', 'histogram', 'adapt']);
  assert.deepEqual(report.workloads.auto.passNames, ['meter']);
  assert.deepEqual(report.workloads['positive-lut'].passNames, ['lut']);
  assert.deepEqual(
    [...new Set(report.timing.windows.map((window) => window.workload))],
    ['auto', 'positive-lut'],
  );
  assert.equal(report.timing.p95Ms['1080p'], 0.1);
  assert.equal(report.timing.p95Ms['4K'], 0.1);
  assert.notEqual(report.status, 'pass');
  assert.notEqual(report.verdict, 'accepted');
});

test('equal physical timestamp ticks remain raw and use a conservative window quantum bound', () => {
  const input = validInput();
  const window = input.workloads.auto.passes[0].windows[0];
  window.endTicks[7] = window.beginTicks[7];
  const report = createTimingReport(input);
  assert.equal(report.status, 'observation');
  assert.equal(report.qualification.status, 'eligible-candidate');
  assert.equal(report.workloads.auto.passes[0].windows[0].timestampQuantization.equalTickSamples, 1);
  assert.equal(
    report.workloads.auto.passes[0].windows[0].timestampQuantization.mode,
    'equal-ticks-upper-bound',
  );
  assert.equal(report.workloads.auto.passes[0].windows[0].durationsNanoseconds[7], 100_000);
  assert.equal(report.workloads.auto.passes[0].windows[0].beginTicks[7], window.beginTicks[7]);
  assert.equal(report.workloads.auto.passes[0].windows[0].endTicks[7], window.beginTicks[7]);
});

test('a window containing only equal ticks remains blocked without an observed quantum', () => {
  const input = validInput();
  for (const pass of [input.workloads.auto.passes[0], input.workloads['positive-lut'].passes[0]]) {
    for (const window of pass.windows) {
      window.endTicks = [...window.beginTicks];
    }
  }
  const report = createTimingReport(input);
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'timestamp-quantum-unavailable'));
});

test('workload boundaries reject composite passes and cross-workload sample reuse', () => {
  const positiveWithAuto = validInput();
  positiveWithAuto.workloads['positive-lut'].passes.push(
    ...workload('auto', 'device-3:graph-lut', 120, 300_000).passes,
  );
  const positiveReport = createTimingReport(positiveWithAuto);
  assert.equal(positiveReport.status, 'blocked');
  assert.ok(
    positiveReport.errors.some(
      (entry) => entry.code === 'pass-invalid' && entry.path.includes('/positive-lut/'),
    ),
  );

  const autoWithLut = validInput();
  autoWithLut.workloads.auto.passes.push(
    ...workload('positive-lut', 'device-3:graph-auto', 120, 400_000).passes,
  );
  const autoReport = createTimingReport(autoWithLut);
  assert.equal(autoReport.status, 'blocked');
  assert.ok(
    autoReport.errors.some(
      (entry) => entry.code === 'pass-invalid' && entry.path.includes('/auto/'),
    ),
  );

  const reused = validInput();
  reused.workloads['positive-lut'].passes[0].windows[0] = structuredClone(
    reused.workloads.auto.passes[0].windows[0],
  );
  const reusedReport = createTimingReport(reused);
  assert.equal(reusedReport.status, 'blocked');
  assert.ok(reusedReport.errors.some((entry) => entry.code === 'samples-reused'));
});

test('LUT P95 is reported independently and never supplies the meter budget', () => {
  const lutSlow = validInput();
  for (const pass of lutSlow.workloads['positive-lut'].passes) {
    for (const window of pass.windows) {
      window.endTicks = window.beginTicks.map((value) => String(Number(value) + 10_000_000));
    }
  }
  const report = createTimingReport(lutSlow);
  assert.equal(report.status, 'observation');
  assert.equal(report.timing.p95Ms['1080p'], 0.1);
  assert.equal(report.timing.p95Ms['4K'], 0.1);
  assert.equal(report.workloads['positive-lut'].p95Ms['1080p'], 1_000);
  assert.equal(report.workloads['positive-lut'].p95Ms['4K'], 1_000);
});

test('missing renderer capability, LUT stage, 4K, and zero-cost receipt are blocked', () => {
  const noCapability = createTimingReport(validInput({ backend: { ...backend, physicalGpu: false } }));
  assert.equal(noCapability.status, 'blocked');
  assert.ok(noCapability.errors.some((entry) => entry.code === 'timing-capability-ineligible'));

  const noLut = validInput();
  noLut.workloads['positive-lut'].passes = noLut.workloads['positive-lut'].passes.filter(
    (pass) => pass.passName !== 'lut',
  );
  const noLutReport = createTimingReport(noLut);
  assert.equal(noLutReport.status, 'blocked');
  assert.deepEqual(noLutReport.timing.passes, ['meter']);

  const no4k = validInput();
  no4k.workloads.auto.passes[0].windows = no4k.workloads.auto.passes[0].windows.filter(
    (window) => window.width === 1920,
  );
  assert.equal(createTimingReport(no4k).status, 'blocked');

  const noManual = validInput();
  delete noManual.manual;
  assert.equal(createTimingReport(noManual).status, 'blocked');

  const noManualReceipt = validInput();
  delete noManualReceipt.manual.receipt;
  assert.equal(createTimingReport(noManualReceipt).status, 'blocked');

  const forgedManualReceipt = validInput();
  forgedManualReceipt.manual.receipt = {};
  assert.equal(createTimingReport(forgedManualReceipt).status, 'blocked');
});

test('wall-time, TAA, reused samples, and over-budget P95 never qualify', () => {
  const wall = validInput();
  wall.workloads.auto.passes[0].windows[0].measurementSource = 'wall-time';
  const wallReport = createTimingReport(wall);
  assert.equal(wallReport.status, 'blocked');
  assert.ok(wallReport.errors.some((entry) => entry.code === 'measurement-source-invalid'));

  const taa = validInput();
  taa.workloads.auto.passes[0].passName = 'taa-motion-blur';
  const taaReport = createTimingReport(taa);
  assert.equal(taaReport.status, 'blocked');

  const reused = validInput();
  const first = reused.workloads.auto.passes[0].windows[0];
  reused.workloads['positive-lut'].passes[0].windows[0] = structuredClone(first);
  assert.equal(createTimingReport(reused).status, 'blocked');

  const overBudget = validInput();
  for (const workloadRecord of Object.values(overBudget.workloads)) {
    for (const pass of workloadRecord.passes) {
      for (const window of pass.windows) {
        Object.assign(window, ticks(900_000_000, 10_000_000));
      }
    }
  }
  const overBudgetReport = createTimingReport(overBudget);
  assert.equal(overBudgetReport.status, 'blocked');
  assert.ok(overBudgetReport.errors.some((entry) => entry.code === 'timing-budget-invalid'));

  const wrongIdentity = validInput();
  wrongIdentity.workloads.auto.passes[0].passIdentity = 'standard-output/taa';
  assert.equal(createTimingReport(wrongIdentity).status, 'blocked');

  const invalidFrame = validInput();
  invalidFrame.workloads.auto.frame.firstFrame = 0;
  invalidFrame.workloads.auto.frame.lastFrame = 59;
  assert.equal(createTimingReport(invalidFrame).status, 'blocked');
});

test('renderer callback collector fixes warmup/window counts and only consumes measured pass facts', async () => {
  let calls = 0;
  const result = await collectRendererPassTiming({
    ...context,
    manual: { executed: true, zeroCost: true, timestampSlots: 0, receipt: { frameId: 180 } },
    runFrame: ({ workload: kind, resolution, phase, frameIndex }) => {
      calls += 1;
      const frameId = frameIndex + 1;
      const names = kind === 'auto' ? ['auto-exposure-meter'] : ['standard-color-lut'];
      return {
        backend,
        frame: {
          frameId,
          deviceGeneration: 3,
          graphGeneration: kind === 'auto' ? 10 : 11,
          passes: names.map((passName, passIndex) => ({
            passName,
            status: 'measured',
            beginningTick: String(frameId * 1_000_000 + (kind === 'auto' ? 0 : 500_000_000) + passIndex * 10_000),
            endTick: String(frameId * 1_000_000 + (kind === 'auto' ? 0 : 500_000_000) + passIndex * 10_000 + (resolution.width === 1920 ? 1_000 : 2_000)),
          })),
        },
        phase,
      };
    },
  });
  assert.equal(calls, 2 * 2 * (TIMING_SAMPLING.warmupFrames + TIMING_SAMPLING.framesPerWindow));
  assert.equal(result.status, 'observation');
  assert.equal(result.qualification.status, 'eligible-candidate');
});
