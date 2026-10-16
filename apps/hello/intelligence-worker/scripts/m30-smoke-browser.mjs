import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5217;
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
      const response = await fetch(`http://127.0.0.1:${port}/m30.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M30 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function requiredEvent(report, name) {
  const event = report.workerEvents.find((item) => item.event === name);
  if (event === undefined) fail(`M30 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M30 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M30 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M30 Worker capability was not available', execution.capabilities);
  }
}

function assertPollTrace(report) {
  for (const providerId of ['providerA', 'providerB']) {
    const trace = report.ports?.[providerId];
    if (
      trace === undefined ||
      trace.pollRequests <= 0 ||
      trace.pollResponses !== trace.pollRequests ||
      trace.pollOutstanding !== 0 ||
      trace.maxPollOutstanding !== 1
    ) {
      fail(`M30 ${providerId} one-credit poll accounting failed`, trace);
    }
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
    report.bindingCloseResults?.providerA?.first?.ok !== true ||
    report.bindingCloseResults.providerA.second?.ok !== true ||
    report.bindingCloseResults.providerB?.first?.ok !== true ||
    report.bindingCloseResults.providerB.second?.ok !== true
  ) {
    fail('repeated Host binding close did not complete idempotently', report.bindingCloseResults);
  }
  for (const providerId of ['providerA', 'providerB']) {
    const provider = report[providerId];
    const port = report.ports?.[providerId];
    if (
      provider?.closeCalls !== 1 ||
      provider.activeCountAtClose !== 0 ||
      provider.activeCount !== 0 ||
      provider.closed !== true ||
      port?.closeMessages !== 2
    ) {
      fail(`M30 ${providerId} cleanup proof failed`, { provider, port });
    }
  }
  const closeRequested = requiredEvent(report, 'close-requested');
  if (
    closeRequested.detail?.clientClosePromiseSame?.providerA !== true ||
    closeRequested.detail?.clientClosePromiseSame?.providerB !== true
  ) {
    fail('M30 Worker client close was not idempotent', closeRequested);
  }
}

function assertCommon(report) {
  assertWorkerTier(report);
  assertPollTrace(report);
  assertCleanup(report);
  if (report.failure !== null) fail('M30 page or Worker reported a failure', report.failure);
  requiredEvent(report, 'provider-a-submitted');
  requiredEvent(report, 'provider-mismatch-rejected');
  requiredEvent(report, 'worker-finished');
}

function assertNormal(report) {
  assertCommon(report);
  const worker = report.workerResult;
  const mismatch = requiredEvent(report, 'provider-mismatch-rejected').detail;
  if (worker?.ok !== true || worker.falsifierCaught !== false || worker.failure !== null) {
    fail('normal M30 Worker run did not pass', worker);
  }
  if (
    mismatch.code !== 'intelligence-session-provider-mismatch' ||
    mismatch.detail?.expectedProviderId !== 'm30.host.provider-b' ||
    mismatch.detail?.receivedProviderId !== 'm30.host.provider-a' ||
    mismatch.activityIdentityCalls !== 0 ||
    mismatch.sessionIdentityCalls !== 0 ||
    mismatch.authoritativeMutationCount !== 1
  ) {
    fail('M30 mismatch was not rejected before provider-B side effects', mismatch);
  }
  const proof = worker.proof;
  if (
    worker.activityIdentityCalls?.providerA !== 2 ||
    worker.activityIdentityCalls?.providerB !== 1 ||
    worker.sessionIdentityCalls?.providerA !== 1 ||
    worker.sessionIdentityCalls?.providerB !== 1 ||
    worker.sameSession !== true ||
    proof?.pendingA !== 'a:' ||
    proof.pendingB !== 'b:' ||
    proof.preTerminalMutationAttempts !== 2 ||
    proof.prematureMutationCount !== 0 ||
    proof.authoritativeMutationCount !== 3 ||
    proof.authoritativeOutputs?.[report.workerEvents.find((item) => item.event === 'provider-a-submitted')?.detail.activityId] !== 'a-first-ok'
  ) {
    fail('M30 provider/session/World proof failed', worker);
  }
  const outputs = Object.values(proof.authoritativeOutputs ?? {}).sort().join('|');
  if (outputs !== 'a-first-ok|a-retry-ok|b-valid-ok') {
    fail('M30 terminal outputs changed', proof.authoritativeOutputs);
  }
  const providerA = report.providerA;
  const providerB = report.providerB;
  if (
    providerA?.starts?.map((item) => item.input).join('|') !== 'a-first|a-retry' ||
    providerB?.starts?.map((item) => item.input).join('|') !== 'b-valid' ||
    report.ports.providerA.submittedInputs.join('|') !== 'a-first|a-retry' ||
    report.ports.providerB.submittedInputs.join('|') !== 'b-valid' ||
    report.ports.providerB.rejectionMessages !== 0
  ) {
    fail('M30 normal Host/provider dispatch roster changed', {
      providerA,
      providerB,
      ports: report.ports,
    });
  }
  for (const name of ['provider-b-submitted', 'provider-a-retry-submitted']) requiredEvent(report, name);
  if (report.workerEvents.some((item) => item.event === 'falsifier-injected')) {
    fail('M30 normal case unexpectedly injected its falsifier', report.workerEvents);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.failure !== null) {
    fail('M30 raw-submit falsifier was not caught', worker);
  }
  requiredEvent(report, 'falsifier-injected');
  const caught = requiredEvent(report, 'falsifier-caught');
  if (!String(caught.detail?.reason).includes('unexpected provider-B event')) {
    fail('M30 falsifier did not identify the unexpected provider-B activity', caught);
  }
  if (
    report.ports.providerA.submittedInputs.join('|') !== 'a-first' ||
    report.ports.providerB.submittedInputs.join('|') !== 'b-mismatch' ||
    report.ports.providerB.rejectionMessages !== 1
  ) {
    fail('M30 falsifier reached the wrong Host dispatch path', report.ports);
  }
  const proof = worker.proof;
  if (
    worker.activityIdentityCalls?.providerA !== 1 ||
    worker.activityIdentityCalls?.providerB !== 0 ||
    worker.sessionIdentityCalls?.providerA !== 1 ||
    worker.sessionIdentityCalls?.providerB !== 0 ||
    worker.sameSession !== false ||
    proof?.authoritativeMutationCount !== 1 ||
    proof.prematureMutationCount !== 0 ||
    Object.values(proof.authoritativeOutputs ?? {}).sort().join('|') !== 'a-first-ok'
  ) {
    fail('M30 falsifier exposed unexpected authoritative or identity state', worker);
  }
  if (
    report.providerA?.starts?.map((item) => item.input).join('|') !== 'a-first' ||
    report.providerB?.starts?.length !== 0 ||
    report.providerB?.startCalls !== 0
  ) {
    fail('M30 falsifier reached provider-B start', report.providerB);
  }
  if (report.workerEvents.some((item) => item.event === 'provider-b-submitted')) {
    fail('M30 falsifier unexpectedly continued into valid provider-B work', report.workerEvents);
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
    await page.goto(`http://127.0.0.1:${port}/m30.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM30Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM30Report?.());
    if (report === undefined) fail('M30 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M30 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM30Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M30 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm30-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M30 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm30-falsifier.png');
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M30 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm30-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M30_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
