#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import UPNG from 'upng-js';
import {
  DARK_GRADIENT_FIXTURE,
  createDarkGradientFixtureReport,
  createInsufficientEvidenceReport,
  pixelSourceForBackend,
} from './dark-gradient-fixture.mjs';
import {
  applyRuntimeEvent,
  createRuntimeCache,
  snapshotRuntimeCache,
} from './smoke-browser-runtime-cache.mjs';

const ROOT = new URL('../../../..', import.meta.url).pathname;
const port = process.env.FORGEAX_BROWSER_PORT ?? '5183';
const lane = process.env.FORGEAX_DARK_GRADIENT_LANE ?? 'direct';
const engine = process.env.FORGEAX_BROWSER_ENGINE ?? 'chromium';
const browserBackendId = engine === 'webkit'
  ? 'webkit-webgl2'
  : engine === 'chromium-webgl2' ? 'chromium-webgl2' : 'browser-webgpu';
const pixelSource = pixelSourceForBackend(browserBackendId);
const usesRawReadback = pixelSource.method === 'gpu-raw-readback';
const usesFinalDisplayReadback = !usesRawReadback;
const externalServerUrl = process.env.FORGEAX_DARK_GRADIENT_URL;
const screenshotDir = process.env.FORGEAX_DARK_GRADIENT_SCREENSHOT_DIR;
const browserCloseTimeoutMs = Number(process.env.FORGEAX_BROWSER_CLOSE_TIMEOUT_MS ?? 30_000);
const runtimeCache = createRuntimeCache({ pixelSourceMethod: pixelSource.method });
const RUNTIME_MARKER = '__forgeaxDarkGradientRuntime:';
const startedAt = Date.now();
let lastStage = 'startup';
let timeoutStage;
let pagePoisoned = false;
let finished = false;
let lastPageUrl = null;
const stageLedger = {
  current: 'startup',
  history: [],
  pauseTarget: null,
  screenshot: 'not-started',
  engineFrameId: null,
  observationId: null,
  rafFrame: null,
};
const pageStages = new Set([
  'newPage',
  'install-browser-hooks',
  'navigation',
  'observation-none',
  'capture-none',
  'phase-pause',
  'phase-pending-frame',
  'phase-resume',
  'webkit-pause',
  'webkit-canvas-bounds',
  'webkit-screenshot',
  'webkit-resume',
  'readback-none',
  'toggle-fxaa',
  'observation-fxaa',
  'capture-fxaa',
  'readback-fxaa',
  'screenshot-none',
  'screenshot-fxaa',
  'context-close',
  'observation-read',
  'capture-evidence-read',
  'page-close',
  'browser-close',
]);
// Software WebGL2 fallback can submit fewer than five Engine frames per
// second on a busy shared runner. Keep the observation budget above one
// minute and leave enough room for the paired readbacks and cleanup.
const hardDeadlineMs = Number(process.env.FORGEAX_BROWSER_HARD_DEADLINE_MS ?? 180_000);
const hardDeadline = setTimeout(() => {
  if (finished) return;
  timeoutStage ??= stageLedger.current;
  const diagnostics = {
    state: 'hard-deadline-exceeded',
    engine,
    lane,
    lastStage,
    timeoutStage,
    elapsedMs: Date.now() - startedAt,
    pageUrl: lastPageUrl,
    process: { viteExited, viteExitCode: viteExitCode ?? null, browserPresent: browser !== undefined },
    stageLedger,
    pixelSource,
    ...snapshotRuntimeCache(runtimeCache),
    cleanup,
    pageConsole: pageDiagnostics.console,
    pageErrors: pageDiagnostics.pageErrors,
    requestFailed: pageDiagnostics.requestFailed,
  };
  const report = createInsufficientEvidenceReport({
    backendId: browserBackendId,
    lane,
    reason: `hard-deadline-exceeded at ${lastStage}`,
    diagnostics,
  });
  console.error(`[dark-gradient-browser] report=${JSON.stringify(report)}`);
  process.exit(2);
}, hardDeadlineMs);
async function runStage(name, operation, timeoutMs = 30_000) {
  lastStage = name;
  stageLedger.current = name;
  stageLedger.history.push({ stage: name, status: 'started', elapsedMs: Date.now() - startedAt });
  let timeout;
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          timeoutStage = name;
          if (pageStages.has(name)) pagePoisoned = true;
          reject(new Error(`stage timeout: ${name} after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    stageLedger.history.push({ stage: name, status: 'complete', elapsedMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    stageLedger.history.push({ stage: name, status: 'failed', elapsedMs: Date.now() - startedAt, error: errorDetail(error) });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
if (lane !== 'direct' && lane !== 'clustered') {
  console.error(`[dark-gradient-browser] FAIL - unsupported lane=${lane}`);
  process.exit(2);
}
if (!['chromium', 'chromium-webgl2', 'webkit'].includes(engine)) {
  console.error(`[dark-gradient-browser] FAIL - unsupported browser engine=${engine}`);
  process.exit(2);
}

const vite = externalServerUrl === undefined
  ? spawn('pnpm', ['--filter', '@forgeax/hello-fxaa', 'dev', '--', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
  : undefined;
let viteExited = vite === undefined;
let viteExitCode;
vite?.once('exit', (code) => { viteExited = true; viteExitCode = code; });
const cleanup = {
  pageClose: 'not-started',
  contextClose: 'not-started',
  browserClose: 'not-started',
  viteShutdown: 'not-started',
};
let page;
const pageDiagnostics = {
  console: [],
  pageErrors: [],
  requestFailed: [],
};
const errorDetail = (error) => error instanceof Error
  ? {
    name: error.name,
    message: error.message,
    stack: error.stack ?? '',
    code: error.code ?? null,
    detail: error.detail ?? null,
    cause: error.cause?.message ?? error.cause ?? null,
  }
  : String(error);
const setupDiagnostics = (error, state) => ({
  state,
  engine,
  lane,
  lastStage,
  timeoutStage: timeoutStage ?? null,
  elapsedMs: Date.now() - startedAt,
  pageUrl: pagePoisoned ? lastPageUrl : page?.url() ?? null,
  process: {
    viteExited,
    viteExitCode: viteExitCode ?? null,
    browserPresent: browser !== undefined,
  },
  rAF: null,
  observation: null,
  pixelSource,
  ...snapshotRuntimeCache(runtimeCache),
  cleanup,
  error: errorDetail(error),
  pageConsole: pageDiagnostics.console,
  pageErrors: pageDiagnostics.pageErrors,
  requestFailed: pageDiagnostics.requestFailed,
});
const reportSetupFailure = (error, state) => {
  const diagnostics = setupDiagnostics(error, state);
  const report = createInsufficientEvidenceReport({
    backendId: browserBackendId,
    lane,
    reason: `${state}: ${error instanceof Error ? error.message : String(error)}`,
    diagnostics,
  });
  console.error(`[dark-gradient-browser] report=${JSON.stringify(report)}`);
};
let url;
let serverOutput = '';
const routeUrl = (baseUrl) => {
  const candidate = new URL(baseUrl);
  candidate.searchParams.set('fixture', 'dark-gradient');
  candidate.searchParams.set('lane', lane);
  candidate.searchParams.set('backend', browserBackendId);
  return candidate.toString();
};
const serverReady = externalServerUrl === undefined
  ? new Promise((resolve, reject) => {
      const onData = (chunk) => {
        serverOutput += chunk.toString();
        const match = serverOutput.match(/Local:\s+(https?:\/\/[^\s]+)/);
        if (match) {
          url = routeUrl(match[1]);
          resolve();
        }
      };
      vite.stdout.on('data', onData);
      vite.stderr.on('data', onData);
      vite.once('exit', (code) => reject(new Error(`vite exited before ready: ${code}\n${serverOutput}`)));
    })
  : Promise.resolve().then(() => {
      url = routeUrl(externalServerUrl);
    });
const viteHasExited = () => vite === undefined || viteExited || vite.exitCode !== null || vite.signalCode !== null;
const signalVite = (signal) => {
  if (vite === undefined || vite.pid === undefined) return;
  try {
    if (process.platform === 'win32') vite.kill(signal);
    else process.kill(-vite.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
};
const waitForViteExit = (timeoutMs) => {
  if (viteHasExited()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const onExit = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    vite.once('exit', onExit);
    timer = setTimeout(() => {
      vite.removeListener('exit', onExit);
      resolve(viteHasExited());
    }, timeoutMs);
    if (viteHasExited()) {
      vite.removeListener('exit', onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
};
async function shutdownVite() {
  cleanup.viteShutdown = 'started';
  if (viteHasExited()) {
    cleanup.viteShutdown = 'complete';
    return;
  }
  await runStage('vite-shutdown', async () => {
    signalVite('SIGTERM');
    if (await waitForViteExit(2_000)) return;
    signalVite('SIGKILL');
    if (await waitForViteExit(5_000)) return;
    throw new Error('vite process group did not exit after SIGTERM/SIGKILL');
  }, 10_000);
  cleanup.viteShutdown = 'complete';
}

let browser;
try {
  await runStage('server-readiness', () => serverReady);
  if (engine === 'webkit') {
    const probe = spawn(process.execPath, [new URL('./webkit-provider-probe.mjs', import.meta.url).pathname], {
      cwd: ROOT,
      env: {
        ...process.env,
        FORGEAX_WEBKIT_EXECUTABLE_PATH: process.env.FORGEAX_WEBKIT_EXECUTABLE_PATH
          ?? process.env.FORGEAX_BROWSER_EXECUTABLE_PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let probeOutput;
    try {
      probeOutput = await runStage('webkit-provider-probe', () => new Promise((resolve, reject) => {
        let output = '';
        probe.stdout.on('data', (chunk) => { output += chunk.toString(); });
        probe.stderr.on('data', (chunk) => { output += chunk.toString(); });
        probe.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output.trim() || `probe exit ${code}`)));
      }), 20_000);
    } catch (error) {
      if (probe.exitCode === null) probe.kill('SIGTERM');
      throw error;
    }
    console.warn(`[dark-gradient-browser] WebKit provider probe=${String(probeOutput).trim()}`);
  }
  const launchOptions = {
    headless: !['0', 'false'].includes((process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase()),
    timeout: 30_000,
  };
  if (engine === 'chromium-webgl2') {
    launchOptions.args = [
      '--disable-features=WebGPU',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-driver-bug-workarounds',
    ];
  } else if (engine !== 'webkit') {
    launchOptions.args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  }
  if (process.env.FORGEAX_BROWSER_CHANNEL !== undefined) {
    launchOptions.channel = process.env.FORGEAX_BROWSER_CHANNEL;
  }
  if (process.env.FORGEAX_BROWSER_EXECUTABLE_PATH !== undefined) {
    launchOptions.executablePath = process.env.FORGEAX_BROWSER_EXECUTABLE_PATH;
  }
  const browserType = engine === 'webkit' ? webkit : chromium;
  browser = await runStage('browser-launch', () => browserType.launch({ ...(launchOptions), chromiumSandbox: true }));
} catch (error) {
  const state = engine === 'webkit' && lastStage === 'webkit-provider-probe'
    ? 'provider-unavailable'
    : 'setup-failed';
  console.error(`[dark-gradient-browser] FAIL - ${state} at ${lastStage}: ${error instanceof Error ? error.message : String(error)}`);
  await shutdownVite().catch(() => { cleanup.viteShutdown = 'timeout-or-failed'; });
  reportSetupFailure(error, state);
  process.exit(2);
}

try {
  page = await runStage('newPage', () => browser.newPage({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    timeout: 30_000,
  }));
} catch (error) {
  cleanup.browserClose = 'started';
  await runStage('browser-close', () => browser.close(), 10_000)
    .then(() => { cleanup.browserClose = 'complete'; })
    .catch(() => { cleanup.browserClose = 'timeout-or-failed'; });
  await shutdownVite().catch(() => { cleanup.viteShutdown = 'timeout-or-failed'; });
  reportSetupFailure(error, 'setup-failed');
  console.error(`[dark-gradient-browser] FAIL - insufficient evidence at ${lastStage}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const appendDiagnostic = (key, value) => {
  const entries = pageDiagnostics[key];
  if (entries.length >= 32) entries.shift();
  entries.push(value);
  if (key === 'console' && typeof value.text === 'string' && value.text.startsWith('__forgeaxDarkGradientState:')) {
    try {
      const state = JSON.parse(value.text.slice('__forgeaxDarkGradientState:'.length));
      if (state.phase !== undefined) stageLedger.pauseTarget = state.phase;
      if (state.engineFrameId !== undefined) stageLedger.engineFrameId = state.engineFrameId;
      if (state.observationId !== undefined) stageLedger.observationId = state.observationId;
      if (state.rafFrame !== undefined) stageLedger.rafFrame = state.rafFrame;
      if (state.screenshot !== undefined) stageLedger.screenshot = state.screenshot;
    } catch {
      // Keep the raw console diagnostic when a state marker is malformed.
    }
  }
  if (key === 'console' && typeof value.text === 'string' && value.text.startsWith(RUNTIME_MARKER)) {
    try {
      applyRuntimeEvent(runtimeCache, JSON.parse(value.text.slice(RUNTIME_MARKER.length)));
    } catch {
      // Keep the raw console diagnostic when a runtime marker is malformed.
    }
  }
};
page.on('console', (message) => appendDiagnostic('console', {
  type: message.type(),
  text: message.text(),
  location: message.location(),
}));
page.on('pageerror', (error) => appendDiagnostic('pageErrors', {
  name: error.name,
  message: error.message,
  stack: error.stack ?? '',
  code: error.code ?? null,
  detail: error.detail ?? null,
  cause: error.cause?.message ?? error.cause ?? null,
}));
page.on('requestfailed', (request) => appendDiagnostic('requestFailed', {
  url: request.url(),
  method: request.method(),
  failure: request.failure(),
}));
try {
  await runStage('install-browser-hooks', () => page.addInitScript(({ rawReadback, pixelMethod }) => {
  const runtimeMarker = '__forgeaxDarkGradientRuntime:';
  const projectCause = (cause) => {
    if (cause === null || typeof cause !== 'object') return null;
    return {
      code: cause.code ?? null,
      expected: cause.expected ?? null,
      hint: cause.hint ?? null,
      detail: cause.detail ?? null,
    };
  };
  const errorDetails = (error) => ({
    code: error?.code ?? null,
    expected: error?.expected ?? null,
    hint: error?.hint ?? null,
    detail: {
      operation: error?.detail?.operation ?? null,
      frameId: error?.detail?.frameId ?? null,
      deviceGeneration: error?.detail?.deviceGeneration ?? null,
      cause: projectCause(error?.detail?.cause),
    },
    cause: projectCause(error?.cause),
  });
  const emitRuntimeEvent = (event) => {
    console.debug(`${runtimeMarker}${JSON.stringify(event)}`);
  };
  globalThis.__forgeaxDarkGradientBrowser = {
    adapter: undefined,
    device: undefined,
    context: undefined,
    lastTexture: undefined,
    lastTextureIdentity: undefined,
    acquiredFrame: undefined,
    rafFrame: 0,
    lastRenderedFrame: 0,
    captures: new Map(),
    captureFrames: new Map(),
    captureMetadata: new Map(),
    captureRequests: new Map(),
    webkitPaused: false,
    pausedAnimationFrames: [],
    textureIdentities: new WeakMap(),
    nextIdentity: 1,
    submittedFrames: [],
    pixelSourceMethod: pixelMethod,
    configureUsageBefore: undefined,
    configureUsageAfter: undefined,
    rawCopyInjected: false,
    surfaceIdentity: undefined,
    rendererErrors: [],
  };
  globalThis.__forgeaxDarkGradientArmCapture = ({ phase, engineFrameId, observationId = null }) => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    state.captureRequests.set(phase, {
      phase,
      engineFrameId,
      observationId,
      armedRafFrame: state.rafFrame,
      lastSkipReason: null,
    });
    console.debug(`__forgeaxDarkGradientState:${JSON.stringify({ phase, engineFrameId, observationId, rafFrame: state.rafFrame })}`);
  };
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (callback) => originalRequestAnimationFrame((time) => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    if (state.webkitPaused) {
      state.pausedAnimationFrames.push(() => callback(time));
      return;
    }
    state.rafFrame += 1;
    state.lastRenderedFrame = state.rafFrame;
    callback(time);
  });
  const originalContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(kind, attributes) {
    const context = originalContext.call(this, kind, attributes);
    if (kind !== 'webgpu' || context === null) return context;
    globalThis.__forgeaxDarkGradientBrowser.context = context;
    const originalGetCurrentTexture = context.getCurrentTexture.bind(context);
    context.getCurrentTexture = () => {
      let texture;
      try {
        texture = originalGetCurrentTexture();
      } catch (error) {
        const rendererError = errorDetails(error);
        globalThis.__forgeaxDarkGradientBrowser.rendererErrors.push({ stage: 'surface.getCurrentTexture', ...rendererError });
        emitRuntimeEvent({
          surfaceIdentity: globalThis.__forgeaxDarkGradientBrowser.surfaceIdentity ?? 'webgpu-surface',
          rendererError,
          lastSuccessfulLifecyclePhase: 'surface-acquire-failed',
        });
        throw error;
      }
      const state = globalThis.__forgeaxDarkGradientBrowser;
      state.lastTexture = texture;
      let textureIdentity = state.textureIdentities.get(texture);
      if (textureIdentity === undefined) {
        textureIdentity = `texture-${state.nextIdentity++}`;
        state.textureIdentities.set(texture, textureIdentity);
      }
      state.lastTextureIdentity = textureIdentity;
      state.acquiredFrame = state.rafFrame;
      emitRuntimeEvent({
        surfaceIdentity: 'webgpu-surface',
        lastSuccessfulLifecyclePhase: 'surface-acquired',
        frameId: state.acquiredFrame,
      });
      return texture;
    };
    const originalConfigure = context.configure.bind(context);
    context.configure = (descriptor) => {
      const state = globalThis.__forgeaxDarkGradientBrowser;
      const usageBefore = descriptor.usage ?? 0;
      const usageAfter = rawReadback ? usageBefore | 1 : usageBefore;
      state.configureUsageBefore = usageBefore;
      state.configureUsageAfter = usageAfter;
      state.surfaceIdentity = 'webgpu-surface';
      emitRuntimeEvent({
        surfaceIdentity: state.surfaceIdentity,
        pixelSourceMethod: state.pixelSourceMethod,
        configureUsageBefore: usageBefore,
        configureUsageAfter: usageAfter,
        rawCopyInjected: false,
        lastSuccessfulLifecyclePhase: 'surface-configure-attempt',
      });
      try {
        const result = originalConfigure({ ...descriptor, usage: usageAfter });
        emitRuntimeEvent({
          surfaceIdentity: state.surfaceIdentity,
          configureUsageBefore: usageBefore,
          configureUsageAfter: usageAfter,
          lastSuccessfulLifecyclePhase: 'surface-configured',
        });
        return result;
      } catch (error) {
        const rendererError = errorDetails(error);
        state.rendererErrors.push({ stage: 'surface.configure', ...rendererError });
        emitRuntimeEvent({
          surfaceIdentity: state.surfaceIdentity,
          rendererError,
          lastSuccessfulLifecyclePhase: 'surface-configure-failed',
        });
        throw error;
      }
    };
    return context;
  };
  const originalRequestAdapter = navigator.gpu?.requestAdapter?.bind(navigator.gpu);
  if (originalRequestAdapter === undefined) return;
  navigator.gpu.requestAdapter = async (...args) => {
    const adapter = await originalRequestAdapter(...args);
    if (adapter === null) return adapter;
    globalThis.__forgeaxDarkGradientBrowser.adapter = adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...deviceArgs) => {
      const device = await originalRequestDevice(...deviceArgs);
      const state = globalThis.__forgeaxDarkGradientBrowser;
      state.device = device;
      if (!rawReadback) return device;
      const originalSubmit = device.queue.submit.bind(device.queue);
      device.queue.submit = (commandBuffers) => {
        const observations = globalThis.__forgeaxDarkGradientObservations;
        const request = Array.from(state.captureRequests.values()).find((entry) => (
          !state.captures.has(entry.phase)
        ));
        const submitObservation = request === undefined ? undefined : observations?.[request.phase];
        const frame = state.rafFrame;
        state.submittedFrames.push({
          rafFrame: frame,
          engineFrameId: submitObservation?.frameId ?? null,
          observationId: submitObservation?.observationId ?? null,
          hasTexture: state.lastTexture !== undefined,
          acquiredFrame: state.acquiredFrame,
          textureIdentity: state.lastTextureIdentity ?? null,
        });
        if (state.submittedFrames.length > 32) state.submittedFrames.shift();
        if (
          request === undefined ||
          state.lastTexture === undefined ||
          state.acquiredFrame === undefined
        ) {
          if (request !== undefined) request.lastSkipReason = state.lastTexture === undefined
            ? 'surface-texture-not-acquired'
            : state.acquiredFrame === undefined ? 'acquired-texture-frame-missing' : 'observation-phase-mismatch';
          originalSubmit(commandBuffers);
          return;
        }
        const buffer = device.createBuffer({ size: 3328 * 600, usage: 1 | 8 });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: state.lastTexture },
          { buffer, bytesPerRow: 3328, rowsPerImage: 600 },
          { width: 800, height: 600, depthOrArrayLayers: 1 },
        );
        const bufferIdentity = `buffer-${state.nextIdentity++}`;
        state.rawCopyInjected = true;
        emitRuntimeEvent({
          surfaceIdentity: state.surfaceIdentity ?? 'webgpu-surface',
          rawCopyInjected: true,
          lastSuccessfulLifecyclePhase: 'same-submit-copy-injected',
          frameId: frame,
          deviceGeneration: null,
        });
        state.captures.set(request.phase, buffer);
        state.captureFrames.set(request.phase, frame);
        state.captureMetadata.set(request.phase, {
          phase: request.phase,
          engineFrameId: request.engineFrameId,
          armedEngineFrame: request.engineFrameId,
          observationId: request.observationId,
          armedRafFrame: request.armedRafFrame,
          acquiredEngineFrameId: request.engineFrameId,
          acquiredRafFrame: state.acquiredFrame,
          actualSubmitFrame: frame,
          submitRafFrame: frame,
          submitEngineFrameId: submitObservation?.frameId ?? null,
          submitObservationId: submitObservation?.observationId ?? null,
          textureIdentity: state.lastTextureIdentity,
          bufferIdentity,
          skipReason: null,
          pixelSourceMethod: state.pixelSourceMethod,
          rawCopyInjected: true,
        });
        console.debug(`__forgeaxDarkGradientState:${JSON.stringify({
          phase: request.phase,
          engineFrameId: request.engineFrameId,
          observationId: request.observationId,
          rafFrame: frame,
          screenshot: 'submitted',
        })}`);
        originalSubmit([...commandBuffers, encoder.finish()]);
      };
      return device;
    };
    return adapter;
  };
  }, { rawReadback: usesRawReadback, pixelMethod: pixelSource.method }));
} catch (error) {
  reportSetupFailure(error, 'setup-failed');
  cleanup.browserClose = 'started';
  await runStage('browser-close', () => browser.close(), 10_000)
    .then(() => { cleanup.browserClose = 'complete'; })
    .catch(() => { cleanup.browserClose = 'timeout-or-failed'; });
  await shutdownVite().catch(() => { cleanup.viteShutdown = 'timeout-or-failed'; });
  process.exit(2);
}

async function readCapturedFrame(phase) {
  return page.evaluate(async (targetFrame) => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    if (state?.device === undefined || state.context === undefined) throw new Error('browser WebGPU device/context not captured');
    const buffer = state.captures.get(targetFrame);
    if (buffer === undefined) {
      throw new Error(`browser WebGPU frame ${targetFrame} capture was not submitted; `
        + `rafFrame=${state.rafFrame} lastRenderedFrame=${state.lastRenderedFrame} `
        + `submittedFrames=${JSON.stringify(state.submittedFrames)} `
        + `captureKeys=${JSON.stringify(Array.from(state.captures.keys()))}`);
    }
    const width = 800;
    const height = 600;
    const bytesPerRow = 3328;
    await state.device.queue.onSubmittedWorkDone();
    await buffer.mapAsync(1);
    const mapped = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    buffer.destroy();
    state.captures.delete(targetFrame);
    const capturedFrame = state.captureFrames.get(targetFrame);
    state.captureFrames.delete(targetFrame);
    state.captureRequests.delete(targetFrame);
    const tight = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      tight.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    return { bytes: Array.from(tight), capturedFrame };
  }, phase);
}

async function readFrame(frame) {
  if (usesFinalDisplayReadback) {
    await runStage('webkit-pause', () => page.evaluate(() => {
      const state = globalThis.__forgeaxDarkGradientBrowser;
      if (state === undefined) throw new Error('WebKit browser state was not initialized');
      state.webkitPaused = true;
    }));
    try {
      const box = await runStage('webkit-canvas-bounds', () => page.locator('#app').boundingBox());
      if (box === null) throw new Error('WebKit dark-gradient canvas bounds were not available');
      if (box.width !== 800 || box.height !== 600) {
        throw new Error(`WebKit dark-gradient canvas bounds are ${box.width}x${box.height}; expected 800x600`);
      }
      const png = await runStage('webkit-screenshot', () => page.screenshot({
        clip: box,
        animations: 'disabled',
        omitBackground: false,
      }));
      const decoded = UPNG.decode(png);
      const rgba = UPNG.toRGBA8(decoded)[0];
      if (decoded.width !== 800 || decoded.height !== 600) {
        throw new Error(`WebKit final-display readback is ${decoded.width}x${decoded.height}; expected 800x600`);
      }
      return Array.from(new Uint8Array(rgba));
    } finally {
      if (!pagePoisoned) {
        await runStage('webkit-resume', () => page.evaluate(() => {
          const state = globalThis.__forgeaxDarkGradientBrowser;
          if (state !== undefined) {
            state.webkitPaused = false;
            const pending = state.pausedAnimationFrames.splice(0);
            pending.shift()?.();
          }
        })).catch(() => undefined);
      }
    }
  }
  const result = await readCapturedFrame(frame);
  return result.bytes;
}

async function pauseAnimationFrames() {
  await runStage('phase-pause', () => page.evaluate(() => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    if (state === undefined) throw new Error('Browser state was not initialized');
    state.webkitPaused = true;
  }));
}

async function resumeOneAnimationFrame() {
  await runStage('phase-resume', () => page.evaluate(() => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    if (state === undefined) throw new Error('Browser state was not initialized');
    const pending = state.pausedAnimationFrames.splice(0);
    if (pending.length === 0) throw new Error('No queued animation frame was available for phase transition');
    state.webkitPaused = false;
    pending[0]();
  }));
}

async function resumeAnimationFrames() {
  await runStage('phase-resume', () => page.evaluate(() => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    if (state === undefined) return;
    state.webkitPaused = false;
    state.pausedAnimationFrames.splice(0).shift()?.();
  }));
}

async function waitForQueuedAnimationFrame() {
  await runStage('phase-pending-frame', () => page.waitForFunction(() => (
    globalThis.__forgeaxDarkGradientBrowser?.pausedAnimationFrames?.length > 0
  ), null, { timeout: 30_000 }));
}

async function captureVisualScreenshot(phase) {
  if (screenshotDir === undefined) return undefined;
  await mkdir(screenshotDir, { recursive: true });
  const path = `${screenshotDir}/dark-gradient-${lane}-${phase}.png`;
  await runStage(`screenshot-${phase}`, () => page.screenshot({
    path,
    clip: { x: 0, y: 0, width: 800, height: 600 },
    animations: 'disabled',
    omitBackground: false,
  }), 15_000);
  return path;
}

async function collectBrowserDiagnostics(phase, error) {
  if (pagePoisoned || page === undefined) {
    return {
      state: pagePoisoned ? 'page-abandoned-after-timeout' : 'page-unavailable',
      engine,
      lane,
      phase,
      lastStage,
      timeoutStage: timeoutStage ?? null,
      elapsedMs: Date.now() - startedAt,
      pageUrl: lastPageUrl,
      process: { viteExited, viteExitCode: viteExitCode ?? null, browserPresent: browser !== undefined },
      stageLedger,
      cleanup,
      pageConsole: pageDiagnostics.console,
      pageErrors: pageDiagnostics.pageErrors,
      requestFailed: pageDiagnostics.requestFailed,
      ...snapshotRuntimeCache(runtimeCache),
      error: errorDetail(error),
    };
  }
  let runtime = {};
  try {
    runtime = await runStage('diagnostics-evaluate', () => page.evaluate((targetPhase) => {
      const state = globalThis.__forgeaxDarkGradientBrowser;
      const observations = globalThis.__forgeaxDarkGradientObservations;
      const noneObservation = observations?.none ?? null;
      const fxaaObservation = observations?.fxaa ?? null;
      const rafFrame = state?.rafFrame ?? 0;
      const lastRenderedFrame = state?.lastRenderedFrame ?? 0;
      const submittedFrames = state?.submittedFrames ?? [];
      const captureKeys = state === undefined ? [] : Array.from(state.captures.keys());
      const captureRequests = state === undefined ? [] : Array.from(state.captureRequests.entries());
      const captureMetadata = state === undefined ? [] : Array.from(state.captureMetadata.entries());
      const pixelSourceMethod = state?.pixelSourceMethod ?? null;
      const configureUsageBefore = state?.configureUsageBefore ?? null;
      const configureUsageAfter = state?.configureUsageAfter ?? null;
      const rawCopyInjected = state?.rawCopyInjected ?? false;
      const rendererErrors = state?.rendererErrors ?? [];
      let stateClass = 'observation-not-ready';
      if (typeof navigator.gpu === 'undefined') stateClass = 'navigator-gpu-unavailable';
      else if (state?.device === undefined) stateClass = 'device-not-captured';
      else if (lastRenderedFrame === 0) stateClass = 'render-loop-not-started';
      else if (noneObservation?.status === 'insufficient-evidence' || fxaaObservation?.status === 'insufficient-evidence') stateClass = 'observation-insufficient-evidence';
      else if (captureRequests.some(([, request]) => request.lastSkipReason !== null)) stateClass = 'capture-skip';
      else if (!captureKeys.includes(targetPhase)) stateClass = 'capture-not-submitted';
      else if (noneObservation === null) stateClass = 'none-observation-missing';
      return JSON.parse(JSON.stringify({
        state: stateClass,
        targetPhase,
        navigatorGpu: typeof navigator.gpu !== 'undefined',
        adapterCaptured: state?.adapter !== undefined,
        deviceCaptured: state?.device !== undefined,
        contextCaptured: state?.context !== undefined,
        rafFrame,
        lastRenderedFrame,
        acquiredFrame: state?.acquiredFrame ?? null,
        submittedFrames,
        captureKeys,
        captureRequests,
        captureMetadata,
        pixelSourceMethod,
        configureUsageBefore,
        configureUsageAfter,
        rawCopyInjected,
        rendererErrors,
        captureFrames: state === undefined ? [] : Array.from(state.captureFrames.entries()),
        observations,
        noneObservation,
        fxaaObservation,
        rAF: { rafFrame, lastRenderedFrame },
        observation: noneObservation,
      }));
    }, phase), 5_000);
  } catch (diagnosticError) {
    runtime = {
      state: 'diagnostic-evaluation-failed',
      diagnosticError: errorDetail(diagnosticError),
      rAF: null,
      observation: null,
    };
  }
  return {
    ...runtime,
    engine,
    lane,
    phase,
    lastStage,
    timeoutStage: timeoutStage ?? null,
    elapsedMs: Date.now() - startedAt,
    pageUrl: pagePoisoned ? lastPageUrl : page?.url() ?? null,
    process: { viteExited, viteExitCode: viteExitCode ?? null, browserPresent: browser !== undefined },
    stageLedger,
    cleanup,
    error: errorDetail(error),
    pageConsole: pageDiagnostics.console,
      pageErrors: pageDiagnostics.pageErrors,
      requestFailed: pageDiagnostics.requestFailed,
      ...snapshotRuntimeCache(runtimeCache),
    };
}

let currentPhase = 'none';
async function waitForObservation(phase) {
  // Slow WebGL2 software paths may need more than the default stage budget to
  // submit all 60 frames. Keep the budget bounded and retain the exact
  // ready/insufficient-evidence and frame-count gates below.
  const observationTimeoutMs = Number(process.env.FORGEAX_DARK_GRADIENT_OBSERVATION_TIMEOUT_MS ?? 90_000);
  const observation = await runStage(`observation-${phase}`, async () => {
    await page.waitForFunction((targetPhase) => {
      const candidate = globalThis.__forgeaxDarkGradientObservations?.[targetPhase];
      return candidate?.status === 'ready' || candidate?.status === 'insufficient-evidence';
    }, phase, { timeout: observationTimeoutMs });
    return page.evaluate((targetPhase) => globalThis.__forgeaxDarkGradientObservations?.[targetPhase] ?? null, phase);
  }, observationTimeoutMs + 5_000);
  if (observation?.status !== 'ready') {
    throw new Error(
      `browser observation ${phase} is insufficient-evidence: ${observation?.reason ?? '<missing reason>'}`
      + ` actualBackendKind=${observation?.actualBackendKind ?? '<missing>'}`,
    );
  }
  return observation;
}

try {
  await runStage('navigation', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
  lastPageUrl = url;
  await waitForObservation('none');
  if (usesRawReadback) {
    await runStage('capture-none', () => page.waitForFunction(() => globalThis.__forgeaxDarkGradientBrowser?.captures?.has('none') === true, null, { timeout: 30_000 }));
  }
  currentPhase = 'fxaa';
  let referenceBytes;
  let referenceScreenshot;
  if (usesRawReadback) {
    let keyHeld = false;
    let animationPaused = false;
    try {
      await pauseAnimationFrames();
      animationPaused = true;
      referenceBytes = await runStage('readback-none', () => readFrame('none'));
      referenceScreenshot = await captureVisualScreenshot('none');
      await waitForQueuedAnimationFrame();
      await runStage('toggle-fxaa', async () => {
        // InputSnapshot is sampled once at frame start. Keep rAF paused while
        // reading the reference, then hold Space through exactly one queued
        // frame so the transition belongs to the observed FXAA phase.
        await page.keyboard.down(' ');
        keyHeld = true;
        await resumeOneAnimationFrame();
        animationPaused = false;
        await page.keyboard.up(' ');
        keyHeld = false;
      });
    } finally {
      if (keyHeld) await page.keyboard.up(' ').catch(() => undefined);
      if (animationPaused) await resumeAnimationFrames().catch(() => undefined);
    }
  } else {
    referenceBytes = await runStage('readback-none', () => readFrame('none'));
    referenceScreenshot = await captureVisualScreenshot('none');
    await runStage('toggle-fxaa', async () => {
      // InputSnapshot is sampled once at frame start. Hold the real Space
      // path across at least one frame instead of bypassing user input.
      await page.keyboard.down(' ');
      await delay(150);
      await page.keyboard.up(' ');
    });
  }
  await waitForObservation('fxaa');
  if (usesRawReadback) {
    await runStage('capture-fxaa', () => page.waitForFunction(() => globalThis.__forgeaxDarkGradientBrowser?.captures?.has('fxaa') === true, null, { timeout: 30_000 }));
  }
  const bytes = await runStage('readback-fxaa', () => readFrame('fxaa'));
  const finalScreenshot = await captureVisualScreenshot('fxaa');
  const observations = await runStage('observation-read', () => page.evaluate(() => globalThis.__forgeaxDarkGradientObservations));
  if (observations?.none?.backendId !== browserBackendId || observations?.fxaa?.backendId !== browserBackendId) {
    throw new Error(
      `browser channel mismatch: expected ${browserBackendId}, `
      + `observed none=${observations?.none?.backendId ?? '<missing>'} `
      + `fxaa=${observations?.fxaa?.backendId ?? '<missing>'}`,
    );
  }
  const expectedActualBackendKind = engine === 'chromium-webgl2' || engine === 'webkit' ? 'wgpu-webgl2' : 'webgpu';
  if (
    observations?.none?.actualBackendKind !== expectedActualBackendKind ||
    observations?.fxaa?.actualBackendKind !== expectedActualBackendKind
  ) {
    throw new Error(
      `actual RHI backend mismatch: expected ${expectedActualBackendKind}, `
      + `observed none=${observations?.none?.actualBackendKind ?? '<missing>'} `
      + `fxaa=${observations?.fxaa?.actualBackendKind ?? '<missing>'}`,
    );
  }
  const captureEvidence = usesRawReadback ? await runStage('capture-evidence-read', () => page.evaluate(() => {
    const state = globalThis.__forgeaxDarkGradientBrowser;
    const observations = globalThis.__forgeaxDarkGradientObservations ?? {};
    return Array.from(state.captureMetadata.entries()).map(([phase, evidence]) => {
      const observation = observations[phase];
      return {
        ...evidence,
        observationId: evidence.observationId ?? observation?.observationId ?? null,
        submitEngineFrameId: evidence.submitEngineFrameId ?? observation?.frameId ?? evidence.engineFrameId,
        submitObservationId: evidence.submitObservationId ?? observation?.observationId ?? null,
        captureBufferIdentity: evidence.bufferIdentity,
      };
    });
  })) : [];
  const surface = observations.fxaa.surface;
  const report = createDarkGradientFixtureReport({
    backendId: observations.fxaa.backendId,
    lane,
    bytes: new Uint8Array(bytes),
    referenceBytes: new Uint8Array(referenceBytes),
    surface,
    presentationProof: observations.fxaa.presentationProof,
    identity: observations.fxaa,
    referenceIdentity: observations.none,
    captureEvidence,
  });
  if (referenceScreenshot !== undefined || finalScreenshot !== undefined) {
    console.log(`[dark-gradient-browser] screenshots=${JSON.stringify({
      none: referenceScreenshot ?? null,
      fxaa: finalScreenshot ?? null,
    })}`);
  }
  console.log(`[dark-gradient-browser] report=${JSON.stringify(report)}`);
  if (report.status !== 'complete') process.exitCode = 2;
} catch (error) {
  const diagnostics = await collectBrowserDiagnostics(currentPhase, error);
  const report = createInsufficientEvidenceReport({
    backendId: browserBackendId,
    lane,
    reason: `${diagnostics.state}: ${error instanceof Error ? error.message : String(error)}`,
    diagnostics,
  });
  console.error(`[dark-gradient-browser] report=${JSON.stringify(report)}`);
  console.error(`[dark-gradient-browser] FAIL - insufficient evidence state=${diagnostics.state}`);
  process.exitCode = 2;
} finally {
  const browserContext = page === undefined ? undefined : page.context();
  cleanup.pageClose = 'started';
  const pageCloseError = await runStage('page-close', async () => {
    if (page === undefined || page.isClosed()) return;
    await page.close({ runBeforeUnload: false });
  }, 10_000)
    .then(() => undefined)
    .catch((error) => error);
  // Never evaluate a page after its close attempt. This keeps cleanup
  // diagnostics from issuing a second Playwright call against a torn-down
  // browser context when page.close() or browser.close() fails.
  pagePoisoned = true;
  cleanup.pageClose = pageCloseError === undefined ? 'complete' : 'timeout-or-failed';
  cleanup.contextClose = 'started';
  const contextCloseError = await runStage('context-close', async () => {
    if (browserContext === undefined) return;
    await browserContext.close();
  }, 10_000)
    .then(() => undefined)
    .catch((error) => error);
  cleanup.contextClose = contextCloseError === undefined ? 'complete' : 'timeout-or-failed';
  cleanup.browserClose = 'started';
  const browserCloseError = await runStage('browser-close', () => browser.close(), browserCloseTimeoutMs)
    .then(() => undefined)
    .catch((error) => error);
  cleanup.browserClose = browserCloseError === undefined ? 'complete' : 'timeout-or-failed';
  const viteShutdownError = await shutdownVite().then(() => undefined).catch((error) => error);
  if (pageCloseError !== undefined || contextCloseError !== undefined || browserCloseError !== undefined || viteShutdownError !== undefined) {
    const cleanupError = pageCloseError ?? contextCloseError ?? browserCloseError ?? viteShutdownError;
    const diagnostics = await collectBrowserDiagnostics(currentPhase, cleanupError);
    const report = createInsufficientEvidenceReport({
      backendId: browserBackendId,
      lane,
      reason: `cleanup-failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      diagnostics,
    });
    console.error(`[dark-gradient-browser] report=${JSON.stringify(report)}`);
    process.exitCode = 2;
  }
  process.exit(process.exitCode ?? 0);
}
