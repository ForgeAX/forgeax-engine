import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { preview } from 'vite';
import { waitForPreview } from './preview-readiness.mjs';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5199;
const gauntlet = process.argv.includes('--gauntlet');
const artifactDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
if (gauntlet && artifactDir) mkdirSync(artifactDir, { recursive: true });
const server = await preview({
  preview: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
});

function assertFaultView(view) {
  if (view.status === 'running') throw new Error('fault view still presents the Engine as running');
  if (!view.summary.includes('faulted') || !view.summary.includes('shared-kernel-failed')) {
    throw new Error('fault view summary omits the stopped state or stable fault code');
  }
  if (!view.report.includes('shared-kernel-failed')) {
    throw new Error('fault view omits the stable shared-kernel-failed code');
  }
  if (view.rebuildHidden) throw new Error('fault view hides the rebuild action');
}

function capabilityTruth(report) {
  return {
    workers: report.workers,
    capabilities: report.capabilities,
  };
}

async function captureCanvas(page, name) {
  const bytes = await page.locator('#game').screenshot();
  if (artifactDir) writeFileSync(join(artifactDir, name), bytes);
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

try {
  await waitForPreview(server);
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  const reports = [];
  for (const tier of ['main-serial', 'engine-worker', 'shared', 'render-worker', 'auto']) {
    const page = await browser.newPage();
    const errors = [];
    const logs = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    const telemetryQuery = gauntlet ? '&gauntlet=1' : '';
    await page.goto(`http://127.0.0.1:${port}/?tier=${tier}${telemetryQuery}`, {
      waitUntil: 'domcontentloaded',
    });
    try {
      await page.waitForFunction(() => globalThis.__forgeaxExecutionReady === true, null, { timeout: 30_000 });
    } catch (error) {
      const output = await page.locator('#execution-report').textContent();
      throw new Error(`${tier} did not become ready: ${String(error)}; output=${output}; errors=${errors.join(' | ')}; logs=${logs.join(' | ')}`);
    }
    const report = JSON.parse(await page.locator('#execution-report').textContent());
    const expected = { engine: tier !== 'main-serial', render: tier === 'render-worker' || tier === 'auto', kernels: tier === 'shared' || tier === 'auto' };
    for (const [worker, enabled] of Object.entries(expected)) {
      if (report.workers[worker].enabled !== enabled) throw new Error(`unexpected ${worker} policy: ${JSON.stringify(report.workers)}`);
    }
    const expectedRealm = tier === 'main-serial' ? 'host' : 'worker';
    if (report.engine.realm !== expectedRealm) throw new Error(`unexpected realm: ${report.engine.realm}`);
    if (report.world.identity === null) throw new Error('missing World identity');
    if ((tier === 'shared' || tier === 'auto') && report.kernelDispatch.usedShared !== true) {
      throw new Error(`shared kernel did not dispatch: ${JSON.stringify(report.kernelDispatch)}`);
    }
    if (report.world.health !== 'healthy' || report.engine.health !== 'running') {
      throw new Error(`baseline is not healthy: ${JSON.stringify(report)}`);
    }
    if (errors.length > 0) throw new Error(`browser errors: ${errors.join(' | ')}`);
    reports.push({
      tier,
      worldIdentity: report.world.identity,
      kernelDispatch: report.kernelDispatch,
      capabilityTruth: capabilityTruth(report),
      hostFrameSamples: report.performance.hostFrameMs?.samples ?? 0,
    });
    await page.close();
  }
  const faultPage = await browser.newPage();
  const faultErrors = [];
  faultPage.on('pageerror', (error) => faultErrors.push(error.message));
  const faultTelemetryQuery = gauntlet ? '&gauntlet=1' : '';
  await faultPage.goto(`http://127.0.0.1:${port}/?tier=shared&fault=1${faultTelemetryQuery}`, {
    waitUntil: 'domcontentloaded',
  });
  let baselineCanvas;
  let baselineHostFrameSamples;
  let preFaultTelemetry;
  if (gauntlet) {
    await faultPage.bringToFront();
    await faultPage.waitForFunction(
      () =>
        globalThis.__forgeaxExecutionTelemetry?.registered.length === 2 &&
        globalThis.__forgeaxExecutionReport?.().engine.health === 'running',
      null,
      { timeout: 30_000 },
    );
    const canvas = faultPage.locator('#game');
    await canvas.scrollIntoViewIfNeeded();
    const canvasBox = await canvas.boundingBox();
    if (canvasBox === null) throw new Error('execution canvas has no browser bounding box');
    const beforeFault = await faultPage.evaluate(() => ({
      report: globalThis.__forgeaxExecutionReport?.(),
      telemetry: globalThis.__forgeaxExecutionTelemetry,
    }));
    if (beforeFault.report?.engine.health !== 'running' || beforeFault.report.world.health !== 'healthy') {
      throw new Error(`input/update baseline did not precede the fault: ${JSON.stringify(beforeFault)}`);
    }
    if (beforeFault.report.kernelDispatch.usedShared !== true) {
      throw new Error(`shared baseline did not dispatch before fault: ${JSON.stringify(beforeFault.report)}`);
    }
    if ((beforeFault.report.performance.hostFrameMs?.samples ?? 0) <= 0) {
      throw new Error(`Host frame-credit baseline is empty: ${JSON.stringify(beforeFault.report.performance)}`);
    }
    baselineHostFrameSamples = beforeFault.report.performance.hostFrameMs.samples;
    baselineCanvas = await captureCanvas(faultPage, 'm12-before-poison.png');
    if (baselineCanvas.bytes <= 0) throw new Error('Host render baseline screenshot is empty');
    preFaultTelemetry = beforeFault.telemetry;
    await faultPage.mouse.move(
      canvasBox.x + canvasBox.width / 2,
      canvasBox.y + canvasBox.height / 2,
    );
    await faultPage.mouse.down();
    try {
      await faultPage.waitForFunction(
        () =>
          globalThis.__forgeaxExecutionTelemetry?.updates.some(
            (event) => event.mousePrimaryDown === true,
          ) === true,
        null,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostic = await faultPage.evaluate(() => ({
        status: document.querySelector('#execution-report')?.getAttribute('data-status'),
        output: document.querySelector('#execution-report')?.textContent,
        telemetry: globalThis.__forgeaxExecutionTelemetry,
      }));
      throw new Error(`Host pointer input did not reach the World: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}`);
    }
    await faultPage.waitForFunction(
      () => globalThis.__forgeaxExecutionTelemetry?.faultArmed.length > 0,
      null,
      { timeout: 30_000 },
    );
    const inputWitness = await faultPage.evaluate(() => {
      const telemetry = globalThis.__forgeaxExecutionTelemetry;
      return telemetry?.updates.find((event) => event.mousePrimaryDown === true) ?? null;
    });
    if (inputWitness === null || inputWitness.worldIdentity !== beforeFault.report.world.identity) {
      throw new Error(
        `Host input/update witness did not precede poison: ${JSON.stringify({
          inputWitness,
          baselineWorldIdentity: beforeFault.report.world.identity,
          preFaultTelemetry,
        })}`,
      );
    }
  }
  await faultPage.waitForFunction(
    () => globalThis.__forgeaxExecutionReport?.().world.health === 'poisoned',
    null,
    { timeout: 30_000 },
  );
  const poisoned = await faultPage.evaluate(() => globalThis.__forgeaxExecutionReport());
  if (poisoned.world.partialWrite !== true || poisoned.world.retryable !== false) {
    throw new Error(`fault did not poison World: ${JSON.stringify(poisoned.world)}`);
  }
  if (poisoned.fault?.code !== 'shared-kernel-failed') {
    throw new Error(`unexpected fault: ${JSON.stringify(poisoned.fault)}`);
  }
  if (
    poisoned.engine.health !== 'faulted' ||
    poisoned.kernelDispatch.reason !== 'poisoned'
  ) {
    throw new Error(`poison did not freeze shared execution: ${JSON.stringify(poisoned)}`);
  }
  const frozenSamples = poisoned.performance.hostFrameMs?.samples ?? 0;
  const frozenUpdates = gauntlet
    ? (await faultPage.evaluate(() => globalThis.__forgeaxExecutionTelemetry?.updates.length ?? 0))
    : undefined;
  await faultPage.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }));
  const stopped = await faultPage.evaluate(() => ({
    status: document.querySelector('#execution-report')?.getAttribute('data-status'),
    summary: document.querySelector('#execution-summary')?.textContent ?? '',
    report: document.querySelector('#execution-report')?.textContent ?? '',
    rebuildHidden: document.querySelector('#rebuild')?.hasAttribute('hidden') ?? true,
    samples: globalThis.__forgeaxExecutionReport?.().performance.hostFrameMs?.samples ?? 0,
  }));
  assertFaultView(stopped);
  if (stopped.samples !== frozenSamples) {
    throw new Error(`fault view frame samples advanced after poison: ${frozenSamples} -> ${stopped.samples}`);
  }
  if (
    gauntlet &&
    (stopped.samples !== frozenSamples ||
      (await faultPage.evaluate(() => globalThis.__forgeaxExecutionTelemetry?.updates.length ?? 0)) !==
        frozenUpdates)
  ) {
    throw new Error('poisoned update/draw state was not frozen');
  }
  const falsified = await faultPage.evaluate(() => {
    const output = document.querySelector('#execution-report');
    const rebuild = document.querySelector('#rebuild');
    output?.setAttribute('data-status', 'running');
    rebuild?.setAttribute('hidden', '');
    return {
      status: output?.getAttribute('data-status'),
      summary: document.querySelector('#execution-summary')?.textContent ?? '',
      report: output?.textContent ?? '',
      rebuildHidden: rebuild?.hasAttribute('hidden') ?? true,
    };
  });
  let falsificationCaught = false;
  try {
    assertFaultView(falsified);
  } catch {
    falsificationCaught = true;
  }
  if (!falsificationCaught) throw new Error('fault-view falsification was not detected');
  await faultPage.waitForFunction(() => {
    const output = document.querySelector('#execution-report');
    const rebuild = document.querySelector('#rebuild');
    return output?.getAttribute('data-status') !== 'running' && rebuild?.hasAttribute('hidden') === false;
  });
  const oldIdentity = poisoned.world.identity;
  await faultPage.locator('#rebuild').evaluate((button) => button.click());
  try {
    await faultPage.waitForFunction(
      (identity) => {
        const report = globalThis.__forgeaxExecutionReport?.();
        return report?.engine.health === 'running' && report.world.identity !== identity;
      },
      oldIdentity,
      { timeout: 30_000 },
    );
  } catch (error) {
    const diagnostic = await faultPage.evaluate(() => ({
      report: globalThis.__forgeaxExecutionReport?.(),
      button: {
        hidden: document.querySelector('#rebuild')?.hasAttribute('hidden'),
        disabled: document.querySelector('#rebuild')?.disabled,
      },
    }));
    throw new Error(`execution.rebuild did not publish a fresh running World: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${faultErrors.join(' | ')}`);
  }
  const rebuilt = await faultPage.evaluate(() => globalThis.__forgeaxExecutionReport());
  if (rebuilt.world.health !== 'healthy' || rebuilt.fault !== null) {
    throw new Error(`rebuild did not recover: ${JSON.stringify(rebuilt)}`);
  }
  let recoveryEvidence;
  if (gauntlet) {
    await faultPage.waitForFunction(
      (identity) => {
        const telemetry = globalThis.__forgeaxExecutionTelemetry;
        return (
          telemetry?.registered.filter((event) => event.worldIdentity === identity).length === 2 &&
          telemetry?.cleanups.filter((event) => event.worldIdentity === identity).length === 2
        );
      },
      oldIdentity,
      { timeout: 30_000 },
    );
    await faultPage.waitForFunction(
      (identity) =>
        globalThis.__forgeaxExecutionTelemetry?.updates.some(
          (event) => event.worldIdentity === identity && event.mousePrimaryDown === true,
        ) === true,
      rebuilt.world.identity,
      { timeout: 30_000 },
    );
    await faultPage.waitForFunction(
      () => (globalThis.__forgeaxExecutionReport?.().performance.hostFrameMs?.samples ?? 0) > 0,
      null,
      { timeout: 30_000 },
    );
    const telemetryAfterRebuild = await faultPage.evaluate(() => ({
      telemetry: globalThis.__forgeaxExecutionTelemetry,
      report: globalThis.__forgeaxExecutionReport?.(),
    }));
    const oldRegistrations = telemetryAfterRebuild.telemetry.registered
      .filter((event) => event.worldIdentity === oldIdentity)
      .map((event) => event.name);
    const oldCleanups = telemetryAfterRebuild.telemetry.cleanups
      .filter((event) => event.worldIdentity === oldIdentity)
      .map((event) => event.name);
    if (oldRegistrations.join(',') !== 'input-observer,render-session') {
      throw new Error(`cleanup registration order was not recorded: ${oldRegistrations.join(',')}`);
    }
    if (oldCleanups.join(',') !== 'render-session,input-observer') {
      throw new Error(`cleanup reverse order was not recorded: ${oldCleanups.join(',')}`);
    }
    const rebuiltUpdates = telemetryAfterRebuild.telemetry.updates.filter(
      (event) => event.worldIdentity === rebuilt.world.identity,
    );
    if (rebuiltUpdates.length === 0 || rebuiltUpdates.every((event) => !event.mousePrimaryDown)) {
      throw new Error('Host input did not reach the rebuilt World');
    }
    if ((telemetryAfterRebuild.report.performance.hostFrameMs?.samples ?? 0) <= 0) {
      throw new Error('Host frame credits did not resume after rebuild');
    }
    if (telemetryAfterRebuild.report.kernelDispatch.usedShared !== true) {
      throw new Error(`shared kernel did not resume after rebuild: ${JSON.stringify(telemetryAfterRebuild.report)}`);
    }
    const recoveredCanvas = await captureCanvas(faultPage, 'm12-after-rebuild.png');
    if (recoveredCanvas.bytes <= 0) throw new Error('Host render recovery screenshot is empty');
    const cleanupBeforeStop = telemetryAfterRebuild.telemetry.cleanups.length;
    await faultPage.mouse.up();
    const firstStop = await faultPage.evaluate(() => globalThis.__forgeaxExecutionStop?.());
    if (firstStop?.ok !== true) throw new Error(`first stop failed: ${JSON.stringify(firstStop)}`);
    await faultPage.waitForFunction(
      (identity) =>
        globalThis.__forgeaxExecutionTelemetry?.cleanups.filter(
          (event) => event.worldIdentity === identity,
        ).length === 2,
      rebuilt.world.identity,
      { timeout: 30_000 },
    );
    const afterFirstStop = await faultPage.evaluate(() => globalThis.__forgeaxExecutionTelemetry);
    const secondStop = await faultPage.evaluate(() => {
      const result = globalThis.__forgeaxExecutionStop?.();
      if (result?.ok === true) return { ok: true };
      return {
        ok: false,
        errorCode: result?.error?.code,
        errorName: result?.error?.name,
      };
    });
    await faultPage.waitForTimeout(100);
    const afterSecondStop = await faultPage.evaluate(() => globalThis.__forgeaxExecutionTelemetry);
    if (secondStop.ok || secondStop.errorCode !== 'app-not-started') {
      throw new Error('repeated app.stop unexpectedly succeeded instead of returning a no-op Result');
    }
    if (afterSecondStop.cleanups.length !== afterFirstStop.cleanups.length) {
      throw new Error('cleanup was not idempotent after a repeated stop');
    }
    recoveryEvidence = {
      oldWorldIdentity: oldIdentity,
      newWorldIdentity: rebuilt.world.identity,
      oldRegistrations,
      oldCleanups,
      rebuiltInputUpdates: rebuiltUpdates.length,
      frozenUpdates,
      cleanupBeforeStop,
      cleanupIdempotence: {
        firstStop: 'flushed-current-generation-in-reverse-order',
        secondStop: 'no-op-result',
        secondStopOk: secondStop.ok,
        secondStopErrorCode: secondStop.errorCode,
        cleanupCountUnchanged: afterSecondStop.cleanups.length === afterFirstStop.cleanups.length,
      },
      rendering: {
        baselineHostFrameSamples,
        recoveredHostFrameSamples: telemetryAfterRebuild.report.performance.hostFrameMs?.samples ?? 0,
        baselineCanvas,
        recoveredCanvas,
      },
      baselineCanvas,
      recoveredCanvas,
    };
  }
  if (faultErrors.length > 0) throw new Error(`fault page errors: ${faultErrors.join(' | ')}`);
  reports.push({
    tier: 'shared-fault-rebuild',
    oldWorldIdentity: oldIdentity,
    worldIdentity: rebuilt.world.identity,
    kernelDispatch: rebuilt.kernelDispatch,
    capabilityTruth: capabilityTruth(rebuilt),
    poisoned: {
      worldHealth: poisoned.world.health,
      faultCode: poisoned.fault?.code,
      kernelDispatchReason: poisoned.kernelDispatch.reason,
      frozenHostFrameSamples: frozenSamples,
      frozenUpdateCount: frozenUpdates,
    },
    recovery: recoveryEvidence,
  });
  await faultPage.close();
  let refusal;
  if (gauntlet) {
    const refusalBrowser = await webkit.launch({ headless: true });
    const refusalPage = await refusalBrowser.newPage();
    try {
      await refusalPage.goto(`http://127.0.0.1:${port}/?tier=engine-worker&gauntlet=1`, {
        waitUntil: 'domcontentloaded',
      });
      await refusalPage.waitForFunction(
        () => document.querySelector('#execution-report')?.getAttribute('data-status') === 'failed',
        null,
        { timeout: 30_000 },
      );
      refusal = JSON.parse(await refusalPage.locator('#execution-report').textContent());
      if (
        refusal.code !== 'app-execution-worker-unavailable' ||
        refusal.requestedWorkers.engine !== true ||
        !Array.isArray(refusal.capabilityTruth?.missingCapabilities) ||
        refusal.capabilityTruth.missingCapabilities.length === 0 ||
        refusal.detail?.worker !== 'engine'
      ) {
        throw new Error(`unavailable tier was not refused structurally: ${JSON.stringify(refusal)}`);
      }
      const refusalReportType = await refusalPage.evaluate(
        () => typeof globalThis.__forgeaxExecutionReport,
      );
      if (refusalReportType !== 'undefined') {
        throw new Error('unavailable tier unexpectedly exposed an execution report');
      }
    } finally {
      await refusalPage.close();
      await refusalBrowser.close();
    }
  }
  await browser.close();
  const result = { ok: true, reports, ...(refusal === undefined ? {} : { refusal }) };
  if (gauntlet) process.stdout.write(`M12_EXECUTION_POISON_REBUILD_PASS ${JSON.stringify(result)}\n`);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await server.close();
}
