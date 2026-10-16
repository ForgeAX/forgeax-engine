import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5224;
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const gauntlet = process.argv.includes('--gauntlet');
const artifactDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
if (gauntlet && artifactDir) mkdirSync(artifactDir, { recursive: true });

const server = await preview({
  root: appRoot,
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
      const response = await fetch(`http://127.0.0.1:${port}/m38.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M38 preview server deadline exceeded');
}

function requiredEvent(report, name) {
  const event = report.workerEvents?.find((item) => item.event === name);
  if (event === undefined) fail(`M38 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M38 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M38 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M38 Worker capability was not available', execution.capabilities);
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
      fail(`M38 repeated ${providerId} binding close did not settle`, report.bindingCloseResults);
    }
    if (report.bindingClosePromiseSame?.[providerId] !== true) {
      fail(`M38 ${providerId} binding close did not reuse one Promise`, report.bindingClosePromiseSame);
    }
    const provider = report[providerId];
    if (provider?.closeCalls !== 1 || provider.activeCount !== 0 || provider.closed !== true) {
      fail(`M38 ${providerId} provider cleanup proof failed`, provider);
    }
  }
  if (report.providerB?.cancelCalls < 1) {
    fail('M38 Host cleanup did not cancel active poll target work', report.providerB);
  }
  if (report.providerB?.lateCallbackAttempts !== 2) {
    fail('M38 late provider callbacks were not exercised after cleanup', report.providerB);
  }
  const cleanup = requiredEvent(report, 'cleanup-requested');
  if (
    cleanup.detail?.clientClosePromiseSame?.providerA !== true ||
    cleanup.detail?.clientClosePromiseSame?.providerC !== true
  ) {
    fail('M38 repeated Worker client cleanup did not reuse one Promise', cleanup);
  }
}

function assertProof(worker) {
  const proof = worker.proof;
  if (
    proof?.preTerminalMutationAttempts !== 2 ||
    proof.authoritativeMutationCount !== 2 ||
    proof.targetEventsReturned !== 0
  ) {
    fail('M38 terminal-only World mutation proof failed', proof);
  }
  const outputs = Object.values(proof.authoritativeOutputs ?? {}).sort().join('|');
  if (outputs !== 'control-ok|fresh-ok') fail('M38 authoritative outputs changed', proof);
  const sequences = Object.values(proof.perActivitySequences ?? {})
    .map((value) => JSON.stringify(value))
    .sort();
  if (sequences.join('|') !== '[1,2]|[1,2]') fail('M38 activity sequence proof failed', proof);
}

function assertCommon(report) {
  assertWorkerTier(report);
  if (report.failure !== null) fail('M38 page reported a failure', report.failure);
  if (report.freshChannelCreated !== true) fail('M38 did not create a fresh same-page channel', report);
  for (const event of [
    'control-submitted',
    'target-submitted',
    report.falsify ? 'poll-response-fault-escaped' : 'poll-response-fault-contained',
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
    fail('normal M38 Worker run did not pass', worker);
  }
  if (worker.controlId === worker.freshId || worker.retainedSession?.providerId !== 'm38.host.control') {
    fail('M38 fresh recovery did not use a distinct ActivityId and retained SessionRef', worker);
  }
  const trace = worker.clientTrace?.providerB;
  if (
    trace?.pollOutcome !== 'closed' ||
    trace.pollAttempts !== 1 ||
    trace.closedObserved !== true ||
    trace.stagedEventObserved !== false ||
    trace.removeListenerCalls !== 1 ||
    trace.physicalCloseCalls !== 1 ||
    trace.postFaultCommands.length !== 0 ||
    trace.pollResult?.error?.code !== 'intelligence-closed'
  ) {
    fail('normal M38 poll response fault did not release the Worker client', trace);
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
    probe.commandCountBefore !== probe.commandCountAfter
  ) {
    fail('normal M38 post-fault client contract failed', probe);
  }
  const host = worker.hostClose;
  if (
    host?.origin !== 'host-binding.after-poll-response-fault' ||
    host.faultOutcome !== 'contained' ||
    host.activeCountBeforeCleanup !== 1 ||
    host.activeCountAtClose !== 1 ||
    host.hostCloseSettled !== true ||
    host.hostCloseRejected !== false ||
    host.physicalCloseCalls !== 1 ||
    host.pollResponseFaultAttempts !== 1 ||
    host.nonEmptyPollResponses !== 1
  ) {
    fail('normal M38 Host cleanup proof failed', host);
  }
  const traceB = report.ports.providerB;
  if (
    traceB?.pollRequests !== 1 ||
    traceB.pollResponses !== 1 ||
    traceB.nonEmptyPollResponses !== 1 ||
    traceB.pollResponseFaultAttempts !== 1 ||
    traceB.pollResponseFaultInjected !== true ||
    traceB.closeMessages !== 1 ||
    traceB.listenerRemoveCalls !== 1 ||
    traceB.physicalCloseCalls !== 1 ||
    traceB.postCleanupHostCommands.length !== 0
  ) {
    fail('normal M38 Host transport trace was not exactly once', traceB);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.failure !== null) {
    fail('M38 Host poll-response falsifier was not caught', worker);
  }
  const trace = worker.clientTrace?.providerB;
  if (
    trace?.pollOutcome !== 'threw' ||
    trace.closedObserved !== false ||
    trace.stagedEventObserved !== false ||
    trace.postFaultCommands.join('|') !== 'intelligence-submit'
  ) {
    fail('M38 falsifier did not expose the uncontained Host response fault', trace);
  }
  const probe = worker.probe;
  if (
    probe?.normalClientState !== false ||
    probe.falsifierState !== true ||
    probe.activeCountAfterFault < 2 ||
    probe.stagedEventCountBeforeProbe !== 0 ||
    probe.pollPendingAfterFault !== true ||
    probe.activityIdentityCallsAfter <= probe.activityIdentityCallsBefore ||
    probe.sessionIdentityCallsAfter <= probe.sessionIdentityCallsBefore ||
    probe.commandCountAfter <= probe.commandCountBefore ||
    !String(worker.falsifierReason).includes('uncontained Host poll response')
  ) {
    fail('M38 falsifier did not expose drained-event loss and live Host authority', worker);
  }
  const host = worker.hostClose;
  if (
    host?.origin !== 'host-binding.after-poll-response-fault' ||
    host.faultOutcome !== 'escaped' ||
    host.activeCountBeforeCleanup < 2 ||
    host.hostCloseSettled !== true ||
    host.hostCloseRejected !== false ||
    host.physicalCloseCalls !== 1
  ) {
    fail('M38 falsifier did not require explicit cleanup after leaked Host authority', host);
  }
  const traceB = report.ports.providerB;
  if (
    traceB?.pollResponseFaultInjected !== true ||
    traceB.pollResponseFaultAttempts !== 1 ||
    traceB.nonEmptyPollResponses !== 1 ||
    traceB.listenerRemoveCalls !== 1 ||
    traceB.physicalCloseCalls !== 1
  ) {
    fail('M38 falsifier Host cleanup trace was not recorded', traceB);
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
    await page.goto(`http://127.0.0.1:${port}/m38.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM38Done === true, null, { timeout: 30_000 });
    const report = await page.evaluate(() => globalThis.__forgeaxM38Report?.());
    if (report === undefined) fail('M38 page did not publish a report', report);
    if (!falsify && pageErrors.length > 0) fail('normal M38 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, `m38-${falsify ? 'falsifier' : 'normal'}.png`);
    const result = { report, canvas, consoleLogs, pageErrors };
    if (artifactDir) {
      writeFileSync(
        join(artifactDir, `m38-${falsify ? 'falsifier' : 'normal'}-raw.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
    return result;
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM38Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M38 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
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
      fail('normal M38 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true);
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M38 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = { ok: true, normal, ...(falsifier === undefined ? {} : { falsifier }) };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm38-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'm38-normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'm38-falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    process.stdout.write(
      gauntlet ? `M38_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n` : `${JSON.stringify(result)}\n`,
    );
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
