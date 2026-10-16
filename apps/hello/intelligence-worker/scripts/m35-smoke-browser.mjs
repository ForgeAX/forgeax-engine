import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5221;
const gauntlet = process.argv.includes('--gauntlet');
const artifactDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
if (gauntlet && artifactDir) mkdirSync(artifactDir, { recursive: true });

const server = await preview({
  preview: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'error',
});

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/m35.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M35 preview server deadline exceeded');
}

function requiredEvent(report, name) {
  const event = report.workerEvents?.find((item) => item.event === name);
  if (event === undefined) fail(`M35 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M35 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M35 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M35 Worker capability was not available', execution.capabilities);
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
  for (const providerId of ['providerA', 'providerB', 'providerC']) {
    const binding = report.bindingCloseResults?.[providerId];
    if (binding?.first?.ok !== true || binding.second?.ok !== true) {
      fail(`M35 repeated ${providerId} binding close did not settle`, report.bindingCloseResults);
    }
    if (report.bindingClosePromiseSame?.[providerId] !== true) {
      fail(`M35 ${providerId} binding close did not reuse one Promise`, report.bindingClosePromiseSame);
    }
    const provider = report[providerId];
    if (provider?.closeCalls !== 1 || provider.activeCount !== 0 || provider.closed !== true) {
      fail(`M35 ${providerId} provider cleanup proof failed`, provider);
    }
  }
  if (report.providerB?.activeCountAtClose !== 1 || report.providerB?.lateCallbackAttempts !== 2) {
    fail('M35 late provider callbacks were not quarantined after Host cleanup', report.providerB);
  }
  const cleanup = requiredEvent(report, 'cleanup-requested');
  if (
    cleanup.detail?.clientClosePromiseSame?.providerA !== true ||
    cleanup.detail?.clientClosePromiseSame?.providerC !== true
  ) {
    fail('M35 repeated client cleanup did not reuse one Promise', cleanup);
  }
  if (report.ports.providerB.postCloseHostCommands.length !== 0) {
    fail('M35 Host received a post-close command', report.ports.providerB);
  }
}

function assertProof(worker) {
  const proof = worker.proof;
  if (
    proof?.preTerminalMutationAttempts !== 3 ||
    proof.prematureMutationCount !== 0 ||
    proof.acceptedTerminalCount !== 3 ||
    proof.authoritativeMutationCount !== 3
  ) {
    fail('M35 terminal-only World mutation proof failed', proof);
  }
  const outputs = Object.values(proof.authoritativeOutputs ?? {}).sort().join('|');
  if (outputs !== 'control-ok|fresh-ok|survivor-ok') fail('M35 authoritative outputs changed', proof);
  const sequences = Object.values(proof.perActivitySequences ?? {})
    .map((value) => JSON.stringify(value))
    .sort();
  if (sequences.join('|') !== '[1,2]|[1,2]|[1,2]') fail('M35 activity sequence proof failed', proof);
  if (proof.pendingText[worker.closingId] !== 'closing:') {
    fail('M35 closing activity did not produce only its pre-fault text witness', proof);
  }
}

function assertCommon(report) {
  assertWorkerTier(report);
  if (report.failure !== null) fail('M35 page reported a failure', report.failure);
  if (report.freshChannelCreated !== true) fail('M35 did not create a fresh same-page channel', report);
  for (const event of [
    'initial-submitted',
    'control-completed',
    'submit-fault-contained',
    'host-binding-closed-observed',
    'fault-probed',
    'fresh-port-requested',
    'fresh-submitted',
    'worker-finished',
    'cleanup-requested',
  ]) {
    requiredEvent(report, event);
  }
  assertCleanup(report);
  assertProof(report.workerResult);
}

function assertNormal(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== true || worker.falsifierCaught !== false || worker.failure !== null) {
    fail('normal M35 Worker run did not pass', worker);
  }
  const trace = worker.clientTrace?.providerB;
  if (
    trace?.faultOutcome !== 'closed' ||
    trace.faultSubmitAttempts !== 1 ||
    trace.faultThrowInjected !== true ||
    trace.removeListenerCalls !== 1 ||
    trace.physicalCloseCalls !== 1 ||
    trace.closePromiseSame !== true ||
    trace.postFaultCommands.length !== 0
  ) {
    fail('normal M35 submit fault transport release was not exactly once', trace);
  }
  const probe = worker.probe;
  if (
    probe?.normalClientState !== true ||
    probe.falsifierState !== false ||
    probe.submitAfterFault?.error?.code !== 'intelligence-closed' ||
    probe.cancelAfterFault?.error?.code !== 'intelligence-closed' ||
    probe.pollAfterFault?.length !== 0 ||
    probe.activityIdentityCallsBefore !== probe.activityIdentityCallsAfter ||
    probe.sessionIdentityCallsBefore !== probe.sessionIdentityCallsAfter ||
    probe.commandCountBefore !== probe.commandCountAfter ||
    probe.uncontainedActiveCount !== 0
  ) {
    fail('normal M35 post-fault client contract failed', probe);
  }
  const host = worker.hostClose;
  if (
    host?.origin !== 'host-binding.after-submit-command-fault' ||
    host.pollOutstandingAtClose !== 1 ||
    host.hostCloseSettled !== true ||
    host.hostCloseRejected !== false ||
    host.physicalCloseCalls !== 1 ||
    host.notificationAttempted !== true ||
    host.notificationForwarded !== true ||
    host.notificationSuppressed !== false
  ) {
    fail('normal M35 explicit Host cleanup proof failed', host);
  }
  if (
    report.providerA?.starts?.map((item) => item.input).join('|') !== 'survivor' ||
    report.providerB?.starts?.map((item) => item.input).join('|') !== 'control|closing' ||
    report.providerC?.starts?.map((item) => item.input).join('|') !== 'fresh'
  ) {
    fail('normal M35 provider dispatch roster changed', report);
  }
  if (report.workerEvents.some((item) => item.event === 'falsifier-caught')) {
    fail('normal M35 unexpectedly reported a falsifier', report.workerEvents);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.failure !== null) {
    fail('M35 submit release falsifier was not caught', worker);
  }
  const trace = worker.clientTrace?.providerB;
  if (
    trace?.faultOutcome !== 'threw' ||
    trace.faultSubmitAttempts !== 1 ||
    trace.faultThrowInjected !== true ||
    trace.removeListenerCalls !== 0 ||
    trace.physicalCloseCalls !== 0 ||
    trace.postFaultCommands.join('|') !==
      'intelligence-submit|intelligence-cancel|intelligence-poll'
  ) {
    fail('M35 falsifier did not expose the uncontained submit release', trace);
  }
  const probe = worker.probe;
  if (
    probe?.normalClientState !== false ||
    probe.falsifierState !== true ||
    probe.uncontainedActiveCount !== 1 ||
    probe.activityIdentityCallsAfter <= probe.activityIdentityCallsBefore ||
    probe.sessionIdentityCallsAfter <= probe.sessionIdentityCallsBefore ||
    !String(worker.falsifierReason).includes('optimistic')
  ) {
    fail('M35 falsifier reason did not name the uncontained optimistic state', worker);
  }
  const host = worker.hostClose;
  if (
    host?.pollOutstandingAtClose !== 1 ||
    host.hostCloseSettled !== true ||
    host.hostCloseRejected !== false ||
    host.physicalCloseCalls !== 1 ||
    host.notificationAttempted !== true ||
    host.notificationForwarded !== false ||
    host.notificationSuppressed !== true
  ) {
    fail('M35 falsifier did not isolate the client release failure', host);
  }
  if (report.providerB?.starts?.map((item) => item.input).join('|') !== 'control|closing') {
    fail('M35 falsifier sent the failed command into the Host provider', report.providerB);
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

async function runCase(browser, falsify) {
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleLogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleLogs.push(`${message.type()}: ${message.text()}`));
  try {
    await page.goto(`http://127.0.0.1:${port}/m35.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM35Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM35Report?.());
    if (report === undefined) fail('M35 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M35 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, `m35-${falsify ? 'falsifier' : 'normal'}.png`);
    const result = { report, canvas, consoleLogs, pageErrors };
    if (artifactDir) {
      writeFileSync(
        join(artifactDir, `m35-${falsify ? 'falsifier' : 'normal'}-raw.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
    return result;
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM35Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M35 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false);
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M35 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true);
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M35 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = { ok: true, normal, ...(falsifier === undefined ? {} : { falsifier }) };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm35-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'm35-normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'm35-falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    process.stdout.write(
      gauntlet
        ? `M35_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`
        : `${JSON.stringify(result)}\n`,
    );
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
