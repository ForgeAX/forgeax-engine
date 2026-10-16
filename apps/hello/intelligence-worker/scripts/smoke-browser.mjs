import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5212;
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
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M26 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function eventByName(report, name) {
  return report.workerEvents.find((item) => item.event === name);
}

function requiredEvent(report, name) {
  const event = eventByName(report, name);
  if (event === undefined) fail(`M26 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M26 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M26 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M26 Worker capability was not available', execution.capabilities);
  }
}

function assertOverflow(detail, activityId, label) {
  if (
    detail?.code !== 'intelligence-output-overflow' ||
    detail.activityId !== activityId ||
    detail.bound !== 'output-chars' ||
    detail.limit !== 8
  ) {
    fail(`${label} was not the exact structured output-chars failure`, detail);
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
    fail('repeated Host binding close did not complete cleanly', report.bindingCloseResults);
  }
}

function assertNormal(report) {
  assertWorkerTier(report);
  const worker = report.workerResult;
  if (worker?.ok !== true) fail('normal M26 Worker run did not pass', worker);
  if (worker.closePromiseSame !== true) fail('Worker close was not idempotent', worker);
  if (worker.failedProviderEvents !== 1 || worker.completedEvents !== 7 || worker.cancelledEvents !== 1) {
    fail('terminal event cardinality changed', worker);
  }
  if (worker.outputLimit !== 8 || worker.pendingEventsLimit !== 32) {
    fail('M26 did not configure character and queue limits independently', worker);
  }

  const initial = requiredEvent(report, 'initial-submitted');
  if (initial.detail.capacityError !== 'intelligence-capacity-exceeded') {
    fail('Worker capacity refusal was not observed', initial);
  }
  if (requiredEvent(report, 'start-retried').detail.sameSession !== true) {
    fail('provider start retry did not retain SessionRef', report.workerEvents);
  }

  const exact = requiredEvent(report, 'exact-limit-submitted');
  if (exact.detail.outputCharsLimit !== 8 || worker.proof?.exactLimitOutput !== '12345678') {
    fail('exact-limit control did not complete normally', { exact, proof: worker.proof });
  }

  const submitted = requiredEvent(report, 'output-submitted');
  if (
    submitted.detail.outputCharsLimit !== 8 ||
    submitted.detail.pendingEventsLimit !== 32 ||
    submitted.detail.expectedStreamPartialText !== '12345678' ||
    submitted.detail.expectedStreamCrossingText !== '!' ||
    submitted.detail.expectedCompletionLength !== 9 ||
    submitted.detail.providerId !== 'm26.host.deterministic'
  ) {
    fail('M26 did not publish the exact output boundary setup', submitted);
  }
  const streamId = submitted.detail.streamActivityId;
  const completionId = submitted.detail.completionActivityId;
  if (worker.terminalCounts?.[streamId] !== 1 || worker.terminalCounts?.[completionId] !== 1) {
    fail('each output overflow Activity did not produce exactly one terminal event', worker.terminalCounts);
  }
  const streamFailed = requiredEvent(report, 'stream-overflow-failed');
  const completionFailed = requiredEvent(report, 'completion-overflow-failed');
  assertOverflow(streamFailed.detail, streamId, 'stream overflow');
  assertOverflow(completionFailed.detail, completionId, 'completion overflow');
  if (requiredEvent(report, 'output-retried').detail.sameSession !== true) {
    fail('output retry did not retain the provider-scoped SessionRef', report.workerEvents);
  }

  const proof = worker.proof;
  if (
    proof?.prematureMutationCount !== 0 ||
    proof.authoritativeMutationCount !== proof.acceptedTerminalCount ||
    proof.preTerminalMutationAttempts <= 0 ||
    proof.lateDeltaEvents !== 0 ||
    proof.streamPartialText !== '12345678' ||
    proof.streamPartialDeltaCount !== 8 ||
    proof.streamPreTerminalMutationAttempts !== 8 ||
    proof.streamFailedTerminalCount !== 1 ||
    proof.streamFailure?.code !== 'intelligence-output-overflow' ||
    proof.streamFailure.detail.bound !== 'output-chars' ||
    proof.streamFailure.detail.limit !== 8 ||
    proof.completionPreTerminalMutationAttempts !== 0 ||
    proof.completionFailedTerminalCount !== 1 ||
    proof.completionFailure?.code !== 'intelligence-output-overflow' ||
    proof.completionFailure.detail.bound !== 'output-chars' ||
    proof.completionFailure.detail.limit !== 8 ||
    proof.streamLateDeltaEvents !== 0 ||
    proof.streamLateCompletionEvents !== 0 ||
    proof.completionLateDeltaEvents !== 0 ||
    proof.completionLateCompletionEvents !== 0
  ) {
    fail('non-terminal or post-overflow data mutated authoritative World state', proof);
  }

  const provider = report.provider;
  if (
    provider.startThrows !== 1 ||
    provider.streamOutputAttempts !== 9 ||
    provider.streamOutputReturned !== true ||
    provider.completionOutputAttempts !== 1 ||
    provider.completionOutputReturned !== true ||
    provider.outputCancelThrows !== 2 ||
    provider.cancelFailures?.length !== 3
  ) {
    fail('Host provider fault injection did not run once per boundary', provider);
  }
  if (
    provider.cancelFailures.some(
      (item) => item.code !== 'intelligence-provider-failed' || item.providerId !== 'm26.host.deterministic',
    )
  ) {
    fail('provider cancellation throws lost their structured trace', provider);
  }
  const cancelAttempts = provider.cancels?.filter((item) => item.input === 'late-cancel');
  if (
    cancelAttempts?.length !== 2 ||
    cancelAttempts[0]?.outcome !== 'provider-throw' ||
    cancelAttempts[1]?.outcome !== 'cancelled'
  ) {
    fail('cancel recovery did not preserve the Activity for retry', provider);
  }
  if (
    provider.lateDeltaAttempts !== 3 ||
    provider.lateCompletionAttempts !== 3 ||
    provider.activeCount !== 0 ||
    provider.closed !== true ||
    provider.closeCalls !== 1 ||
    provider.activeCountAtClose !== 0
  ) {
    fail('provider cleanup or late-output quarantine was not idempotent', provider);
  }
  assertCleanup(report);
}

function assertFalsifier(report) {
  assertWorkerTier(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true) {
    fail('pre-terminal mutation falsifier was not rejected', worker);
  }
  if (
    worker.proof?.prematureMutationCount !== 1 ||
    worker.proof.authoritativeOutputs?.length <= worker.proof.acceptedTerminalCount ||
    worker.proof.exactLimitOutput !== '12345678' ||
    worker.proof.streamFailedTerminalCount !== 1 ||
    worker.proof.completionFailedTerminalCount !== 1
  ) {
    fail('falsifier did not prove pre-terminal mutation while exact control stayed green', worker.proof);
  }
  const submitted = requiredEvent(report, 'output-submitted');
  assertOverflow(requiredEvent(report, 'stream-overflow-failed').detail, submitted.detail.streamActivityId, 'falsifier stream overflow');
  assertOverflow(
    requiredEvent(report, 'completion-overflow-failed').detail,
    submitted.detail.completionActivityId,
    'falsifier completion overflow',
  );
  if (report.provider?.lateDeltaAttempts !== 3 || report.provider?.lateCompletionAttempts !== 3) {
    fail('falsifier did not inject post-overflow output and completion', report.provider);
  }
  assertCleanup(report);
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
    await page.goto(`http://127.0.0.1:${port}/?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () => globalThis.__forgeaxM26Done === true,
      null,
      { timeout: 30_000 },
    );
    const report = await page.evaluate(() => globalThis.__forgeaxM26Report?.());
    if (report === undefined) fail('M26 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M26 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM26Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M26 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm26-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M26 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm26-falsifier.png');
      assertFalsifier(falsifier.report);
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm26-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M26_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
