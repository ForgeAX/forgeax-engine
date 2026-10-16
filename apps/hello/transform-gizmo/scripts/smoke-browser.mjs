import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { startGizmoHost, waitGizmoFrames } from './browser-host.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { resolveBrowserWebGpuLaunch } from '../../../shared/scripts/rhi-debug-verify.mjs';

const output = resolve(process.env.GIZMO_EVIDENCE_DIR ?? 'artifacts/transform-gizmo');
mkdirSync(output, { recursive: true });
const sampleFrames = Number(process.env.GIZMO_PERF_FRAMES ?? (process.argv.includes('--performance') ? 180 : 0));
assert(Number.isSafeInteger(sampleFrames) && (sampleFrames === 0 || sampleFrames >= 60),
  'performance samples must be zero (correctness smoke) or an integer of at least 60');
const lightweight = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' && sampleFrames === 0;
const viewport = lightweight ? { width: 860, height: 780 } : { width: 1180, height: 920 };
const host = await startGizmoHost();
const launch = resolveBrowserWebGpuLaunch();
const browser = await chromium
  .launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
    args: launch.args,
    chromiumSandbox: true,
  })
  .catch(async (error) => {
    await host.stop();
    throw error;
  });
const page = await browser.newPage({
  viewport,
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const samples = [];
const report = {
  backend: launch.selectedBackend,
  resolution: [1000, 640],
  tests: [],
  modeResources: [],
  performance: [],
};
const started = performance.now();
const progress = (phase) => console.log(`[gizmo-progress] ${JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started) })}`);
async function settle(n = 4) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
  }, n);
}
async function point(kind, axis = 0, amount = 0.75, angle = 0.35) {
  return page.evaluate(
    ({ kind, axis, amount, angle }) => {
      const { scene } = globalThis.__gizmo;
      scene.sync();
      const f = scene.gizmo.frame;
      const p = f.origin.slice();
      if (kind === 'axis') for (let j = 0; j < 3; j++) p[j] += f.axes[axis][j] * f.radius * amount;
      if (kind === 'ring')
        for (let j = 0; j < 3; j++)
          p[j] +=
            (f.axes[(axis + 1) % 3][j] * Math.cos(angle) +
              f.axes[(axis + 2) % 3][j] * Math.sin(angle)) *
            f.radius;
      if (kind === 'plane')
        for (let j = 0; j < 3; j++) p[j] += (f.axes[0][j] + f.axes[1][j]) * f.radius * 0.34;
      const s = f.project(p),
        canvas = document.querySelector('canvas'),
        rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + (s[0] * rect.width) / canvas.width,
        y: rect.top + (s[1] * rect.height) / canvas.height,
        handle: scene.gizmo.hitTest(s[0], s[1]),
      };
    },
    { kind, axis, amount, angle },
  );
}
async function drag(from, to, cancel = false) {
  await page.mouse.move(from.x, from.y);
  await settle();
  await page.mouse.down();
  assert(
    await page.evaluate(() => globalThis.__gizmo.scene.gizmo.dragging),
    'real pointer did not begin drag',
  );
  await page.mouse.move(to.x, to.y, { steps: lightweight ? 4 : 12 });
  await settle();
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  await settle();
}
const pose = () => page.evaluate(() => globalThis.__gizmo.pose());
const shot = async (name) => page.screenshot({ path: resolve(output, `${name}.png`) });
try {
  progress('navigate');
  // Vite may still be transforming the shader-heavy entry after the listener
  // is ready, especially while the full smoke roster shares the host.
  await page.goto(sampleFrames ? `${host.url}?perf` : host.url, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  progress('frame admission');
  await waitGizmoFrames(page);
  progress('pointer journeys');
  report.resolution = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return [c.width, c.height];
  });
  report.recorderEnabled = await page.evaluate(
    () => typeof globalThis.__forgeax?.captureFrame === 'function',
  );
  if (!process.env.GIZMO_URL)
    assert.equal(report.recorderEnabled, false, 'performance host must disable the recorder');
  const before = await pose(),
    x = await point('axis');
  assert.equal(x.handle, 'X');
  await drag(x, { x: x.x + 75, y: x.y });
  const moved = await pose();
  assert(moved.pos[0] > 0.25);
  assert(Math.abs(moved.pos[1]) + Math.abs(moved.pos[2]) < 0.001);
  report.tests.push({ name: 'axis translate', before, after: moved });
  await shot('01-translate');
  await page.click('#reset');
  await settle();
  const xy = await point('plane');
  assert.equal(xy.handle, 'XY');
  await drag(xy, { x: xy.x + 30, y: xy.y - 30 });
  const planar = await pose();
  assert(
    Math.abs(planar.pos[0]) > 0.05 &&
      Math.abs(planar.pos[1]) > 0.05 &&
      Math.abs(planar.pos[2]) < 0.001,
  );
  report.tests.push({ name: 'plane translate', after: planar });
  await page.click('#reset');
  await settle();
  const start = await pose(),
    cancel = await point('axis');
  await drag(cancel, { x: cancel.x + 90, y: cancel.y }, true);
  assert.deepEqual(await pose(), start);
  report.tests.push({ name: 'Escape cancel', passed: true });
  // Exercise host cancellation with actual pointer capture still held.
  for (const event of ['pointercancel', 'lostpointercapture', 'blur']) {
    await page.click('#reset');
    await settle();
    const initial = await pose(),
      p = await point('axis');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 60, p.y);
    await settle();
    assert(await page.evaluate(() => globalThis.__gizmo.scene.gizmo.dragging));
    await page.evaluate((event) => {
      const canvas = document.querySelector('canvas');
      if (event === 'blur') window.dispatchEvent(new Event('blur'));
      else if (event === 'lostpointercapture') canvas.releasePointerCapture(1);
      else canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    }, event);
    await settle();
    await page.mouse.up();
    assert.deepEqual(await pose(), initial);
    assert(!(await page.evaluate(() => globalThis.__gizmo.scene.gizmo.dragging)));
    report.tests.push({ name: `${event} cancels`, passed: true });
  }
  await page.check('#snap');
  const snapStart = await point('axis');
  await drag(snapStart, { x: snapStart.x + 73, y: snapStart.y });
  const snapped = await pose();
  assert(Math.abs(snapped.pos[0] / 0.25 - Math.round(snapped.pos[0] / 0.25)) < 0.0001);
  report.tests.push({ name: 'translation snapping', after: snapped });
  await page.uncheck('#snap');
  await page.click('#reset');
  await page.setViewportSize(lightweight ? { width: 740, height: 740 } : { width: 920, height: 800 });
  await settle(12);
  const resized = await point('axis');
  assert.equal(resized.handle, 'X');
  await drag(resized, { x: resized.x + 50, y: resized.y });
  assert((await pose()).pos[0] > 0.1);
  report.tests.push({ name: 'resized canvas CSS-to-physical drag', passed: true });
  await page.setViewportSize(viewport);
  await settle(12);
  await page.click('#reset');
  await page.click('[data-mode=rotate]');
  await settle();
  const a = await point('ring', 2, 1, 0.35),
    b = await point('ring', 2, 1, 1.2);
  assert.equal(a.handle, 'Z');
  await drag(a, b);
  const rotated = await pose();
  assert(Math.abs(rotated.quat[2]) > 0.25);
  report.tests.push({ name: 'Z rotation', after: rotated });
  await shot('02-rotate');
  await page.click('[data-mode=scale]');
  await settle();
  const sa = await point('axis', 0, 1),
    sb = await point('axis', 0, 1.45);
  assert.equal(sa.handle, 'X');
  await drag(sa, sb);
  const scaled = await pose();
  assert(scaled.scale[0] > 2);
  assert(Math.abs(scaled.scale[1] - 1.1) < 0.001);
  report.tests.push({ name: 'local X scale', after: scaled });
  await shot('03-scale');
  await page.click('#reset');
  await settle();
  const c = await point('center');
  await drag(c, { x: c.x, y: c.y - 45 });
  const uniform = await pose();
  assert(uniform.scale[2] > 0.8);
  report.tests.push({ name: 'uniform scale', after: uniform });
  await page.click('[data-mode=translate]');
  await page.check('#parent');
  await page.check('#ortho');
  await page.selectOption('#space', 'local');
  await settle();
  const nested = await point('axis', 0, 0.75);
  assert.equal(nested.handle, 'X');
  await drag(nested, { x: nested.x + 45, y: nested.y });
  report.tests.push({ name: 'local nested orthographic drag', after: await pose() });
  await shot('04-local-orthographic');
  progress('pointer journeys complete');
  await page.uncheck('#parent');
  await page.uncheck('#ortho');
  await page.click('#reset');
  await page.selectOption('#space', 'world');
  await settle();
  const phases = [
    'disabled',
    'translate',
    'rotate',
    'scale',
    'disabled',
    'translate',
    'rotate',
    'scale',
  ];
  for (const phase of phases) {
    progress(`${sampleFrames ? 'performance' : 'resource transition'} ${phase} round ${Math.floor(report.modeResources.length / 4) + 1}`);
    await page.evaluate((phase) => {
      const { scene } = globalThis.__gizmo;
      scene.gizmo.configure({ mode: phase === 'disabled' ? 'translate' : phase });
      scene.enable(phase !== 'disabled');
    }, phase);
    await settle(sampleFrames ? 30 : 4);
    const data = await page.evaluate(async (sampleFrames) => {
      const intervals = [],
        sync = [];
      let previous = performance.now();
      for (let i = 0; i < sampleFrames; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        intervals.push(now - previous);
        previous = now;
        sync.push(globalThis.__gizmo.timings().at(-1));
      }
      const g = globalThis.__gizmo.scene.gizmo,
        f = g.frame;
      let hitUs = null;
      if (sampleFrames && f) {
        const s = f.project([
          f.origin[0] + f.axes[0][0] * f.radius * 0.7,
          f.origin[1] + f.axes[0][1] * f.radius * 0.7,
          f.origin[2] + f.axes[0][2] * f.radius * 0.7,
        ]);
        const start = performance.now();
        for (let i = 0; i < 10000; i++) g.hitTest(s[0], s[1]);
        hitUs = ((performance.now() - start) * 1000) / 10000;
      }
      return {
        intervals,
        sync,
        hitUs,
        gpu: sampleFrames ? globalThis.__gizmo.gpuTimings().slice(-sampleFrames) : [],
        entities: globalThis.__gizmo.app.world.inspect().entityCount,
        renderer: globalThis.__gizmo.app.renderer.inspect(),
      };
    }, sampleFrames);
    report.modeResources.push({ phase, entities: data.entities, allocation: data.renderer.renderGraphResourceAllocation });
    report.renderer = data.renderer;
    if (!sampleFrames) continue;
    const stats = (a) => {
      const s = a.slice().sort((a, b) => a - b);
      return {
        median: s[Math.floor(s.length * 0.5)],
        p95: s[Math.floor(s.length * 0.95)],
        mean: a.reduce((a, b) => a + b, 0) / a.length,
      };
    };
    const gpu = data.gpu
      .filter((row) => row.timings.status === 'complete' || row.timings.status === 'partial')
      .map((row) => row.timings.frame);
    const gpuMs = gpu.map((frame) => frame.measuredPassNanoseconds / 1e6);
    const sceneMainMs = gpu.map((frame) =>
      frame.passes
        .filter((p) => p.status === 'measured' && p.passName === 'main')
        .reduce((sum, p) => sum + p.durationNanoseconds / 1e6, 0),
    );
    report.performance.push({
      phase,
      frames: sampleFrames,
      frameMs: stats(data.intervals),
      syncMs: stats(data.sync),
      hitUs: data.hitUs,
      entities: data.entities,
      allocation: data.renderer.renderGraphResourceAllocation,
      gpuSamples: gpu.length,
      measuredGpuPassMs: gpuMs.length ? stats(gpuMs) : null,
      sceneMainPassMs: sceneMainMs.length ? stats(sceneMainMs) : null,
      gpuStatuses: [...new Set(data.gpu.map((row) => row.timings.status))],
      gpuEvidence: data.gpu.at(-1)?.timings,
      unmeasuredPasses: data.gpu
        .at(-1)
        ?.timings.frame?.passes.filter((p) => p.status === 'unmeasured'),
    });
    samples.push({
      phase,
      intervalsMs: data.intervals,
      syncMs: data.sync,
      gpu: data.gpu,
      hitUs: data.hitUs,
    });
  }
  report.hardware = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return {
      userAgent: navigator.userAgent,
      adapter: a.info.toJSON?.() ?? {
        vendor: a.info.vendor,
        architecture: a.info.architecture,
        device: a.info.device,
        description: a.info.description,
      },
      features: [...a.features],
    };
  });
  assert.equal(errors.length, 0, errors.join('\n'));
  report.errors = errors;
  report.measurement = {
    warmupFramesPerPhase: sampleFrames ? 30 : 0,
    sampledFramesPerPhase: sampleFrames,
    rounds: 2,
    hitTestIterations: sampleFrames ? 10000 : 0,
    baseline: 'Same retained scene and assets; gizmo detached and hidden',
    cpuTimerResolutionMs: 0.1,
    gpuTime:
      'Only measured raster/compute/copy pass durations; partial reasons and unmeasured passes are retained',
  };
  report.completedFrames = await page.evaluate(() => globalThis.__gizmo.frames());
  if (process.platform === 'darwin')
    report.host = {
      cpu: execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
      memoryBytes: Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' })),
    };
  assert(
    report.modeResources.every((row) => row.entities === report.modeResources[0].entities),
    'entity roster grew during repeated modes',
  );
  writeFileSync(resolve(output, 'performance-samples.json.gz'), gzipSync(JSON.stringify(samples)));
  writeFileSync(resolve(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  emitSmokeReceipt('hello-transform-gizmo/browser', report.completedFrames, 'smoke:browser');
} catch (error) {
  const failure = { message: error.message, errors, report };
  writeFileSync(
    resolve(output, 'failure.json'),
    JSON.stringify(failure, null, 2),
  );
  console.error(`[gizmo-failure] ${JSON.stringify(failure)}`);
  await page.screenshot({ path: resolve(output, 'failure.png'), timeout: 5000 }).catch((screenshotError) => {
    console.error(`[gizmo-failure-screenshot] ${screenshotError.message}`);
  });
  throw error;
} finally {
  await browser.close();
  await host.stop();
}
