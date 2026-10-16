import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5223;
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
      const response = await fetch(`http://127.0.0.1:${port}/m37.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M37 preview server deadline exceeded');
}

function requiredEvent(report, name) {
  const event = report.workerEvents?.find((item) => item.event === name);
  if (event === undefined) fail(`M37 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M37 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M37 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M37 Worker capability was not available', execution.capabilities);
  }
}

function assertCleanup(report) {
  if (report.stopResults?.first?.ok !== true) fail('first App.stop did not succeed', report.stopResults);
  if (report.stopResults?.second?.ok !== false || report.stopResults.second.error?.code !== 'app-not-started') {
    fail('second App.stop was not the documented no-op Result', report.stopResults);
  }
  for (const providerId of ['providerA', 'providerB', 'providerC']) {
    const binding = report.bindingCloseResults?.[providerId];
    if (binding?.first?.ok !== true || binding.second?.ok !== true) {
      fail(`M37 repeated ${providerId} binding close did not settle`, report.bindingCloseResults);
    }
    if (report.bindingClosePromiseSame?.[providerId] !== true) {
      fail(`M37 ${providerId} binding close did not reuse one Promise`, report.bindingClosePromiseSame);
    }
    const provider = report[providerId];
    if (provider?.closeCalls !== 1 || provider.activeCount !== 0 || provider.closed !== true) {
      fail(`M37 ${providerId} provider cleanup proof failed`, provider);
    }
  }
  if (report.providerB?.cancelCalls !== 0) {
    fail('M37 cancel command reached the provider before explicit Host cleanup', report.providerB);
  }
  if (report.providerB?.lateCallbackAttempts !== 2) {
    fail('M37 late provider callbacks were not quarantined', report.providerB);
  }
  const cleanup = requiredEvent(report, 'cleanup-requested');
  if (
    cleanup.detail?.clientClosePromiseSame?.providerA !== true ||
    cleanup.detail?.clientClosePromiseSame?.providerC !== true
  ) {
    fail('M37 repeated client cleanup did not reuse one Promise', cleanup);
  }
  if (report.ports.providerB.cancelRequests !== 0) {
    fail('M37 Host observed a cancel command', report.ports.providerB);
  }
  if (report.ports.providerB.physicalCloseCalls !== 1) {
    fail('M37 Host physical target transport was not closed exactly once', report.ports.providerB);
  }
}

function assertProof(worker) {
  const proof = worker.proof;
  if (
    proof?.preTerminalMutationAttempts !== 2 ||
    proof.authoritativeMutationCount !== 2 ||
    proof.targetEventsReturned !== 0
  ) {
    fail('M37 terminal-only World mutation proof failed', proof);
  }
  const outputs = Object.values(proof.authoritativeOutputs ?? {}).sort().join('|');
  if (outputs !== 'control-ok|fresh-ok') fail('M37 authoritative outputs changed', proof);
  const sequences = Object.values(proof.perActivitySequences ?? {})
    .map((value) => JSON.stringify(value))
    .sort();
  if (sequences.join('|') !== '[1,2]|[1,2]') fail('M37 activity sequence proof failed', proof);
  if (proof.pendingText[worker.targetId] !== undefined) {
    fail('M37 staged target event mutated World state', proof);
  }
}

function assertCommon(report) {
  assertWorkerTier(report);
  if (report.failure !== null) fail('M37 page reported a failure', report.failure);
  if (report.freshChannelCreated !== true) fail('M37 did not create a fresh same-page channel', report);
  for (const event of [
    'initial-submitted',
    'cancel-fault-contained',
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
    fail('normal M37 Worker run did not pass', worker);
  }
  const trace = worker.clientTrace?.providerB;
  if (
    trace?.cancelOutcome !== 'closed' ||
    trace.cancelAttempts !== 1 ||
    trace.cancelThrowInjected !== true ||
    trace.stagedEventObserved !== true ||
    trace.stagedEventCountAtResponse !== 1 ||
    trace.removeListenerCalls !== 1 ||
    trace.physicalCloseCalls !== 1 ||
    trace.postFaultCommands.length !== 0 ||
    trace.cancelResult?.error?.code !== 'intelligence-closed'
  ) {
    fail('normal M37 cancel fault transport release was not exactly once', trace);
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
    fail('normal M37 post-fault client contract failed', probe);
  }
  const host = worker.hostClose;
  if (
    host?.origin !== 'host-binding.after-cancel-command-fault' ||
    host.cancelCallsBeforeClose !== 0 ||
    host.hostCloseSettled !== true ||
    host.hostCloseRejected !== false ||
    host.physicalCloseCalls !== 1
  ) {
    fail('normal M37 explicit Host cleanup proof failed', host);
  }
  if (
    report.providerA?.starts?.map((item) => item.input).join('|') !== 'control' ||
    report.providerB?.starts?.map((item) => item.input).join('|') !== 'cancel-target' ||
    report.providerC?.starts?.map((item) => item.input).join('|') !== 'fresh'
  ) {
    fail('normal M37 provider dispatch roster changed', report);
  }
  if (report.workerEvents.some((item) => item.event === 'falsifier-caught')) {
    fail('normal M37 unexpectedly reported a falsifier', report.workerEvents);
  }
}

function assertFalsifier(report) {
  assertCommon(report);
  const worker = report.workerResult;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.failure !== null) {
    fail('M37 cancel release falsifier was not caught', worker);
  }
  const trace = worker.clientTrace?.providerB;
  if (
    trace?.cancelOutcome !== 'threw' ||
    trace.cancelAttempts !== 1 ||
    trace.cancelThrowInjected !== true ||
    trace.stagedEventObserved !== true ||
    trace.removeListenerCalls !== 0 ||
    trace.physicalCloseCalls !== 0 ||
    trace.postFaultCommands.join('|') !== 'intelligence-submit|intelligence-cancel|intelligence-poll'
  ) {
    fail('M37 falsifier did not expose the uncontained cancel release', trace);
  }
  const probe = worker.probe;
  if (
    probe?.normalClientState !== false ||
    probe.falsifierState !== true ||
    probe.activeCountAfterFault < 2 ||
    probe.stagedEventCountBeforeProbe !== 1 ||
    probe.activityIdentityCallsAfter <= probe.activityIdentityCallsBefore ||
    probe.sessionIdentityCallsAfter <= probe.sessionIdentityCallsBefore ||
    probe.commandCountAfter <= probe.commandCountBefore ||
    !String(worker.falsifierReason).includes('uncontained cancel')
  ) {
    fail('M37 falsifier reason did not expose active-state and transport leakage', worker);
  }
  const host = worker.hostClose;
  if (
    host?.cancelCallsBeforeClose !== 0 ||
    host.hostCloseSettled !== true ||
    host.hostCloseRejected !== false ||
    host.physicalCloseCalls !== 1
  ) {
    fail('M37 falsifier did not isolate the client release failure', host);
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
    await page.goto(`http://127.0.0.1:${port}/m37.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM37Done === true, null, { timeout: 30_000 });
    const report = await page.evaluate(() => globalThis.__forgeaxM37Report?.());
    if (report === undefined) fail('M37 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M37 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, `m37-${falsify ? 'falsifier' : 'normal'}.png`);
    const result = { report, canvas, consoleLogs, pageErrors };
    if (artifactDir) {
      writeFileSync(
        join(artifactDir, `m37-${falsify ? 'falsifier' : 'normal'}-raw.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    }
    return result;
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM37Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M37 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
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
      fail('normal M37 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true);
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M37 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = { ok: true, normal, ...(falsifier === undefined ? {} : { falsifier }) };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm37-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'm37-normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'm37-falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    process.stdout.write(
      gauntlet ? `M37_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n` : `${JSON.stringify(result)}\n`,
    );
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
