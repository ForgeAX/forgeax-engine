import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5213;
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
      const response = await fetch(`http://127.0.0.1:${port}/m27.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M27 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function requiredEvent(report, name) {
  const event = report.workerEvents.find((item) => item.event === name);
  if (event === undefined) fail(`M27 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M27 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M27 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M27 Worker capability was not available', execution.capabilities);
  }
}

function assertInvalidRequest(value, reason) {
  if (
    value?.ok !== false ||
    value.code !== 'intelligence-invalid-request' ||
    value.detail?.field !== 'input' ||
    value.detail?.reason !== reason
  ) {
    fail(`M27 ${reason} rejection was not structured`, value);
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
  if (report.failure !== null) fail('M27 page or Worker reported a failure', report.failure);
  const worker = report.workerResult;
  if (worker?.inputLimit !== 4) fail('M27 input limit was not configured to four', worker);
  assertInvalidRequest(worker.invalidRequests?.empty, 'input is empty');
  assertInvalidRequest(worker.invalidRequests?.overLimit, 'input exceeds 4 characters');
  if (worker.activityIdentityCalls !== 3 || worker.sessionIdentityCalls !== 2) {
    fail('invalid requests consumed Worker identity factories', worker);
  }
  if (report.hostSubmittedInputs.includes('') || report.hostSubmittedInputs.includes('abcde')) {
    fail('invalid input crossed the Host MessagePort', report.hostSubmittedInputs);
  }
  if (report.hostSubmittedInputs.join('|') !== 'abcd|sib|rtry') {
    fail('valid input dispatch roster changed', report.hostSubmittedInputs);
  }

  const initial = requiredEvent(report, 'initial-submitted');
  assertInvalidRequest(initial.detail.empty, 'input is empty');
  assertInvalidRequest(initial.detail.overLimit, 'input exceeds 4 characters');
  if (initial.detail.activityIdentityCalls !== 2 || initial.detail.sessionIdentityCalls !== 2) {
    fail('invalid initial requests consumed identity before event publication', initial.detail);
  }
  const retry = requiredEvent(report, 'retry-submitted');
  if (retry.detail.sameSession !== true) fail('valid retry did not retain SessionRef', retry.detail);

  if (
    worker.completedEvents !== 3 ||
    worker.terminalCounts?.[initial.detail.exactActivityId] !== 1 ||
    worker.terminalCounts?.[initial.detail.siblingActivityId] !== 1 ||
    worker.terminalCounts?.[retry.detail.activityId] !== 1
  ) {
    fail('M27 terminal cardinality changed', worker);
  }
  const proof = worker.proof;
  if (
    proof?.exactOutput !== 'abcd' ||
    proof.siblingOutput !== 'sibling-ok' ||
    proof.retryOutput !== 'retry-ok' ||
    proof.preTerminalMutationAttempts <= 0 ||
    proof.authoritativeMutationCount !== proof.acceptedTerminalCount
  ) {
    fail('M27 terminal-only World authority proof failed', proof);
  }

  const provider = report.provider;
  if (
    provider.startCalls !== 3 ||
    provider.invalidStartInputs?.length !== 0 ||
    provider.starts?.map((item) => item.input).join('|') !== 'abcd|sib|rtry' ||
    provider.activeCount !== 0 ||
    provider.closed !== true ||
    provider.closeCalls !== 1 ||
    provider.activeCountAtClose !== 0
  ) {
    fail('M27 Host provider boundary or cleanup proof failed', provider);
  }
  assertCleanup(report);
}

function assertNormal(report) {
  assertCommon(report);
  if (report.workerResult?.ok !== true || report.workerResult?.falsifierCaught !== false) {
    fail('normal M27 Worker run did not pass', report.workerResult);
  }
  if (report.workerResult.proof.prematureMutationCount !== 0) {
    fail('normal M27 run mutated World before a terminal', report.workerResult.proof);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true) {
    fail('M27 pre-terminal mutation falsifier was not rejected', worker);
  }
  if (
    worker.proof?.prematureMutationCount !== 1 ||
    worker.proof.authoritativeOutputs.length !== worker.proof.acceptedTerminalCount + 1
  ) {
    fail('M27 falsifier did not expose premature World mutation', worker.proof);
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
    await page.goto(`http://127.0.0.1:${port}/m27.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM27Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM27Report?.());
    if (report === undefined) fail('M27 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M27 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM27Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M27 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm27-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M27 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm27-falsifier.png');
      assertFalsifier(falsifier.report);
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm27-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M27_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
