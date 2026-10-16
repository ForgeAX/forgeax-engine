import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5216;
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
      const response = await fetch(`http://127.0.0.1:${port}/m31.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M31 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function requiredEvent(report, name) {
  const event = report.workerEvents.find((item) => item.event === name);
  if (event === undefined) fail(`M31 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M31 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M31 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M31 Worker capability was not available', execution.capabilities);
  }
}

function assertPollTrace(report) {
  const trace = report.pollTrace;
  if (
    trace?.requests <= 0 ||
    trace.responses !== trace.requests ||
    trace.outstanding !== 0 ||
    trace.maxOutstanding !== 1 ||
    trace.requestedMaxEvents.some((value) => value !== 1)
  ) {
    fail('M31 one-credit poll accounting failed', trace);
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
  if (
    report.provider?.closeCalls !== 1 ||
    report.provider?.activeCount !== 0 ||
    report.provider?.closed !== true
  ) {
    fail('M31 provider cleanup proof failed', report.provider);
  }
  const closeRequested = requiredEvent(report, 'close-requested');
  if (closeRequested.detail?.closePromiseSame !== true) {
    fail('M31 client close was not idempotent', closeRequested);
  }
}

function assertCommon(report) {
  assertWorkerTier(report);
  assertPollTrace(report);
  assertCleanup(report);
  if (report.failure !== null) fail('M31 page or Worker reported a failure', report.failure);
  requiredEvent(report, 'initial-submitted');
  requiredEvent(report, 'worker-finished');
  const worker = report.workerResult;
  if (worker?.sessionIdentityCalls !== 2) {
    fail('M31 session identity factory was called by the wrong requests', worker);
  }
}

function assertNormal(report) {
  assertCommon(report);
  const initial = requiredEvent(report, 'initial-submitted').detail;
  const recovery = requiredEvent(report, 'recovery-submitted').detail;
  if (report.hostSubmittedInputs.join('|') !== 'first|second|after terminal') {
    fail('M31 normal dispatch roster changed', report.hostSubmittedInputs);
  }
  if (
    recovery.sameSession !== true ||
    recovery.activityId === initial.firstActivityId ||
    recovery.activityId === initial.secondActivityId
  ) {
    fail('M31 same-client recovery did not use a fresh ActivityId and SessionRef', recovery);
  }
  if (report.pollTrace.responseSizes.some((value) => value > 1)) {
    fail('M31 normal Host response exceeded maxPollEvents=1', report.pollTrace);
  }
  if (report.pollTrace.falsifierInjected !== false) {
    fail('M31 normal case unexpectedly injected its falsifier', report.pollTrace);
  }
  const worker = report.workerResult;
  if (worker?.ok !== true || worker.falsifierCaught !== false) {
    fail('normal M31 Worker run did not pass', worker);
  }
  const proof = worker.proof;
  if (
    proof?.preTerminalMutationAttempts !== 4 ||
    proof.prematureMutationCount !== 0 ||
    proof.acceptedTerminalCount !== 3 ||
    proof.authoritativeMutationCount !== 3 ||
    proof.bothInitialActivitiesObservedBeforeFirstTerminal !== true ||
    proof.pendingText?.[initial.firstActivityId] !== 'first-1first-2' ||
    proof.pendingText?.[initial.secondActivityId] !== 'second-1second-2' ||
    proof.authoritativeOutputs?.[initial.firstActivityId] !== 'first-ok' ||
    proof.authoritativeOutputs?.[initial.secondActivityId] !== 'second-ok' ||
    proof.authoritativeOutputs?.[recovery.activityId] !== 'after-ok'
  ) {
    fail('M31 terminal-only or no-starvation proof failed', proof);
  }
  if (
    JSON.stringify(proof.perActivitySequences?.[initial.firstActivityId]) !== JSON.stringify([1, 2, 3]) ||
    JSON.stringify(proof.perActivitySequences?.[initial.secondActivityId]) !== JSON.stringify([1, 2, 3]) ||
    JSON.stringify(proof.perActivitySequences?.[recovery.activityId]) !== JSON.stringify([1])
  ) {
    fail('M31 per-activity sequence proof failed', proof?.perActivitySequences);
  }
  const emissions = report.provider.emissions.map((item) => `${item.input}:${item.event}`).join('|');
  if (
    emissions !==
    'first:text-1|second:text-1|first:text-2|second:text-2|second:terminal|first:terminal|after terminal:terminal'
  ) {
    fail('M31 provider did not emit the deliberate interleaving', report.provider.emissions);
  }
  if (report.provider.starts.map((item) => item.input).join('|') !== 'first|second|after terminal') {
    fail('M31 provider accepted the wrong activity roster', report.provider);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  if (report.hostSubmittedInputs.join('|') !== 'first|second') {
    fail('M31 falsifier unexpectedly reached same-client recovery', report.hostSubmittedInputs);
  }
  if (report.pollTrace.falsifierInjected !== true || !report.pollTrace.responseSizes.includes(2)) {
    fail('M31 duplicate-event falsifier was not injected at the Host seam', report.pollTrace);
  }
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.failure !== null) {
    fail('M31 duplicate-event falsifier was not caught', worker);
  }
  if (
    worker.proof?.acceptedTerminalCount !== 0 ||
    worker.proof?.authoritativeMutationCount !== 0 ||
    worker.proof?.preTerminalMutationAttempts !== 1
  ) {
    fail('M31 falsifier exposed unexpected authoritative state', worker.proof);
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
    await page.goto(`http://127.0.0.1:${port}/m31.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM31Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM31Report?.());
    if (report === undefined) fail('M31 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M31 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM31Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M31 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm31-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M31 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm31-falsifier.png');
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M31 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm31-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M31_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
