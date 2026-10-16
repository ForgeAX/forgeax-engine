import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const toolRoot = process.env.FORGEAX_TOOL_ROOT ?? root;
const require = createRequire(join(toolRoot, 'node_modules/tsup/package.json'));
const { build } = require('esbuild');
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../phone_gameplay_cpu.mjs', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'phoneCpuModule',
  platform: 'browser',
  target: 'es2022',
  write: false,
  metafile: true,
  alias: { '@forgeax/engine-profiler': join(root, 'packages/profiler/src/index.ts') },
  nodePaths: [join(toolRoot, 'node_modules'), join(toolRoot, 'node_modules/.pnpm/node_modules')],
});

function fixture() {
  const context = {};
  runInNewContext(bundled.outputFiles[0].text, context, {
    contextCodeGeneration: { strings: false, wasm: false },
  });
  let time = 100;
  let clockCalls = 0;
  let clockFailure;
  const cpu = context.phoneCpuModule.createPhoneGameplayCpu({
    now() {
      clockCalls += 1;
      if (clockFailure !== undefined) throw clockFailure;
      return time;
    },
  });
  assert.equal(clockCalls, 0, 'Factory must not read the clock before App platform binding');
  assert.equal(
    cpu.profiler.registerPhaseCatalog('app', [
      'frame-total',
      'world-update-primary',
      'renderer-draw',
    ]).ok,
    true,
  );
  assert.equal(
    cpu.profiler.registerPhaseCatalog('render', ['record', 'record/graph-execute']).ok,
    true,
  );
  function frame(frameId, render = true) {
    const session = cpu.profiler.activeSession();
    assert.ok(session, 'The shared owner must still be capturing');
    for (const result of [
      session.beginFrame(frameId),
      session.beginPhase('app', 'frame-total'),
      session.beginPhase('app', 'world-update-primary'),
    ])
      assert.equal(result.ok, true);
    time += 2;
    assert.equal(session.endPhase().ok, true);
    assert.equal(session.beginPhase('app', 'renderer-draw').ok, true);
    if (render) {
      assert.equal(session.beginPhase('render', 'record').ok, true);
      assert.equal(session.beginPhase('render', 'record/graph-execute').ok, true);
      time += 3;
      assert.equal(session.endPhase().ok, true);
      time += 1;
      assert.equal(session.endPhase().ok, true);
    } else time += 4;
    time += 1;
    assert.equal(session.endPhase().ok, true);
    time += 1;
    assert.equal(session.endPhase().ok, true);
    assert.equal(session.endFrame().ok, true);
  }
  return {
    cpu,
    context,
    frame,
    setTime(value) {
      time = value;
    },
    failClock(error) {
      clockFailure = error;
    },
  };
}

test('bundles one real profiler owner and runs without performance, eval or WASM', () => {
  const f = fixture();
  assert.equal('performance' in f.context, false);
  const owners = Object.keys(bundled.metafile.inputs).filter((path) =>
    path.endsWith('packages/profiler/src/profiler.ts'),
  );
  assert.equal(owners.length, 1);
  assert.equal(f.cpu.read().status, 'not-started');
  assert.equal(f.cpu.read().capture, null);
});

for (const frameLimit of [120, 240]) {
  test(`retains exactly ${frameLimit} full CPU frames with App/Render nesting`, () => {
    const f = fixture();
    const started = f.cpu.start({ frameLimit });
    assert.equal(started.ok, true);
    assert.equal(started.value.detail, 'nested');
    assert.equal(f.cpu.read().status, 'recording');
    assert.equal(f.cpu.read().capture, null);
    for (let id = 1; id <= frameLimit; id++) f.frame(id);
    assert.equal(f.cpu.profiler.activeSession(), undefined);
    const raw = f.cpu.profiler.latestCapture();
    const report = f.cpu.read();
    assert.equal(report.capture, raw, 'The original ProfileCapture is exported unchanged');
    assert.equal(report.status, 'complete');
    assert.equal(report.validation.ok, true);
    assert.equal(report.diagnosticOnly, true);
    assert.equal(report.cleanFpsEvidence, false);
    assert.equal(report.coverage.completedAppFrames, frameLimit);
    assert.equal(report.coverage.rendererFrames, frameLimit);
    assert.equal(report.model.summary.frameCount, frameLimit);
    assert.equal(report.model.summary.p95DurationMicros, 8000);
    const world = report.timing.app.find((phase) => phase.phase === 'world-update-primary');
    assert.equal(world.meanMicros, 2000);
    assert.equal(world.totalMicros, frameLimit * 2000);
    assert.equal(world.parentPhase, 'frame-total');
    const draw = report.timing.app.find((phase) => phase.phase === 'renderer-draw');
    assert.equal(draw.meanMicros, 5000);
    const nested = report.timing.render.find((phase) => phase.phase === 'record/graph-execute');
    assert.equal(nested.p95DurationMicros, 3000);
    assert.equal(nested.maxMicros, 3000);
    assert.equal(nested.parentSource, 'render');
    assert.equal(nested.parentPhase, 'record');
    assert.equal(f.cpu.stop().value, raw, 'Auto-finished capture remains idempotently retrievable');
  });
}

test('stopping at 119 frames preserves the original partial reason and counts', () => {
  const f = fixture();
  f.cpu.start();
  for (let id = 1; id <= 119; id++) f.frame(id);
  assert.equal(f.cpu.stop().ok, true);
  const report = f.cpu.read();
  assert.equal(report.status, 'partial');
  assert.equal(report.capture.completeness.status, 'partial');
  assert.equal(report.capture.completeness.incompleteReason, 'stopped-before-frame');
  assert.equal(report.model.summary.frameCount, 119);
  assert.equal(report.coverage.ownerCoverageComplete, false);
});

test('overflow retains dropped-event evidence and never becomes complete', () => {
  const f = fixture();
  f.cpu.start({ eventLimit: 2 });
  for (let id = 1; id <= 120; id++) f.frame(id);
  const report = f.cpu.read();
  assert.equal(report.status, 'overflow');
  assert.equal(report.capture.completeness.retainedEventCount, 2);
  assert.equal(report.capture.completeness.droppedEventCount, 598);
  assert.equal(report.capture.completeness.firstAffectedFrameId, 1);
  assert.equal(report.capture.completeness.lastAffectedFrameId, 120);
  assert.equal(report.validation.ok, true);
});

test('owner lifecycle errors survive recovery and never overwrite the raw capture', () => {
  const f = fixture();
  const started = f.cpu.start();
  const repeated = f.cpu.start();
  assert.equal(repeated.ok, false);
  assert.equal(repeated.error.code, 'capture-already-active');
  assert.equal(f.cpu.read().firstFailure.error, repeated.error);
  const session = started.value;
  session.beginFrame(1);
  session.beginPhase('app', 'frame-total');
  const stopped = f.cpu.stop();
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, 'capture-state-invalid');
  assert.equal(stopped.error.detail.operation, 'finish');
  session.endPhase();
  session.endFrame();
  assert.equal(f.cpu.stop().ok, true);
  const report = f.cpu.read();
  assert.equal(report.status, 'failed');
  assert.equal(report.failureCount, 2);
  assert.equal(report.firstFailure.error, repeated.error);
  assert.equal(report.capture.completeness.status, 'partial');
});

test('a complete recorder without Render phases is insufficient owner coverage', () => {
  const f = fixture();
  f.cpu.start();
  for (let id = 1; id <= 120; id++) f.frame(id, false);
  const report = f.cpu.read();
  assert.equal(report.capture.completeness.status, 'complete');
  assert.equal(report.status, 'partial');
  assert.equal(report.coverage.rendererFrames, 0);
  assert.equal(report.timing.render.length, 0);
});

test('explicit bounds and an unstarted stop remain structured failures', () => {
  for (const options of [{ frameLimit: 119 }, { eventLimit: 65537 }, { eventLimit: 0 }]) {
    const f = fixture();
    const result = f.cpu.start(options);
    assert.equal(result.ok, false);
    assert.equal(f.cpu.read().firstFailure.error, result.error);
    assert.equal(f.cpu.profiler.activeSession(), undefined);
  }
  const f = fixture();
  assert.equal(f.cpu.stop().error.code, 'phone-cpu-not-started');
  assert.equal(f.cpu.read().status, 'failed');
});

test('the actual Platform clock failure is preserved without a performance fallback', () => {
  const f = fixture();
  const started = f.cpu.start();
  const original = { code: 'platform-clock-unavailable' };
  f.failClock(original);
  started.value.beginFrame(1);
  assert.throws(
    () => started.value.beginPhase('app', 'frame-total'),
    (error) => error === original,
  );
  assert.equal(f.cpu.read().firstFailure.operation, 'clock');
  assert.equal(f.cpu.read().firstFailure.error, original);
  assert.equal(f.cpu.read().status, 'failed');
});

test('a nonfinite clock is rejected instead of fabricating valid phase durations', () => {
  const f = fixture();
  const started = f.cpu.start();
  f.setTime(Number.NaN);
  started.value.beginFrame(1);
  assert.throws(() => started.value.beginPhase('app', 'frame-total'), /finite nonnegative/);
  assert.equal(f.cpu.read().firstFailure.operation, 'clock');
});

test('fractional Platform milliseconds are quantized at the profiler clock boundary', () => {
  const f = fixture();
  f.setTime(123.456789);
  f.cpu.start({ frameLimit: 120 });
  for (let id = 1; id <= 120; id++) f.frame(id);
  const report = f.cpu.read();
  assert.equal(report.validation.ok, true);
  assert.equal(report.status, 'complete');
  assert.equal(report.coverage.ownerCoverageComplete, true);
  assert.equal(report.capture.records[0].startMicros, 123456);
  for (const record of report.capture.records) {
    assert.ok(Number.isSafeInteger(record.startMicros));
    assert.ok(Number.isSafeInteger(record.endMicros));
    assert.equal(record.durationMicros, record.endMicros - record.startMicros);
  }
});
