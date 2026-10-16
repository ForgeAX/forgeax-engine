import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { chromeLaunchOptions } from './chrome-options.mjs';

const port = 5218;
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
      const response = await fetch(`http://127.0.0.1:${port}/m32.html`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('M32 preview server deadline exceeded');
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function requiredEvent(report, name) {
  const event = report.workerEvents.find((item) => item.event === name);
  if (event === undefined) fail(`M32 did not publish ${name}`, report.workerEvents);
  return event;
}

function assertWorkerTier(report) {
  const execution = report.appReportBeforeStop;
  if (execution?.workers?.engine?.requested !== true || execution?.workers?.engine?.enabled !== true || execution?.workers?.render?.enabled !== false || execution?.workers?.kernels?.enabled !== false) {
    fail('M32 did not keep the explicit co-located Engine Worker policy', execution);
  }
  if (execution.engine?.realm !== 'worker') fail('M32 engine realm fell back to Host', execution);
  if (execution.capabilities?.worker?.available !== true) {
    fail('M32 Worker capability was not available', execution.capabilities);
  }
}

function assertPollTrace(report, falsifier) {
  const providerA = report.ports?.providerA;
  const providerB = report.ports?.providerB;
  if (
    providerA?.pollRequests <= 0 ||
    providerA.pollResponses !== providerA.pollRequests ||
    providerA.pollOutstanding !== 0 ||
    providerA.maxPollOutstanding !== 1
  ) {
    fail('M32 provider-A one-credit poll accounting failed', providerA);
  }
  if (
    (falsifier ? providerB?.pollRequests <= 1 : providerB?.pollRequests !== 1) ||
    providerB.pollResponses !== 1 ||
    providerB.pollOutstanding !== (falsifier ? 1 : 0) ||
    providerB.maxPollOutstanding !== 1 ||
    providerB.pollOutstandingAtClose !== 1
  ) {
    fail('M32 provider-B close did not occur with one outstanding poll', providerB);
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
      fail(`M32 repeated ${providerId} binding close did not settle`, report.bindingCloseResults);
    }
    if (report.bindingClosePromiseSame?.[providerId] !== true) {
      fail(`M32 ${providerId} binding close did not reuse one Promise`, report.bindingClosePromiseSame);
    }
  }
  for (const providerId of ['providerA', 'providerB', 'providerC']) {
    const provider = report[providerId];
    if (
      provider?.closeCalls !== 1 ||
      provider.activeCount !== 0 ||
      provider.closed !== true
    ) {
      fail(`M32 ${providerId} provider cleanup proof failed`, provider);
    }
  }
  if (report.providerB?.activeCountAtClose !== 1 || report.providerB?.lateCallbackAttempts !== 2) {
    fail('M32 provider-B did not close active work and run both late callbacks', report.providerB);
  }
  const cleanup = requiredEvent(report, 'cleanup-requested');
  if (
    cleanup.detail?.clientClosePromiseSame?.providerA !== true ||
    cleanup.detail?.clientClosePromiseSame?.providerB !== true ||
    cleanup.detail?.clientClosePromiseSame?.providerC !== true
  ) {
    fail('M32 repeated Worker client close was not idempotent', cleanup);
  }
}

function assertCommon(report, falsifier) {
  assertWorkerTier(report);
  assertPollTrace(report, falsifier);
  assertCleanup(report);
  if (report.failure !== null) fail('M32 page or Worker reported a failure', report.failure);
  requiredEvent(report, 'initial-submitted');
  requiredEvent(report, 'host-close-probed');
  requiredEvent(report, 'fresh-port-requested');
  requiredEvent(report, 'fresh-submitted');
  requiredEvent(report, 'worker-finished');
  if (report.freshChannelCreated !== true || report.providerC === null) {
    fail('M32 did not create a fresh same-page provider-C runtime', report);
  }
}

function assertPrimaryProof(report) {
  const worker = report.workerResult;
  const proof = worker?.proof;
  if (
    worker?.activityIdentityCalls?.providerA !== 1 ||
    worker.activityIdentityCalls?.providerC !== 1 ||
    worker.sessionIdentityCalls?.providerA !== 1 ||
    worker.sessionIdentityCalls?.providerC !== 1 ||
    proof?.preTerminalMutationAttempts !== 2 ||
    proof.prematureMutationCount !== 0 ||
    proof.acceptedTerminalCount !== 2 ||
    proof.authoritativeMutationCount !== 2
  ) {
    fail('M32 survivor/fresh terminal-only World proof failed', worker);
  }
  const outputs = Object.values(proof.authoritativeOutputs ?? {}).sort().join('|');
  if (outputs !== 'fresh-ok|survivor-ok') fail('M32 authoritative outputs changed', proof);
  const sequences = Object.values(proof.perActivitySequences ?? {}).map((value) => JSON.stringify(value)).sort();
  if (sequences.join('|') !== '[1,2]|[1,2]') fail('M32 primary sequence proof failed', proof);
}

function assertNormal(report) {
  assertCommon(report, false);
  const worker = report.workerResult;
  const probe = requiredEvent(report, 'host-close-probed').detail;
  if (worker?.ok !== true || worker.falsifierCaught !== false || worker.failure !== null) {
    fail('normal M32 Worker run did not pass', worker);
  }
  if (
    report.ports.providerB.hostCloseOrigin !== 'host-binding.close' ||
    report.ports.providerB.notificationForwarded !== true ||
    report.ports.providerB.notificationSuppressed !== false ||
    report.ports.providerB.portCloseSuppressed !== false
  ) {
    fail('normal M32 did not forward the Host binding close notification', report.ports.providerB);
  }
  if (
    probe.noPostCloseEffects !== true ||
    probe.afterSubmit.error?.code !== 'intelligence-closed' ||
    probe.cancel.error?.code !== 'intelligence-closed' ||
    probe.postClosePollTypes.length !== 0 ||
    probe.activityIdentityCallsBefore !== probe.activityIdentityCallsAfter ||
    probe.sessionIdentityCallsBefore !== probe.sessionIdentityCallsAfter ||
    probe.commandCountBefore !== probe.commandCountAfter
  ) {
    fail('normal M32 post-close client proof failed', probe);
  }
  if (worker.activityIdentityCalls?.providerB !== 2 || worker.sessionIdentityCalls?.providerB !== 2) {
    fail('normal M32 rejected capacity probe allocated the wrong identity count', worker);
  }
  if (worker.bProbe?.closeSettled !== true || worker.bProbe.closePromiseSame !== true) {
    fail('normal M32 client close did not settle idempotently', worker.bProbe);
  }
  assertPrimaryProof(report);
  if (
    report.providerA.starts?.map((item) => item.input).join('|') !== 'survivor' ||
    report.providerB.starts?.map((item) => item.input).join('|') !== 'closing' ||
    report.providerC.starts?.map((item) => item.input).join('|') !== 'fresh' ||
    report.ports.providerB.submittedInputs.join('|') !== 'closing|rejected' ||
    report.ports.providerB.commandKinds.includes('intelligence-close') ||
    report.ports.providerB.rejectionMessages !== 1
  ) {
    fail('normal M32 Host/provider dispatch roster changed', report);
  }
  if (report.workerEvents.some((item) => item.event === 'falsifier-caught')) {
    fail('normal M32 unexpectedly reported a falsifier', report.workerEvents);
  }
}

function assertFalsifier(report) {
  assertCommon(report, true);
  const worker = report.workerResult;
  const probe = requiredEvent(report, 'host-close-probed').detail;
  if (worker?.ok !== false || worker.falsifierCaught !== true || worker.failure !== null) {
    fail('M32 notification-suppression falsifier was not caught', worker);
  }
  if (
    report.ports.providerB.hostCloseOrigin !== 'host-binding.close' ||
    report.ports.providerB.notificationSuppressed !== true ||
    report.ports.providerB.notificationForwarded !== false ||
    report.ports.providerB.portCloseSuppressed !== true
  ) {
    fail('M32 falsifier did not suppress the Host closed notification at the port seam', report.ports.providerB);
  }
  if (
    probe.noPostCloseEffects !== false ||
    probe.postClosePollTypes.length === 0 ||
    probe.commandCountAfter <= probe.commandCountBefore ||
    probe.activityIdentityCallsAfter <= probe.activityIdentityCallsBefore ||
    worker.bProbe?.closeSettled !== false ||
    worker.bProbe.closePromiseSame !== true ||
    !report.ports.providerB.commandKinds.includes('intelligence-close')
  ) {
    fail('M32 falsifier did not expose post-close effects or hanging close', { probe, worker, port: report.ports.providerB });
  }
  assertPrimaryProof(report);
  if (
    report.providerB.starts?.map((item) => item.input).join('|') !== 'closing' ||
    report.providerB.startCalls !== 1 ||
    !report.ports.providerB.submittedInputs.includes('after-close')
  ) {
    fail('M32 falsifier reached provider-B side effects after the binding was closed', report.providerB);
  }
  if (!String(worker.falsifierReason).includes('logically open') && !String(worker.falsifierReason).includes('unsettled')) {
    fail('M32 falsifier reason did not name the close recovery failure', worker);
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
    await page.goto(`http://127.0.0.1:${port}/m32.html?falsify=${falsify ? '1' : '0'}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => globalThis.__forgeaxM32Done === true, null, {
      timeout: 30_000,
    });
    const report = await page.evaluate(() => globalThis.__forgeaxM32Report?.());
    if (report === undefined) fail('M32 page did not publish a report', report);
    if (pageErrors.length > 0) fail('M32 emitted a raw page or Worker exception', pageErrors);
    const canvas = await captureCanvas(page, screenshotName);
    return { report, canvas, consoleLogs };
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.getAttribute('data-status'),
        output: document.querySelector('#report')?.textContent,
        report: globalThis.__forgeaxM32Report?.(),
      }))
      .catch(() => undefined);
    throw new Error(
      `M32 ${falsify ? 'falsifier' : 'normal'} case failed: ${String(error)}; diagnostic=${JSON.stringify(diagnostic)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(consoleLogs)}`,
    );
  } finally {
    await page.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ ...(chromeLaunchOptions()), chromiumSandbox: true });
  try {
    const normal = await runCase(browser, false, 'm32-worker.png');
    assertNormal(normal.report);
    if (normal.consoleLogs.some((entry) => entry.includes('404'))) {
      fail('normal M32 page emitted a missing-resource console error', normal.consoleLogs);
    }
    let falsifier;
    if (gauntlet) {
      falsifier = await runCase(browser, true, 'm32-falsifier.png');
      assertFalsifier(falsifier.report);
      if (falsifier.consoleLogs.some((entry) => entry.includes('404'))) {
        fail('M32 falsifier page emitted a missing-resource console error', falsifier.consoleLogs);
      }
    }
    const result = {
      ok: true,
      normal,
      ...(falsifier === undefined ? {} : { falsifier }),
    };
    if (artifactDir) {
      writeFileSync(join(artifactDir, 'm32-evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(artifactDir, 'm32-normal-evidence.json'), `${JSON.stringify(normal, null, 2)}\n`);
      if (falsifier !== undefined) {
        writeFileSync(
          join(artifactDir, 'm32-falsifier-evidence.json'),
          `${JSON.stringify(falsifier, null, 2)}\n`,
        );
      }
    }
    if (gauntlet) {
      process.stdout.write(`M32_INTELLIGENCE_WORKER_PASS ${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
