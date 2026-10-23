#!/usr/bin/env node
import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };
import { reduceTestProject } from '../../../scripts/test/reduce-test-project.mjs';
// The CI smoke owns the shortest real browser path for every engine template:
// Preview host -> template bootstrap -> WebGPU frame loop. Runtime browser
// errors are the oracle. game-default keeps its deeper gameplay projection
// assertions; game-3d keeps a real pointer-lock / camera / movement / physics
// journey; every other template must at least load, start, size its canvas, and
// leave the renderer alive.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { probeLocalization } from '../../../templates/game-3d/scripts/localization-probe.mjs';
import { probeRuntimeVase } from '../../../templates/game-3d/scripts/runtime-vase-probe.mjs';
import { serializeBrowserConsoleValue } from './serialize-browser-console-value.mjs';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { decodeCatalogWire } from '@forgeax/engine/pack';
import { GameProjectSchema } from '@forgeax/engine/project';
import { createOwnedProcessGroupStopper } from '../../shared/scripts/rhi-debug-process.mjs';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { withLocalGpuLease } from '../../../scripts/ci/local-gpu-lease.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PROJECTS = [
  { root: resolve(ROOT, 'templates/empty'), slug: 'empty', descriptor: 'template.json' },
  { root: resolve(ROOT, 'templates/game-3d'), slug: 'game-3d', descriptor: 'template.json' },
  {
    root: resolve(ROOT, 'apps/game-capability-lab'),
    slug: 'game-capability-lab',
    descriptor: 'forge.json',
  },
  { root: resolve(ROOT, 'apps/showcase/brotato-3d'), slug: 'brotato-3d', descriptor: 'forge.json' },
];
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_TEMPLATE_SMOKE_DIR ?? resolve(ROOT, '.forgeax-debug/templates'),
);
const PORT = Number.parseInt(process.env.FORGEAX_TEMPLATE_SMOKE_PORT ?? '5201', 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CATALOG_URL = createStandaloneRuntimeAssetBinding('preview').catalogUrl;
const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 90_000;
const MAX_SERVER_STARTUP_TIMEOUT_MS = 180_000;
const configuredServerStartupTimeoutMs = Number.parseInt(
  process.env.FORGEAX_TEMPLATE_SMOKE_SERVER_STARTUP_TIMEOUT_MS ?? '',
  10,
);
const SERVER_STARTUP_TIMEOUT_MS = Number.isFinite(configuredServerStartupTimeoutMs)
  && configuredServerStartupTimeoutMs > 0
  ? Math.min(configuredServerStartupTimeoutMs, MAX_SERVER_STARTUP_TIMEOUT_MS)
  : DEFAULT_SERVER_STARTUP_TIMEOUT_MS;
const CHROME_CHANNEL = process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel;
const CI_LIGHTWEIGHT = process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const positiveEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const TEMPLATE_VIEWPORT = CI_LIGHTWEIGHT
  ? {
      width: positiveEnv('FORGEAX_BROWSER_CI_VIEWPORT_WIDTH', testQuality.viewport.width),
      height: positiveEnv('FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT', testQuality.viewport.height),
    }
  : { width: 960, height: 540 };
const TEMPLATE_SETTLE_FRAMES = CI_LIGHTWEIGHT
  ? positiveEnv('FORGEAX_BROWSER_CI_SETTLE_FRAMES', 2)
  : 10;
// The headed lavapipe path can advance a healthy fixed-step simulation at
// roughly 6 ticks/s when the heavy runner is contended.  Keep this finite, but
// give the 48-tick witness more than 2x the observed wall-clock budget.
const GAME3D_FIXED_TICK_PROGRESS_TIMEOUT_MS = 60_000;
const GAME3D_FIXED_TICK_STALL_TIMEOUT_MS = 20_000;
const GAME3D_MIN_LUMA_RANGE = 8;
const GAME3D_NON_BLACK_FLOOR = 8;
const CHROME_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-pointer-lock',
  '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-gpu-driver-bug-workarounds',
  '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
  '--autoplay-policy=no-user-gesture-required',
];
const SELECTED_TEMPLATE_SLUGS = (process.env.FORGEAX_TEMPLATE_SMOKE_SLUGS ?? '')
  .split(',')
  .map((slug) => slug.trim())
  .filter((slug) => slug.length > 0);
const GAME3D_COLLISION_MODE =
  process.env.FORGEAX_TEMPLATE_SMOKE_GAME3D_COLLISION_MODE ?? 'required';
if (GAME3D_COLLISION_MODE !== 'required' && GAME3D_COLLISION_MODE !== 'omit-sdk-source') {
  throw new Error(`unsupported game-3d collision mode: ${GAME3D_COLLISION_MODE}`);
}
const SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_MESSAGE = 'A valid external Instance reference no longer exists.';
const SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_CONSOLE = `[preview] app error: ${JSON.stringify({
  code: 'device-operation-failed',
  expected: 'the active device generation completes the renderer-owned operation',
  hint: 'inspect renderer state and the structured cause, then retry or recover',
  detail: {
    operation: 'renderer-event',
    cause: {
      code: 'device-lost',
      expected: 'device must remain alive (driver / browser must not destroy the GPUDevice)',
      hint: `device-lost reason: unknown; message: ${SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_MESSAGE}`,
    },
  },
  name: 'RendererOperationError',
})} @ ${ORIGIN}/src/main.ts`;

function discoverTemplates() {
  let entries = PROJECTS.map(({ root, slug, descriptor }) => {
    if (!existsSync(root)) throw new Error(`${slug}: missing project root`);
    if (!existsSync(join(root, descriptor))) throw new Error(`${slug}: missing project descriptor`);
    if (!existsSync(join(root, 'forge.json'))) throw new Error(`${slug}: missing forge.json`);
    return { root, slug };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
  if (entries.length === 0) throw new Error('no engine projects found under templates or apps');
  if (SELECTED_TEMPLATE_SLUGS.length > 0) {
    const selected = new Set(SELECTED_TEMPLATE_SLUGS);
    const available = new Set(entries.map((entry) => entry.slug));
    const missing = [...selected].filter((slug) => !available.has(slug));
    if (missing.length > 0) throw new Error(`unknown engine templates: ${missing.join(', ')}`);
    entries = entries.filter((entry) => selected.has(entry.slug));
  }

  return entries.map((entry) => {
    const { root } = entry;
    const manifestPath = join(root, 'forge.json');
    if (!existsSync(manifestPath)) throw new Error(`${entry.slug}: missing forge.json`);
    let manifest;
    try {
      manifest = GameProjectSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch (error) {
      throw new Error(`${entry.slug}: invalid forge.json: ${String(error)}`);
    }
    return {
      slug: entry.slug,
      id: manifest.id,
      name: manifest.name,
      manifest,
    };
  });
}

const templates = discoverTemplates();
mkdirSync(ARTIFACT_DIR, { recursive: true });

let server;
let serverOutput = '';
let serverSpawnError;
let serverExit;
let stopServer = async () => {};
let templateSmokeRoot;
async function prepareTemplateSmokeProject(slug) {
  const sourceRoot = PROJECTS.find((project) => project.slug === slug)?.root;
  if (sourceRoot === undefined) throw new Error(`unknown smoke project: ${slug}`);
  const root = await mkdtemp(resolve(ARTIFACT_DIR, `${slug}-ci-`));
  try {
    await cp(sourceRoot, root, {
      recursive: true,
      filter: (path) => !['node_modules', '.forgeax', 'dist', '.git'].includes(path.split(sep).at(-1)),
    });
    await symlink(resolve(sourceRoot, 'node_modules'), resolve(root, 'node_modules'), 'dir');
    await reduceTestProject(root);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
const appendServerOutput = (stream, chunk) => {
  serverOutput += `[${stream}] ${chunk.toString()}`;
};

function startServer(templateSlug) {
  serverOutput = '';
  serverSpawnError = undefined;
  serverExit = undefined;
  server = spawn(
    process.execPath,
    [
      resolve(createRequire(import.meta.url).resolve('vite/package.json'), '..', 'bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
    ],
    {
      cwd: resolve(ROOT, 'apps/preview'),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Finish native asset production at the Catalog barrier, outside the
      // browser deadline, even when the caller selects on-demand preparation.
      env: { ...process.env, NODE_ENV: 'development', FORGEAX_TEMPLATE_SMOKE: '1', FORGEAX_TEMPLATE_SMOKE_SLUGS: templateSlug,
        FORGEAX_DEV_PACK_READINESS: 'before-consume',
        ...(templateSmokeRoot === undefined ? {} : { FORGEAX_TEMPLATE_SMOKE_ROOT: templateSmokeRoot }) },
    },
  );
  server.stdout.on('data', (chunk) => { appendServerOutput('stdout', chunk); });
  server.stderr.on('data', (chunk) => { appendServerOutput('stderr', chunk); });
  server.on('error', (error) => { serverSpawnError = error; });
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });

  stopServer = server.pid === undefined
    ? async () => {}
    : createOwnedProcessGroupStopper(server);
}

let browser;
let browserServer;
let context;
let page;
let activeEvidence;
let pointerLockMode = 'native';
let nativePointerLockProbe;
const templateEvidence = [];
let cancelled;
let cancellation;
function cancelSmoke(signal) {
  if (cancellation !== undefined) return cancellation;
  cancelled = signal;
  cancellation = (async () => {
    const cleanup = await Promise.allSettled([closeSmokeBrowser(), stopServer()]);
    if (templateSmokeRoot !== undefined && cleanup[1].status === 'fulfilled') {
      try {
        await rm(templateSmokeRoot, { recursive: true, force: true });
      } catch (error) {
        cleanup.push({ status: 'rejected', reason: error });
      }
    }
    writeReport('failed', {
      error: `template smoke cancelled by ${signal}`,
      cleanupErrors: cleanup.filter((result) => result.status === 'rejected').map((result) => String(result.reason)),
    });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  })();
  return cancellation;
}
const onInterrupt = () => { void cancelSmoke('SIGINT'); };
const onTerminate = () => { void cancelSmoke('SIGTERM'); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

function browserEvidence() {
  return { templates: templateEvidence, serverOutput };
}

function writeReport(status, extra = {}) {
  writeFileSync(
    resolve(ARTIFACT_DIR, 'report.json'),
    `${JSON.stringify({ status, ...extra, ...browserEvidence() }, null, 2)}\n`,
  );
}

function unexpectedConsoleErrors(evidence) {
  return evidence.consoleErrors.filter((message) => !evidence.expectedConsoleErrors.includes(message));
}

async function closeSmokeBrowser() {
  const closingEvidence = activeEvidence;
  activeEvidence = undefined;
  const cleanupErrors = [];
  const currentPage = page;
  const currentContext = context;
  const currentBrowserServer = browserServer;
  // Keep teardown errors separate from the completed gameplay oracle. These
  // bounded observations do not acknowledge App/Worker disposal or settle work.
  const shutdownEvidence = { phase: 'inspection-unobserved', events: [], droppedEvents: 0, attempts: [] };
  if (closingEvidence !== undefined) closingEvidence.shutdown = shutdownEvidence;
  const closingText = (value) => {
    try { return String(value).slice(0, 2048); }
    catch { return 'UNOBSERVED: error text unavailable'; }
  };
  const recordClosingEvent = (kind, message) => {
    if (shutdownEvidence.events.length >= 32) { shutdownEvidence.droppedEvents += 1; return; }
    shutdownEvidence.events.push({ kind, message: closingText(message) });
  };
  const onClosingPageError = (error) => {
    try { recordClosingEvent('pageerror', error?.message ?? error); }
    catch { shutdownEvidence.droppedEvents += 1; }
  };
  const onClosingConsole = (message) => {
    try { if (message.type() === 'error') recordClosingEvent('console-error', message.text()); }
    catch { shutdownEvidence.droppedEvents += 1; }
  };
  const readPreviewProgress = async () => {
    if (currentPage === undefined || currentPage.isClosed()) return null;
    return currentPage.evaluate(() => {
      const inspection = globalThis.__forgeaxPreviewInspection;
      const progress = document.querySelector('canvas#app')?.forgeaxFrameProgress;
      return {
        frame: progress === undefined
          ? null
          : {
              submitted: progress.submitted?.frameId ?? null,
              completed: progress.completed?.frameId ?? null,
            },
        renderer: inspection?.renderer.health() ?? null,
      };
    });
  };
  try {
    currentPage?.on?.('pageerror', onClosingPageError);
    currentPage?.on?.('console', onClosingConsole);
  } catch { recordClosingEvent('observer-error', 'UNOBSERVED: closing listeners unavailable'); }
  page = undefined;
  context = undefined;
  browser = undefined;
  browserServer = undefined;
  const attemptClose = async (label, close) => {
    const attempt = { label, status: 'pending' };
    shutdownEvidence.attempts.push(attempt);
    let timer;
    try {
      const closed = await Promise.race([
        Promise.resolve().then(close).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10_000); }),
      ]);
      if (!closed) throw new Error(`${label} cleanup incomplete after 10s`);
      attempt.status = 'completed';
      return true;
    } catch (cause) {
      attempt.status = 'failed';
      attempt.cause = closingText(cause);
      cleanupErrors.push(new Error(`${label} cleanup failed`, { cause }));
      return false;
    } finally {
      if (label === 'Preview') attempt.phase = shutdownEvidence.phase;
      clearTimeout(timer);
    }
  };
  // Keep page, context, and browser teardown independent. A Playwright page
  // rejection must not leave its WebGPU context alive for the next template.
  // Page destruction cannot await asynchronous pagehide work. Use the Host's
  // existing disposal protocol while its Worker/GPU lifetime is still live.
  await attemptClose('Preview', async () => {
    if (currentPage === undefined || currentPage.isClosed()) {
      shutdownEvidence.phase = 'page-unavailable';
      return;
    }
    try {
      shutdownEvidence.frameAtCloseStart = await readPreviewProgress();
    } catch (cause) {
      shutdownEvidence.frameProgressError = closingText(cause);
    }
    shutdownEvidence.phase = 'inspection-query';
    const running = await currentPage.evaluate(() => globalThis.__forgeaxPreviewInspection !== undefined);
    if (!running) { shutdownEvidence.phase = 'inspection-absent'; return; }
    shutdownEvidence.phase = 'dispose-message-posting';
    await currentPage.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
    shutdownEvidence.phase = 'dispose-message-posted';
    await currentPage.waitForFunction(
      () => globalThis.__forgeaxPreviewInspection === undefined && document.querySelector('[data-forgeax-ui-root]') === null,
      null,
      { timeout: 10_000 },
    );
    shutdownEvidence.phase = 'inspection-and-ui-retired';
  });
  await attemptClose('page', () => currentPage?.close());
  await attemptClose('context', () => currentContext?.close());
  // The public server handle owns the process, including when the protocol
  // client can no longer close it. Recovery retires that process but keeps
  // the original 10-second close failure as a failed smoke.
  const browserClosed = await attemptClose('browser', () => currentBrowserServer?.close());
  if (!browserClosed)
    await attemptClose('browser process', () => currentBrowserServer?.kill());
  try {
    currentPage?.off?.('pageerror', onClosingPageError);
    currentPage?.off?.('console', onClosingConsole);
  } catch { recordClosingEvent('observer-error', 'UNOBSERVED: closing listener removal failed'); }
  await sleep(250);
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'template smoke browser cleanup failed');
  }
}

async function waitForSubmittedRendererFrame(label) {
  await page.waitForFunction(
    () => {
      const health = globalThis.__forgeaxPreviewInspection?.renderer.health();
      return health?.reason === 'alive' && (health.frame?.frameId ?? -1) > 0;
    },
    undefined,
    { timeout: 120_000, polling: 100 },
  );
  const rendererHealth = await page.evaluate(
    () => globalThis.__forgeaxPreviewInspection?.renderer.health(),
  );
  if (rendererHealth?.reason !== 'alive' || (rendererHealth.frame?.frameId ?? -1) <= 0) {
    throw new Error(`${label}: ${JSON.stringify(rendererHealth)}`);
  }
  return rendererHealth;
}

async function probeFreshGame3dRendererViability(evidence) {
  evidence.phase = 'fresh-process-viability';
  await restartSmokeBrowser(evidence);
  await page.goto(`${ORIGIN}/?game=game-3d&journey=fresh-process-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForTemplateReady();
  const rendererHealth = await waitForSubmittedRendererFrame(
    'fresh game-3d renderer did not submit a frame',
  );
  const canvas = await page.evaluate(() => ({
    width: document.querySelector('canvas#app')?.width ?? 0,
    height: document.querySelector('canvas#app')?.height ?? 0,
  }));
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new Error(`fresh game-3d canvas has no drawable size: ${JSON.stringify(canvas)}`);
  }
  await page.waitForTimeout(250);
  const stableHealth = await page.evaluate(
    () => globalThis.__forgeaxPreviewInspection?.renderer.health(),
  );
  if (
    stableHealth?.reason !== 'alive'
    || (stableHealth.frame?.frameId ?? -1) < rendererHealth.frame.frameId
  ) {
    throw new Error(`fresh game-3d renderer did not remain viable: ${JSON.stringify(stableHealth)}`);
  }
  evidence.phase = 'journey-complete';
  return stableHealth;
}

async function classifySdkSourceHostGpuInstanceLoss(evidence) {
  if (GAME3D_COLLISION_MODE !== 'omit-sdk-source') return;
  let matchingEvents = evidence.consoleErrorEvents.filter(
    ({ message }) => message === SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_CONSOLE,
  );
  const rendererHealth = evidence.game3d?.rendererHealth;
  const fixedTick = evidence.game3d?.unlocked?.simulation?.fixedTick;
  const lastHealthyFrameId = evidence.probe?.state?.frame?.frameId;
  const auditBase = {
    phase: 'journey-complete',
    lastHealthyFrameId: lastHealthyFrameId ?? null,
    fixedTick: fixedTick ?? null,
  };
  if (
    evidence.phase !== 'journey-complete'
    || evidence.probe?.state?.reason !== 'alive'
    || typeof auditBase.lastHealthyFrameId !== 'number'
    || auditBase.lastHealthyFrameId <= 0
    || typeof fixedTick !== 'number'
    || fixedTick <= 0
    || typeof evidence.journeyCompleteSequence !== 'number'
  ) {
    throw new Error(
      `sdk-source-host-gpu-instance-loss-prerequisite:${JSON.stringify({ rendererHealth, fixedTick, probe: evidence.probe, journeyCompleteSequence: evidence.journeyCompleteSequence })}`,
    );
  }
  if (matchingEvents.length === 0) {
    if (rendererHealth?.reason !== 'alive') {
      throw new Error(
        `sdk-source-host-gpu-instance-loss-contract:${JSON.stringify({ matchingEvents, rendererHealth, fixedTick })}`,
      );
    }
    evidence.game3d.hostGpuInstanceLoss = { status: 'not-observed', ...auditBase };
    await closeSmokeBrowser();
    return;
  }
  if (
    matchingEvents.length !== 1 ||
    matchingEvents[0]?.phase !== 'interaction'
    || typeof matchingEvents[0].sequence !== 'number'
    || matchingEvents[0].sequence >= evidence.journeyCompleteSequence
    || rendererHealth?.reason !== 'device-lost'
  ) {
    throw new Error(
      `sdk-source-host-gpu-instance-loss-contract:${JSON.stringify({ matchingEvents, rendererHealth, fixedTick, journeyCompleteSequence: evidence.journeyCompleteSequence })}`,
    );
  }

  const freshProcessRendererHealth = await probeFreshGame3dRendererViability(evidence);
  evidence.game3d.freshProcessRendererHealth = freshProcessRendererHealth;
  matchingEvents = evidence.consoleErrorEvents.filter(
    ({ message }) => message === SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_CONSOLE,
  );
  if (matchingEvents.length !== 1) {
    throw new Error(
      `sdk-source-host-gpu-instance-loss-fresh-process-contract:${JSON.stringify({ matchingEvents, freshProcessRendererHealth })}`,
    );
  }
  evidence.expectedConsoleErrors.push(matchingEvents[0].message);
  evidence.game3d.hostGpuInstanceLoss = {
    status: 'omitted',
    reason: 'sdk-source-host-gpu-instance-loss',
    ...auditBase,
    eventPhase: matchingEvents[0].phase,
    eventSequence: matchingEvents[0].sequence,
    journeyCompleteSequence: evidence.journeyCompleteSequence,
    freshProcessFrameId: freshProcessRendererHealth.frame.frameId,
    message: SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_MESSAGE,
  };
  await closeSmokeBrowser();
}

async function launchSmokeBrowser() {
  const startedAt = performance.now();
  browserServer = await chromium.launchServer({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: CHROME_CHANNEL,
    args: CHROME_ARGS,
    timeout: 30_000,
    chromiumSandbox: true,
  });
  try {
    return await chromium.connect(browserServer.wsEndpoint(), {
      timeout: Math.max(1, 30_000 - (performance.now() - startedAt)),
    });
  } catch (cause) {
    try {
      await closeSmokeBrowser();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'template smoke browser startup and cleanup failed');
    }
    throw cause;
  }
}

async function createSmokePage(targetBrowser, { probePointerLock = false } = {}) {
  context = await targetBrowser.newContext({
    viewport: TEMPLATE_VIEWPORT,
    deviceScaleFactor: 1,
  });
  const nextPage = await context.newPage();
  if (probePointerLock) {
    nativePointerLockProbe = await probeNativePointerLock(nextPage);
    pointerLockMode = nativePointerLockProbe.status === 'locked' ? 'native' : 'simulated';
  }
  if (pointerLockMode === 'simulated') {
    await nextPage.addInitScript(() => {
      let lockedElement = null;
      const probe = { requests: 0, releases: 0 };
      const pointerLockOwner = Document.prototype;
      Object.defineProperty(pointerLockOwner, 'pointerLockElement', {
        configurable: true,
        get: () => lockedElement,
      });
      Object.defineProperty(pointerLockOwner, 'exitPointerLock', {
        configurable: true,
        value: () => {
          if (lockedElement === null) return;
          lockedElement = null;
          probe.releases += 1;
          document.dispatchEvent(new Event('pointerlockchange'));
        },
      });
      Object.defineProperty(HTMLCanvasElement.prototype, 'requestPointerLock', {
        configurable: true,
        value: function () {
          lockedElement = this;
          probe.requests += 1;
          document.dispatchEvent(new Event('pointerlockchange'));
          return Promise.resolve();
        },
      });
      const releaseOnEscape = (event) => {
        if (event.key === 'Escape') document.exitPointerLock();
      };
      window.addEventListener('keydown', releaseOnEscape, true);
      globalThis.__forgeaxPointerLockProbe = {
        read: () => ({ mode: 'simulated', ...probe }),
      };
    });
  }
  await nextPage.addInitScript(() => {
    const errors = [];
    let requests = 0;
    const existingProbe = globalThis.__forgeaxPointerLockProbe;
    globalThis.__forgeaxPointerLockProbe = {
      read: () => ({
        ...(existingProbe?.read?.() ?? {}),
        requests,
        errors: [...errors],
      }),
    };
    const original = HTMLCanvasElement.prototype.requestPointerLock;
    if (typeof original !== 'function') return;
    Object.defineProperty(HTMLCanvasElement.prototype, 'requestPointerLock', {
      configurable: true,
      value: function (...args) {
        requests += 1;
        const result = original.apply(this, args);
        result?.catch?.((cause) => {
          errors.push({
            name: cause?.name ?? null,
            message: cause?.message ?? String(cause),
            code: cause?.code ?? null,
          });
        });
        return result;
      },
    });
  });
  nextPage.on('pageerror', (error) => { activeEvidence?.pageErrors.push(error.message); });
  nextPage.on('console', (message) => {
    if (message.type() !== 'error' || activeEvidence === undefined) return;
    const text = `${message.text()} @ ${message.location().url}`;
    activeEvidence.sequence += 1;
    activeEvidence.consoleErrors.push(text);
    const event = {
      sequence: activeEvidence.sequence,
      phase: activeEvidence.phase,
      message: text,
    };
    activeEvidence.consoleErrorEvents.push(event);
    void Promise.all(message.args().map(async (argument) => {
      try {
        // Browser JSONValue drops non-enumerable Error.message and cause.
        // Preserve those fields so plugin activation failures stay actionable.
        return await argument.evaluate(serializeBrowserConsoleValue);
      } catch (cause) {
        return { unavailable: String(cause) };
      }
    })).then((values) => { event.arguments = values; });
  });
  nextPage.on('response', (response) => {
    if (response.status() >= 400) activeEvidence?.badResponses.push(`${response.status()} ${response.url()}`);
  });
  return nextPage;
}

async function restartSmokeBrowser(evidence) {
  if (cancelled !== undefined) throw new Error(`template smoke cancelled by ${cancelled}`);
  // Ignore teardown-only device-loss events from the completed journey. The
  // next journey gets a fresh browser/GPU process and its own evidence hooks.
  activeEvidence = undefined;
  await closeSmokeBrowser();
  browser = await launchSmokeBrowser();
  page = await createSmokePage(browser, { probePointerLock: evidence?.slug === 'game-3d' });
  activeEvidence = evidence;
}

async function waitForDefaultGame(page, evidence) {
  await page.waitForFunction(
    () => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const deadline = Date.now() + 30_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
    if (snapshot?.ok && snapshot.value.state?.phase === 'Play' && snapshot.value.state.fixedTicks > 0) break;
    await sleep(100);
  }
  if (!snapshot?.ok || snapshot.value.state?.phase !== 'Play' || snapshot.value.state.fixedTicks <= 0) {
    throw new Error(`game-default did not reach Play: ${JSON.stringify(snapshot)}`);
  }
  evidence.snapshot = snapshot;
  const renderer = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.renderer-contract'));
  evidence.renderer = renderer;
  if (!renderer?.ok) throw new Error(`game-default renderer projection failed: ${JSON.stringify(renderer)}`);
  const listed = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.list());
  if (listed.actions.length === 0 || listed.reads.length === 0) {
    throw new Error(`game-default inspection is empty: ${JSON.stringify(listed)}`);
  }
}

async function readGame3dPlayer() {
  const result = await page.evaluate(async () => (
    await globalThis.__forgeaxPreviewInspection?.read('game-3d.player')
  ));
  if (result?.ok !== true) {
    throw new Error(`game-3d.player read failed: ${JSON.stringify(result)}`);
  }
  return result.value;
}

async function waitForGame3dPlayer(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readGame3dPlayer();
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

async function waitForGame3dFixedTicks(
  originTick,
  tickDelta,
  label,
  timeout = GAME3D_FIXED_TICK_PROGRESS_TIMEOUT_MS,
) {
  const targetTick = originTick + tickDelta;
  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let latest;
  let lastProgressTick = originTick;
  let lastProgressAt = startedAt;
  while (Date.now() < deadline) {
    latest = await readGame3dPlayer();
    const now = Date.now();
    const fixedTick = latest.simulation?.fixedTick ?? 0;
    if (fixedTick >= targetTick) return latest;
    if (fixedTick > lastProgressTick) {
      lastProgressTick = fixedTick;
      lastProgressAt = now;
    } else if (now - lastProgressAt >= GAME3D_FIXED_TICK_STALL_TIMEOUT_MS) {
      throw new Error(
        `${label} stalled: ${JSON.stringify({
          originTick,
          targetTick,
          latest,
          elapsedMs: now - startedAt,
          lastProgressTick,
          stalledMs: now - lastProgressAt,
        })}`,
      );
    }
    await sleep(100);
  }
  throw new Error(
    `${label} timed out: ${JSON.stringify({
      originTick,
      targetTick,
      latest,
      elapsedMs: Date.now() - startedAt,
      lastProgressTick,
      stalledMs: Date.now() - lastProgressAt,
    })}`,
  );
}

function game3dCanvasPixelStats(bytes) {
  const image = PNG.sync.read(bytes);
  let lumaMin = 255;
  let lumaMax = 0;
  let nonBlackPixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const green = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    lumaMin = Math.min(lumaMin, luma);
    lumaMax = Math.max(lumaMax, luma);
    if (red > GAME3D_NON_BLACK_FLOOR || green > GAME3D_NON_BLACK_FLOOR || blue > GAME3D_NON_BLACK_FLOOR) {
      nonBlackPixels += 1;
    }
  }
  return {
    width: image.width,
    height: image.height,
    sampledPixels: image.width * image.height,
    nonBlackPixels,
    lumaMin: Math.round(lumaMin),
    lumaMax: Math.round(lumaMax),
    lumaRange: Math.round(lumaMax - lumaMin),
  };
}

async function readGame3dCanvasRender() {
  const canvas = page.locator('canvas#app');
  const bytes = await canvas.screenshot({ type: 'png' });
  const stats = game3dCanvasPixelStats(bytes);
  if (stats.nonBlackPixels === 0 || stats.lumaRange <= GAME3D_MIN_LUMA_RANGE) {
    const path = resolve(ARTIFACT_DIR, 'game-3d-render.png');
    writeFileSync(path, bytes);
    throw new Error(
      `game-3d canvas was blank: ${JSON.stringify({ ...stats, screenshot: path })}`,
    );
  }
  return stats;
}

function serverDiagnostics(lastStatus, elapsedMs) {
  return {
    origin: ORIGIN,
    pid: server?.pid ?? null,
    elapsedMs,
    lastStatus: lastStatus ?? null,
    spawnError: serverSpawnError === undefined ? null : String(serverSpawnError),
    exit: serverExit ?? null,
    output: serverOutput.trim() || 'none',
  };
}

async function waitForServerReady() {
  const startedAt = Date.now();
  let lastStatus;
  let lastProbeError;
  while (Date.now() - startedAt < SERVER_STARTUP_TIMEOUT_MS) {
    const elapsedMs = Date.now() - startedAt;
    if (serverSpawnError !== undefined) {
      throw new Error(`Preview server failed to start: ${JSON.stringify(serverDiagnostics(lastStatus, elapsedMs))}`);
    }
    if (serverExit !== undefined) {
      throw new Error(`Preview server exited before becoming ready: ${JSON.stringify(serverDiagnostics(lastStatus, elapsedMs))}`);
    }
    let response;
    let body;
    try {
      // The HTTP listener may precede Pack initialization. Finish preparation
      // before the separate 30-second browser/rendering assertion begins.
      // A Catalog request fences filesystem freshness, which can take more
      // than a second. Let that request finish within the existing startup
      // deadline instead of aborting it and starting overlapping scans.
      response = await fetch(new URL(CATALOG_URL, ORIGIN), {
        signal: AbortSignal.timeout(Math.max(1, SERVER_STARTUP_TIMEOUT_MS - elapsedMs)),
      });
      lastStatus = response.status;
      body = await response.text();
    } catch (error) {
      // Vite is still starting, or its producer has not answered yet.
      lastProbeError = {
        name: error?.name,
        message: error instanceof Error ? error.message : String(error),
        code: error?.cause?.code ?? error?.code,
      };
    }
    if (body !== undefined) {
      if (response.ok) {
        decodeCatalogWire(JSON.parse(body)).unwrap();
        return;
      }
      if (response.status !== 503) {
        throw new Error(`Preview catalog failed: HTTP ${response.status}: ${body.slice(0, 4096)}`);
      }
    }
    await sleep(Math.min(250, Math.max(0, SERVER_STARTUP_TIMEOUT_MS - (Date.now() - startedAt))));
  }
  throw new Error(
    `Preview server did not become ready within ${SERVER_STARTUP_TIMEOUT_MS}ms: ${JSON.stringify({ ...serverDiagnostics(lastStatus, Date.now() - startedAt), lastProbeError })}`,
  );
}

function movementProjection(origin, current, yaw) {
  const dx = (current.position[0] ?? 0) - (origin.position[0] ?? 0);
  const dz = (current.position[2] ?? 0) - (origin.position[2] ?? 0);
  const forward = [Math.sin(yaw), -Math.cos(yaw)];
  const right = [Math.cos(yaw), Math.sin(yaw)];
  return {
    forward: dx * forward[0] + dz * forward[1],
    right: dx * right[0] + dz * right[1],
    distance: Math.hypot(dx, dz),
  };
}

function facingAlignment(state, direction) {
  return (state.facing[0] ?? 0) * direction[0] + (state.facing[1] ?? 0) * direction[1];
}

async function probeNativePointerLock(probePage) {
  const probeUrl = `${ORIGIN}/__forgeax-pointer-lock-probe__.html`;
  const fulfillProbeDocument = (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body></body></html>',
  });
  await probePage.route(probeUrl, fulfillProbeDocument);
  try {
    await probePage.goto(probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await probePage.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.id = 'forgeax-pointer-lock-probe';
      canvas.width = 320;
      canvas.height = 240;
      canvas.style.cssText = 'position:fixed;inset:0;width:320px;height:240px;z-index:10000';
      document.body.append(canvas);
      const result = { errors: [], requests: 0 };
      globalThis.__forgeaxNativePointerLockProbe = result;
      canvas.addEventListener('click', () => {
        result.requests += 1;
        try {
          const request = canvas.requestPointerLock();
          request?.catch?.((cause) => result.errors.push({
            name: cause?.name ?? null,
            message: cause?.message ?? String(cause),
            code: cause?.code ?? null,
          }));
        } catch (cause) {
          result.errors.push({
            name: cause?.name ?? null,
            message: cause?.message ?? String(cause),
            code: cause?.code ?? null,
          });
        }
      });
    });
    await probePage.bringToFront();
    const box = await probePage.locator('#forgeax-pointer-lock-probe').boundingBox();
    if (box === null) return { status: 'probe-failed', error: 'probe canvas has no bounds' };
    await probePage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await probePage.waitForTimeout(250);
    const acquired = await probePage.evaluate(() => {
      const canvas = document.querySelector('#forgeax-pointer-lock-probe');
      const probe = globalThis.__forgeaxNativePointerLockProbe;
      return {
        status: document.pointerLockElement === canvas ? 'locked' : 'unavailable',
        errors: probe?.errors ?? [],
        requests: probe?.requests ?? 0,
      };
    });
    if (acquired.status !== 'locked') return acquired;
    await probePage.keyboard.press('Escape');
    await probePage.waitForTimeout(250);
    const releasedByEscape = await probePage.evaluate(() => document.pointerLockElement === null);
    if (!releasedByEscape) {
      // A browser that can acquire a lock but cannot release it through the
      // same trusted Escape path is not a complete native smoke carrier. Keep
      // the real game assertions running with the explicit test-only shim
      // below, while preserving the native probe evidence for diagnosis.
      await probePage.evaluate(() => document.exitPointerLock());
    }
    return { ...acquired, status: releasedByEscape ? 'locked' : 'unavailable', releasedByEscape };
  } catch (error) {
    return { status: 'probe-failed', error: String(error) };
  } finally {
    await probePage.evaluate(() => {
      if (document.pointerLockElement !== null) document.exitPointerLock();
    }).catch(() => {});
    await probePage.unroute(probeUrl, fulfillProbeDocument);
  }
}

async function readGame3dUi() {
  return page.evaluate(() => {
    const root = document.querySelector('[data-forgeax-ui-root="true"]');
    const host = root?.querySelector('[data-ui-asset]');
    const shadow = host?.shadowRoot;
    const lock = shadow?.querySelector('[data-ui-slot="lock"]');
    const guide = shadow?.querySelector('.guide');
    const crosshair = shadow?.querySelector('.crosshair');
    return {
      rootChildren: root?.children.length ?? 0,
      assetGuid: host?.getAttribute('data-ui-asset') ?? null,
      lockedClass: host?.classList.contains('locked') ?? false,
      lockText: lock?.textContent?.trim() ?? null,
      guideText: guide?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      crosshairDisplay: crosshair === null || crosshair === undefined
        ? null
        : getComputedStyle(crosshair).display,
    };
  });
}

async function dispatchLockedPointerDelta(movementX, movementY) {
  await page.evaluate(({ movementX: deltaX, movementY: deltaY }) => {
    const canvas = document.querySelector('canvas#app');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('game-3d canvas is unavailable for locked pointer input');
    }
    const bounds = canvas.getBoundingClientRect();
    const event = new PointerEvent('pointermove', {
      bubbles: true,
      clientX: bounds.x + bounds.width / 2,
      clientY: bounds.y + bounds.height / 2,
      pointerId: 1,
      pointerType: 'mouse',
    });
    Object.defineProperties(event, {
      movementX: { configurable: true, value: deltaX },
      movementY: { configurable: true, value: deltaY },
    });
    canvas.dispatchEvent(event);
  }, { movementX, movementY });
}

async function waitForLockedPointerLook(origin, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  const maxDispatches = 16;
  let dispatches = 0;
  let latest;
  while (Date.now() < deadline) {
    // A software-GPU frame can take seconds. Pulse a small relative delta
    // through the real canvas listener until one InputSnapshot scan consumes
    // it, instead of assuming a single synthetic event lands between scans.
    if (dispatches < maxDispatches) {
      await dispatchLockedPointerDelta(8, 2);
      dispatches += 1;
    }
    latest = await readGame3dPlayer();
    const yawDelta = latest.camera?.yaw - origin.camera.yaw;
    const pitchDelta = latest.camera?.pitch - origin.camera.pitch;
    if (
      latest.camera?.pointerLocked === true
      && latest.simulation?.fixedTick > origin.simulation.fixedTick
      && yawDelta > 0.05
      && yawDelta <= 0.4
      && pitchDelta > 0.01
      && pitchDelta <= 0.12
    ) {
      return { state: latest, dispatches };
    }
    await sleep(100);
  }
  throw new Error(
    `game-3d mouse yaw/pitch timed out: ${JSON.stringify({ latest, dispatches })}`,
  );
}

async function readPointerLockDiagnostic() {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas#app');
    return {
      origin: location.origin,
      isSecureContext,
      isTopLevel: window.top === window,
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      userActivation: navigator.userActivation === undefined
        ? null
        : {
          isActive: navigator.userActivation.isActive,
          hasBeenActive: navigator.userActivation.hasBeenActive,
        },
      pointerLockElement: document.pointerLockElement?.tagName ?? null,
      canvas: {
        connected: canvas?.isConnected ?? false,
        sameDocument: canvas?.ownerDocument === document,
        rootIsDocument: canvas?.getRootNode() === document,
        requestPointerLock: typeof canvas?.requestPointerLock,
      },
      probe: globalThis.__forgeaxPointerLockProbe?.read() ?? null,
    };
  });
}

async function readPointerLockRequests() {
  return page.evaluate(() => globalThis.__forgeaxPointerLockProbe?.read().requests ?? 0);
}

async function waitForGame3dPointerLock(label) {
  try {
    await page.waitForFunction(
      () => document.pointerLockElement === document.querySelector('canvas#app'),
      undefined,
      { timeout: 10_000, polling: 50 },
    );
  } catch (error) {
    throw new Error(`${label} failed: ${String(error)} diagnostic=${JSON.stringify(await readPointerLockDiagnostic())}`);
  }
}

async function waitForTemplateReady(requireCompletedFrame = true) {
  const startedAtMs = Date.now();
  try {
    // Bound startup and the first GPU completion separately: cold software GPU
    // compilation must not consume the renderer's completion budget.
    for (const completionStage of requireCompletedFrame ? [false, true] : [false]) {
      await page.waitForFunction(
        ({ requireCompletedFrame, finalStage, startedAtMs }) => {
          const inspection = globalThis.__forgeaxPreviewInspection;
          const canvas = document.querySelector('canvas#app');
          const health = inspection?.renderer.health();
          const state = health?.reason;
          const submitted = canvas?.forgeaxFrameProgress?.submitted?.frameId;
          const completed = canvas?.forgeaxFrameProgress?.completed?.frameId;
          const hasSubmittedFrame = Number.isSafeInteger(submitted) && submitted > 0;
          const hasCompletedFrame = Number.isSafeInteger(completed) && completed > 0;
          const canvasSized = (canvas?.width ?? 0) > 0 && (canvas?.height ?? 0) > 0;
          const elapsedMs = Math.max(0, Date.now() - startedAtMs);
          const timing = globalThis.__forgeaxTemplateReadinessTiming ?? {};
          if (inspection !== undefined) timing.inspectionAvailableMs ??= elapsedMs;
          if (state === 'alive') timing.rendererAliveMs ??= elapsedMs;
          if (canvasSized) timing.canvasSizedMs ??= elapsedMs;
          if (hasSubmittedFrame) timing.frameSubmittedMs ??= elapsedMs;
          if (hasCompletedFrame) timing.frameCompletedMs ??= elapsedMs;
          const ready = inspection !== undefined
            && state === 'alive'
            && (!requireCompletedFrame || hasCompletedFrame)
            && canvasSized;
          if (ready && finalStage) timing.readyMs ??= elapsedMs;
          globalThis.__forgeaxTemplateReadinessTiming = timing;
          return ready;
        },
        { requireCompletedFrame: completionStage, finalStage: completionStage === requireCompletedFrame, startedAtMs },
        { timeout: 30_000, polling: 100 },
      );
    }
  } finally {
    const timing = await page
      .evaluate(() => globalThis.__forgeaxTemplateReadinessTiming ?? null)
      .catch(() => null);
    if (typeof activeEvidence !== 'undefined' && activeEvidence !== undefined) {
      activeEvidence.readinessTiming = timing;
      console.log(`[${activeEvidence.slug ?? 'template'}] readiness-timing=${JSON.stringify(timing)}`);
    }
  }
  const settleStartedAtMs = Date.now();
  await page.evaluate((settleFrames) => new Promise((done) => {
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (frames >= settleFrames) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), TEMPLATE_SETTLE_FRAMES);
  if (typeof activeEvidence !== 'undefined' && activeEvidence !== undefined) {
    activeEvidence.readinessSettleMs = Date.now() - settleStartedAtMs;
    console.log(`[${activeEvidence.slug ?? 'template'}] readiness-settle-ms=${activeEvidence.readinessSettleMs}`);
  }
}

async function diagnoseTemplateReadyFailure(cause, templateSlug) {
  const evidence = { waitError: String(cause) };
  const evaluate = async (operation) => {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(operation).then((value) => ({ status: 'completed', value })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: 'timeout', timeoutMs: 3_000 }), 3_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const runtime = await evaluate(() => {
      const inspection = globalThis.__forgeaxPreviewInspection;
      const canvas = document.querySelector('canvas#app');
      let health;
      let healthError;
      const progress = canvas?.forgeaxFrameProgress;
      try {
        health = inspection?.renderer.health();
      } catch (error) {
        healthError = String(error);
      }
      return {
        inspectionAvailable: inspection !== undefined,
        rendererHealth: health,
        rendererHealthError: healthError,
        frameProgress: progress === undefined
          ? null
          : {
              submitted: progress.submitted?.frameId ?? null,
              completed: progress.completed?.frameId ?? null,
            },
        frameSubmitted: progress?.submitted?.frameId ?? null,
        frameCompleted: progress?.completed?.frameId ?? null,
        canvas: canvas === null
          ? null
          : { width: canvas.width, height: canvas.height, connected: canvas.isConnected },
        document: {
          readyState: document.readyState,
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
        },
      };
    });
    if (runtime.status === 'timeout') {
      evidence.runtimeError = `inspection-read-timeout:${runtime.timeoutMs}ms`;
      return evidence;
    }
    evidence.runtime = runtime.value;
  } catch (error) {
    evidence.runtimeError = String(error);
    return evidence;
  }

  if (evidence.runtime?.inspectionAvailable === true) {
    try {
      const capture = await evaluate(() => globalThis.__forgeaxPreviewInspection.captureFrame(1));
      evidence.rhiCapture = capture.status === 'timeout'
        ? { status: 'timeout', timeoutMs: capture.timeoutMs }
        : capture.value;
    } catch (error) {
      evidence.rhiCaptureError = String(error);
    }
  } else {
    evidence.rhiCapture = {
      ok: false,
      error: {
        code: 'capture-unavailable',
        hint: 'Preview inspection was not published before the original readiness deadline',
      },
    };
  }
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const path = resolve(ARTIFACT_DIR, `${templateSlug}-readiness-failure.png`);
    const screenshot = await page.screenshot({ path, type: 'png', timeout: 3_000 });
    evidence.screenshot = { status: 'captured', path, bytes: screenshot.byteLength };
  } catch (error) {
    evidence.screenshot = { status: 'failed', error: String(error) };
  }
  return evidence;
}

async function smokeGame3dCollision(evidence) {
  evidence.phase = 'collision';
  // Restore the authored straight path in a fresh Chrome/GPU process. Hosted
  // Lavapipe can invalidate its external Instance during same-page navigation;
  // process isolation keeps that teardown artifact out of the collision gate.
  await restartSmokeBrowser(evidence);
  await page.goto(`${ORIGIN}/?game=game-3d&journey=collision-${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await waitForTemplateReady();
  evidence.collisionStartup = await waitForSubmittedRendererFrame(
    'game-3d collision renderer did not submit an initial frame',
  );
  await page.waitForFunction(
    () =>
      globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-3d.player') ??
      false,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const collisionStart = await waitForGame3dPlayer(
    (state) => state.grounded === true && state.camera?.yaw === 0,
    'game-3d collision start',
  );
  // The preceding interaction journey proves pointer lock and mouse look.
  // Collision follows the authored straight path using trusted keyboard input;
  // acquiring mouse lock here lets incidental host cursor motion turn that path.
  await page.bringToFront();
  await page.keyboard.down('KeyW');
  let collisionApproach;
  let collisionLate;
  let collisionSettled;
  try {
    // Wait on simulation evidence rather than wall-clock duration. This keeps
    // the assertion meaningful on slow software-GPU runners: a stalled tab
    // cannot look like a settled collision, while a healthy low-FPS tab gets
    // enough time to advance the same fixed-step path.
    collisionApproach = await waitForGame3dFixedTicks(
      collisionStart.simulation.fixedTick,
      48,
      'game-3d collision approach',
    );
    if (movementProjection(collisionStart, collisionApproach, 0).forward <= 3) {
      throw new Error(`game-3d collision approach did not advance: ${JSON.stringify({ collisionStart, collisionApproach })}`);
    }
    const approachTick = collisionApproach.simulation?.fixedTick ?? 0;
    collisionLate = await waitForGame3dFixedTicks(
      approachTick,
      48,
      'game-3d collision continued simulation',
    );
    const lateTick = collisionLate.simulation?.fixedTick ?? approachTick;
    collisionSettled = await waitForGame3dFixedTicks(
      lateTick,
      24,
      'game-3d collision settling simulation',
    );
  } finally {
    await page.keyboard.up('KeyW');
  }
  const collisionTravel = movementProjection(collisionStart, collisionApproach, 0).forward;
  const collisionLateStep = Math.hypot(
    (collisionSettled.position[0] ?? 0) - (collisionLate.position[0] ?? 0),
    (collisionSettled.position[2] ?? 0) - (collisionLate.position[2] ?? 0),
  );
  if (collisionTravel < 3 || collisionLateStep > 0.45 || collisionSettled.grounded !== true) {
    throw new Error(
      `game-3d collision did not settle: ${JSON.stringify({ collisionStart, collisionApproach, collisionLate, collisionSettled, collisionTravel, collisionLateStep })}`,
    );
  }
  await page.keyboard.press('Escape');

  return {
    status: 'passed',
    collisionStart,
    collisionApproach,
    collisionLate,
    collisionSettled,
    collisionTravel,
    collisionLateStep,
  };
}

async function smokeGame3d(evidence) {
  await page.waitForFunction(
    () => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-3d.player') ?? false,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const listed = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.list());
  if (!listed?.reads.some(({ id }) => id === 'game-3d.player')) {
    throw new Error(`game-3d player projection is missing: ${JSON.stringify(listed)}`);
  }

  const ui = await readGame3dUi();
  if (
    ui.rootChildren !== 1
    || ui.assetGuid === null
    || ui.lockText !== 'Click to lock camera, or hold right mouse to look'
    || !ui.guideText?.includes('WASD')
    || !ui.guideText?.includes('Space')
    || !ui.guideText?.includes('Esc')
    || ui.crosshairDisplay !== 'none'
  ) {
    throw new Error(`game-3d UI asset is incomplete: ${JSON.stringify(ui)}`);
  }

  evidence.localization = await probeLocalization(page, ARTIFACT_DIR);

  evidence.runtimeVase = await probeRuntimeVase(page, async () => {
    const result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-3d.runtime-vase'));
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.value;
  }, ARTIFACT_DIR);

  const initial = await waitForGame3dPlayer(
    (state) => state.grounded === true && state.animation?.walkWeight === 0,
    'game-3d initial grounded state',
  );
  const interactionPointerLock = { mode: pointerLockMode, nativeProbe: nativePointerLockProbe };
  const canvas = page.locator('canvas#app');
  const box = await canvas.boundingBox();
  if (box === null || box.width <= 0 || box.height <= 0) {
    throw new Error(`game-3d canvas has no browser bounds: ${JSON.stringify(box)}`);
  }
  // Renderer health and submitted frame ids can remain healthy while the
  // compositor only shows the clear color. Read the actual canvas once after
  // the game-owned scene witness is ready so a blank game cannot pass on
  // lifecycle/inspection evidence alone.
  const render = await readGame3dCanvasRender();
  // Both panels begin 14px from the edge; retain native input outside their controls.
  const inputPoint = { x: box.x + 4, y: box.y + 4 };

  await page.bringToFront();
  await page.mouse.move(inputPoint.x, inputPoint.y);
  await page.waitForTimeout(100);
  await page.mouse.click(inputPoint.x, inputPoint.y);
  await waitForGame3dPointerLock('game-3d initial pointer lock');
  const locked = await waitForGame3dPlayer(
    (state) => state.camera?.pointerLocked === true,
    'game-3d pointer lock',
  );
  const uiLocked = await readGame3dUi();
  if (
    !uiLocked.lockedClass
    || uiLocked.lockText !== 'Camera locked · mouse look active'
    || uiLocked.crosshairDisplay !== 'block'
  ) {
    throw new Error(`game-3d locked UI state is incomplete: ${JSON.stringify(uiLocked)}`);
  }

  const lookOrigin = locked;
  // Chromium's native pointer lock works under Xvfb, but Playwright's absolute
  // mouse move does not reliably produce relative movementX/movementY there.
  // Keep the real lock probe above and drive the same canvas PointerEvent path
  // that BrowserBackend consumes with an explicit deterministic delta.
  const lookWitness = await waitForLockedPointerLook(lookOrigin);
  const looked = lookWitness.state;
  const lookDelta = {
    yaw: looked.camera.yaw - lookOrigin.camera.yaw,
    pitch: looked.camera.pitch - lookOrigin.camera.pitch,
  };

  const moveOrigin = looked;
  const moveYaw = moveOrigin.camera.yaw;
  const moveDirection = [Math.sin(moveYaw), -Math.cos(moveYaw)];
  await page.keyboard.down('KeyW');
  let walking;
  try {
    walking = await waitForGame3dPlayer(
      (state) => {
        const projection = movementProjection(moveOrigin, state, moveYaw);
        return (
          projection.forward > 0.25
          && state.animation?.walkWeight > 0.9
          && facingAlignment(state, moveDirection) > 0.99
        );
      },
      'game-3d camera-relative W movement',
    );
  } finally {
    await page.keyboard.up('KeyW');
  }
  const afterWalkRelease = await waitForGame3dPlayer(
    (state) => state.animation?.walkWeight === 0,
    'game-3d walk animation release',
  );

  const strafeOrigin = afterWalkRelease;
  const strafeYaw = strafeOrigin.camera.yaw;
  const strafeDirection = [Math.cos(strafeYaw), Math.sin(strafeYaw)];
  await page.keyboard.down('KeyD');
  let strafed;
  try {
    strafed = await waitForGame3dPlayer(
      (state) => {
        const projection = movementProjection(strafeOrigin, state, strafeYaw);
        return projection.right > 0.25 && facingAlignment(state, strafeDirection) > 0.99;
      },
      'game-3d camera-relative D movement',
    );
  } finally {
    await page.keyboard.up('KeyD');
  }

  // An FPS fires with trusted clicks while locked. Those clicks must keep the
  // current lock instead of re-requesting it, which browsers may re-enter or
  // refuse and which would surface as a lock failure mid-game.
  const requestsBeforeLockedClick = await readPointerLockRequests();
  await page.mouse.click(inputPoint.x, inputPoint.y);
  await page.mouse.click(inputPoint.x, inputPoint.y);
  const lockedClicks = await waitForGame3dPlayer(
    (state) => state.camera?.pointerLocked === true,
    'game-3d click while pointer locked',
  );
  const requestsAfterLockedClick = await readPointerLockRequests();
  const stillLocked = await page.evaluate(
    () => document.pointerLockElement === document.querySelector('canvas#app'),
  );
  if (requestsAfterLockedClick !== requestsBeforeLockedClick || !stillLocked) {
    throw new Error(
      `game-3d click while locked re-requested or lost pointer lock: ${JSON.stringify({ requestsBeforeLockedClick, requestsAfterLockedClick, stillLocked, diagnostic: await readPointerLockDiagnostic() })}`,
    );
  }

  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => document.pointerLockElement === null,
    undefined,
    { timeout: 10_000, polling: 50 },
  );
  const unlocked = await waitForGame3dPlayer(
    (state) => state.camera?.pointerLocked === false,
    'game-3d pointer unlock',
  );
  evidence.sequence += 1;
  evidence.journeyCompleteSequence = evidence.sequence;
  evidence.phase = 'journey-complete';

  const collision =
    GAME3D_COLLISION_MODE === 'required'
      ? await smokeGame3dCollision(evidence)
      : { status: 'omitted', reason: 'sdk-source-distribution' };
  evidence.phase = 'journey-complete';
  const rendererHealth = await page.evaluate(
    () => globalThis.__forgeaxPreviewInspection?.renderer.health(),
  );
  if (GAME3D_COLLISION_MODE === 'required' && rendererHealth?.reason !== 'alive') {
    throw new Error(`game-3d renderer did not survive the journey: ${JSON.stringify(rendererHealth)}`);
  }

  evidence.game3d = {
    render,
    pointerLock: interactionPointerLock,
    ui,
    uiLocked,
    initial,
    locked,
    look: {
      origin: lookOrigin,
      result: looked,
      delta: lookDelta,
      inputDispatches: lookWitness.dispatches,
    },
    movement: {
      origin: moveOrigin,
      walking,
      afterRelease: afterWalkRelease,
      projection: movementProjection(moveOrigin, walking, moveYaw),
    },
    strafe: {
      origin: strafeOrigin,
      result: strafed,
      projection: movementProjection(strafeOrigin, strafed, strafeYaw),
    },
    lockedClicks: {
      state: lockedClicks,
      requestsBefore: requestsBeforeLockedClick,
      requestsAfter: requestsAfterLockedClick,
    },
    unlocked,
    rendererHealth,
    collision,
  };
}

async function smokeEmptyStartupReadiness(evidence) {
  const catalog = decodeCatalogWire(await (await fetch(`${ORIGIN}${CATALOG_URL}`)).json()).unwrap();
  const scene = catalog.find((entry) => entry.guid === '019fb7ce-1000-7000-8000-000000000001');
  if (scene?.kind !== 'scene' || typeof scene.packageUrl !== 'string') {
    throw new Error('empty startup disposal requires the ordinary scene Catalog entry');
  }
  await restartSmokeBrowser(evidence);
  const packageUrl = new URL(scene.packageUrl, ORIGIN);
  const matches = (url) => url.origin === packageUrl.origin && url.pathname === packageUrl.pathname;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let admitted;
  const blocked = new Promise((resolve) => { admitted = resolve; });
  await page.route(matches, async (route) => {
    admitted();
    await held;
    await route.continue().catch(() => undefined);
  });
  const requested = page.waitForRequest((request) => matches(new URL(request.url())), { timeout: 30_000 });
  evidence.phase = 'startup-disposal';
  try {
    await Promise.all([
      page.goto(`${ORIGIN}/?game=empty`, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
      requested,
      blocked,
    ]);
    const premature = await page.evaluate(() => globalThis.__forgeaxPreviewInspection !== undefined);
    if (premature) throw new Error('Preview advertised readiness while its native Scene startup was still blocked');
    release();
    await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection !== undefined, null, { timeout: 30_000 });
    await page.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
    await page.waitForFunction(
      () => globalThis.__forgeaxPreviewInspection === undefined && document.querySelector('[data-forgeax-ui-root]') === null,
      null,
      { timeout: 10_000 },
    );
    evidence.startupDisposal = { sceneGuid: scene.guid, sceneRequestHeld: true, notPublishedDuringLoad: true, retired: true };
  } finally {
    release();
    await page.unroute(matches);
  }
}

async function smokeTemplate(template, evidence) {
  const startupStartedAtMs = Date.now();
  const navigationStartedAtMs = Date.now();
  const templateUrl = new URL('/', ORIGIN);
  templateUrl.searchParams.set('game', template.slug);
  if (process.env.FORGEAX_TEMPLATE_RHI_STARTUP_CAPTURE === '1') {
    templateUrl.searchParams.set('rhiStartupCapture', '1');
  }
  await page.goto(templateUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  evidence.navigationToDomContentLoadedMs = Date.now() - navigationStartedAtMs;
  try {
    await waitForTemplateReady(template.slug !== 'empty' && template.manifest.roots?.engine !== undefined);
  } catch (error) {
    evidence.readinessFailure = await diagnoseTemplateReadyFailure(error, template.slug);
    throw error;
  }
  if (template.slug === 'game-3d') {
    await waitForSubmittedRendererFrame('game-3d renderer did not submit an initial frame');
  }

  const probe = await page.evaluate(() => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    if (inspection === undefined) throw new Error('Preview inspection global is unavailable');
    return {
      listed: inspection.list(),
      state: inspection.renderer.health(),
      canvas: {
        width: document.querySelector('canvas#app')?.width ?? 0,
        height: document.querySelector('canvas#app')?.height ?? 0,
      },
    };
  });
  evidence.startupThroughInspectionProbeMs = Date.now() - startupStartedAtMs;
  console.log(`[${template.slug}] startup-timing=${JSON.stringify({
    navigationToDomContentLoadedMs: evidence.navigationToDomContentLoadedMs,
    readinessTiming: evidence.readinessTiming,
    readinessSettleMs: evidence.readinessSettleMs,
    startupThroughInspectionProbeMs: evidence.startupThroughInspectionProbeMs,
  })}`);
  evidence.probe = probe;
  if (probe.state.reason !== 'alive') throw new Error(`${template.slug} renderer is not alive: ${JSON.stringify(probe.state)}`);
  if (probe.canvas.width <= 0 || probe.canvas.height <= 0) {
    throw new Error(`${template.slug} canvas has no drawable size: ${JSON.stringify(probe.canvas)}`);
  }
  if (template.slug === 'game-default') await waitForDefaultGame(page, evidence);
  if (template.slug === 'game-3d') {
    evidence.phase = 'interaction';
    await smokeGame3d(evidence);
    await classifySdkSourceHostGpuInstanceLoss(evidence);
  }

  if (template.slug === 'empty') await smokeEmptyStartupReadiness(evidence);

  const unexpected = unexpectedConsoleErrors(evidence);
  if (evidence.pageErrors.length > 0) throw new Error(`${template.slug} page errors: ${evidence.pageErrors.join(' | ')}`);
  if (unexpected.length > 0) throw new Error(`${template.slug} console errors: ${unexpected.join(' | ')}`);
  if (evidence.badResponses.length > 0) throw new Error(`${template.slug} bad responses: ${evidence.badResponses.join(' | ')}`);
}

let smokeFailure;
try {
  for (const template of templates) {
    const evidence = {
      slug: template.slug,
      id: template.id,
      name: template.name,
      pageErrors: [],
      consoleErrors: [],
      consoleErrorEvents: [],
      expectedConsoleErrors: [],
      badResponses: [],
      phase: 'template-load',
      sequence: 0,
    };
    templateEvidence.push(evidence);
    if (CI_LIGHTWEIGHT) {
      templateSmokeRoot = await prepareTemplateSmokeProject(template.slug);
      evidence.shadowMapSize = testQuality.shadowMapSize;
    }
    startServer(template.slug);
    await waitForServerReady();
    const runBrowser = async () => {
      let failure;
      try {
        await restartSmokeBrowser(evidence);
        await smokeTemplate(template, evidence);
        evidence.status =
          evidence.game3d?.collision?.status === 'omitted' ? 'passed-with-omissions' : 'passed';
        console.log(
          `[${template.slug}] ${evidence.status === 'passed' ? 'PASS' : 'PASS-WITH-OMISSIONS'} id=${template.id} name=${template.name}`,
        );
      } catch (error) {
        failure = error;
      }
      try {
        await closeSmokeBrowser();
      } catch (error) {
        failure = failure === undefined
          ? error
          : new AggregateError([failure, error], 'template browser and cleanup failed');
      }
      if (failure !== undefined) throw failure;
    };
    if (process.env.FORGEAX_LOCAL_GPU_LEASE === '1') {
      await withLocalGpuLease(runBrowser, { label: `Preview template ${template.slug}` });
    } else {
      await runBrowser();
    }
    await stopServer();
    if (templateSmokeRoot !== undefined) {
      await rm(templateSmokeRoot, { recursive: true, force: true });
      templateSmokeRoot = undefined;
    }
  }

} catch (error) {
  smokeFailure = new Error(`${String(error)}\nBrowser evidence: ${JSON.stringify(browserEvidence())}`, {
    cause: error,
  });
} finally {
  let cleanupError;
  try {
    await closeSmokeBrowser();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await stopServer();
    if (templateSmokeRoot !== undefined) {
      await rm(templateSmokeRoot, { recursive: true, force: true });
      templateSmokeRoot = undefined;
    }
  } catch (error) {
    cleanupError = cleanupError === undefined
      ? error
      : new AggregateError([cleanupError, error], 'template smoke cleanup failed');
  }
  if (cleanupError !== undefined) {
    if (smokeFailure === undefined) {
      smokeFailure = cleanupError;
    } else {
      smokeFailure = new AggregateError([smokeFailure, cleanupError], String(smokeFailure), {
        cause: smokeFailure,
      });
    }
  }
}
if (cancelled !== undefined) {
  // The signal handler owns the final report and waits for both child lifetimes.
  await cancellation;
}
process.off('SIGINT', onInterrupt);
process.off('SIGTERM', onTerminate);
if (smokeFailure !== undefined) {
  writeReport('failed', { error: String(smokeFailure) });
  throw smokeFailure;
}
const reportStatus = templateEvidence.some(({ status }) => status === 'passed-with-omissions')
  ? 'passed-with-omissions'
  : 'passed';
writeReport(reportStatus);
console.log(`[templates] PASS count=${templates.length} artifacts=${ARTIFACT_DIR}`);
