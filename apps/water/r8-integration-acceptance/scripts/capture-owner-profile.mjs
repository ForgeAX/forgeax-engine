#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { assertProfileTransfer } from './profile-capture-transfer.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const appRoot = resolve(repoRoot, 'apps/water/r8-integration-acceptance');
const browserLaunchArgs = [
  '--enable-unsafe-webgpu',
  '--use-webgpu-power-preference=force-high-performance',
  '--force-high-performance-gpu',
  '--ignore-gpu-blocklist',
];
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(
    'Usage: node apps/water/r8-integration-acceptance/scripts/capture-owner-profile.mjs --base-url URL --out-dir DIR [--headless] [--browser-executable PATH] [--warmup-frames N] [--baseline-frames N] [--capture-frames N] [--capture-detail owner|passes|nested]\n',
  );
  process.exit(0);
}

if (args.baseUrl === undefined || args.outDir === undefined) {
  throw new Error('Both --base-url and --out-dir are required. Use --help for options.');
}

const baseUrl = new URL(args.baseUrl);
if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
  throw new Error('--base-url must use http or https.');
}
const safeBaseUrl = `${baseUrl.origin}${baseUrl.pathname}`;
const outputRoot = resolve(args.outDir);
const runId = new Date().toISOString().replaceAll(':', '-');
const runDir = resolve(outputRoot, `r8-owner-${runId}`);
const warmupFrames = positiveInteger(args.warmupFrames, '--warmup-frames');
const baselineFrames = positiveInteger(args.baselineFrames, '--baseline-frames');
const captureFrames = positiveInteger(args.captureFrames, '--capture-frames');
if (captureFrames > 900) throw new Error('--capture-frames must not exceed the R8 limit of 900.');
const frameTimeoutMs = positiveInteger(args.frameTimeoutMs, '--frame-timeout-ms');
const finishWaitMs = positiveInteger(args.finishWaitMs, '--finish-wait-ms', true);
if (finishWaitMs > 10_000)
  throw new Error('--finish-wait-ms must not exceed the R8 limit of 10000.');

await mkdir(runDir, { recursive: true });

const issues = [];
const scriptResponseTasks = [];
const payloadResponseTasks = [];
let browser;
let page;
const manifest = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  baseUrl: safeBaseUrl,
  configuration: {
    warmupFrames,
    baselineFrames,
    captureFrames,
    captureDetail: args.captureDetail,
    eventLimit: 1_048_576,
    finishWaitMs,
    browserHeadless: args.headless,
    browserLaunchArgs,
  },
  files: {},
  errors: issues,
};

try {
  const launchOptions = {
    headless: args.headless,
    chromiumSandbox: true,
    args: browserLaunchArgs,
    ...(args.browserExecutable === undefined
      ? {}
      : { executablePath: resolve(args.browserExecutable) }),
  };
  browser = await chromium.launch({ ...launchOptions, chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: args.dpr,
    acceptDownloads: true,
  });
  await context.addInitScript(() => {
    const evidence = {
      requestAdapterCalls: [],
      adapterRefs: new WeakMap(),
      patchedAdapterOwners: new WeakSet(),
      patchedGpuOwners: new WeakSet(),
      installFailures: [],
    };
    Object.defineProperty(window, '__r8AdapterEvidence', { value: evidence });

    const snapshot = (value, depth = 0) => {
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
      if (value === undefined) return null;
      if (depth > 3) return '[depth-limit]';
      if (Array.isArray(value)) return value.map((item) => snapshot(item, depth + 1));
      if (typeof value === 'object') {
        const result = {};
        for (const key of Object.keys(value)) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            result[key] =
              descriptor && 'value' in descriptor
                ? snapshot(descriptor.value, depth + 1)
                : '[accessor]';
          } catch {
            result[key] = '[unavailable]';
          }
        }
        return result;
      }
      return String(value);
    };
    evidence.snapshot = snapshot;
    const findMethod = (object, name) => {
      for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name);
        if (descriptor) return { owner, descriptor };
      }
      return undefined;
    };
    const reportInstallFailure = (method, error) => {
      evidence.installFailures.push({ method, error: String(error) });
    };

    const installRequestDeviceObserver = (adapter) => {
      const found = findMethod(adapter, 'requestDevice');
      if (!found || typeof found.descriptor.value !== 'function') {
        reportInstallFailure('GPUAdapter.requestDevice', 'method descriptor unavailable');
        return;
      }
      const { owner, descriptor } = found;
      if (evidence.patchedAdapterOwners.has(owner)) return;
      const original = descriptor.value;
      const wrapped = function (...callArgs) {
        const request = evidence.adapterRefs.get(this);
        const call = request ? { receiver: this, args: callArgs, status: 'called' } : undefined;
        if (request && call) request.requestDeviceCalls.push(call);
        let returned;
        try {
          returned = Reflect.apply(original, this, callArgs);
        } catch (error) {
          if (call) {
            call.status = 'threw';
            call.error = String(error);
          }
          throw error;
        }
        if (call) {
          call.returnedPromise = returned;
          if (returned && typeof returned.then === 'function') {
            try {
              returned.then(
                () => {
                  call.status = 'fulfilled';
                },
                (error) => {
                  call.status = 'rejected';
                  call.error = String(error);
                },
              );
            } catch (error) {
              call.observerError = String(error);
            }
          }
        }
        return returned;
      };
      try {
        Object.defineProperty(owner, 'requestDevice', { ...descriptor, value: wrapped });
        evidence.patchedAdapterOwners.add(owner);
      } catch (error) {
        reportInstallFailure('GPUAdapter.requestDevice', error);
      }
    };

    const installRequestAdapterObserver = () => {
      let gpu;
      try {
        gpu = navigator.gpu;
      } catch (error) {
        reportInstallFailure('GPU.requestAdapter', error);
        return;
      }
      if (!gpu) return;
      const found = findMethod(gpu, 'requestAdapter');
      if (!found || typeof found.descriptor.value !== 'function') return;
      const { owner, descriptor } = found;
      if (evidence.patchedGpuOwners.has(owner)) return;
      const original = descriptor.value;
      const wrapped = function (...callArgs) {
        const record = {
          receiver: this,
          args: callArgs,
          status: 'called',
          requestDeviceCalls: [],
        };
        evidence.requestAdapterCalls.push(record);
        let returned;
        try {
          returned = Reflect.apply(original, this, callArgs);
        } catch (error) {
          record.status = 'threw';
          record.error = String(error);
          throw error;
        }
        record.returnedPromise = returned;
        if (returned && typeof returned.then === 'function') {
          try {
            returned.then(
              (adapter) => {
                record.status = adapter ? 'fulfilled' : 'fulfilled-null';
                record.adapter = adapter ?? null;
                if (adapter) {
                  evidence.adapterRefs.set(adapter, record);
                  installRequestDeviceObserver(adapter);
                }
              },
              (error) => {
                record.status = 'rejected';
                record.error = String(error);
              },
            );
          } catch (error) {
            record.observerError = String(error);
          }
        }
        return returned;
      };
      try {
        Object.defineProperty(owner, 'requestAdapter', { ...descriptor, value: wrapped });
        evidence.patchedGpuOwners.add(owner);
      } catch (error) {
        reportInstallFailure('GPU.requestAdapter', error);
      }
    };

    installRequestAdapterObserver();
    queueMicrotask(installRequestAdapterObserver);
    document.addEventListener('DOMContentLoaded', installRequestAdapterObserver, { once: true });
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') issues.push({ kind: 'console-error', message: message.text() });
  });
  page.on('pageerror', (error) =>
    issues.push({ kind: 'page-error', message: error.stack ?? error.message }),
  );
  page.on('requestfailed', (request) =>
    issues.push({
      kind: 'request-failed',
      url: request.url(),
      error: request.failure()?.errorText ?? 'unknown',
    }),
  );
  page.on('response', (response) => {
    if (response.status() !== 200) return;
    const resourceType = response.request().resourceType();
    const url = response.url();
    if (resourceType === 'script') {
      const task = response
        .body()
        .then((body) => ({ url, status: response.status(), sha256: sha256(body) }))
        .catch((error) => ({ url, status: response.status(), bodyError: String(error) }));
      scriptResponseTasks.push(task);
    }
    if (isIdentityPayloadUrl(url)) {
      const task = response
        .body()
        .then((body) => ({
          url,
          status: response.status(),
          resourceType,
          contentType: response.headers()['content-type'] ?? null,
          byteLength: body.byteLength,
          sha256: sha256(body),
        }))
        .catch((error) => ({
          url,
          status: response.status(),
          resourceType,
          contentType: response.headers()['content-type'] ?? null,
          bodyError: String(error),
        }));
      payloadResponseTasks.push(task);
    }
  });

  await page.goto(safeBaseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(
    () => typeof window.__waterR8 === 'object' && typeof window.__waterR8.readState === 'function',
    undefined,
    { timeout: 180_000 },
  );
  await page.evaluate(() => {
    const evidence = { submitted: [], completed: [], readyCount: 0, lastReadyAt: null };
    const push = (bucket, detail) => {
      bucket.push({ at: performance.timeOrigin + performance.now(), ...detail });
      if (bucket.length > 2_048) bucket.shift();
    };
    document.addEventListener(
      'forgeax:frame-submitted',
      (event) => {
        const detail = event.detail ?? {};
        push(evidence.submitted, {
          frameId: detail.frameId,
          deviceGeneration: detail.deviceGeneration,
          graphGeneration: detail.graphGeneration ?? null,
          renderDrawIntervalMs: detail.renderDrawIntervalMs ?? null,
          renderDrawCpuMs: detail.renderDrawCpuMs ?? null,
          renderAwaitMs: detail.renderAwaitMs ?? null,
          renderQueuedMs: detail.renderQueuedMs ?? null,
          engineUpdateMs: detail.engineUpdateMs ?? null,
          engineCreditWaitMs: detail.engineCreditWaitMs ?? null,
          renderGraphCompiles: detail.renderGraphCompiles ?? null,
          renderPipelineCreations: detail.renderPipelineCreations ?? null,
          renderStallReason: detail.renderStallReason ?? null,
          rhiCommands: detail.rhiCommands ?? null,
          publicationBytes: detail.publicationBytes ?? null,
        });
      },
      true,
    );
    document.addEventListener(
      'forgeax:frame-completed',
      (event) => {
        const detail = event.detail ?? {};
        const at = performance.timeOrigin + performance.now();
        push(evidence.completed, {
          at,
          frameId: detail.frameId,
          deviceGeneration: detail.deviceGeneration,
          presentation: detail.presentation,
          renderSubmitToCompleteMs: detail.renderSubmitToCompleteMs ?? null,
        });
        if (detail.presentation === 'ready') {
          evidence.readyCount += 1;
          evidence.lastReadyAt = at;
        }
      },
      true,
    );
    window.__r8MaintenanceWaitForFrames = (startReadyCount, count, timeoutMs) =>
      new Promise((resolve, reject) => {
        const target = startReadyCount + count;
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          document.removeEventListener('forgeax:frame-completed', check, true);
          clearTimeout(timer);
          if (error) reject(error);
          else resolve({ readyCount: evidence.readyCount, at: evidence.lastReadyAt });
        };
        const check = () => {
          if (evidence.readyCount >= target) finish();
        };
        const timer = setTimeout(
          () => finish(new Error(`Timed out waiting for ${count} ready frames.`)),
          timeoutMs,
        );
        document.addEventListener('forgeax:frame-completed', check, true);
        check();
      });
    window.__r8MaintenanceFrameEvidence = evidence;
  });
  await waitForFrames(page, warmupFrames, frameTimeoutMs);

  const adapter = await page.evaluate(async () => {
    const evidence = window.__r8AdapterEvidence;
    const records = evidence?.requestAdapterCalls ?? [];
    const snapshot = evidence?.snapshot ?? ((value) => value);
    const value = records.at(-1);
    if (!value) {
      return {
        status: navigator.gpu ? 'not-observed' : 'unavailable',
        reason: navigator.gpu
          ? 'App requestAdapter call was not observed'
          : 'navigator.gpu is absent',
        installFailures: evidence?.installFailures ?? [],
      };
    }
    const adapter = value.adapter;
    const calls = records.map((record) => {
      const argumentsSnapshot = snapshot(record.args);
      return {
        receiverIsNavigatorGpu: record.receiver === navigator.gpu,
        arguments: argumentsSnapshot,
        status: record.status,
        fallbackRequested: argumentsSnapshot[0]?.forceFallbackAdapter === true,
        originalPromisePreserved: true,
        adapterReturned: record.adapter !== null && record.adapter !== undefined,
        requestDeviceOnReturnedAdapter: record.requestDeviceCalls.some(
          (call) => call.receiver === record.adapter,
        ),
        requestDeviceCalls: record.requestDeviceCalls.map((call) => ({
          sameReturnedAdapter: call.receiver === record.adapter,
          arguments: snapshot(call.args),
          status: call.status,
          originalPromisePreserved: true,
          ...(call.error === undefined ? {} : { error: call.error }),
          ...(call.observerError === undefined ? {} : { observerError: call.observerError }),
        })),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.observerError === undefined ? {} : { observerError: record.observerError }),
      };
    });
    if (!adapter) {
      return {
        status: value.status === 'fulfilled-null' ? 'unavailable' : value.status,
        calls,
        installFailures: evidence.installFailures,
      };
    }
    try {
      let info = adapter.info;
      if (info === undefined && typeof adapter.requestAdapterInfo === 'function') {
        try {
          info = await adapter.requestAdapterInfo();
        } catch {
          info = undefined;
        }
      }
const completeObservedAdapterEvidence = () => {
      let isFallbackAdapter = null;
      try {
        if (typeof adapter.isFallbackAdapter === 'boolean')
          isFallbackAdapter = adapter.isFallbackAdapter;
      } catch {
        isFallbackAdapter = null;
      }
      return {
        status: 'available',
        source: 'observed App navigator.gpu.requestAdapter() result',
        calls,
        info:
          info === undefined
            ? null
            : {
                vendor: info.vendor ?? null,
                architecture: info.architecture ?? null,
                device: info.device ?? null,
                description: info.description ?? null,
              },
        fallback: {
          requested: calls.at(-1)?.fallbackRequested ?? false,
          reported: isFallbackAdapter,
          status:
            isFallbackAdapter === true
              ? 'reported-fallback'
              : isFallbackAdapter === false
                ? 'reported-hardware'
                : 'not-reported',
        },
        features: [...adapter.features].sort(),
        limits: Object.fromEntries(Object.entries(adapter.limits)),
        installFailures: evidence.installFailures,
      };};
return completeObservedAdapterEvidence();

    } catch (error) {
      return {
        status: 'failed',
        calls,
        error: String(error),
        installFailures: evidence.installFailures,
      };
    }
  });
  manifest.adapter = adapter;

  const screen = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    screen: { width: screen.width, height: screen.height },
  }));
  manifest.screen = screen;

  await page.screenshot({ path: resolve(runDir, 'before-capture.png') });
  const stateBefore = await readStateJson(page);
  await writeFile(resolve(runDir, 'state-before.json'), stateBefore, 'utf8');

  const baseline = await measureFrames(page, baselineFrames, frameTimeoutMs);
  manifest.performance = { ordinary: baseline };
  process.stdout.write(
    `${JSON.stringify({
      progress: 'ordinary-fps-ready',
      runDir,
      manifestPath: resolve(runDir, 'manifest.json'),
      ordinaryFps: baseline.completedFps,
      frameCount: baseline.frameCount,
      elapsedMs: baseline.elapsedMs,
      unprofiled: baseline.unprofiled,
    })}\n`,
  );
  const profileStart = await page.evaluate(
    ({ frameLimit, detail }) => {
      const profileStartMarker = {
        completedFrames: window.__waterR8.readState().completedFrames,
        readyCount: window.__r8MaintenanceFrameEvidence.readyCount,
        at: performance.timeOrigin + performance.now(),
      };
      const start = window.__waterR8.startProfileCapture({
        preset: 'normal',
        frameLimit,
        eventLimit: 1_048_576,
        detail,
      });
      return { profileStartMarker, start };
    },
    { frameLimit: captureFrames, detail: args.captureDetail },
  );
  const { profileStartMarker, start } = profileStart;
  const profileStartCount = profileStartMarker.completedFrames;
  if (!start?.ok)
    throw new Error(
      `R8 ${args.captureDetail} profile start failed: ${jsonText(start?.error ?? start)}`,
    );
  const captureId = start.value.captureId;
  if (
    start.value.limits?.detail !== args.captureDetail ||
    start.value.limits?.frameLimit !== captureFrames
  ) {
    throw new Error(
      `R8 ${args.captureDetail} profile admitted unexpected limits: ${jsonText(start.value)}`,
    );
  }
  manifest.capture = {
    captureId,
    admitted: start.value,
    startMarker: profileStartMarker,
    markerAndStartSameEvaluation: true,
  };

  const profileWindow = await waitForFrameEvents(
    page,
    profileStartMarker.readyCount,
    captureFrames,
    frameTimeoutMs,
  );
  await page.waitForFunction(
    (expectedId) => window.__waterR8.profiler.activeCaptureId() !== expectedId,
    captureId,
    { timeout: frameTimeoutMs },
  );
  const profileEndCount = await completedFrameCount(page);
  const profileFinishTime = profileWindow.at;
  manifest.capture.closedAtFrameLimit = await page.evaluate(
    () => window.__waterR8.profiler.activeCaptureId() === undefined,
  );
  const finish = await page.evaluate(async (waitMs) => {
    const result = await window.__waterR8.finishProfileCapture({ waitMs });
    return result?.ok
      ? { ok: true, captureId: result.value?.capture?.captureId ?? null }
      : { ok: false, error: result?.error ?? null };
  }, finishWaitMs);
  if (!finish?.ok)
    throw new Error(
      `R8 ${args.captureDetail} profile finish failed: ${jsonText(finish?.error ?? finish)}`,
    );
  if (finish.captureId !== captureId)
    throw new Error('R8 profile finish returned an unexpected capture ID');
  const profilePreflight = await page.evaluate(async (expectedId) => {
    const value = window.__waterR8.exportProfileCapture();
    if (!value || value.capture.captureId !== expectedId)
      throw new Error('R8 profile preflight identity mismatch');
    const sidecars = value.sidecars;
    const receipts = sidecars.receipts;
    const completionCpu = sidecars.completionCpu;
    const nativePhysics = sidecars.nativePhysics;
    const gpu = sidecars.gpu;
    if (
      ![
        receipts,
        completionCpu,
        nativePhysics,
        gpu,
        value.capture.records,
        value.model.phases,
      ].every(Array.isArray)
    ) {
      throw new Error('R8 profile preflight is missing required arrays');
    }
    const sidecarsJson = JSON.stringify(sidecars, (_key, item) =>
      item instanceof Error
        ? {
            name: item.name,
            message: item.message,
            ...Object.fromEntries(Object.entries(item)),
            ...(item.cause === undefined ? {} : { cause: item.cause }),
          }
        : item instanceof Set
          ? [...item]
          : item instanceof Map
            ? Object.fromEntries(item)
            : ArrayBuffer.isView(item)
              ? Array.from(item)
              : item,
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sidecarsJson)),
    );
    const sidecarsSha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return {
      captureId: value.capture.captureId,
      version: value.version,
      captureSchemaVersion: value.capture.schemaVersion,
      retainedEventCount: value.capture.completeness?.retainedEventCount ?? null,
      captureRecordCount: value.capture.records.length,
      modelPhaseCount: value.model.phases.length,
      receiptsCount: receipts.length,
      completionCpuCount: completionCpu.length,
      nativePhysicsCount: nativePhysics.length,
      gpuCount: gpu.length,
      renderPassCpuIdentityCount: receipts.reduce(
        (count, receipt) => count + (receipt.renderPassCpuIdentities?.length ?? 0),
        0,
      ),
      gpuPassIdentityCount: gpu.reduce(
        (count, row) => count + (row.timings?.frame?.passes?.length ?? 0),
        0,
      ),
      sidecarsSha256,
    };
  }, captureId);
  if (profilePreflight.captureId !== captureId)
    throw new Error('R8 profile preflight returned an unexpected capture ID');
  const profileFile = `profile-${args.captureDetail}-${captureId}.json`;
  const profilePath = resolve(runDir, profileFile);
  const downloadEvent = page.waitForEvent('download', { timeout: 60_000 }).then(
    (download) => ({ download }),
    (error) => ({ error }),
  );
  let download;
  try {
    const downloadResult = await page.evaluate((expectedId) => {
      const value = window.__waterR8.downloadProfileCapture();
      if (!value || value.capture.captureId !== expectedId)
        throw new Error('R8 profile download identity mismatch');
      return { captureId: value.capture.captureId };
    }, captureId);
    if (downloadResult.captureId !== captureId)
      throw new Error('R8 profile download returned an unexpected capture ID');
    const outcome = await downloadEvent;
    if (outcome.error !== undefined)
      throw new Error(`R8 profile download event failed: ${String(outcome.error)}`);
    download = outcome.download;
    await download.saveAs(profilePath);
  } catch (error) {
    await page.close().catch(() => undefined);
    await downloadEvent;
    throw error;
  }
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  assertProfileTransfer(profile, profilePreflight, captureId);
  manifest.capture.profileTransfer = { ...profilePreflight, verified: true };
  manifest.files.profile = profileFile;
  const rawReadyEventFrames = profileWindow.readyCount - profileStartMarker.readyCount;
  const rawReadStateCompletedFrames = profileEndCount - profileStartCount;
  const rawWindowElapsedMs = profileFinishTime - profileStartMarker.at;
  const rawIntervalEvidence = await collectIntervalEvidence(
    page,
    profileStartMarker.at,
    profileFinishTime,
  );
  const capturedFrameProgress = await page.evaluate(
    () => window.__r8MaintenanceFrameEvidence ?? { submitted: [], completed: [] },
  );
  const receiptWindow = correlateProfileReceipts(
    profile.sidecars?.receipts ?? [],
    capturedFrameProgress.completed ?? [],
    captureId,
    profileStartMarker.at,
    rawReadStateCompletedFrames,
  );
  manifest.performance.instrumented = {
    frameCount: receiptWindow.matchedFrameCount,
    readyEventFrames: rawReadyEventFrames,
    readStateCompletedFrames: rawReadStateCompletedFrames,
    completionCounterAgrees: receiptWindow.completionCounterAgrees,
    elapsedMs: receiptWindow.throughputWindowMs,
    completedFps: receiptWindow.intervalFps,
    intervalFps: receiptWindow.intervalFps,
    throughputFps: receiptWindow.throughputFps,
    profileReceiptWindow: receiptWindow,
    rawWindow: {
      frameCount: rawReadyEventFrames,
      readStateCompletedFrames: rawReadStateCompletedFrames,
      completionCounterAgrees: rawReadyEventFrames === rawReadStateCompletedFrames,
      counterMeaning:
        'Ready-event and readState counters are separate mixed-window checks; exact receipt joins remain authoritative.',
      elapsedMs: rawWindowElapsedMs,
      completedFps: fps(rawReadyEventFrames, rawWindowElapsedMs),
      intervalEvidence: rawIntervalEvidence,
    },
    fpsDisplay: await page
      .locator('#fps')
      .textContent()
      .catch(() => null),
    intervalEvidence: rawIntervalEvidence,
  };
  manifest.profile = summarizeProfile(profile);
  manifest.profileSourceFailure = profile.sidecars?.diagnostics?.profileSourceFailure ?? null;
  manifest.gpu = summarizeGpu(profile);
  process.stdout.write(
    `${JSON.stringify({
      progress: 'owner-profile-ready',
      runDir,
      manifestPath: resolve(runDir, 'manifest.json'),
      profilePath: resolve(runDir, profileFile),
      captureId,
      profileSourceFailure: manifest.profileSourceFailure,
      instrumentedIntervalFps: manifest.performance.instrumented.intervalFps,
      instrumentedThroughputFps: manifest.performance.instrumented.throughputFps,
      completionCounterAgrees: manifest.performance.instrumented.completionCounterAgrees,
      completeness: profile.sidecars.completeness,
      gpuFrameIntegrity: profile.sidecars.completeness?.gpu ?? null,
    })}\n`,
  );
  const stateAfterProfile = await readStateJson(page);
  await writeFile(resolve(runDir, 'state-after-profile.json'), stateAfterProfile, 'utf8');
  await page.screenshot({ path: resolve(runDir, 'after-profile.png') });

  const rhi = await page.evaluate(async () => {
    try {
      const result = await window.__waterR8.capture();
      if (!result.ok) return { ok: false, error: JSON.parse(JSON.stringify(result.error)) };
      const artifact = result.value;
      const bytes = artifact.bytes;
      let binary = '';
      const chunkSize = 49_152;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)),
        );
      }
      const submitted = artifact.submittedFrame;
      return {
        ok: true,
        byteLength: artifact.byteLength,
        digest: artifact.digest,
        tapeBase64: btoa(binary),
        submittedFrame:
          submitted?.status === 'complete'
            ? {
                status: submitted.status,
                captureGeneration: submitted.captureGeneration,
                receipt: {
                  frameId: submitted.receipt.frameId,
                  deviceGeneration: submitted.receipt.deviceGeneration,
                  graphGeneration: submitted.receipt.graphGeneration ?? null,
                  presentation: submitted.receipt.presentation,
                },
              }
            : (submitted ?? null),
      };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  if (rhi.ok) {
    const tape = Buffer.from(rhi.tapeBase64, 'base64');
    const tapeFile = 'frame.rhitape';
    await writeFile(resolve(runDir, tapeFile), tape);
    manifest.files.rhiTape = tapeFile;
    manifest.rhiCapture = {
      ok: true,
      byteLength: tape.byteLength,
      digest: rhi.digest,
      fileSha256: sha256(tape),
      submittedFrame: rhi.submittedFrame,
      digestMatchesBytes: rhi.digest === `sha256:${sha256(tape)}`,
    };
  } else {
    manifest.rhiCapture = rhi;
    issues.push({ kind: 'rhi-capture', error: rhi.error });
  }

  const stateAfterRhi = await readStateJson(page);
  await writeFile(resolve(runDir, 'state-after-rhi.json'), stateAfterRhi, 'utf8');
  await page.screenshot({ path: resolve(runDir, 'final.png') });
  await Promise.allSettled(scriptResponseTasks);
  manifest.codeIdentity = await collectCodeIdentity(
    scriptResponseTasks,
    payloadResponseTasks,
    repoRoot,
    appRoot,
  );
  manifest.frameProgress = await page.evaluate(
    () => window.__r8MaintenanceFrameEvidence ?? { submitted: [], completed: [] },
  );
  manifest.completedAt = new Date().toISOString();
  manifest.files.screenshots = ['before-capture.png', 'after-profile.png', 'final.png'];
  manifest.files.states = ['state-before.json', 'state-after-profile.json', 'state-after-rhi.json'];
  await writeJson(resolve(runDir, 'manifest.json'), manifest);
  process.stdout.write(
    `${JSON.stringify(
      {
        runDir,
        captureId,
        captureDetail: args.captureDetail,
        ordinaryFps: baseline.completedFps,
        instrumentedIntervalFps: manifest.performance.instrumented.intervalFps,
        instrumentedThroughputFps: manifest.performance.instrumented.throughputFps,
        receiptMatchedFrames: manifest.performance.instrumented.frameCount,
        completionCounterAgrees: manifest.performance.instrumented.completionCounterAgrees,
        completeness: profile.sidecars.completeness,
        adapter: adapter.status,
        rhiCapture: manifest.rhiCapture.ok,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  manifest.completedAt = new Date().toISOString();
  manifest.failure = { message: error.message, stack: error.stack };
  manifest.issues = issues;
  await writeJson(resolve(runDir, 'failure.json'), manifest).catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
}

function parseArgs(values) {
  const result = {
    headless: false,
    warmupFrames: 180,
    baselineFrames: 180,
    captureFrames: 180,
    captureDetail: 'owner',
    frameTimeoutMs: 120_000,
    finishWaitMs: 10_000,
    width: 1280,
    height: 720,
    dpr: 1,
  };
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === '--help') result.help = true;
    else if (token === '--headless') result.headless = true;
    else if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      const value = equals === -1 ? values[++index] : token.slice(equals + 1);
      if (value === undefined) throw new Error(`Missing value for ${name}`);
      const key = {
        '--base-url': 'baseUrl',
        '--out-dir': 'outDir',
        '--browser-executable': 'browserExecutable',
        '--warmup-frames': 'warmupFrames',
        '--baseline-frames': 'baselineFrames',
        '--capture-frames': 'captureFrames',
        '--capture-detail': 'captureDetail',
        '--frame-timeout-ms': 'frameTimeoutMs',
        '--finish-wait-ms': 'finishWaitMs',
        '--width': 'width',
        '--height': 'height',
        '--dpr': 'dpr',
      }[name];
      if (key === undefined) throw new Error(`Unknown option: ${name}`);
      result[key] = ['baseUrl', 'outDir', 'browserExecutable', 'captureDetail'].includes(key)
        ? value
        : Number(value);
    } else throw new Error(`Unexpected argument: ${token}`);
  }
  if (!['owner', 'passes', 'nested'].includes(result.captureDetail)) {
    throw new Error('--capture-detail must be owner, passes, or nested.');
  }
  return result;
}

function positiveInteger(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`);
  return value;
}

async function completedFrameCount(page) {
  return page.evaluate(() => window.__waterR8.readState().completedFrames);
}

async function frameMarker(page) {
  return page.evaluate(() => ({
    completedFrames: window.__waterR8.readState().completedFrames,
    readyCount: window.__r8MaintenanceFrameEvidence.readyCount,
    at: performance.timeOrigin + performance.now(),
  }));
}

async function waitForFrames(page, count, timeoutMs) {
  const start = await frameMarker(page);
  await waitForFrameEvents(page, start.readyCount, count, timeoutMs);
}

async function waitForFrameEvents(page, startReadyCount, count, timeoutMs) {
  return page.evaluate(
    ({ start, targetCount, waitMs }) =>
      window.__r8MaintenanceWaitForFrames(start, targetCount, waitMs),
    { start: startReadyCount, targetCount: count, waitMs: timeoutMs },
  );
}

async function measureFrames(page, count, timeoutMs) {
  const start = await frameMarker(page);
  const activeCaptureAtStart = await page.evaluate(
    () => window.__waterR8.profiler.activeCaptureId() ?? null,
  );
  const end = await waitForFrameEvents(page, start.readyCount, count, timeoutMs);
  const activeCaptureAtEnd = await page.evaluate(
    () => window.__waterR8.profiler.activeCaptureId() ?? null,
  );
  return {
    frameCount: end.readyCount - start.readyCount,
    elapsedMs: end.at - start.at,
    completedFps: fps(end.readyCount - start.readyCount, end.at - start.at),
    activeCaptureAtStart,
    activeCaptureAtEnd,
    unprofiled: activeCaptureAtStart === null && activeCaptureAtEnd === null,
    intervalEvidence: await collectIntervalEvidence(page, start.at, end.at),
  };
}

async function collectIntervalEvidence(page, startMs, endMs) {
  const evidence = await page.evaluate(
    () => window.__r8MaintenanceFrameEvidence ?? { submitted: [], completed: [] },
  );
  const completed = evidence.completed
    .filter((row) => row.at >= startMs && row.at <= endMs && row.presentation === 'ready')
    .map((row) => row.at);
  const intervals = completed.slice(1).map((time, index) => time - completed[index]);
  const inRange = intervals.filter((interval) => interval >= 0);
  return {
    completedEventsObserved: completed.length,
    intervalMs: distribution(inRange),
    submitted: evidence.submitted.filter((row) => row.at >= startMs && row.at <= endMs),
    completed: evidence.completed.filter((row) => row.at >= startMs && row.at <= endMs),
  };
}

async function readStateJson(page) {
  return page.evaluate(() =>
    JSON.stringify(window.__waterR8.readState(), (_key, item) => {
      if (item instanceof Error)
        return {
          name: item.name,
          message: item.message,
          ...Object.fromEntries(Object.entries(item)),
        };
      if (item instanceof Set) return [...item];
      if (item instanceof Map) return Object.fromEntries(item);
      if (ArrayBuffer.isView(item)) return Array.from(item);
      if (typeof item === 'bigint') return String(item);
      return item;
    }),
  );
}

function summarizeProfile(profile) {
  const phases = [...(profile.model?.phases ?? [])]
    .sort((left, right) => right.totalDurationMicros - left.totalDurationMicros)
    .map((phase) => ({
      source: phase.source,
      phase: phase.phase,
      parentSource: phase.parentSource ?? null,
      parentPhase: phase.parentPhase ?? null,
      count: phase.count,
      totalMs: phase.totalDurationMicros / 1000,
      p95CallMs:
        phase.callDuration?.p95DurationMicros === null
          ? null
          : phase.callDuration.p95DurationMicros / 1000,
      p95FrameMs:
        phase.frameDuration?.p95DurationMicros === null
          ? null
          : phase.frameDuration.p95DurationMicros / 1000,
    }));
  return {
    profile: profile.capture?.completeness,
    summary: profile.model?.summary,
    highestTotalPhases: phases.slice(0, 50),
    requestedOwnerPhases: phases.filter((phase) =>
      /world|extract|prepare|record|submit|cleanup|completion|wait/i.test(phase.phase),
    ),
  };
}

function summarizeGpu(profile) {
  const byPass = new Map();
  let measuredPassNanoseconds = 0;
  let measuredRows = 0;
  for (const sidecar of profile.sidecars?.gpu ?? []) {
    const frame = sidecar.timings?.frame;
    for (const pass of frame?.passes ?? []) {
      if (pass.status !== 'measured') continue;
      const key = JSON.stringify([pass.viewId ?? null, pass.passName, pass.passKind]);
      const aggregate = byPass.get(key) ?? {
        viewId: pass.viewId ?? null,
        passName: pass.passName,
        passKind: pass.passKind,
        samples: 0,
        durationNanoseconds: 0,
      };
      aggregate.samples += 1;
      aggregate.durationNanoseconds += pass.durationNanoseconds;
      byPass.set(key, aggregate);
      measuredRows += 1;
      measuredPassNanoseconds += pass.durationNanoseconds;
    }
  }
  return {
    completeness: profile.sidecars?.completeness?.gpu ?? null,
    measuredRows,
    measuredPassMilliseconds: measuredPassNanoseconds / 1_000_000,
    aggregationMeaning:
      'sum of reported pass durations; overlapping intervals remain summed and this is not frame latency',
    passes: [...byPass.values()].sort(
      (left, right) => right.durationNanoseconds - left.durationNanoseconds,
    ),
  };
}

function distribution(values) {
  if (values.length === 0)
    return { sampleCount: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.ceil(sorted.length * ratio) - 1] ?? null;
  return {
    sampleCount: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}

function fps(frames, elapsedMs) {
  return elapsedMs <= 0 ? null : (frames * 1000) / elapsedMs;
}

function correlateProfileReceipts(
  receipts,
  completionRows,
  captureId,
  windowStartAt,
  readStateCompletedFrames,
) {
  const captureReceipts = receipts.filter((receipt) => receipt?.captureId === captureId);
  const readyRows = completionRows.filter((row) => row?.presentation === 'ready');
  const identityOf = (row) => {
    if (!Number.isSafeInteger(row?.frameId) || !Number.isSafeInteger(row?.deviceGeneration))
      return undefined;
    return `${row.deviceGeneration}:${row.frameId}`;
  };
  const completionsByIdentity = new Map();
  for (const row of readyRows) {
    const identity = identityOf(row);
    if (identity === undefined) continue;
    const matches = completionsByIdentity.get(identity) ?? [];
    matches.push(row);
    completionsByIdentity.set(identity, matches);
  }
  const receiptCountsByIdentity = new Map();
  for (const receipt of captureReceipts) {
    const identity = identityOf({
      frameId: receipt?.receiptFrameId,
      deviceGeneration: receipt?.deviceGeneration,
    });
    if (identity === undefined) continue;
    receiptCountsByIdentity.set(identity, (receiptCountsByIdentity.get(identity) ?? 0) + 1);
  }
  const matched = [];
  let completedReceiptsWithoutEvent = 0;
  let ambiguousReceiptIdentities = 0;
  for (const receipt of captureReceipts) {
    if (receipt?.status !== 'completed') continue;
    const identity = identityOf({
      frameId: receipt.receiptFrameId,
      deviceGeneration: receipt.deviceGeneration,
    });
    const events = identity === undefined ? undefined : completionsByIdentity.get(identity);
    if (events === undefined || events.length === 0) {
      completedReceiptsWithoutEvent += 1;
      continue;
    }
    if (events.length !== 1 || receiptCountsByIdentity.get(identity) !== 1) {
      ambiguousReceiptIdentities += 1;
      continue;
    }
    matched.push({ receipt, completion: events[0] });
  }
  matched.sort((left, right) => left.completion.at - right.completion.at);
  const timestamps = matched
    .map(({ completion }) => completion.at)
    .filter((at) => Number.isFinite(at));
  const firstCompletionAt = timestamps[0] ?? null;
  const lastCompletionAt = timestamps.at(-1) ?? null;
  const intervalElapsedMs = timestamps.length > 1 ? lastCompletionAt - firstCompletionAt : null;
  const throughputWindowMs = lastCompletionAt === null ? null : lastCompletionAt - windowStartAt;
  const matchedFrameCount = matched.length;
  const profileReceiptIdentities = matched.map(({ receipt }) => ({
    profileFrameId: receipt.profileFrameId,
    receiptFrameId: receipt.receiptFrameId,
    deviceGeneration: receipt.deviceGeneration,
  }));
  const intervals = timestamps.slice(1).map((at, index) => at - timestamps[index]);
  const completionCounterAgrees = readStateCompletedFrames === matchedFrameCount;
  return {
    expectedReceipts: captureReceipts.length,
    completedReceipts: captureReceipts.filter((receipt) => receipt?.status === 'completed').length,
    matchedFrameCount,
    completedReceiptsWithoutEvent,
    ambiguousReceiptIdentities,
    nonCompletedReceiptCount: captureReceipts.filter((receipt) => receipt?.status !== 'completed')
      .length,
    readStateCompletedFrames,
    counterDriftFrames: readStateCompletedFrames - matchedFrameCount,
    completionCounterAgrees,
    firstCompletionAt,
    lastCompletionAt,
    intervalElapsedMs,
    intervalFps: timestamps.length < 2 ? null : fps(timestamps.length - 1, intervalElapsedMs),
    throughputWindowStartAt: windowStartAt,
    throughputWindowMs,
    throughputFps: fps(matchedFrameCount, throughputWindowMs),
    frameIntervalMs: distribution(intervals),
    receipts: profileReceiptIdentities,
  };
}

async function collectCodeIdentity(tasks, payloadTasks, root, appRoot) {
  const servedModules = await Promise.all(tasks);
  const loadedPayloads = await Promise.all(payloadTasks);
  const sourceFiles = new Map();
  const distFiles = new Map();
  const loadedDistPayloads = new Map();
  const loadedNativePayloads = new Map();
  const uniqueModules = new Map();
  for (const module of servedModules) {
    uniqueModules.set(module.url, module);
    const diskPath = await sourcePathFromUrl(module.url, root, appRoot);
    if (diskPath === undefined) continue;
    const rel = relative(root, diskPath).split(sep).join('/');
    if (rel.startsWith('..') || rel === '') continue;
    const diskSha256 = await hashFile(diskPath);
    if (rel.split('/').includes('dist')) {
      distFiles.set(rel, { path: rel, sha256: diskSha256 });
      loadedDistPayloads.set(module.url, {
        path: rel,
        url: module.url,
        sha256: module.sha256 ?? null,
        diskSha256,
        resourceType: 'script',
      });
    } else if (!rel.split('/').includes('node_modules')) {
      sourceFiles.set(rel, { path: rel, sha256: diskSha256 });
    }
  }
  for (const payload of loadedPayloads) {
    const diskPath = await sourcePathFromUrl(payload.url, root, appRoot);
    const rel = diskPath === undefined ? undefined : relative(root, diskPath).split(sep).join('/');
    const pathname = new URL(payload.url).pathname.toLowerCase();
    const row = {
      path: rel && !rel.startsWith('..') ? rel : null,
      url: payload.url,
      status: payload.status,
      resourceType: payload.resourceType,
      contentType: payload.contentType,
      byteLength: payload.byteLength ?? null,
      sha256: payload.sha256 ?? null,
      ...(payload.bodyError === undefined ? {} : { bodyError: payload.bodyError }),
      ...(diskPath === undefined ? {} : { diskSha256: await hashFile(diskPath) }),
    };
const recordLoadedIdentityPayload = () => {
    if (/\.(?:wasm|node|dll|so|dylib)$/.test(pathname)) {
      loadedNativePayloads.set(payload.url, row);
    } else if (rel?.split('/').includes('dist') || pathname.startsWith('/assets/')) {
      loadedDistPayloads.set(payload.url, row);
      if (rel && !rel.startsWith('..') && rel.split('/').includes('dist')) {
        distFiles.set(rel, { path: rel, sha256: row.diskSha256 ?? row.sha256 });
      }
    }};
recordLoadedIdentityPayload();

  }
  const served = [...uniqueModules.values()].sort((left, right) =>
    left.url.localeCompare(right.url),
  );
  const sources = [...sourceFiles.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const distributions = [...distFiles.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const loadedDist = [...loadedDistPayloads.values()].sort((left, right) =>
    left.url.localeCompare(right.url),
  );
  const loadedNative = [...loadedNativePayloads.values()].sort((left, right) =>
    left.url.localeCompare(right.url),
  );
  return {
    gitHead: gitHead(root),
    gitStatus: gitStatus(root),
    sourceFiles: sources,
    sourceSha256: hashJson(sources),
    distFiles: distributions,
    distSha256: hashJson(distributions),
    loadedDistPayloads: loadedDist,
    loadedDistPayloadsSha256: hashJson(loadedDist),
    loadedNativePayloads: loadedNative,
    loadedNativePayloadsSha256: hashJson(loadedNative),
    servedModules: served,
    servedSha256: hashJson(served),
  };
}

async function sourcePathFromUrl(value, root, appRoot) {
  const pathname = decodeURIComponent(new URL(value).pathname);
  if (pathname.startsWith('/@fs/')) {
    const candidate = resolve(pathname.slice('/@fs/'.length));
    try {
      return (await stat(candidate)).isFile() ? candidate : undefined;
    } catch {
      return undefined;
    }
  }
  if (!pathname.startsWith('/') || pathname.startsWith('/@')) return undefined;
  const route = pathname.replace(/^\/+/, '');
  const candidates = [resolve(appRoot, route)];
  if (route.startsWith('assets/')) candidates.push(resolve(appRoot, 'dist', route));
  candidates.push(resolve(root, route));
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return resolve(candidate);
    } catch {
      // Try the next Vite route root.
    }
  }
  return undefined;
}

function isIdentityPayloadUrl(value) {
  const pathname = decodeURIComponent(new URL(value).pathname).toLowerCase();
  return (
    /\.(?:wasm|node|dll|so|dylib|bin|pack(?:\.[^/]+)?|receipt\.json|body\.json|pack-index\.json)$/.test(
      pathname,
    ) ||
    (pathname.startsWith('/assets/') && pathname.endsWith('.json'))
  );
}

function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function gitStatus(root) {
  try {
    return execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function jsonText(value) {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item));
  } catch {
    return String(value);
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
