#!/usr/bin/env node

// Browser companion to smoke-dawn.mjs. Dawn owns the numerical Motion Blur
// falsifier; this carrier owns the dev-server pack path, WebGPU validation,
// compositor readback, and deterministic controls. Device-loss recovery is a
// separate provider-dependent lane and is not inferred from a browser crash.

import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import {
  AUTO_EXPOSURE_TAA_FIXTURE,
  AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY,
} from '@forgeax/apps-shared/auto-exposure-fixture';
import { createFeatureEvidence, emitRequiredUnavailable } from './required-evidence.mjs';
import { createBrowserFeatureObservation } from './feature-evidence-producer.mjs';
import { withTimeout } from './smoke-carrier.mjs';
import { compareDecodedRgb, validateMotionBlurTrace } from './smoke-browser-observations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const autoExposureFixtureIdentity = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json'), 'utf8'),
);
if (JSON.stringify(autoExposureFixtureIdentity) !== JSON.stringify(AUTO_EXPOSURE_TAA_FIXTURE_IDENTITY)) {
  throw new Error('hello-taa: scene-identity.json is not the shared auto-exposure fixture identity');
}
const FRAME_FLOOR = 60;
const falsifierLightweight = process.env.FORGEAX_TAA_FALSIFIER_PROFILE === 'ci';
const FEATURE_DOMAIN_NAMES = Object.freeze({
  'linear-hdr': 'linear-HDR',
  'linear-ldr': 'linear-LDR',
  'final-display': 'final-sRGB',
});
const MAX_VITE_READINESS_TIMEOUT_MS = 180_000;
const VITE_READINESS_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_TAA_VITE_READINESS_TIMEOUT_MS ?? '180000', 10) || 180_000, 1),
  MAX_VITE_READINESS_TIMEOUT_MS,
);
const PACK_CATALOG_PATH = '/__pack/scopes/hello-taa/1/catalog.json';
const PACK_READINESS_POLL_MS = 100;
const requestedFrames = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? `${FRAME_FLOOR}`, 10);
const requiredFrames = Math.max(Number.isFinite(requestedFrames) ? requestedFrames : FRAME_FLOOR, FRAME_FLOOR);
const waitMs = Number.parseInt(process.env.SMOKE_BROWSER_WAIT_MS ?? '180000', 10);
const channel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
const headless = process.env.FORGEAX_BROWSER_HEADLESS !== '0';
const serverPort = process.env.SMOKE_BROWSER_PORT ?? '0';
const evidenceDir = process.env.SMOKE_EVIDENCE_DIR;
const visualCase = process.env.SMOKE_CASE ?? 'moving-rigid';
const workloadKind = process.env.SMOKE_WORKLOAD ?? 'none';
const evidencePrefix = process.env.SMOKE_EVIDENCE_PREFIX ?? visualCase;
const timingMode = ['1', 'manual'].includes(process.env.SMOKE_TIMING_MODE ?? '');
const timingCaptureEnabled = process.env.SMOKE_TIMING_MODE === '1';
const timingResolutionId = process.env.SMOKE_TIMING_RESOLUTION ?? '1080p';
const timingResolution = timingResolutionId === '4K'
  ? { id: '4K', width: 3840, height: 2160 }
  : { id: '1080p', width: 1920, height: 1080 };
const viewport = falsifierLightweight ? { width: 320, height: 180 } : { width: 960, height: 720 };
const timingFrameCount = 420;
const timingViewport = {
  width: Number.parseInt(process.env.SMOKE_TIMING_WIDTH ?? `${timingResolution.width}`, 10),
  height: Number.parseInt(process.env.SMOKE_TIMING_HEIGHT ?? `${timingResolution.height}`, 10),
};
const timingDeviceScaleFactor = Number.parseFloat(process.env.SMOKE_TIMING_DEVICE_SCALE_FACTOR ?? '1');
if (timingMode && !['manual', 'auto', 'positive-lut'].includes(workloadKind)) {
  throw new Error(`SMOKE_TIMING_MODE requires SMOKE_WORKLOAD=manual, auto, or positive-lut, got ${workloadKind}`);
}
const captureLabel = (label) => `${evidencePrefix}-${label}`;
const normalizeFeatureStages = (stages) =>
  (Array.isArray(stages) ? stages : []).map((stage) => ({
    ...stage,
    domain: FEATURE_DOMAIN_NAMES[stage?.domain] ?? stage?.domain,
  }));
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const expectMotionDifference = [
  'moving-rigid',
  'camera-pan',
  'depth-edge',
  'cut-reset',
  'taa-motion-blur-bloom',
].includes(visualCase);
const SOFTWARE_PROVENANCE_PATTERN = /swiftshader|lavapipe|llvmpipe|software|fallback/i;

class GateFailure extends Error {}
class TimingComplete extends Error {}

const execFileAsync = promisify(execFile);

const fail = (message) => {
  throw new GateFailure(message);
};

// Vite prints its Local URL before plugin-pack has finished the source scan
// and publication transaction.  Starting the browser at that point races the
// first lazy import against the deliberately fail-closed 503 Pack route; the
// runtime then reports the less useful "no ImportTransport" miss.  Probe the
// same scoped catalog URL the browser will consume and admit the page only
// after the producer has published an authoritative snapshot.  A persistent
// producer failure remains red, and a 503 is only treated as a bounded startup
// state—not as a successful fallback.
const waitForScopedPackCatalog = async (baseUrl) => {
  const startedAt = Date.now();
  let lastDiagnostics = { status: 'unobserved' };
  while (Date.now() - startedAt < VITE_READINESS_TIMEOUT_MS) {
    try {
      const response = await fetch(`${baseUrl}${PACK_CATALOG_PATH}`, { cache: 'no-store' });
      const body = await response.text();
      lastDiagnostics = { status: response.status, body: body.slice(0, 1024) };
      if (response.status === 404 || response.status === 410) {
        fail(`Pack catalog route is not bound for hello-taa: ${JSON.stringify(lastDiagnostics)}`);
      }
      if (response.ok) {
        let snapshot;
        try {
          snapshot = JSON.parse(body);
        } catch {
          fail(`Pack catalog readiness returned invalid JSON: ${JSON.stringify(lastDiagnostics)}`);
        }
        if (
          snapshot?.schemaVersion !== 'runtime-catalog-snapshot-v1' ||
          snapshot?.scopeId !== 'hello-taa' ||
          snapshot?.generation !== 1 ||
          snapshot?.authority !== 'authoritative'
        ) {
          fail(`Pack catalog readiness was not authoritative: ${JSON.stringify(snapshot)}`);
        }
        return snapshot;
      }
    } catch (error) {
      if (error instanceof GateFailure) throw error;
      lastDiagnostics = { error: error instanceof Error ? error.message : String(error) };
    }
    await sleep(PACK_READINESS_POLL_MS);
  }
  fail(
    `Pack catalog did not become authoritative within ${VITE_READINESS_TIMEOUT_MS}ms: ${JSON.stringify(lastDiagnostics)}`,
  );
};

const vite = spawn('pnpm', ['--filter', '@forgeax/hello-taa', 'exec', 'vite', '--host', '127.0.0.1', '--port', serverPort], {
  cwd: REPO_ROOT,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '0' },
  // pnpm owns the Vite child. On POSIX, isolate the complete dev-server
  // tree so teardown cannot leave a grandchild holding this smoke open.
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteClosed = false;
let viteSpawnError;
let viteTreePids;
// `close` waits for stdout/stderr pipes as well as process termination.  A
// Vite descendant can keep those pipes open briefly after pnpm has exited,
// which would falsely turn a ready timing report into a cleanup failure.  The
// process `exit` event is the lifecycle authority here; descendants are still
// terminated explicitly by signalVite below.
const viteExit = new Promise((resolve) =>
  vite.once('exit', (code, signal) => {
    viteClosed = true;
    resolve({ code, signal });
  }),
);
vite.once('error', (error) => {
  viteSpawnError = error;
});
let appUrl;
let serverOutput = '';
const observeServer = (chunk) => {
  serverOutput += String(chunk);
  const plain = serverOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  appUrl ??= plain.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
};
vite.stdout.on('data', (chunk) => observeServer(chunk));
vite.stderr.on('data', (chunk) => observeServer(chunk));

let browser;
let context;
let page;
let browserProvenance;
const pageErrors = [];
const consoleErrors = [];
const requestFailures = [];
const screenshots = [];

const asLaunchArgs = (value) => {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  if (typeof value === 'string') return value.split(/\s+/).filter((entry) => entry.length > 0);
  return [];
};

// Physical Browser verification must inherit the host adapter.  Software
// correctness runs may opt into a carrier explicitly through the environment,
// but this generic smoke must never force a software adapter for every caller.
const explicitLaunchArgs = asLaunchArgs(process.env.FORGEAX_BROWSER_LAUNCH_ARGS);

const collectBrowserProvenance = async () => {
  const browserVersion = browser === undefined ? '' : browser.version();
  const processLaunchArgs = asLaunchArgs(browser?.process?.()?.spawnargs);
  const runner = {
    kind: 'playwright',
    id: channel,
    channel,
    version: browserVersion,
    os: `${process.platform}-${process.arch}`,
    headless,
    launchArgs: processLaunchArgs,
  };
  let systemInfo;
  let webGpuAdapter;
  try {
    const cdp = await browser.newBrowserCDPSession();
    console.log('[smoke-browser] requesting CDP system info');
    systemInfo = await cdp.send('SystemInfo.getInfo');
    console.log('[smoke-browser] CDP system info received');
    await cdp.detach().catch(() => undefined);
  } catch (cause) {
    systemInfo = { error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (page !== undefined) {
    console.log('[smoke-browser] requesting WebGPU adapter info');
    webGpuAdapter = await page
      .evaluate(async () => {
        if (navigator.gpu === undefined) return undefined;
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter === null) return undefined;
        const info = adapter.info;
        const isFallbackAdapter =
          typeof info?.isFallbackAdapter === 'boolean'
            ? info.isFallbackAdapter
            : typeof adapter.isFallbackAdapter === 'boolean'
              ? adapter.isFallbackAdapter
              : null;
        return {
          vendor: typeof info?.vendor === 'string' ? info.vendor : '',
          architecture: typeof info?.architecture === 'string' ? info.architecture : '',
          device: typeof info?.device === 'string' ? info.device : '',
          description: typeof info?.description === 'string' ? info.description : '',
          isFallbackAdapter,
        };
      })
      .catch(() => undefined);
  }
  const devices = Array.isArray(systemInfo?.gpu?.devices) ? systemInfo.gpu.devices : [];
  const device = devices.find((entry) => entry?.active === true) ?? devices[0] ?? {};
  const launchArgs = Array.from(
    new Set([...asLaunchArgs(systemInfo?.commandLine), ...processLaunchArgs]),
  );
  const vendor = webGpuAdapter?.vendor || device.vendorString || device.vendor || '';
  const deviceName = webGpuAdapter?.device || device.deviceString || device.device || '';
  // Architecture is an explicit WebGPU adapter fact. Never substitute a
  // device/renderer label here: a guessed field would turn incomplete CDP
  // output into physical-adapter evidence.
  const architecture = webGpuAdapter?.architecture ?? '';
  const description =
    webGpuAdapter?.description || device.description || device.glRenderer || deviceName;
  const driver = device.driverVendor ?? device.driver ?? '';
  const isFallbackAdapter = webGpuAdapter?.isFallbackAdapter ?? null;
  const adapterText = [vendor, deviceName, architecture, description, driver].join(' ');
  const denylisted = SOFTWARE_PROVENANCE_PATTERN.test(
    adapterText + ' ' + launchArgs.join(' '),
  );
  const physicalGpu =
    isFallbackAdapter === false &&
    !denylisted &&
    devices.length > 0 &&
    Number.isSafeInteger(device.vendorId) &&
    Number.isSafeInteger(device.deviceId) &&
    typeof vendor === 'string' &&
    vendor.length > 0 &&
    typeof deviceName === 'string' &&
    deviceName.length > 0 &&
    typeof architecture === 'string' &&
    architecture.length > 0 &&
    typeof description === 'string' &&
    description.length > 0;
  return {
    adapter: {
      physicalGpu,
      fallbackAdapter: isFallbackAdapter,
      isFallbackAdapter,
      vendorId: device.vendorId,
      deviceId: device.deviceId,
      vendor,
      device: deviceName,
      architecture,
      description,
      driver,
      driverVersion: device.driverVersion ?? '',
      backend: 'webgpu',
      source: 'cdp:SystemInfo.getInfo+WebGPUAdapter.info',
      ...(systemInfo?.error === undefined ? {} : { error: systemInfo.error }),
    },
    runner: {
      ...runner,
      version: browserVersion,
      launchArgs,
      launchArgsSource: 'browser.process+cdp:SystemInfo.getInfo',
      commandLine: typeof systemInfo?.commandLine === 'string' ? systemInfo.commandLine : '',
    },
  };
};

const frameIdOf = (state) =>
  typeof state?.frame === 'number' ? state.frame : state?.frame?.frameId;

const readInspection = async () => {
  const state = await page.evaluate(() => {
    const text = document.querySelector('#inspection')?.textContent ?? '';
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  });
  if (state === undefined) fail('TAA inspection never published valid JSON');
  if (state.dynamicResolution?.enabled === false && state.dynamicResolution.status !== 'off') {
    fail(`disabled Dynamic Resolution reports stale status: ${JSON.stringify(state.dynamicResolution)}`);
  }
  return state;
};

const waitForFrame = async (minimum) => {
  await page.waitForFunction(
    (target) => {
      const text = document.querySelector('#inspection')?.textContent ?? '';
      try {
        const state = JSON.parse(text);
        const frameId = typeof state.frame === 'number' ? state.frame : state.frame?.frameId;
        return Number.isFinite(frameId) && frameId >= target;
      } catch {
        return false;
      }
    },
    minimum,
    { timeout: waitMs },
  );
  return readInspection();
};

const waitForInspection = async (predicate, label) => {
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt < waitMs) {
    latest = await readInspection();
    if (predicate(latest)) return latest;
    await sleep(PACK_READINESS_POLL_MS);
  }
  fail(`${label} did not publish the expected state within ${waitMs}ms: ${JSON.stringify(latest)}`);
};

const compositorReadback = async (label) => {
  const png = await page.locator('#app').screenshot({ type: 'png' });
  const sha256 = createHash('sha256').update(png).digest('hex');
  const pixels = await page.evaluate(async (encoded) => {
    const response = await fetch(`data:image/png;base64,${encoded}`);
    const bitmap = await createImageBitmap(await response.blob());
    const surface = document.createElement('canvas');
    surface.width = bitmap.width;
    surface.height = bitmap.height;
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Browser compositor PNG readback has no 2D decoder');
    context.drawImage(bitmap, 0, 0);
    const width = bitmap.width;
    const height = bitmap.height;
    const data = context.getImageData(0, 0, width, height).data;
    bitmap.close();
    const rgbBytes = new Uint8Array(width * height * 3);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < data.length; sourceIndex += 4) {
      rgbBytes[targetIndex++] = data[sourceIndex] ?? 0;
      rgbBytes[targetIndex++] = data[sourceIndex + 1] ?? 0;
      rgbBytes[targetIndex++] = data[sourceIndex + 2] ?? 0;
    }
    const rgbDigest = await crypto.subtle.digest('SHA-256', rgbBytes);
    const rgbHash = Array.from(new Uint8Array(rgbDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let nonBlack = 0;
    let sum = 0;
    let sumSquared = 0;
    let bottomSum = 0;
    let bottomSquared = 0;
    let bottomCount = 0;
    let alphaMin = 255;
    let alphaOpaque = 0;
    let sampledPixels = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const index = (y * width + x) * 4;
        const alpha = data[index + 3] ?? 0;
        alphaMin = Math.min(alphaMin, alpha);
        if (alpha === 255) alphaOpaque += 1;
        sampledPixels += 1;
        const luma = (0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]) / 255;
        if (luma > 0.01) nonBlack += 1;
        sum += luma;
        sumSquared += luma * luma;
        if (y >= height * 0.5) {
          bottomSum += luma;
          bottomSquared += luma * luma;
          bottomCount += 1;
        }
      }
    }
    const count = Math.max(1, Math.ceil(width / 2) * Math.ceil(height / 2));
    const meanLuma = sum / count;
    const bottomMean = bottomSum / Math.max(1, bottomCount);
    return {
      width,
      height,
      rgbHash,
      nonBlack,
      meanLuma,
      stddevLuma: Math.sqrt(Math.max(0, sumSquared / count - meanLuma * meanLuma)),
      bottomMeanLuma: bottomMean,
      bottomStddevLuma: Math.sqrt(Math.max(0, bottomSquared / Math.max(1, bottomCount) - bottomMean * bottomMean)),
      alphaMin,
      alphaOpaque,
      sampledPixels,
    };
  }, png.toString('base64'));
  const evidence = {
    label,
    sha256,
    bytes: png.byteLength,
    ...(evidenceDir === undefined ? {} : { path: `${evidenceDir}/${label}.png` }),
    pixels,
  };
  if (evidenceDir !== undefined) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/${label}.png`, png);
  }
  screenshots.push(evidence);
  console.log(`[smoke-browser] ${label}: ${pixels.width}x${pixels.height} nonBlack=${pixels.nonBlack} luma=${pixels.meanLuma.toFixed(4)} bottomStddev=${pixels.bottomStddevLuma.toFixed(4)} pngSha256=${sha256} rgbSha256=${pixels.rgbHash}`);
  if (pixels.nonBlack === 0) fail(`${label} compositor readback is entirely black`);
  return evidence;
};

const assertOnState = (state, label) => {
  if (state.backend !== 'webgpu') fail(`${label}: backend=${state.backend ?? 'unknown'}, expected webgpu`);
  if (state.antialias !== 'taa') {
    fail(`${label}: antialias=${state.antialias ?? 'unknown'}, expected taa`);
  }
  if (state.temporal?.status !== 'stable' || state.temporal.historyValid !== true) {
    fail(`${label}: TAA history is not stable and valid: ${JSON.stringify(state.temporal)}`);
  }
  if (state.taa?.enabled !== true || state.taa?.historyOwner !== 'renderer-temporal') {
    fail(`${label}: TAA-only carrier is not enabled: ${JSON.stringify(state.taa)}`);
  }
  if (
    state.dynamicResolution?.enabled !== true ||
    state.dynamicResolution?.coverageProducer !== true ||
    state.dynamicResolution?.internal === null
  ) {
    fail(`${label}: fixed TAAU carrier is not producing internal extent/coverage: ${JSON.stringify(state.dynamicResolution)}`);
  }
  const passes = state.passes ?? [];
  for (const pass of ['standard-scene-data', 'taa-resolve']) {
    if (!passes.includes(pass)) fail(`${label}: missing required pass ${pass}`);
  }
};

const assertNoUnexpectedErrors = () => {
  // Every renderer error is a gate failure. Preserve the first hello-level
  // structured carrier together with the full error corpus so an
  // ensureCompiledFrameGraph failure cannot be hidden by its facade wrapper.
  const firstRendererError = consoleErrors.find(
    (message) => message.includes('[hello-taa] renderer error') || message.includes('RendererOperationError:'),
  );
  if (pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
    fail(
      `browser errors: ${JSON.stringify({
        firstRendererError,
        pageErrors,
        consoleErrors,
        requestFailures,
      })}`,
    );
  }
};

const unavailable = (reason, detail = {}) => {
  emitRequiredUnavailable({
    backend: 'browser',
    status: 'unavailable',
    reason,
    requiredProbe: 'browser launch, 60 frames, compositor readback, validation, Motion Blur toggle, and pause/resume recovery',
    ...detail,
  });
};

const signalVite = async (signal) => {
  if (vite.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      // `detached` makes the pnpm/Vite tree its own process group.  Signal the
      // group first so a reparented Vite child cannot survive after the outer
      // pnpm process exits; the explicit PID walk below remains a fallback for
      // hosts where the child was not attached to that group.
      try {
        process.kill(-vite.pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH' && error?.code !== 128 && !viteClosed) throw error;
      }
      // pnpm may keep the nested Vite process in the caller's process group
      // even when the outer child was requested as detached.  Capture the
      // exact descendant tree once and signal those PIDs directly so a
      // reparented Vite child cannot survive the smoke and steal port 5173.
      if (viteTreePids === undefined) {
        const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=']);
        const childrenByParent = new Map();
        for (const line of stdout.split(/\r?\n/)) {
          const [pidText, ppidText] = line.trim().split(/\s+/);
          const pid = Number(pidText);
          const ppid = Number(ppidText);
          if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
          const children = childrenByParent.get(ppid) ?? [];
          children.push(pid);
          childrenByParent.set(ppid, children);
        }
        const queue = [vite.pid];
        viteTreePids = [];
        while (queue.length > 0) {
          const pid = queue.shift();
          if (pid === undefined || viteTreePids.includes(pid)) continue;
          viteTreePids.push(pid);
          queue.push(...(childrenByParent.get(pid) ?? []));
        }
      }
      for (const pid of [...viteTreePids].reverse()) {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error?.code !== 'ESRCH' && error?.code !== 128 && !viteClosed) throw error;
        }
      }
    } else {
      const args = ['/PID', String(vite.pid), '/T'];
      if (signal === 'SIGKILL') args.push('/F');
      await execFileAsync('taskkill', args);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH' && error?.code !== 128 && !viteClosed) throw error;
  }
};

const waitForViteClose = async (timeoutMs) => {
  return Promise.race([
    viteExit.then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
};

const stopVite = async () => {
  await signalVite('SIGTERM');
  if (await waitForViteClose(5_000)) return;
  console.error('[smoke-browser] vite process group did not close after SIGTERM; forcing SIGKILL');
  await signalVite('SIGKILL');
  if (!(await waitForViteClose(5_000))) {
    throw new Error('vite process-group cleanup incomplete after SIGKILL');
  }
};

const closeBrowser = async () => {
  if (browser === undefined) return;
  let cleanupError;
  const closeResource = async (label, close, timeoutMs = 10_000) => {
    try {
      await withTimeout(label, close, timeoutMs);
    } catch (error) {
      cleanupError ??= error;
    }
  };
  // Close the page and context before Chromium. This drains page-owned
  // WebGPU resources explicitly; headed Chrome can otherwise keep its GPU
  // process alive after browser.close() and make the next smoke phase inherit
  // stale queue state.
  await closeResource('page', () => page?.close());
  await closeResource('context', () => context?.close());
  const currentBrowser = browser;
  // Chromium may need the full Playwright close window after a real WebGPU
  // readback/submit sequence; keep the page/context fence short but allow the
  // browser process to perform its own bounded graceful-close/kill cycle.
  await closeResource('browser', () => currentBrowser.close(), 35_000);
  if (cleanupError !== undefined) {
    // Playwright exposes this connection only on its Node implementation. It
    // is a last-resort transport fence after the bounded public close path;
    // do not silently turn a real teardown failure into a green smoke.
    currentBrowser._connection?.close();
    await sleep(300);
    throw cleanupError;
  }
  page = undefined;
  context = undefined;
  browser = undefined;
};

let resultCode = 0;
let gatePassed = false;
try {
  const readinessStartedAt = Date.now();
  while (appUrl === undefined && viteSpawnError === undefined && !viteClosed && Date.now() - readinessStartedAt < VITE_READINESS_TIMEOUT_MS) await sleep(100);
  const readinessDiagnostics = JSON.stringify({
    elapsedMs: Date.now() - readinessStartedAt,
    pid: vite.pid ?? null,
    exitCode: vite.exitCode,
    signalCode: vite.signalCode,
    spawnError: viteSpawnError === undefined ? null : String(viteSpawnError),
    output: serverOutput.trim() || 'none',
  });
  if (viteSpawnError !== undefined) throw new Error(`Vite failed to start; diagnostics=${readinessDiagnostics}`);
  if (appUrl === undefined) throw new Error(`Vite did not publish a URL within ${VITE_READINESS_TIMEOUT_MS}ms; diagnostics=${readinessDiagnostics}`);
  console.log(`[smoke-browser] using ${appUrl} channel=${channel} headless=${headless}`);
  await waitForScopedPackCatalog(appUrl);
  console.log('[smoke-browser] pack catalog ready; launching browser');

  try {
    browser = await chromium.launch({
      headless,
      channel,
      // Playwright's Chromium defaults include --enable-unsafe-swiftshader on
      // hosts where WebGPU is not generally enabled.  That implicit flag is
      // still a software-rendering admission even when the feature runner's
      // explicit args are clean, so remove only this default and retain the
      // rest of Playwright's safety defaults.  Provenance below remains the
      // final authority and blocks when Chrome still falls back.
      ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
      args: [
        '--disable-features=MacAppCodeSignClone',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--ignore-gpu-blocklist',
        '--disable-gpu-driver-bug-workarounds',
        '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
        ...explicitLaunchArgs,
      ],
      chromiumSandbox: true,
    });
  } catch (error) {
    unavailable(`chromium launch failed on channel ${channel}`, {
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    resultCode = 1;
  }

  if (browser !== undefined) {
    context = await browser.newContext(
      timingMode
        ? { viewport: timingViewport, deviceScaleFactor: timingDeviceScaleFactor }
        : { viewport, deviceScaleFactor: 1 },
    );
    page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('favicon.ico')) consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      if (!request.url().includes('/@vite/client')) requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
    });

    const workloadQuery = workloadKind === 'none' ? '' : `&taa-workload=${encodeURIComponent(workloadKind)}`;
    const timingQuery = timingMode
      ? `&taa-timing=${timingCaptureEnabled ? '1' : 'manual'}&taa-timing-resolution=${encodeURIComponent(timingResolution.id)}`
      : '';
    const profileQuery = falsifierLightweight ? '&taa-profile=ci' : '';
    const dynamicResolutionQuery = '&taa-dynamic-resolution=1';
    await page.goto(`${appUrl}/?taa-smoke=1&taa-case=${encodeURIComponent(visualCase)}${workloadQuery}${timingQuery}${profileQuery}${dynamicResolutionQuery}`, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForSelector('#app', { timeout: 10_000 });
    // Collect provenance only after a page exists so WebGPU adapter.info is an
    // observed browser fact, not a guessed host/CDP substitution.
    console.log('[smoke-browser] page ready; collecting adapter provenance');
    browserProvenance = await withTimeout(
      'browser provenance',
      () => collectBrowserProvenance(),
      waitMs,
    );
    console.log('[smoke-browser] adapter provenance collected; waiting for frames');
    if (timingMode) {
      if (timingCaptureEnabled) {
        await page.waitForFunction(
          (targetFrames) => {
            const text = document.querySelector('#inspection')?.textContent ?? '';
            try {
              const state = JSON.parse(text);
              return state.timing?.status === 'blocked' || state.timing?.frameCount >= targetFrames;
            } catch {
              return false;
            }
          },
          timingFrameCount,
          { timeout: waitMs },
        );
      } else {
        await waitForFrame(1);
      }
      const state = await readInspection();
      const capability = state.timing?.capability ?? state.capabilities ?? {};
      const backend = {
        kind: state.backend ?? 'unknown',
        physicalGpu: browserProvenance?.adapter?.physicalGpu === true,
        timestampQuery: capability.timestampQuery === true,
        timestampPeriodNanoseconds: capability.timestampPeriodNanoseconds ?? null,
        adapter: browserProvenance?.adapter?.description ?? browserProvenance?.adapter?.device ?? '',
        driver: browserProvenance?.adapter?.driver || 'browser-webgpu',
        browser: browserProvenance?.runner?.channel || channel,
        device: browserProvenance?.adapter?.device ?? '',
      };
      const testedRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      const fixture = autoExposureFixtureIdentity;
      const sourcePath = resolve(REPO_ROOT, 'apps/hello/taa/src/main.ts');
      const buildPath = resolve(REPO_ROOT, 'apps/hello/taa/dist/index.html');
      const timingReport = {
        schemaVersion: 'forgeax-auto-exposure-gpu-pass-timing-observation/1',
        featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
        testedRevision,
        status: state.timing?.status === 'ready' ? 'ready' : 'blocked',
        workload: workloadKind,
        resolution: timingResolution,
        source: { path: 'apps/hello/taa/src/main.ts', sha256: sha256File(sourcePath) },
        build: { path: 'apps/hello/taa/dist/index.html', sha256: sha256File(buildPath) },
        runner: browserProvenance?.runner ?? { kind: 'playwright', id: channel, channel, headless, launchArgs: [] },
        backend,
        fixture,
        frame: state.timing?.frames?.at(-1) ?? null,
        frames: Array.isArray(state.timing?.frames) ? state.timing.frames : [],
        ...(state.timing?.manual === undefined ? {} : { manual: state.timing.manual }),
        ...(state.timing?.error === undefined ? {} : { error: state.timing.error }),
      };
      if (typeof process.env.SMOKE_TIMING_OUTPUT === 'string' && process.env.SMOKE_TIMING_OUTPUT.length > 0) {
        mkdirSync(resolve(process.env.SMOKE_TIMING_OUTPUT, '..'), { recursive: true });
        writeFileSync(process.env.SMOKE_TIMING_OUTPUT, `${JSON.stringify(timingReport, null, 2)}\n`);
      }
      console.log(JSON.stringify({ timingReport }));
      resultCode = timingReport.status === 'ready' ? 0 : 2;
      throw new TimingComplete();
    }
    let initial = await waitForFrame(requiredFrames);
    if (workloadKind === 'auto' || workloadKind === 'positive-lut') {
      await page.waitForFunction(
        (targetFrames) => {
          const text = document.querySelector('#inspection')?.textContent ?? '';
          try {
            const state = JSON.parse(text);
            return (
              (Array.isArray(state.observations) &&
                state.observations.length === 3 &&
                state.workload?.frameIdentity?.count >= targetFrames &&
                state.workload?.frameIdentity?.contiguous === true &&
                /^[a-f0-9]{64}$/.test(state.workload?.frameIdentity?.sequenceSha256 ?? '') &&
                state.workload?.frameIdentity?.sequenceSha256 !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' &&
                state.workload?.resourceGrowth?.stableFrames >= targetFrames) ||
              typeof state.observationError === 'string'
            );
          } catch {
            return false;
          }
        },
        requiredFrames,
        { timeout: waitMs },
      );
      initial = await readInspection();
    }
    assertOnState(initial, `initial ${requiredFrames}-frame inspection`);
    const initialFrame = frameIdOf(initial);
    if (!Number.isFinite(initialFrame)) fail(`initial inspection has no numeric frame id: ${JSON.stringify(initial.frame)}`);
    if (!validateMotionBlurTrace(initial, 'off').ok) fail(`initial TAA-only state unexpectedly demands Motion Blur: ${JSON.stringify(initial.motionBlur)}`);
    const initialOn = await compositorReadback(captureLabel('taa-on-taau'));
    // Manual workloads intentionally do not publish renderer-owned domain
    // observations. Use the canvas drawing-buffer extent as their canonical
    // identity instead of the compositor PNG extent, which includes the
    // authored CSS border and would diverge from the Dawn carrier.
    const featureCanvasExtent = await page.locator('#app').evaluate((element) => ({
      width: Number(element?.width ?? 0),
      height: Number(element?.height ?? 0),
    }));

    // Exercise the authored controls, including both TAA-only and fixed TAAU
    // carriers.  The smoke starts with fixed Dynamic Resolution enabled so the
    // initial graph proves the internal extent/coverage producer; these live
    // clicks then prove that removing and restoring the carrier keeps the
    // surface-domain path coherent and that TAA is the prerequisite for TAAU.
    await page.locator('#dynamic-resolution-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.includes('Dynamic Resolution Off') === true,
      undefined,
      { timeout: 5000 },
    );
    const taaOnlyState = await waitForInspection(
      (state) =>
        frameIdOf(state) > initialFrame &&
        state.antialias === 'taa' &&
        state.taa?.enabled === true &&
        state.dynamicResolution?.enabled === false &&
        state.dynamicResolution?.internal === null,
      'TAA-only toggle',
    );
    if (
      taaOnlyState.antialias !== 'taa' ||
      taaOnlyState.taa?.enabled !== true ||
      taaOnlyState.dynamicResolution?.enabled !== false ||
      taaOnlyState.dynamicResolution?.internal !== null
    ) {
      fail(`TAA-only toggle did not restore surface-domain inspection: ${JSON.stringify(taaOnlyState)}`);
    }
    const taaOnlyReadback = await compositorReadback(captureLabel('taa-on-taa-only'));

    await page.locator('#dynamic-resolution-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.includes('Dynamic Resolution 0.67') === true,
      undefined,
      { timeout: 5000 },
    );
    const fixedTaaBeforeToggle = await waitForInspection(
      (state) =>
        frameIdOf(state) > frameIdOf(taaOnlyState) &&
        state.dynamicResolution?.enabled === true &&
        state.dynamicResolution?.coverageProducer === true &&
        state.dynamicResolution?.internal !== null,
      'fixed TAAU toggle',
    );
    assertOnState(fixedTaaBeforeToggle, 'fixed TAAU after Dynamic Resolution toggle');

    await page.locator('#taa-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.includes('TAA Off') === true,
      undefined,
      { timeout: 5000 },
    );
    const taaOffState = await waitForInspection(
      (state) =>
        frameIdOf(state) > frameIdOf(fixedTaaBeforeToggle) &&
        state.antialias === 'none' &&
        state.taa?.enabled === false &&
        state.dynamicResolution?.enabled === false &&
        state.dynamicResolution?.internal === null,
      'TAA-off toggle',
    );
    if (
      taaOffState.antialias !== 'none' ||
      taaOffState.taa?.enabled !== false ||
      taaOffState.dynamicResolution?.enabled !== false ||
      taaOffState.dynamicResolution?.internal !== null
    ) {
      fail(`TAA-off toggle did not remove the dependent TAAU carrier: ${JSON.stringify(taaOffState)}`);
    }

    await page.locator('#taa-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.includes('TAA On') === true,
      undefined,
      { timeout: 5000 },
    );
    const taaRestoredState = await waitForInspection(
      (state) =>
        frameIdOf(state) > frameIdOf(taaOffState) &&
        state.antialias === 'taa' &&
        state.taa?.enabled === true &&
        state.dynamicResolution?.enabled === false &&
        state.dynamicResolution?.internal === null,
      'TAA restore',
    );
    if (taaRestoredState.antialias !== 'taa' || taaRestoredState.taa?.enabled !== true || taaRestoredState.dynamicResolution?.enabled !== false) {
      fail(`TAA restore did not produce the TAA-only carrier: ${JSON.stringify(taaRestoredState)}`);
    }

    await page.locator('#dynamic-resolution-toggle').click();
    await page.waitForFunction(
      () => document.querySelector('#control-status')?.textContent?.includes('Dynamic Resolution 0.67') === true,
      undefined,
      { timeout: 5000 },
    );
    const fixedTaaRestored = await waitForInspection(
      (state) =>
        frameIdOf(state) > frameIdOf(taaRestoredState) &&
        state.dynamicResolution?.enabled === true &&
        state.dynamicResolution?.coverageProducer === true &&
        state.dynamicResolution?.internal !== null,
      'fixed TAAU restore',
    );
    assertOnState(fixedTaaRestored, 'fixed TAAU after TAA restore');
    const fixedTaaRestoredReadback = await compositorReadback(captureLabel('taa-on-taau-restored'));

    // Pause must freeze the frame counter, then resume must advance it again.
    // The feature toggle is exercised on a live frame because a paused App
    // intentionally does not submit a new render after a World mutation.
    await page.locator('#pause-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.startsWith('Paused') === true, undefined, { timeout: 5000 });
    const paused = await readInspection();
    const pausedFrame = frameIdOf(paused);
    await sleep(300);
    const pausedAfterWait = await readInspection();
    if (paused.paused !== true || frameIdOf(pausedAfterWait) !== pausedFrame) {
      fail(`pause did not freeze the frame loop: before=${JSON.stringify(paused)} after=${JSON.stringify(pausedAfterWait)}`);
    }

    await page.locator('#pause-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.startsWith('Running') === true, undefined, { timeout: 5000 });
    const resumedOnState = await waitForFrame(pausedFrame + 3);
    assertOnState(resumedOnState, 'post-resume inspection');
    await compositorReadback(captureLabel('taa-on-taau-resumed'));

    // Motion Blur is an independent opt-in consumer. Toggle it on and back off
    // after the TAA-only/DynamicResolution carrier has produced fresh frames.
    await page.locator('#motion-blur-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.includes('Motion Blur On') === true, undefined, { timeout: 5000 });
    const motionBlurOnState = await waitForInspection(
      (state) => frameIdOf(state) > frameIdOf(fixedTaaRestored) && validateMotionBlurTrace(state, 'on').ok,
      'Motion Blur on toggle',
    );
    const onTrace = validateMotionBlurTrace(motionBlurOnState, 'on');
    if (!onTrace.ok) fail(`Motion Blur opt-in frame published an invalid trace: ${JSON.stringify(onTrace)}`);
    const motionBlurOn = await compositorReadback(captureLabel('motion-blur-on'));

    await page.locator('#motion-blur-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.includes('Motion Blur Off') === true, undefined, { timeout: 5000 });
    const motionBlurOnFrame = frameIdOf(motionBlurOnState);
    const offState = await waitForInspection(
      (state) => frameIdOf(state) > motionBlurOnFrame && validateMotionBlurTrace(state, 'off').ok,
      'Motion Blur off toggle',
    );
    const offTrace = validateMotionBlurTrace(offState, 'off');
    if (!offTrace.ok) fail(`Motion Blur off frame published an invalid trace: ${JSON.stringify(offTrace)}`);
    const resumedOffFrame = frameIdOf(offState);
    const off = await compositorReadback(captureLabel('motion-blur-off'));

    await page.locator('#pause-toggle').click();
    await page.waitForFunction(() => document.querySelector('#control-status')?.textContent?.startsWith('Paused') === true, undefined, { timeout: 5000 });
    const pausedOff = await readInspection();
    const pausedOffFrame = frameIdOf(pausedOff);
    await sleep(300);
    if (frameIdOf(await readInspection()) !== pausedOffFrame) fail('pause after toggle did not freeze the frame loop');

    if (expectMotionDifference) {
      const decodedRgbComparison = compareDecodedRgb(motionBlurOn, off);
      if (!decodedRgbComparison.ok) {
        fail(`Motion Blur on/off decoded RGB is indistinguishable: ${JSON.stringify(decodedRgbComparison)}`);
      }
    }
    assertNoUnexpectedErrors();

    const featureEvidence = workloadKind === 'none'
      ? createFeatureEvidence({
          backend: 'browser-webgpu',
          runner: { kind: 'playwright', id: channel },
          resolution: { width: initialOn.pixels.width, height: initialOn.pixels.height },
          frames: requiredFrames,
          sourceSha: sha256File(resolve(REPO_ROOT, 'apps/hello/taa/src/main.ts')),
          buildSha: sha256File(resolve(REPO_ROOT, 'apps/hello/taa/dist/index.html')),
          stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
            id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
            domain,
            readback: { rawHash: initialOn.pixels.rgbHash, frame: requiredFrames - 1 },
          })),
          resourceGrowth: { stableFrames: Math.max(1, requiredFrames - 240), byteLengthDelta: 0, bindGroupDelta: 0 },
        })
      : createBrowserFeatureObservation({
          workloadKind,
          state: initial,
          backend: 'browser-webgpu',
          runner: { kind: 'playwright', id: channel },
          // The compositor readback includes the authored canvas border. The
          // renderer-owned observation metadata is the canonical workload
          // extent and must match Dawn for the exact Browser/Dawn join.
          resolution: {
            width: initial.observations?.[0]?.metadata?.width ?? featureCanvasExtent.width,
            height: initial.observations?.[0]?.metadata?.height ?? featureCanvasExtent.height,
          },
          source: { path: 'apps/hello/taa/src/main.ts', sha256: sha256File(resolve(REPO_ROOT, 'apps/hello/taa/src/main.ts')) },
          build: { path: 'apps/hello/taa/dist/index.html', sha256: sha256File(resolve(REPO_ROOT, 'apps/hello/taa/dist/index.html')) },
          frames: requiredFrames,
          frameIdentity: initial.workload?.frameIdentity,
          fixtureIdentity: autoExposureFixtureIdentity,
          scene: AUTO_EXPOSURE_TAA_FIXTURE,
          provenance: {
            source: { path: 'apps/hello/taa/src/main.ts', sha256: sha256File(resolve(REPO_ROOT, 'apps/hello/taa/src/main.ts')) },
            build: { path: 'apps/hello/taa/dist/index.html', sha256: sha256File(resolve(REPO_ROOT, 'apps/hello/taa/dist/index.html')) },
            fixture: 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json',
            frame: initial.workload?.frameIdentity,
            backend: initial.backend,
            adapter: browserProvenance?.adapter,
            runner: browserProvenance?.runner,
          },
          stages: normalizeFeatureStages(initial.observations),
          resourceGrowth: initial.workload?.resourceGrowth,
        });
    if (workloadKind !== 'none') {
      const testedRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      if (typeof evidenceDir === 'string' && evidenceDir.length > 0) {
        writeFileSync(
          resolve(evidenceDir, `browser-${workloadKind}-feature.json`),
          `${JSON.stringify({
            schemaVersion: 'hello-taa-browser-feature-evidence/1',
            testedRevision,
            featureEvidence,
          }, null, 2)}\n`,
        );
      }
      console.log(JSON.stringify({ featureEvidence }));
      if (featureEvidence.status === 'blocked') fail(`feature workload evidence blocked: ${JSON.stringify(featureEvidence.errors)}`);
    }

    console.log(JSON.stringify({
      schemaVersion: 'hello-taa-browser-smoke/1',
      visualCase,
      backend: initial.backend,
      requiredFrames,
      recovery: { kind: 'pause-resume', pausedFrame, resumedFrame: resumedOffFrame, pausedOffFrame },
      controls: {
        pauseResume: true,
        taaToggle: true,
        dynamicResolutionToggle: true,
        taaOnly: true,
        dynamicResolution: true,
        motionBlurToggle: true,
        onOffDifferent: true,
      },
      toggleTrace: {
        taaOnly: { frame: frameIdOf(taaOnlyState), antialias: taaOnlyState.antialias, dynamicResolution: taaOnlyState.dynamicResolution },
        fixedBeforeTaaOff: { frame: frameIdOf(fixedTaaBeforeToggle), dynamicResolution: fixedTaaBeforeToggle.dynamicResolution },
        taaOff: { frame: frameIdOf(taaOffState), antialias: taaOffState.antialias, dynamicResolution: taaOffState.dynamicResolution },
        taaRestored: { frame: frameIdOf(taaRestoredState), antialias: taaRestoredState.antialias, dynamicResolution: taaRestoredState.dynamicResolution },
        fixedRestored: { frame: frameIdOf(fixedTaaRestored), dynamicResolution: fixedTaaRestored.dynamicResolution },
      },
      taaResolutionComparison: {
        taaOnly: {
          screenshot: taaOnlyReadback.label,
          frame: frameIdOf(taaOnlyState),
          antialias: taaOnlyState.antialias,
          dynamicResolution: taaOnlyState.dynamicResolution,
        },
        taaU: {
          screenshot: initialOn.label,
          frame: initialFrame,
          antialias: initial.antialias,
          dynamicResolution: initial.dynamicResolution,
        },
        taaURestored: {
          screenshot: fixedTaaRestoredReadback.label,
          frame: frameIdOf(fixedTaaRestored),
          antialias: fixedTaaRestored.antialias,
          dynamicResolution: fixedTaaRestored.dynamicResolution,
        },
      },
      screenshots,
      temporal: initial.temporal,
      passes: initial.passes,
      initialState: {
        frame: initialFrame,
        antialias: initial.antialias,
        taa: initial.taa,
        dynamicResolution: initial.dynamicResolution,
        motionBlur: initial.motionBlur,
        temporal: initial.temporal,
        passes: initial.passes,
      },
      resumedState: {
        frame: frameIdOf(resumedOnState),
        antialias: resumedOnState.antialias,
        taa: resumedOnState.taa,
        dynamicResolution: resumedOnState.dynamicResolution,
        motionBlur: resumedOnState.motionBlur,
        temporal: resumedOnState.temporal,
        passes: resumedOnState.passes,
      },
      offState: {
        frame: frameIdOf(offState),
        motionBlur: offState.motionBlur,
        passes: offState.passes,
      },
      errors: { page: pageErrors, console: consoleErrors, requests: requestFailures },
      initialReadback: initialOn.pixels,
      featureEvidence,
    }));
    gatePassed = true;
  }
} catch (error) {
  if (error instanceof TimingComplete) {
    // Timing mode writes its structured observation before terminating.  The
    // producer interprets exit 2 as a capability/observation block, while the
    // normal correctness gate keeps its existing failure handling below.
  } else if (!(error instanceof GateFailure) && page !== undefined) {
    resultCode = 1;
    const diagnostic = await withTimeout(
      'browser gate diagnostic',
      () =>
        page.evaluate(() => ({
          url: location.href,
          gpu: typeof navigator.gpu,
          inspection: document.querySelector('#inspection')?.textContent ?? '',
          controls: document.querySelector('#control-status')?.textContent ?? '',
        })),
      10_000,
    )
      .catch((diagnosticError) => ({ evaluateError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }));
    console.error(
      `[smoke-browser] browser gate diagnostic: ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        diagnostic,
        pageErrors,
        consoleErrors,
        requestFailures,
      })}`,
    );
  } else {
    resultCode = error instanceof GateFailure ? 1 : 2;
    console.error(`[smoke-browser] ${resultCode === 1 ? 'RED' : 'HARNESS ERROR'}: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  console.log('[smoke-browser] closing browser and Vite');
  try {
    await closeBrowser();
  } catch (error) {
    resultCode = 2;
    console.error(`[smoke-browser] HARNESS ERROR: browser cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await stopVite();
  } catch (error) {
    resultCode = 2;
    console.error(`[smoke-browser] HARNESS ERROR: vite cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (gatePassed && resultCode === 0) {
  console.log(`[smoke-browser] PASS TAA browser WebGPU ${requiredFrames}-frame/readback/toggle/pause-resume gate`);
}
process.exitCode = resultCode;
