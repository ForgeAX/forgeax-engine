import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5214;
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
      const response = await fetch(`http://127.0.0.1:${port}/m28.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M28 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function requiredEvent(report, name) {
  const event = report.workerEvents.find((item) => item.event === name);
  if (event === undefined) fail(`M28 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M28 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M28 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M28 Worker capability was not available', execution.capabilities);
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
    fail('repeated Host binding close did not complete idempotently', report);
  }
}

function assertCommon(report) {
  assertWorkerTier(report);
  if (report.failure !== null) fail('M28 page or Worker reported a failure', report.failure);
  if (report.hostSubmittedInputs.join('|') !== 'terminal|hold-open') {
    fail('M28 valid dispatch roster changed', report.hostSubmittedInputs);
  }

  const terminal = requiredEvent(report, 'terminal-submitted');
  const hold = requiredEvent(report, 'hold-submitted');
  if (terminal.detail.activityId === hold.detail.activityId) {
    fail('M28 did not allocate distinct terminal and held activities', { terminal, hold });
  }
  const closeRequested = requiredEvent(report, 'close-requested');
  if (closeRequested.detail.closePromiseSame !== true) {
    fail('Worker client close was not idempotent', closeRequested.detail);
  }
  requiredEvent(report, 'worker-finished');

  const worker = report.workerResult;
  const proof = worker?.proof;
  if (
    proof?.terminalOutput !== 'terminal-ok' ||
    proof.pendingText !== 'pending:' ||
    proof.preTerminalMutationAttempts <= 0 ||
    proof.acceptedTerminalCount !== 1 ||
    proof.authoritativeMutationCount !== proof.acceptedTerminalCount
  ) {
    fail('M28 terminal-only World authority proof failed', proof);
  }

  const provider = report.provider;
  if (
    provider.startCalls !== 2 ||
    provider.starts?.map((item) => item.input).join('|') !== 'terminal|hold-open' ||
    provider.closeCalls !== 1 ||
    provider.activeCountAtClose !== 1 ||
    provider.activeCount !== 0 ||
    provider.closed !== true ||
    provider.lateCallbackAttempts !== 1 ||
    provider.eventsObservedDuringClose?.length !== 0
  ) {
    fail('M28 Host close-fault containment or late-callback proof failed', provider);
  }

  const fresh = report.freshRecovery;
  if (
    fresh?.submitted !== true ||
    fresh.starts !== 1 ||
    fresh.closeSettled !== true ||
    fresh.events?.length !== 1 ||
    fresh.events[0]?.type !== 'completed' ||
    fresh.events[0]?.output !== 'fresh-ok'
  ) {
    fail('M28 same-page fresh binding recovery failed', fresh);
  }
  assertCleanup(report);
}

function assertNormal(report) {
  assertCommon(report);
  if (report.workerResult?.ok !== true || report.workerResult?.falsifierCaught !== false) {
    fail('normal M28 Worker run did not pass', report.workerResult);
  }
  if (
    report.workerResult.proof.prematureMutationCount !== 0 ||
    report.workerResult.proof.authoritativeOutputs.join('|') !== 'terminal-ok'
  ) {
    fail('normal M28 run mutated World before a terminal', report.workerResult.proof);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true) {
    fail('M28 pre-terminal mutation falsifier was not rejected', worker);
  }
  if (
    worker.proof?.prematureMutationCount !== 1 ||
    worker.proof.authoritativeOutputs.length !== worker.proof.acceptedTerminalCount + 1
  ) {
    fail('M28 falsifier did not expose premature World mutation', worker.proof);
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
    await page.goto(`http://127.0.0.1:${port}/m28.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM28Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM28Report?.());
    if (report === undefined) fail('M28 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M28 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM28Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M28 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm28-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M28 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm28-falsifier.png');
      assertFalsifier(falsifier.report);
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm28-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M28_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
