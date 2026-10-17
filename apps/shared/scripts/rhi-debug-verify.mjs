import { teardownDawnInstance } from '../../../scripts/lib/dawn-teardown.mjs';
// @forgeax/apps-shared/scripts/rhi-debug-verify -- reusable RHI-debug capture
// verification harness for learn-render / hello-* demos.
//
// Why this exists: feat-20260625 (initial-state capture) and PR #525 (the
// all-black replay bug) exposed that the "real demo capture -> offline replay"
// path had no test comparing the replayed frame against the demo's actual
// rendered image. Synthetic-tape tests stayed green while the real path rendered
// black. This harness closes that gap with two modes:
//
//   mode='pixel'      (static demos): capture a frame, replay it on a fresh
//                     dawn-node device, read back BOTH the live canvas pixels and
//                     the replayed RT pixels, and assert RGB pixel delta <= eps.
//                     This is the only check that proves "replay == demo effect".
//
//   mode='structural' (animated demos): capture -> replay -> stepTo -> inspect,
//                     asserting bindings/drawCall/rt are non-empty. No live-pixel
//                     comparison (an animated demo's live frame and tape frame
//                     can diverge by a frame, which would masquerade as a tool
//                     bug). Same coverage as apps/hello/cube/scripts/smoke-browser.
//
// The pixel comparison auto-detects the correct pixel-buffer alignment between
// the two readback paths (identity / Y-flip / BGRA<->RGBA channel swap / both)
// by measuring the delta under each and choosing the minimum. Both paths SHOULD
// already agree (renderer.readPixels returns top-left RGBA via getImageData;
// replay.readbackRt returns top-left RGBA from an rgba8unorm RT), but measuring
// rather than assuming turns "is it flipped/swapped?" from a guess into reported
// data -- so a genuine fidelity bug is never misread as a normalization mistake.
//
// Exit codes (mirrors cube smoke): 0 green, 1 red (regression), 2 harness error.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { buildFrameModel, decodeTape, replayDeviceRequest } from '@forgeax/engine-rhi-debug';
import { writeReferencePng } from '../png-codec.mjs';
import { createOwnedProcessGroupStopper } from './rhi-debug-process.mjs';
import { pnpmCommand } from '../../../scripts/lib/pnpm-command.mjs';
import browserLaunchConfig from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const RAW_TAPE_ROUTE = '/__forgeax-debug/tape';
const RHITAPE_MIME = 'application/x-forgeax-rhitape';
// Cold learn-render shader inventory takes about three minutes on a desktop;
// readiness is separate from the bounded capture/replay phase below.
const MAX_VITE_READINESS_TIMEOUT_MS = 600_000;
const VITE_READINESS_TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.FORGEAX_RHI_DEBUG_VITE_READINESS_TIMEOUT_MS ?? '300000', 10) || 300_000, 1),
  MAX_VITE_READINESS_TIMEOUT_MS,
);

const COMMON_BROWSER_WEBGPU_ARGS = Object.freeze([
  '--disable-features=MacAppCodeSignClone',
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--disable-gpu-driver-bug-workarounds',
  '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
]);

/**
 * Resolve the browser backend used by the RHI-debug carrier.
 *
 * The Node Dawn carrier on macOS is Metal. Chromium's historical verifier
 * forced SwiftShader Vulkan on every host, which made a paired pixel result a
 * cross-backend comparison even though the product and tape were unchanged.
 * Keep that path available as an explicit negative-control while making the
 * default macOS path request ANGLE Metal. Windows keeps native ANGLE presentation
 * while explicitly selecting the SwiftShader WebGPU adapter; Linux retains the
 * SwiftShader-Vulkan launch arguments.
 *
 * `FORGEAX_BROWSER_BACKEND` is intentionally a closed set:
 *   - `auto` (default): Metal on macOS, SwiftShader Vulkan elsewhere
 *   - `metal`: explicit Metal (macOS only)
 *   - `swiftshader-vulkan`: explicit legacy/negative-control path
 *
 * There is no silent fallback between these choices. A caller that requests
 * Metal on a non-macOS host receives a setup error instead of an unrelated
 * backend being substituted.
 *
 * @param {{ platform?: string, backend?: string }} [options]
 * @returns {{ requestedBackend: string, selectedBackend: 'metal'|'swiftshader-vulkan', comparisonMode: string, args: string[] }}
 */
export function resolveBrowserWebGpuLaunch({
  platform = process.platform,
  backend = process.env.FORGEAX_BROWSER_BACKEND ?? 'auto',
} = {}) {
  const requestedBackend = String(backend).trim().toLowerCase() || 'auto';
  if (!['auto', 'metal', 'swiftshader-vulkan'].includes(requestedBackend)) {
    throw new Error(
      `invalid FORGEAX_BROWSER_BACKEND '${requestedBackend}'; expected auto, metal, or swiftshader-vulkan`,
    );
  }
  if (requestedBackend === 'metal' && platform !== 'darwin') {
    throw new Error(
      `FORGEAX_BROWSER_BACKEND=metal requires macOS (platform=${platform}); refusing an implicit backend fallback`,
    );
  }

  const selectedBackend = requestedBackend === 'auto'
    ? (platform === 'darwin' ? 'metal' : 'swiftshader-vulkan')
    : requestedBackend;
  const comparisonMode = selectedBackend === 'metal'
    ? 'browser-metal-vs-dawn-metal'
    : platform === 'darwin'
      ? 'browser-swiftshader-vulkan-vs-dawn-metal'
      : 'browser-swiftshader-vulkan-vs-dawn-default';
  if (selectedBackend === 'metal') {
    return {
      requestedBackend,
      selectedBackend,
      comparisonMode,
      args: [
        ...COMMON_BROWSER_WEBGPU_ARGS,
        '--use-angle=metal',
      ],
    };
  }
  return {
    requestedBackend,
    selectedBackend,
    comparisonMode,
    args: [
      ...COMMON_BROWSER_WEBGPU_ARGS,
      ...(platform === 'win32' ? ['--use-webgpu-adapter=swiftshader'] : [
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
      ]),
    ],
  };
}

/**
 * Classify the backend identity exposed by a browser adapter probe. Chromium
 * does not expose a backend identity on every release, so `unverified` is a
 * first-class result; feature/limit fingerprints are evidence, not proof.
 *
 * @param {{ selectedBackend: 'metal'|'swiftshader-vulkan', adapterInfo?: Record<string, unknown>|null, adapterInfoSource?: string }} input
 * @returns {{ status: 'confirmed'|'unverified'|'mismatch', expectedBackend: 'metal'|'vulkan', observedBackend: string|null, source: string }}
 */
export function classifyBrowserWebGpuAlignment({
  selectedBackend,
  adapterInfo,
  adapterInfoSource = 'unavailable',
}) {
  const expectedBackend = selectedBackend === 'metal' ? 'metal' : 'vulkan';
  const raw = adapterInfo?.backendType;
  const observedBackend = typeof raw === 'string' && raw.trim().length > 0
    ? raw.trim().toLowerCase()
    : null;
  if (observedBackend === null) {
    return { status: 'unverified', expectedBackend, observedBackend, source: adapterInfoSource };
  }
  const backendAliases = expectedBackend === 'metal'
    ? new Set(['metal'])
    : new Set(['vulkan', 'swiftshader-vulkan']);
  return {
    status: backendAliases.has(observedBackend) ? 'confirmed' : 'mismatch',
    expectedBackend,
    observedBackend,
    source: adapterInfoSource,
  };
}

/**
 * Resolve the backend request for the fresh Node Dawn replay. This is kept
 * separate from Browser selection: a macOS SwiftShader negative control still
 * replays against explicitly selected Dawn Metal, while legacy callers keep
 * dawn.node's platform default.
 *
 * @param {{ platform?: string, requestedBackend?: string }} [options]
 * @returns {{ requestedBackend: string, selectedBackend: 'metal'|'dawn-default', args: string[] }}
 */
export function resolveDawnReplaySelection({
  platform = process.platform,
  requestedBackend = 'default',
} = {}) {
  const requested = String(requestedBackend).trim().toLowerCase() || 'default';
  if (requested !== 'default' && requested !== 'metal') {
    throw new Error(`invalid Dawn replay backend '${requested}'; expected default or metal`);
  }
  if (requested === 'metal' && platform !== 'darwin') {
    throw new Error(
      `Dawn replay backend=metal requires macOS (platform=${platform}); refusing an implicit backend fallback`,
    );
  }
  return {
    requestedBackend: requested,
    selectedBackend: requested === 'metal' ? 'metal' : 'dawn-default',
    args: requested === 'metal' ? ['backend=metal'] : [],
  };
}

export class VerifyFailure extends Error {
  /** @param {number} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message);
    this.name = 'VerifyFailure';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** @param {import('playwright').Browser} browser @param {number} [timeoutMs] */
export async function closeBrowserBounded(browser, timeoutMs = 30_000) {
  if (browser === undefined) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(async () => {
        // Release the captured GPU page before browser-level shutdown. The
        // entire cleanup keeps the existing deadline, including page close.
        try {
          for (const context of browser.contexts()) {
            for (const page of context.pages()) await page.close({ runBeforeUnload: false });
          }
        } finally {
          await browser.close();
        }
      }),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(`browser close timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Keep the capture/readback/upload transaction in one page-evaluable function.
 * Pixel mode starts its live snapshot at submit, before capture completion can
 * yield to presentation; the injected operations make that exact production path
 * directly testable without a browser.
 *
 * @param {{
 *   mode: 'pixel'|'structural',
 *   liveHook?: string,
 *   browserReplayHook?: string,
 *   capturePrepareHook?: string,
 *   reportHook?: string,
 *   rawTapeRoute: string,
 *   tapeMime: string,
 * }} input
 * @param {{
 *   prepare?: () => Promise<{preparationMs?: number, completedFrames?: number}>,
 *   capture?: (onSubmitted?: () => void) => Promise<{bytes: Uint8Array}>,
 *   readLive?: () => Promise<{live: string, dims: {width: number, height: number}}>,
 *   replay?: (bytes: Uint8Array) => Promise<{
 *     pixels: Uint8Array,
 *     width: number,
 *     height: number,
 *     workIndex: number,
 *   }>,
 *   upload?: (bytes: Uint8Array) => Promise<{artifact: object, runId?: string}>,
 *   transmissionInspection?: () => unknown,
 * }} [injected]
 */
export async function runCaptureLiveUploadTransaction(input, injected) {
  const {
    mode,
    liveHook,
    browserReplayHook,
    capturePrepareHook,
    reportHook,
    rawTapeRoute,
    tapeMime,
  } = input;
  let preparationMs = 0;
  let completedFrames = 0;

  if (capturePrepareHook !== undefined || injected?.prepare !== undefined) {
    const prepare = injected?.prepare ?? (async () => {
      const fn = globalThis[capturePrepareHook];
      if (typeof fn !== 'function') {
        throw new Error(`capture preparation hook window.${capturePrepareHook} is not a function`);
      }
      const preparationStart = performance.now();
      await fn();
      const frameCount = globalThis.__transmissionFrameCount;
      return {
        preparationMs: performance.now() - preparationStart,
        completedFrames: typeof frameCount === 'number' ? frameCount : 0,
      };
    });
    const prepared = await prepare();
    preparationMs = prepared?.preparationMs ?? 0;
    completedFrames = prepared?.completedFrames ?? 0;
  }

  const readLive = injected?.readLive ?? (async () => {
    const fn = globalThis[liveHook];
    if (typeof fn !== 'function') {
      throw new Error(`live hook window.${liveHook} is not a function`);
    }
    const bytes = await fn();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const canvas = document.querySelector('#app');
    const liveDims = { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
    let binary = '';
    const CHUNK = 0x2000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    }
    return { live: btoa(binary), dims: liveDims };
  });
  const capture = injected?.capture ?? (async (onSubmitted) => {
    const cap = await globalThis.__forgeax.captureFrame(undefined, onSubmitted);
    if (!cap?.ok) throw new Error(`captureFrame failed: ${JSON.stringify(cap?.error)}`);
    return { bytes: cap.value.bytes };
  });
  let pendingLive;
  const onSubmitted = mode !== 'pixel' ? undefined : () => {
    if (pendingLive !== undefined) return;
    // Start the native snapshot while the submitted surface is still valid.
    // Completion may yield to browser presentation and expire that surface.
    pendingLive = (async () => readLive())();
    void pendingLive.catch(() => {});
  };
  const captured = await capture(onSubmitted);

  // Await the submission-time snapshot before replay or upload.
  let live = null;
  let dims = null;
  let browserReplay = null;
  if (mode === 'pixel') {
    if (pendingLive === undefined) throw new Error('Pixel capture did not observe an App submission');
    const readback = await pendingLive;
    live = readback.live;
    dims = readback.dims;
  }

  const runId = `verify-${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`;
  const upload = injected?.upload ?? (async (bytes) => {
    const uploadResponse = await fetch(
      `${location.origin}${rawTapeRoute}?runId=${runId}`,
      {
        method: 'POST',
        headers: { 'content-type': tapeMime },
        // Blob keeps large binary tapes out of Chromium protocol postData.
        body: new Blob([bytes]),
      },
    );
    const artifact = await uploadResponse.json();
    if (!uploadResponse.ok) {
      throw new Error(`raw tape upload failed: ${JSON.stringify(artifact)}`);
    }
    return { artifact, runId };
  });
  // Read a producer-owned report in the same page transaction as capture and
  // live readback. This keeps wrappers from depending on page-console
  // forwarding or a later presentation frame.
  const producerReport = reportHook === undefined
    ? undefined
    : globalThis[reportHook] ?? null;
  const uploaded = await upload(captured.bytes);
  // Persist the canonical bytes before fresh-backend replay can fail.
  if (mode === 'pixel') {
    if (browserReplayHook !== undefined || injected?.replay !== undefined) {
      const replay = injected?.replay ?? (async (bytes) => {
        const fn = globalThis[browserReplayHook];
        if (typeof fn !== 'function') {
          throw new Error(`browser replay hook window.${browserReplayHook} is not a function`);
        }
        return fn(bytes);
      });
      const replayed = await replay(captured.bytes);
      const replayPixels = replayed.pixels instanceof Uint8Array
        ? replayed.pixels
        : new Uint8Array(replayed.pixels);
      let binary = '';
      const CHUNK = 0x2000;
      for (let i = 0; i < replayPixels.length; i += CHUNK) {
        binary += String.fromCharCode(...replayPixels.subarray(i, i + CHUNK));
      }
      browserReplay = {
        pixels: btoa(binary),
        dims: { width: replayed.width, height: replayed.height },
        workIndex: replayed.workIndex,
      };
    }
  }
  const artifact = uploaded?.artifact ?? {};
  const transmissionInspection = injected?.transmissionInspection === undefined
    ? (globalThis.__transmissionInspection ?? null)
    : await injected.transmissionInspection();
  return {
    artifact: { ...artifact, runId: uploaded?.runId ?? runId },
    live,
    dims,
    ...(browserReplay === null ? {} : { browserReplay }),
    ...(reportHook === undefined ? {} : { producerReport }),
    preparationMs,
    completedFrames,
    transmissionInspection,
  };
}

/**
 * @typedef {Object} VerifyOptions
 * @property {string} pkg           pnpm package name, e.g. '@forgeax/learn-render-2-1-colors'
 * @property {string} label         human label for log lines
 * @property {'pixel'|'structural'} mode
 * @property {string} [liveHook]    readback-only window fn name returning live
 *                                  RGBA Uint8Array (pixel mode only); it must
 *                                  not update, draw, or wait for another rAF.
 *                                  e.g. '__captureColors'.
 * @property {string} [browserReplayHook] window fn accepting the captured tape
 *                                  bytes and returning fresh browser replay
 *                                  RGBA pixels plus dimensions/workIndex.
 * @property {'node-dawn'|'browser-fresh'} [pixelVerdictOwner] owner of the
 *                                  strict pixel thresholds (default node-dawn);
 *                                  browser-fresh requires browserReplayHook.
 * @property {string} [capturePrepareHook] window fn name awaited immediately
 *                                  before captureFrame arms/snapshots the tape.
 * @property {string} [reportHook] optional window global name whose producer
 *                                  report is returned with the capture.
 * @property {number} [workIndex]   Explicit work ordinal; structural defaults to the first color-attachment work, pixel mode to the last swapchain writer (or last work for offscreen-only tapes)
 * @property {number} [epsilon]     max whole-frame RGB pixel delta (default 0.02)
 * @property {number} [maxChannelEpsilon] max RGB-channel abs delta over any pixel (default 0.10)
 * @property {number} [coveredEpsilon]    max mean RGB delta over non-background pixels (default 0.03)
 * @property {boolean} [allowEmptyFrame]  permit an intentional all-black pixel falsifier
 * @property {(report: object) => void} [assertCapture] extra report-level contract gate
 * @property {(input: {tape: object}) => void} [assertTape] extra contract over the
 *                                  deserialized self-contained capture tape
 * @property {(input: {pixels: Uint8Array, width: number, height: number}) => void} [assertPixels]
 *                                  extra contract over the live RGBA frame
 * @property {string} [appDir]      the demo's own dir (dirname of its smoke script's parent);
 *                                  the dev endpoint writes .forgeax-debug relative to vite cwd
 *                                  (= the package dir), so artifacts are resolved against this.
 * @property {boolean} [waitForPackIndex] wait for a Pack dev session to publish its
 *                                  catalog before navigating (useful for image-heavy demos)
 * @property {number} [packReadinessTimeoutMs] bounded Pack catalog startup wait
 * @property {number} [warmupMs]    rAF warmup before capture (default 3000)
 * @property {number} [hookReadyTimeoutMs] bounded wait for declared capture hooks (default 90000)
 * @property {'networkidle'|'domcontentloaded'} [navigationWaitUntil] page navigation
 *                                  readiness policy (default 'networkidle')
 * @property {string} [urlSuffix]   query/hash suffix appended to the dev URL
 */

/** Select the displayed attachment from recorded resource provenance, not pass order. */
export function selectCaptureWorkIndex(model, mode, workIndex) {
  if (typeof workIndex === 'number') return workIndex;
  if (mode === 'structural') {
    return model.works.find((work) => (work.attachments?.colorViewHandleIds.length ?? 0) > 0)?.workIndex;
  }
  const swapchainTextures = new Set(model.resources
    .filter((resource) => resource.descriptor?.kind === 'createTexture' && resource.descriptor.origin === 'swapchain')
    .map((resource) => resource.resourceId));
  const swapchainViews = new Set(model.resources
    .filter((resource) => resource.descriptor?.kind === 'createTextureView' && swapchainTextures.has(resource.descriptor.sourceHandleId))
    .map((resource) => resource.resourceId));
  return model.works.findLast((work) => work.attachments?.colorViewHandleIds.some((id) => swapchainViews.has(id)))?.workIndex
    ?? model.works.at(-1)?.workIndex;
}

/**
 * Vite can publish its Local URL before the Pack watcher has accepted its first
 * catalog generation. A browser navigation during that interval receives the
 * intentionally fail-closed 503 from the Pack middleware, and the app records
 * a misleading asset bootstrap failure. Probe the optional route once before
 * navigation so captured demos start from a stable producer generation. A 404
 * means the demo has no Pack route and is allowed to continue.
 *
 * @param {string} portUrl
 * @param {number} timeoutMs
 * @returns {Promise<{kind: 'ready'|'absent', elapsedMs: number, status: number}>}
 */
async function awaitPackIndex(portUrl, timeoutMs) {
  const startedAt = Date.now();
  const packUrl = new URL('/pack-index.json', portUrl).toString();
  let lastStatus = 0;
  let lastBody = '';
  let lastError = '';
  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), Math.min(5000, timeoutMs));
    try {
      const response = await fetch(packUrl, { signal: controller.signal });
      const body = await response.text();
      lastStatus = response.status;
      lastBody = body.slice(0, 300);
      if (response.status === 404) {
        return { kind: 'absent', elapsedMs: Date.now() - startedAt, status: response.status };
      }
      if (response.status === 200) {
        try {
          JSON.parse(body);
        } catch {
          throw new VerifyFailure(
            2,
            `Pack catalog returned non-JSON content at ${packUrl}: ${JSON.stringify(lastBody)}`,
          );
        }
        return { kind: 'ready', elapsedMs: Date.now() - startedAt, status: response.status };
      }
      if (response.status !== 503) {
        throw new VerifyFailure(
          2,
          `Pack catalog returned HTTP ${response.status} at ${packUrl}: ${JSON.stringify(lastBody)}`,
        );
      }
    } catch (error) {
      if (error instanceof VerifyFailure) throw error;
      lastError = error?.message ?? String(error);
    } finally {
      clearTimeout(abortTimer);
    }
    await sleep(200);
  }
  throw new VerifyFailure(
    2,
    `Pack catalog did not become ready within ${timeoutMs}ms at ${packUrl}: ` +
      JSON.stringify({ lastStatus, lastBody, lastError }),
  );
}

/** @param {VerifyOptions} opts */
export async function verifyDemoCapture(opts) {
  const {
    pkg,
    label,
    mode,
    liveHook,
    browserReplayHook,
    capturePrepareHook,
    reportHook,
    pixelVerdictOwner = 'node-dawn',
    workIndex,
    epsilon = 0.02,
    maxChannelEpsilon = 0.1,
    coveredEpsilon = 0.03,
    allowEmptyFrame = false,
    assertCapture,
    assertTape,
    assertPixels,
    appDir = REPO_ROOT,
    waitForPackIndex = false,
    packReadinessTimeoutMs = VITE_READINESS_TIMEOUT_MS,
    warmupMs = 3000,
    hookReadyTimeoutMs = 90000,
    navigationWaitUntil = 'networkidle',
    urlSuffix = '',
  } = opts;

  if (mode === 'pixel' && !liveHook) {
    fail(2, `[${label}] pixel mode requires a liveHook (window fn returning live RGBA)`);
  }
  if (pixelVerdictOwner !== 'node-dawn' && pixelVerdictOwner !== 'browser-fresh') {
    fail(2, `[${label}] invalid pixelVerdictOwner '${pixelVerdictOwner}'`);
  }
  if (mode === 'pixel' && pixelVerdictOwner === 'browser-fresh' && !browserReplayHook) {
    fail(
      2,
      `[${label}] browser-fresh pixelVerdictOwner requires a browserReplayHook; ` +
        `never fall back to Node Dawn or live pixels`,
    );
  }

  let browserLaunch;
  try {
    browserLaunch = resolveBrowserWebGpuLaunch();
  } catch (error) {
    fail(2, `[${label}] browser WebGPU backend setup failed: ${error?.message ?? error}`);
  }

  // --- 1. spawn vite dev with the capture flag --------------------------------
  const [manager, ...managerArgs] = pnpmCommand();
  const viteProc = spawn(manager, [...managerArgs, '-F', pkg, 'dev'], {
    cwd: REPO_ROOT,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
  });
  const stopVite = createOwnedProcessGroupStopper(viteProc);
  let portUrl = null;
  let viteOutput = '';
  let viteSpawnError;
  let viteExit;
  const observeViteOutput = (stream, chunk) => {
    const text = chunk.toString();
    viteOutput = `${viteOutput}${text}`.slice(-8192);
    process[stream === 'stdout' ? 'stdout' : 'stderr'].write(`[vite${stream === 'stderr' ? '-err' : ''}] ${text}`);
    // Vite emits ANSI color/style sequences around both the Local label and
    // the URL. Strip them before parsing so readiness does not depend on the
    // terminal formatter or runner output mode.
    const plain = viteOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    const m = plain.match(/Local:\s+(https?:\/\/[^\s]+)/);
    if (m) portUrl = m[1];
  };
  viteProc.stdout.on('data', (chunk) => {
    observeViteOutput('stdout', chunk);
  });
  viteProc.stderr.on('data', (chunk) => observeViteOutput('stderr', chunk));
  viteProc.once('error', (error) => { viteSpawnError = error; });
  viteProc.once('exit', (code, signal) => { viteExit = { code, signal }; });

  const viteDiagnostics = (elapsedMs) => ({
    elapsedMs,
    pid: viteProc.pid ?? null,
    spawnError: viteSpawnError === undefined ? null : String(viteSpawnError),
    exit: viteExit ?? null,
    output: viteOutput.trim() || 'none',
  });

  let browser;
  let page;
  let collectPageDiagnostics;
  let captured;
  let livePixelsB64 = null;
  let liveDims = null;
  let browserReplay;
  let producerReport;
  let browserWebGpuReport;
  let ownedFailure;
  let cleanupFailure;

  try {
    const readinessStartedAt = Date.now();
    while (
      !portUrl
      && viteSpawnError === undefined
      && viteExit === undefined
      && Date.now() - readinessStartedAt < VITE_READINESS_TIMEOUT_MS
    ) await sleep(200);
    const elapsedMs = Date.now() - readinessStartedAt;
    if (viteSpawnError !== undefined) {
      throw new VerifyFailure(
        2,
        `[${label}] vite failed to spawn: ${JSON.stringify(viteDiagnostics(elapsedMs))}`,
        viteSpawnError,
      );
    }
    if (viteExit !== undefined && !portUrl) {
      throw new VerifyFailure(
        2,
        `[${label}] vite exited before becoming ready: ${JSON.stringify(viteDiagnostics(elapsedMs))}`,
      );
    }
    if (!portUrl) {
      throw new VerifyFailure(
        2,
        `[${label}] vite did not become ready within ${VITE_READINESS_TIMEOUT_MS}ms: ${JSON.stringify(viteDiagnostics(elapsedMs))}`,
      );
    }
    console.log(`[${label}] dev server: ${portUrl}`);
    if (waitForPackIndex) {
      const packReadiness = await awaitPackIndex(portUrl, packReadinessTimeoutMs);
      console.log(
        `[${label}] pack catalog=${packReadiness.kind} ` +
          `status=${packReadiness.status} wait=${packReadiness.elapsedMs}ms`,
      );
    }

    // --- 2. launch headless Chrome with WebGPU ----------------------------------
  try {
    const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunchConfig.channel;
    const browserHeadless = !['0', 'false'].includes(
      (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
    );
    browser = await chromium.launch({
      headless: browserHeadless,
      ...(chromeChannel === undefined ? {} : { channel: chromeChannel }),
      args: browserLaunch.args,
      chromiumSandbox: true,
    });
    console.log(
      `[${label}] browser launch channel=${chromeChannel ?? 'default'} headless=${browserHeadless} ` +
        `requestedBackend=${browserLaunch.requestedBackend} selectedBackend=${browserLaunch.selectedBackend} ` +
        `comparisonMode=${browserLaunch.comparisonMode} args=${JSON.stringify(browserLaunch.args)}`,
    );
  } catch (e) {
      throw new VerifyFailure(2, `[${label}] could not launch Chrome with WebGPU: ${e?.message ?? e}`);
  }

  page = await (await browser.newContext()).newPage();
  const errors = [];
  const warnings = [];
  const networkDiagnostics = [];
  const requestStartedAt = new Map();
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`CONSOLE-${msg.type().toUpperCase()}: ${msg.text()}`);
    } else if (msg.type() === 'warning') {
      // Browser warnings are useful evidence but are not a deterministic
      // product failure. Keep them visible in diagnostics without making
      // every Chromium/WebGPU warning fail an otherwise valid capture.
      warnings.push(`CONSOLE-${msg.type().toUpperCase()}: ${msg.text()}`);
    }
  });
  page.on('request', (request) => {
    if (
      request.url().includes('/shaders/manifest.json') ||
      request.url().includes('/pack-index.json') ||
      request.url().includes('/__pack/') ||
      request.url().includes('/__import/')
    ) {
      requestStartedAt.set(request, Date.now());
      networkDiagnostics.push({ kind: 'request.start', url: request.url() });
    }
  });
  page.on('requestfailed', (request) => {
    errors.push(
      `REQUESTFAILED: ${request.url()} ${request.failure()?.errorText ?? 'unknown request failure'}`,
    );
  });
  page.on('response', (response) => {
    if (requestStartedAt.has(response.request())) {
      const request = response.request();
      networkDiagnostics.push({
        kind: 'response',
        url: response.url(),
        status: response.status(),
        elapsedMs: requestStartedAt.has(request) ? Date.now() - requestStartedAt.get(request) : null,
      });
      requestStartedAt.delete(request);
    }
    if (response.status() >= 400) {
      errors.push(`RESPONSE-${response.status()}: ${response.url()}`);
    }
  });
  page.on('crash', () => errors.push('PAGE-CRASHED'));
  page.on('close', () => errors.push('PAGE-CLOSED'));
  browser.on('disconnected', () => errors.push('BROWSER-DISCONNECTED'));

  const requiredHooks = [capturePrepareHook, liveHook, browserReplayHook].filter(
    (hook) => typeof hook === 'string',
  );
  const pageBootstrapDiagnostics = async () => {
    try {
      return await page.evaluate((hooks) => ({
        documentReadyState: document.readyState,
        hasGpu: navigator.gpu !== undefined,
        captureFrame: typeof globalThis.__forgeax?.captureFrame === 'function',
        bootstrapStage: globalThis.__forgeaxBootstrapStage ?? null,
        bootstrapFailure: globalThis.__forgeaxBootstrapFailure ?? null,
        rendererBootstrap: globalThis.__forgeaxRendererBootstrap ?? null,
        shaderManifest: globalThis.__forgeaxShaderManifest ?? null,
        captureHooks: Object.fromEntries(
          hooks.map((hook) => [hook, typeof globalThis[hook] === 'function']),
        ),
      }), requiredHooks);
    } catch (error) {
      return { evaluateError: error?.message ?? String(error) };
    }
  };
  collectPageDiagnostics = async () => {
    const diagnostics = await pageBootstrapDiagnostics();
    const errorSnapshot = [...errors];
    const warningSnapshot = [...warnings];
    let screenshotPath;
    try {
      const diagnosticDir = resolve(appDir, '.forgeax-debug');
      mkdirSync(diagnosticDir, { recursive: true });
      screenshotPath = resolve(diagnosticDir, `bootstrap-failure-${Date.now()}.png`);
      // Screenshot is supplementary evidence only. Do not let Playwright's
      // font readiness wait add another 30s to a bounded bootstrap failure.
      await page.screenshot({ path: screenshotPath, timeout: 5000 });
    } catch (error) {
      screenshotPath = `unavailable: ${error?.message ?? error}`;
    }
    return {
      ...diagnostics,
      errors: errorSnapshot,
      warnings: warningSnapshot,
      networkDiagnostics,
      screenshotPath,
    };
  };

  const captureUrl = urlSuffix.length === 0 ? portUrl : new URL(urlSuffix, portUrl).toString();
  // Vite's HTTP-ready response can precede a large cooked shader transform.
  // Runtime admission below owns the separate hook deadline.
  await page.goto(captureUrl, { waitUntil: navigationWaitUntil, timeout: 120_000 });
  await page.waitForTimeout(warmupMs);

  const hasCapture = await page.waitForFunction(
    () => typeof globalThis.__forgeax?.captureFrame === 'function',
    undefined,
    { timeout: hookReadyTimeoutMs },
  ).then(() => true, () => false);
  if (!hasCapture) {
    const diagnostics = await collectPageDiagnostics();
    throw new VerifyFailure(
      1,
      `[${label}] RED -- window.__forgeax.captureFrame missing. Suspect: demo did not ` +
        `bootstrap via createApp, or FORGEAX_ENGINE_RHI_DEBUG=1 did not reach the create-app guard; ` +
        `diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }
  const hasGpu = await page.evaluate(() => navigator.gpu !== undefined);
  if (!hasGpu) {
    throw new VerifyFailure(2, `[${label}] ENVIRONMENT_BLOCKED -- Chromium has no navigator.gpu`);
  }
  try {
    browserWebGpuReport = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter === null) {
        return { available: false, reason: 'requestAdapter returned null' };
      }
      let adapterInfo = null;
      let adapterInfoSource = 'unavailable';
      let adapterInfoError = null;
      let rawInfo;
      try {
        rawInfo = adapter.info;
      } catch (error) {
        adapterInfoError = error?.message ?? String(error);
      }
      if (rawInfo !== undefined && rawInfo !== null) {
        adapterInfoSource = 'GPUAdapter.info';
      } else if (typeof adapter.requestAdapterInfo === 'function') {
        try {
          rawInfo = await adapter.requestAdapterInfo();
          if (rawInfo !== undefined && rawInfo !== null) {
            adapterInfoSource = 'GPUAdapter.requestAdapterInfo';
          }
        } catch (error) {
          adapterInfoError = error?.message ?? String(error);
        }
      }
      if (rawInfo !== undefined && rawInfo !== null) {
        const fields = [
          'backendType',
          'vendor',
          'architecture',
          'device',
          'description',
          'runtimeService',
          'isFallbackAdapter',
          'subgroupMinSize',
          'subgroupMaxSize',
        ];
        adapterInfo = {};
        for (const field of fields) {
          try {
            const value = rawInfo[field];
            if (value !== undefined) adapterInfo[field] = value;
          } catch {
            // Keep the projection bounded when a browser exposes a throwing getter.
          }
        }
      }
      return {
        available: true,
        adapterInfo,
        adapterInfoSource,
        adapterInfoError,
        features: [...adapter.features].sort(),
        limits: {
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxBindGroups: adapter.limits.maxBindGroups,
          maxUniformBufferBindingSize: adapter.limits.maxUniformBufferBindingSize,
        },
        isFallbackAdapter: adapter.isFallbackAdapter ?? null,
      };
    });
  } catch (error) {
    throw new VerifyFailure(
      2,
      `[${label}] browser WebGPU adapter probe failed: ${error?.message ?? error}`,
      error,
    );
  }
  const browserAlignment = classifyBrowserWebGpuAlignment({
    selectedBackend: browserLaunch.selectedBackend,
    adapterInfo: browserWebGpuReport.adapterInfo,
    adapterInfoSource: browserWebGpuReport.adapterInfoSource,
  });
  browserWebGpuReport = {
    ...browserWebGpuReport,
    identityScope: 'independent-probe',
    carrierIdentity: 'unknown/unverified',
    alignment: browserAlignment,
  };
  console.log(
    `[${label}] browser WebGPU adapter probe (not carrier identity): ${JSON.stringify({
      requestedBackend: browserLaunch.requestedBackend,
      selectedBackend: browserLaunch.selectedBackend,
      comparisonMode: browserLaunch.comparisonMode,
      ...browserWebGpuReport,
    })}`,
  );
  if (!browserWebGpuReport.available) {
    throw new VerifyFailure(
      2,
      `[${label}] browser WebGPU backend setup failed: ${browserWebGpuReport.reason}`,
    );
  }
  if (browserAlignment.status === 'mismatch') {
    throw new VerifyFailure(
      2,
      `[${label}] browser WebGPU backend alignment mismatch: expected ${browserAlignment.expectedBackend}, ` +
        `observed ${browserAlignment.observedBackend} from ${browserAlignment.source}`,
    );
  }
  if (browserLaunch.requestedBackend === 'metal' && browserAlignment.status !== 'confirmed') {
    throw new VerifyFailure(
      2,
      `[${label}] explicit Metal backend alignment is ${browserAlignment.status}; ` +
        `the carrier adapter identity is not confirmed by the browser API`,
    );
  }
  if (requiredHooks.length > 0) {
    try {
      await page.waitForFunction(
        (hooks) => hooks.every((hook) => typeof globalThis[hook] === 'function'),
        requiredHooks,
        { timeout: hookReadyTimeoutMs },
      );
    } catch (e) {
      const diagnostics = await collectPageDiagnostics();
      throw new VerifyFailure(
        1,
        `[${label}] RED -- capture hook readiness timed out after ${hookReadyTimeoutMs}ms: ` +
          `${requiredHooks.join(', ')}; diagnostics=${JSON.stringify(diagnostics)}`,
      );
    }
  }

  // --- 3. capture the frame (and, in pixel mode, the live pixels) -------------
  // Critical for pixel mode: take the live readback in the SAME page.evaluate
  // transaction immediately after captureFrame resolves, before tape upload can
  // yield to another rAF, so both images describe the same GPU state.
  try {
    const result = await page.evaluate(runCaptureLiveUploadTransaction, {
      mode,
      liveHook,
      browserReplayHook,
      capturePrepareHook,
      reportHook,
      rawTapeRoute: RAW_TAPE_ROUTE,
      tapeMime: RHITAPE_MIME,
    });
    captured = result.artifact;
    livePixelsB64 = result.live;
    liveDims = result.dims;
    browserReplay = result.browserReplay;
    producerReport = result.producerReport;
    captured.preparationMs = result.preparationMs;
    captured.completedFrames = result.completedFrames;
    captured.transmissionInspection = result.transmissionInspection;
  } catch (e) {
    const diagnostics = await collectPageDiagnostics();
    throw new VerifyFailure(
      1,
      `[${label}] RED -- capture/live-readback threw: ${e?.message ?? e}; ` +
        `diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }

  console.log(`[${label}] captureFrame result: ${JSON.stringify(captured)}`);
  if (errors.length) {
    throw new VerifyFailure(1, `[${label}] RED -- browser errors during capture: ${errors.slice(0, 8).join('\n')}`);
  }
  if (warnings.length) {
    console.log(`[${label}] browser warnings during capture:`);
    warnings.slice(0, 8).forEach((warning) => console.log(`  ${warning}`));
  }

  } catch (error) {
    if (error instanceof VerifyFailure) {
      ownedFailure = error;
    } else {
      let diagnostics = '';
      if (collectPageDiagnostics !== undefined) {
        try {
          diagnostics = `; diagnostics=${JSON.stringify(await collectPageDiagnostics())}`;
        } catch (diagnosticError) {
          diagnostics = `; diagnostics unavailable: ${diagnosticError?.message ?? diagnosticError}`;
        }
      }
      ownedFailure = new VerifyFailure(
        2,
        `[${label}] harness exception: ${error?.message ?? error}${diagnostics}`,
        error,
      );
    }
  } finally {
    try {
      await closeBrowserBounded(browser);
    } catch (error) {
      cleanupFailure = new Error(`browser cleanup failed: ${error?.message ?? error}`);
    } finally {
      try {
        await stopVite();
      } catch (error) {
        const detail = `Vite cleanup failed: ${error?.message ?? error}`;
        cleanupFailure = cleanupFailure === undefined
          ? new Error(detail)
          : new Error(`${cleanupFailure.message}; ${detail}`);
      }
    }
  }

  if (ownedFailure !== undefined || cleanupFailure !== undefined) {
    const code = ownedFailure?.code ?? 2;
    const message = ownedFailure?.message ?? `[${label}] owned resource cleanup failed`;
    const cleanupDetail = cleanupFailure === undefined ? '' : `; ${cleanupFailure.message}`;
    fail(code, `${message}${cleanupDetail}`);
  }
  await sleep(500);

  // --- 4. validate the single raw artifact and strict-decode it ----------------
  const missing = ['runId', 'kind', 'digest', 'path'].filter(
    (k) => typeof captured?.[k] !== 'string' || captured[k].length === 0,
  );
  if (missing.length) {
    fail(1, `[${label}] RED -- captureFrame missing field(s): ${missing.join(', ')}`);
  }

  const resolveArtifact = (rel) => {
    const inApp = resolve(appDir, rel);
    if (existsSync(inApp)) return inApp;
    return resolve(REPO_ROOT, rel);
  };
  const tapeAbs = resolveArtifact(captured.path);
  if (!existsSync(tapeAbs)) {
    fail(1, `[${label}] RED -- raw .rhitape path missing on disk: ${tapeAbs}`);
  }
  if (captured.kind !== 'rhi-tape') {
    fail(1, `[${label}] RED -- raw artifact kind is not rhi-tape: ${captured.kind}`);
  }
  const tapeBlob = new Uint8Array(readFileSync(tapeAbs));
  const digest = `sha256:${createHash('sha256').update(tapeBlob).digest('hex')}`;
  if (captured.digest !== digest) {
    fail(1, `[${label}] RED -- raw artifact digest mismatch: ${captured.digest} != ${digest}`);
  }
  const decoded = decodeTape(tapeBlob);
  if (!decoded.ok) {
    fail(
      1,
      `[${label}] RED -- strict v7 decode failed: ${decoded.error.code} ` +
        `hint=${JSON.stringify(decoded.error.hint)}. Suspect: raw artifact corruption or non-v7 payload.`,
    );
  }
  const tape = decoded.value;
  const model = buildFrameModel(tape);
  if (model.works.length === 0) {
    fail(1, `[${label}] RED -- decoded tape has no workIndex entries`);
  }
  const selectedWorkIndex = selectCaptureWorkIndex(model, mode, workIndex);
  if (selectedWorkIndex === undefined) {
    fail(1, `[${label}] RED -- decoded tape has no eligible attachment-bearing work`);
  }
  if (assertCapture !== undefined) {
    try {
      assertCapture({
        header: tape.header,
        bootstrap: tape.bootstrap,
        events: tape.events,
        blobs: tape.blobs,
      });
    } catch (e) {
      fail(1, `[${label}] RED -- capture contract failed: ${e?.message ?? e}`);
    }
  }

  // --- 5. strict-decoded artifact -> fresh Dawn replay ------------------------
  if (assertTape !== undefined) {
    try {
      assertTape({
        tape: {
          ...tape,
          bootstrap: tape.bootstrap,
          blobPool: new Map(tape.blobs.map((blob) => [blob.hash, blob.bytes])),
        },
      });
    } catch (e) {
      fail(1, `[${label}] RED -- tape contract failed: ${e?.message ?? e}`);
    }
  }
  const dawnSelection = process.platform === 'darwin' ? { backend: 'metal' } : {};
  const { freshDevice, rhiWebgpu, backend: dawnBackend, dispose } = await bootstrapDawn(
    label,
    tape,
    dawnSelection,
  );
  console.log(`[${label}] tape: ${tape.events.length} events, ${tape.blobs.length} blobs`);

  let replay;
  let work;
  try {
    const { openReplay } = await import('@forgeax/engine-rhi-debug');
    const replayRes = await openReplay(tape, {
      device: freshDevice,
      createShaderModule: rhiWebgpu.createShaderModule,
    });
    if (!replayRes.ok) {
      fail(1, `[${label}] RED -- openReplay failed: ${replayRes.error.code} hint=${JSON.stringify(replayRes.error.hint)}`);
    }
    replay = replayRes.value;
    const workRes = await replay.inspectWork(selectedWorkIndex, ['pixels']);
    if (!workRes.ok) {
      fail(1, `[${label}] RED -- inspectWork(${selectedWorkIndex}) failed: ${workRes.error.code} hint=${JSON.stringify(workRes.error.hint)}`);
    }
    work = workRes.value;
  } finally {
    try {
      if (replay !== undefined) {
        const disposed = await replay.dispose();
        if (!disposed.ok) {
          fail(1, `[${label}] RED -- replay disposal failed: ${disposed.error.code} hint=${JSON.stringify(disposed.error.hint)}`);
        }
      }
    } finally {
      // RhiDevice has no destroy(): its adapter owns the native device and
      // pipeline-library lifetime, including Dawn's device-lost callback.
      await dispose();
    }
  }

  if (mode === 'structural') {
    await assertStructural({ label, tape, work });
    green(label, `structural -- capture+replay+inspect workIndex=${work.workIndex} (runId=${captured.runId})`);
    return {
      runId: captured.runId,
      preparationMs: captured.preparationMs,
      submittedFrames: captured.completedFrames,
      transmissionInspection: captured.transmissionInspection,
      ...(producerReport === undefined ? {} : { producerReport }),
      backend: {
        browser: { ...browserLaunch, adapterProbe: browserWebGpuReport },
        dawn: dawnBackend,
      },
    };
  }

  // --- 6. pixel comparison (static demos) -------------------------------------
  const rtRes = work.attachment;
  if (rtRes === undefined || rtRes.kind !== 'texture' || rtRes.width === undefined || rtRes.height === undefined) {
    fail(1, `[${label}] RED -- replayed work attachment readback is unavailable`);
  }
  const replayPixels = rtRes.bytes;
  const rw = rtRes.width;
  const rh = rtRes.height;

  const livePixels = Uint8Array.from(Buffer.from(livePixelsB64, 'base64'));
  if (livePixels.length !== replayPixels.length) {
    fail(
      1,
      `[${label}] RED -- pixel buffer size mismatch: live=${livePixels.length} ` +
        `(${liveDims?.width}x${liveDims?.height}) replay=${replayPixels.length} (${rw}x${rh}). ` +
        `Suspect: RT size disagreement between live canvas and replayed attachment.`,
    );
  }

  let browserReplayPixels;
  let browserReplayBest;
  let browserReplayLocal;
  if (browserReplay !== undefined) {
    if (browserReplay.workIndex !== selectedWorkIndex) {
      fail(
        1,
        `[${label}] RED -- browser replay selected workIndex ${browserReplay.workIndex} ` +
          `but Node replay selected ${selectedWorkIndex}`,
      );
    }
    if (
      browserReplay.dims.width !== rw ||
      browserReplay.dims.height !== rh
    ) {
      fail(
        1,
        `[${label}] RED -- browser replay dimensions ${browserReplay.dims.width}x${browserReplay.dims.height} ` +
          `do not match Node replay ${rw}x${rh}`,
      );
    }
    browserReplayPixels = Uint8Array.from(Buffer.from(browserReplay.pixels, 'base64'));
    if (browserReplayPixels.length !== replayPixels.length) {
      fail(
        1,
        `[${label}] RED -- browser replay pixel buffer size ${browserReplayPixels.length} ` +
          `does not match Node replay ${replayPixels.length}`,
      );
    }
    browserReplayBest = bestAlignmentDelta(livePixels, browserReplayPixels, rw, rh, normalizedRgbDelta);
    browserReplayLocal = localMetrics(
      livePixels,
      browserReplayBest.applied,
      rw,
      maxChannelEpsilon,
    );
    console.log(
      `[${label}] browser fresh pixel delta: mean=${browserReplayBest.delta.toFixed(5)} ` +
        `via '${browserReplayBest.name}' ` +
        `(identity=${browserReplayBest.all.identity.toFixed(5)} ` +
        `yflip=${browserReplayBest.all.yflip.toFixed(5)} ` +
        `bgra=${browserReplayBest.all.bgra.toFixed(5)} ` +
        `both=${browserReplayBest.all.both.toFixed(5)})`,
    );
    console.log(
      `[${label}] browser fresh localized: maxChannelDelta=${browserReplayLocal.maxDelta.toFixed(5)} ` +
        `coveredMean=${browserReplayLocal.coveredMean.toFixed(5)} ` +
        `(over ${browserReplayLocal.coveredFrac.toFixed(3)} non-bg coverage) ` +
        `maxWitness=${JSON.stringify(browserReplayLocal.maxWitness)} ` +
        `overChannelEpsilonCount=${browserReplayLocal.overChannelEpsilonCount} ` +
        `overChannelEpsilonBbox=${JSON.stringify(browserReplayLocal.overChannelEpsilonBbox)}`,
    );
  }

  if (assertPixels !== undefined) {
    try {
      assertPixels({ pixels: livePixels, width: rw, height: rh });
    } catch (e) {
      fail(1, `[${label}] RED -- live pixel contract failed: ${e?.message ?? e}`);
    }
  }

  // Empty-frame guard (empty-vs-empty trap): if the LIVE frame is essentially
  // all-black the demo did not actually render before capture -- IBL/HDR prewarm
  // still running, an async asset not yet loaded, or capture racing ahead of the
  // first real draw. Comparing two black frames yields delta 0 and a false GREEN.
  // A pixel-mode demo must produce visible output; require a minimum lit
  // coverage. (Demos that legitimately render near-black are not pixel-mode
  // candidates.) Reuse localMetrics' background test via a quick coverage scan.
  const liveCoverage = litCoverage(livePixels);
  if (!allowEmptyFrame && liveCoverage < 0.001) {
    fail(
      1,
      `[${label}] RED -- live frame is ~all-black (lit coverage ${liveCoverage.toFixed(4)}). ` +
        `The demo did not render before capture (IBL/HDR prewarm or async asset not ready, ` +
        `or capture raced the first draw). Increase warmupMs, or if the demo is genuinely ` +
        `slow to first-paint, gate it structurally instead of pixel.`,
    );
  }

  const best = bestAlignmentDelta(livePixels, replayPixels, rw, rh, normalizedRgbDelta);

  // Whole-frame mean alone is too lenient: a demo whose subject covers a small
  // fraction of a mostly-black frame can hide a large per-pixel error in the
  // subject under a tiny mean (the sRGB gap read 0.046 mean while the cube was
  // visibly ~2.7x too dark). Also compute the worst single-channel delta and the
  // mean restricted to non-background pixels, on the best-aligned buffer, and
  // gate on all three so a localized fidelity break cannot pass.
  const local = localMetrics(livePixels, best.applied, rw, maxChannelEpsilon);

  console.log(
    `[${label}] pixel delta: mean=${best.delta.toFixed(5)} via '${best.name}' ` +
      `(identity=${best.all.identity.toFixed(5)} yflip=${best.all.yflip.toFixed(5)} ` +
      `bgra=${best.all.bgra.toFixed(5)} both=${best.all.both.toFixed(5)})`,
  );
  console.log(
    `[${label}] localized: maxChannelDelta=${local.maxDelta.toFixed(5)} ` +
      `coveredMean=${local.coveredMean.toFixed(5)} (over ${local.coveredFrac.toFixed(3)} non-bg coverage) ` +
      `maxWitness=${JSON.stringify(local.maxWitness)} ` +
      `overChannelEpsilonCount=${local.overChannelEpsilonCount} ` +
      `overChannelEpsilonBbox=${JSON.stringify(local.overChannelEpsilonBbox)}`,
  );

  // Dump live / replay / side-by-side PNGs so a human can eyeball "replay ==
  // demo". The replay buffer is written under its best-fit alignment so the two
  // panes are directly comparable (any residual gap is real fidelity, not a flip
  // or channel-order artefact). Written next to the tape under .forgeax-debug.
  const pngDir = dirname(tapeAbs);
  const replayAligned = best.applied;
  try {
    writeFileSync(resolve(pngDir, 'live.png'), writeReferencePng(livePixels, rw, rh));
    writeFileSync(resolve(pngDir, 'replay.png'), writeReferencePng(replayAligned, rw, rh));
    const sbs = sideBySide(livePixels, replayAligned, rw, rh);
    writeFileSync(resolve(pngDir, 'compare.png'), writeReferencePng(sbs.pixels, sbs.width, sbs.height));
    console.log(
      `[${label}] wrote PNGs: ${resolve(pngDir, 'compare.png')} ` +
        `(left=live demo, right=Node Dawn replay diagnostic)`,
    );
  } catch (e) {
    console.log(`[${label}] (non-fatal) PNG dump skipped: ${e?.message ?? e}`);
  }

  const verdict = evaluatePixelVerdict({
    owner: pixelVerdictOwner,
    nodeDawn: { best, local },
    browserFresh: browserReplayBest === undefined || browserReplayLocal === undefined
      ? undefined
      : { best: browserReplayBest, local: browserReplayLocal },
    epsilon,
    maxChannelEpsilon,
    coveredEpsilon,
  });
  const verdictBest = verdict.selected.best;
  const verdictLocal = verdict.selected.local;
  console.log(`[${label}] pixel verdict owner: ${verdict.owner}`);
  if (verdict.failures.length) {
    fail(
      1,
      `[${label}] RED -- ${verdict.owner} replay does NOT match the live demo render: ` +
        `${verdict.failures.join('; ')} (best alignment '${verdictBest.name}'). ` +
        `Node Dawn remains mandatory evidence; ` +
        `inspect .forgeax-debug/${captured.runId}/compare.png.`,
    );
  }
  green(
    label,
    `pixel[${verdict.owner}] -- mean ${verdictBest.delta.toFixed(5)}<=${epsilon}, ` +
      `maxChannel ${verdictLocal.maxDelta.toFixed(5)}<=${maxChannelEpsilon}, ` +
      `coveredMean ${verdictLocal.coveredMean.toFixed(5)}<=${coveredEpsilon} via '${verdictBest.name}' ` +
    `(${rw}x${rh}, runId=${captured.runId})`,
  );
  return {
    runId: captured.runId,
    width: rw,
    height: rh,
    preparationMs: captured.preparationMs,
    submittedFrames: captured.completedFrames,
    transmissionInspection: captured.transmissionInspection,
    backend: {
      browser: { ...browserLaunch, adapterProbe: browserWebGpuReport },
      dawn: dawnBackend,
    },
    ...(producerReport === undefined ? {} : { producerReport }),
    pixel: {
      owner: verdict.owner,
      mean: verdictBest.delta,
      maxChannelDelta: verdictLocal.maxDelta,
      coveredMean: verdictLocal.coveredMean,
      nodeDawn: {
        mean: best.delta,
        maxChannelDelta: local.maxDelta,
        coveredMean: local.coveredMean,
      },
      ...(browserReplayBest === undefined || browserReplayLocal === undefined
        ? {}
        : {
            browserFresh: {
              mean: browserReplayBest.delta,
              maxChannelDelta: browserReplayLocal.maxDelta,
              coveredMean: browserReplayLocal.coveredMean,
            },
          }),
    },
  };
}

// ============================================================================
// helpers
// ============================================================================

/**
 * Select the explicit owner of strict pixel fidelity. Cross-implementation
 * Node Dawn replay remains structural/readback evidence even when a verifier
 * opts into same-browser replay for numeric pixel ownership.
 */
export function evaluatePixelVerdict({
  owner = 'node-dawn',
  nodeDawn,
  browserFresh,
  epsilon,
  maxChannelEpsilon,
  coveredEpsilon,
}) {
  if (owner !== 'node-dawn' && owner !== 'browser-fresh') {
    throw new Error(`invalid pixel verdict owner '${owner}'`);
  }
  if (owner === 'browser-fresh' && browserFresh === undefined) {
    throw new Error('browser-fresh pixel verdict requires a successful browser replay hook result');
  }
  const selected = owner === 'browser-fresh' ? browserFresh : nodeDawn;
  const failures = [];
  const prefix = owner === 'browser-fresh' ? 'browser fresh' : 'Node Dawn';
  if (selected.best.delta > epsilon) {
    failures.push(`${prefix} mean ${selected.best.delta.toFixed(5)} > eps ${epsilon}`);
  }
  if (selected.local.maxDelta > maxChannelEpsilon) {
    failures.push(
      `${prefix} maxChannelDelta ${selected.local.maxDelta.toFixed(5)} > ${maxChannelEpsilon}`,
    );
  }
  if (selected.local.coveredMean > coveredEpsilon) {
    failures.push(
      `${prefix} coveredMean ${selected.local.coveredMean.toFixed(5)} > ${coveredEpsilon}`,
    );
  }
  return { owner, selected, nodeDawn, browserFresh, failures };
}

/**
 * Bootstrap a fresh Dawn replay device. The paired verifier passes
 * `backend: 'metal'` on macOS so the Node side is explicit rather than relying
 * on a backend chosen implicitly by dawn.node. Legacy callers omit the option
 * and retain the package default. This option describes the Dawn side only;
 * Browser backend selection is owned by resolveBrowserWebGpuLaunch.
 *
 * @param {string} label
 * @param {object} tape
 * @param {{ backend?: 'metal' }} [options]
 */
export async function bootstrapDawn(label, tape, options = {}) {
  let createDawn;
  let gpuGlobals;
  try {
    ({ create: createDawn, globals: gpuGlobals } = await import('@forgeax/engine-dawn-node'));
  } catch (err) {
    fail(2, `[${label}] webgpu (dawn-node) import failed: ${err?.message ?? err}`);
  }
  Object.assign(globalThis, gpuGlobals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  let gpu;
  let dawnSelection;
  try {
    dawnSelection = resolveDawnReplaySelection({
      requestedBackend: options.backend ?? 'default',
    });
  } catch (error) {
    fail(2, `[${label}] Dawn replay backend setup failed: ${error?.message ?? error}`);
  }
  const dawnArgs = dawnSelection.args;
  try {
    gpu = createDawn(dawnArgs);
  } catch (err) {
    fail(2, `[${label}] dawn-node create(${JSON.stringify(dawnArgs)}) failed: ${err?.message ?? err}`);
  }
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  const rhiWebgpu = await import('@forgeax/engine-rhi-webgpu');
  const adapterRes = await rhiWebgpu.rhi.requestAdapter();
  if (!adapterRes.ok) fail(2, `[${label}] requestAdapter failed: ${adapterRes.error.code}`);
  const devRes = await requestReplayDeviceForTape(adapterRes.value, tape);
  if (!devRes.ok) fail(2, `[${label}] requestDevice failed: ${devRes.error.code}`);
  const backend = {
    requestedBackend: dawnSelection.requestedBackend,
    selectedBackend: dawnSelection.selectedBackend,
    dawnArgs,
    adapterFeatures: [...adapterRes.value.features].sort(),
    adapterLimits: {
      maxTextureDimension2D: adapterRes.value.limits.maxTextureDimension2D,
      maxBindGroups: adapterRes.value.limits.maxBindGroups,
      maxUniformBufferBindingSize: adapterRes.value.limits.maxUniformBufferBindingSize,
    },
    deviceCaps: {
      backendKind: devRes.value.caps.backendKind,
      timestampQuery: devRes.value.caps.timestampQuery,
      timestampPeriodNanoseconds: devRes.value.caps.timestampPeriodNanoseconds,
    },
  };
  console.log(`[${label}] Node Dawn backend: ${JSON.stringify(backend)}`);
  const freshDevice = devRes.value;
  const dispose = () => teardownDawnInstance([
    { destroy: () => rhiWebgpu.disposeDevice(freshDevice), queue: freshDevice.queue },
  ], () => {
    if (globalThis.navigator.gpu === gpu) delete globalThis.navigator.gpu;
    gpu = undefined;
  });
  return { freshDevice, rhiWebgpu, backend, dispose };
}

/** @param {{ features: ReadonlySet<string>, limits: Readonly<Record<string, number>>, requestDevice: (descriptor: object) => Promise<unknown> }} adapter @param {object} tape */
export function requestReplayDeviceForTape(adapter, tape) {
  return adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits));
}

async function assertStructural({ label, tape, work }) {
  if (work.workIndex < 0 || tape.events[work.eventIndex] === undefined) {
    fail(1, `[${label}] RED -- selected workIndex has no event in tape`);
  }
  const bindings = tape.events.filter((event) => event.kind === 'setBindGroup');
  const missing = [];
  if (bindings.length === 0) missing.push('bindings');
  if (work.attachment === undefined) missing.push('rt');
  if (missing.length) {
    fail(1, `[${label}] RED -- inspect workIndex ${work.workIndex} missing: ${missing.join(', ')}`);
  }
  const selectedEvent = tape.events[work.eventIndex];
  if (selectedEvent === undefined) {
    fail(1, `[${label}] RED -- workIndex ${work.workIndex} has no eventIndex ${work.eventIndex}`);
  }
  console.log(`[${label}] inspect workIndex ${work.workIndex} (${selectedEvent.kind}) OK -- bindings=${bindings.length} attachment=true`);
}

/** Y-flip an RGBA tight buffer in place into a new buffer. */
function yflip(px, w, h) {
  const out = new Uint8Array(px.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const src = y * rowBytes;
    const dst = (h - 1 - y) * rowBytes;
    out.set(px.subarray(src, src + rowBytes), dst);
  }
  return out;
}

/** Swap R and B channels of an RGBA tight buffer into a new buffer. */
function bgraSwap(px) {
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    out[i] = px[i + 2];
    out[i + 1] = px[i + 1];
    out[i + 2] = px[i];
    out[i + 3] = px[i + 3];
  }
  return out;
}

/**
 * Measure whole-frame RGB delta under 4 candidate alignments of the replay
 * buffer and return the minimum. Alpha is transport metadata for these visual
 * captures, so it is intentionally excluded from this visual parity metric.
 * Reports all four so a non-identity winner is visible (= a normalization
 * quirk, not a fidelity failure).
 */
function bestAlignmentDelta(live, replay, w, h, delta) {
  const flipped = yflip(replay, w, h);
  const buffers = {
    identity: replay,
    yflip: flipped,
    bgra: bgraSwap(replay),
    both: bgraSwap(flipped),
  };
  const all = {
    identity: delta(live, buffers.identity),
    yflip: delta(live, buffers.yflip),
    bgra: delta(live, buffers.bgra),
    both: delta(live, buffers.both),
  };
  let name = 'identity';
  let min = all.identity;
  for (const k of ['yflip', 'bgra', 'both']) {
    if (all[k] < min) {
      min = all[k];
      name = k;
    }
  }
  return { delta: min, name, all, applied: buffers[name] };
}

/** Compute mean absolute RGB delta while preserving the RGBA buffer contract. */
function normalizedRgbDelta(orig, replay) {
  if (orig.length !== replay.length || orig.length % 4 !== 0) {
    throw new Error('pixel buffers must have equal RGBA length');
  }
  let sum = 0;
  for (let i = 0; i < orig.length; i += 4) {
    sum += Math.abs((orig[i] ?? 0) - (replay[i] ?? 0));
    sum += Math.abs((orig[i + 1] ?? 0) - (replay[i + 1] ?? 0));
    sum += Math.abs((orig[i + 2] ?? 0) - (replay[i + 2] ?? 0));
  }
  return sum / ((orig.length / 4) * 3) / 255;
}

/**
 * Localized visual fidelity metrics on two aligned RGBA buffers:
 * - maxDelta: worst RGB-channel |a-b|/255 over every pixel. Catches a large
 *   visual error confined to a small region (which a whole-frame mean would
 *   average away). Alpha is transport metadata for these color captures and
 *   is not a visual replay criterion.
 * - coveredMean: mean RGB delta restricted to "non-background" pixels (any
 *   RGB pixel non-black in either buffer). For a small subject on a black frame
 *   this is the delta that actually matters; the whole-frame mean dilutes it
 *   by the black area's coverage.
 * - coveredFrac: fraction of pixels counted as non-background.
 */
function localMetrics(a, b, width, channelEpsilon = 0.1) {
  let maxAbs = 0;
  let coveredSum = 0;
  let coveredCount = 0;
  let maxWitness = null;
  let overChannelEpsilonCount = 0;
  let overChannelEpsilonBbox = null;
  const pixels = a.length / 4;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    const x = p % width;
    const y = Math.floor(p / width);
    let pixelDeltaSum = 0;
    let nonBg = false;
    for (let c = 0; c < 3; c++) {
      const av = a[i + c] ?? 0;
      const bv = b[i + c] ?? 0;
      const d = Math.abs(av - bv);
      if (d > maxAbs) {
        maxAbs = d;
        maxWitness = { x, y, channel: c, live: av, replay: bv, delta: d / 255 };
      }
      if (d / 255 > channelEpsilon) {
        overChannelEpsilonCount++;
        if (overChannelEpsilonBbox === null) {
          overChannelEpsilonBbox = { minX: x, minY: y, maxX: x, maxY: y };
        } else {
          overChannelEpsilonBbox.minX = Math.min(overChannelEpsilonBbox.minX, x);
          overChannelEpsilonBbox.minY = Math.min(overChannelEpsilonBbox.minY, y);
          overChannelEpsilonBbox.maxX = Math.max(overChannelEpsilonBbox.maxX, x);
          overChannelEpsilonBbox.maxY = Math.max(overChannelEpsilonBbox.maxY, y);
        }
      }
      pixelDeltaSum += d;
      // A pixel is "covered" if any RGB channel is lit in either buffer.
      if (av > 8 || bv > 8) nonBg = true;
    }
    if (nonBg) {
      coveredSum += pixelDeltaSum;
      coveredCount++;
    }
  }
  return {
    maxDelta: maxAbs / 255,
    coveredMean: coveredCount > 0 ? coveredSum / (coveredCount * 3) / 255 : 0,
    coveredFrac: pixels > 0 ? coveredCount / pixels : 0,
    maxWitness,
    overChannelEpsilonCount,
    overChannelEpsilonBbox,
  };
}

/** Fraction of pixels with any RGB channel lit (> 8). Used by the empty-frame guard. */
function litCoverage(px) {
  let lit = 0;
  const pixels = px.length / 4;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    if ((px[i] ?? 0) > 8 || (px[i + 1] ?? 0) > 8 || (px[i + 2] ?? 0) > 8) lit++;
  }
  return pixels > 0 ? lit / pixels : 0;
}

/**
 * Build a side-by-side RGBA image: live on the left, replay on the right, with a
 * 4px black gutter between them. Both panes are w x h, so the result is
 * (2w + gutter) x h.
 */
function sideBySide(live, replay, w, h) {
  const gutter = 4;
  const outW = w * 2 + gutter;
  const out = new Uint8Array(outW * h * 4);
  // gutter column stays black (alpha 255 so it renders solid).
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const rowBytes = w * 4;
  const outRowBytes = outW * 4;
  for (let y = 0; y < h; y++) {
    out.set(live.subarray(y * rowBytes, y * rowBytes + rowBytes), y * outRowBytes);
    out.set(
      replay.subarray(y * rowBytes, y * rowBytes + rowBytes),
      y * outRowBytes + (w + gutter) * 4,
    );
  }
  return { pixels: out, width: outW, height: h };
}

function fail(code, msg) {
  console.error(`\n${msg}`);
  process.exit(code);
}

function green(label, detail) {
  console.log(`\n[${label}] GREEN -- ${detail}`);
}
