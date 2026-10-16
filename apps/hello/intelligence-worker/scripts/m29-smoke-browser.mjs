import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5215;
const gauntlet = process.argv.includes('--gauntlet');
const artifactDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
if (gauntlet && artifactDir) mkdirSync(artifactDir, { recursive: true });

const server = await preview({
  preview: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
});

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/m29.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M29 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function requiredEvent(report, name) {
  const event = report.workerEvents.find((item) => item.event === name);
  if (event === undefined) fail(`M29 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M29 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M29 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M29 Worker capability was not available', execution.capabilities);
  }
}

function assertCleanup(report) {
  if (report.stopResults?.first?.ok !== true) fail('first App.stop did not succeed', report.stopResults);
  if (
    report.stopResults?.second?.ok !== false ||
    report.stopResults.second.error?.code !== 'app-not-started'
  ) {
    fail('second App.stop was not the documented no-op Result', report.stopResults);
  }
  if (
    report.bindingCloseResults?.first?.ok !== true ||
    report.bindingCloseResults?.second?.ok !== true
  ) {
    fail('repeated Host binding close did not complete idempotently', report.bindingCloseResults);
  }
}

function assertCommon(report) {
  assertWorkerTier(report);
  if (report.failure !== null) fail('M29 page or Worker reported a failure', report.failure);
  const worker = report.workerResult;
  if (worker?.sessionIdentityCalls !== 2) {
    fail('M29 session identity factory was called by the wrong requests', worker);
  }

  const initial = requiredEvent(report, 'initial-submitted');
  if (
    initial.detail.keepActivityId === initial.detail.rejectedActivityId ||
    initial.detail.rejectedSession?.providerId !== 'm29.host.rejection'
  ) {
    fail('M29 did not allocate distinct activities with the expected SessionRef', initial.detail);
  }
  requiredEvent(report, 'keep-completed');
  requiredEvent(report, 'worker-finished');
  requiredEvent(report, 'close-requested');

  const provider = report.provider;
  if (
    provider.closeCalls !== 1 ||
    provider.activeCountAtClose !== 0 ||
    provider.activeCount !== 0 ||
    provider.closed !== true
  ) {
    fail('M29 Host provider cleanup proof failed', provider);
  }
  assertCleanup(report);
}

function assertNormal(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (
    report.rejectionTrace?.observed !== 1 ||
    report.rejectionTrace?.delivered !== 1 ||
    report.rejectionTrace?.dropped !== 0
  ) {
    fail('M29 normal case did not deliver exactly one Host rejection terminal', report.rejectionTrace);
  }
  if (report.hostSubmittedInputs.join('|') !== 'keep-live|host-reject|retry') {
    fail('M29 normal dispatch roster changed', report.hostSubmittedInputs);
  }
  requiredEvent(report, 'host-rejection-observed');
  requiredEvent(report, 'cancel-after-rejection');
  requiredEvent(report, 'retry-submitted');
  requiredEvent(report, 'retry-completed');
  if (worker?.activityIdentityCalls !== 3) {
    fail('M29 normal case did not allocate a fresh retry ActivityId', worker);
  }
  const proof = worker.proof;
  if (
    proof?.pendingText !== 'keep:' ||
    proof.keepOutput !== 'keep-ok' ||
    proof.preTerminalMutationAttempts <= 0 ||
    proof.rejectionTerminalCount !== 1 ||
    proof.rejection?.code !== 'intelligence-capacity-exceeded' ||
    proof.rejection?.detail?.limit !== 1 ||
    proof.cancelAfterRejection?.ok !== false ||
    proof.cancelAfterRejection?.error?.code !== 'intelligence-activity-not-found'
  ) {
    fail('M29 Host rejection terminal or optimistic-set release proof failed', proof);
  }
  if (report.workerResult?.ok !== true || report.workerResult?.falsifierCaught !== false) {
    fail('normal M29 Worker run did not pass', report.workerResult);
  }
  if (
    worker.sameSession !== true ||
    proof.keepOutput !== 'keep-ok' ||
    proof.retryOutput !== 'retry-ok' ||
    proof.acceptedTerminalCount !== 2 ||
    proof.authoritativeMutationCount !== 2 ||
    proof.authoritativeOutputs.join('|') !== 'keep-ok|retry-ok'
  ) {
    fail('M29 sibling preservation or same-session retry proof failed', worker);
  }
  const provider = report.provider;
  if (
    provider.startCalls !== 2 ||
    provider.starts?.map((item) => item.input).join('|') !== 'keep-live|retry'
  ) {
    fail('M29 Host provider accepted the wrong activity roster', provider);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  if (report.hostSubmittedInputs.join('|') !== 'keep-live|host-reject') {
    fail('M29 falsifier unexpectedly retried the rejected activity', report.hostSubmittedInputs);
  }
  if (
    report.rejectionTrace?.observed !== 1 ||
    report.rejectionTrace?.delivered !== 0 ||
    report.rejectionTrace?.dropped !== 1
  ) {
    fail('M29 falsifier did not drop exactly one Host rejection terminal', report.rejectionTrace);
  }
  if (
    report.workerEvents.some(
      (item) => item.event === 'host-rejection-observed' || item.event === 'cancel-after-rejection',
    )
  ) {
    fail('M29 falsifier unexpectedly observed the dropped rejection in the Worker', report.workerEvents);
  }
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.sameSession !== false) {
    fail('M29 dropped-rejection falsifier was not caught', worker);
  }
  if (
    worker.proof?.keepOutput !== 'keep-ok' ||
    worker.proof?.retryOutput !== '' ||
    worker.proof?.rejectionTerminalCount !== 0 ||
    worker.proof?.acceptedTerminalCount !== 1 ||
    worker.proof?.authoritativeMutationCount !== 1 ||
    worker.proof?.authoritativeOutputs.join('|') !== 'keep-ok'
  ) {
    fail('M29 falsifier exposed unexpected authoritative state', worker.proof);
  }
  const provider = report.provider;
  if (
    provider.startCalls !== 1 ||
    provider.starts?.map((item) => item.input).join('|') !== 'keep-live'
  ) {
    fail('M29 falsifier caused the rejected request to reach the provider', provider);
  }
}

async function captureCanvas(page, name) {
  const bytes = await page.locator('#game').screenshot();
  const evidence = {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (artifactDir) writeFileSync(join(artifactDir, name), bytes);
  return evidence;
}

async function runCase(browser, falsify, screenshotName) {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleLogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleLogs.push(`${message.type()}: ${message.text()}`));
  try {
    await page.goto(`http://127.0.0.1:${port}/m29.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM29Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM29Report?.());
    if (report === undefined) fail('M29 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M29 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM29Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M29 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm29-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M29 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm29-falsifier.png');
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M29 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm29-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M29_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
