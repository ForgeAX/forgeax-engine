import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserFrameProgress } from '@forgeax/engine-app';
import { parseImage } from '@forgeax/engine-image/parse-image';
import {
  type Browser,
  type ConsoleMessage,
  chromium,
  type Frame,
  type Page,
  type Request,
  type Response,
} from 'playwright';
import type { ViteDevServer } from 'vite';
import { createViteConfig } from './host.js';
import { type DevKitHostBinding, hostBindingError } from './host-binding.js';
import { commandError, readProjectFacts } from './project.js';
import type { BrowserCarrierTarget, BrowserExecutionTarget } from './tools/display-carrier.js';
import { acquireBrowserCarrierPage } from './tools/display-carrier.js';
import type {
  BrowserCaptureOptions,
  CaptureBackend,
  CaptureBackendObserved,
  CommandError,
  CommandResult,
} from './types.js';
import { waitForRuntimeCatalog } from './workspace-provider.js';

interface VirtualDisplay {
  readonly value?: string;
  close(): Promise<void>;
}

export interface CapturePixelWitness {
  readonly width: number;
  readonly height: number;
  readonly sampledPixels: number;
  readonly lumaMin: number;
  readonly lumaMax: number;
  readonly lumaRange: number;
  readonly varyingPixels: number;
  readonly rendered: boolean;
}

export interface BrowserCaptureRuntimeWitness {
  readonly title: string;
  readonly canvas: { readonly width: number; readonly height: number } | null;
  readonly domUi: {
    readonly rootChildren: number;
    readonly openShadowRoots: number;
    readonly textWitness: string;
  };
  readonly adapter: Readonly<Record<string, unknown>> | null;
  readonly adapterError: string | null;
  readonly engineFrameId: number | null;
  readonly captureReady: string | null;
  readonly fatalError: string | null;
  readonly singleHtml: {
    readonly ready: boolean;
    readonly resourceHits: number;
    readonly resourceMisses: readonly Readonly<Record<string, unknown>>[];
    readonly externalRequests: readonly Readonly<Record<string, unknown>>[];
  } | null;
  readonly userAgent: string;
}

export interface BrowserCaptureRequestWitness {
  readonly url: string;
  readonly resourceType: string;
  readonly status: number | null;
  readonly failed: boolean;
  readonly failure: string | null;
  readonly resourceMiss: boolean;
}

export interface BrowserCaptureRequestReport {
  readonly total: number;
  readonly documents: number;
  readonly http: number;
  readonly https: number;
  readonly failed: number;
  readonly resourceMisses: number;
  /** Requests still without a response or failure when the report was written. */
  readonly pending: number;
  /**
   * Failed, missing, HTTP 4xx/5xx and pending requests, plus every http(s)
   * request of a single-HTML target. An ok run counts the remaining requests only.
   */
  readonly notable: readonly BrowserCaptureRequestWitness[];
  /** Every request, kept whenever the run is not ok. */
  readonly entries?: readonly BrowserCaptureRequestWitness[];
}

export interface BrowserCaptureRecord {
  readonly index: number;
  readonly checkpoint: string | null;
  readonly ok: boolean;
  readonly output: string;
  readonly digest: string;
  readonly pixels: CapturePixelWitness;
  readonly runtime: BrowserCaptureRuntimeWitness;
}

export interface BrowserCaptureRunReport {
  readonly schemaVersion: '3.0.0';
  readonly runId: string;
  readonly ok: boolean;
  readonly mode: 'browser-compositor' | 'advanced-cpu-only-development';
  readonly root: string;
  readonly url: string;
  readonly target: BrowserCaptureTarget;
  readonly carrier: 'private-browser' | 'borrowed';
  readonly carrierTarget?: BrowserCarrierTarget;
  readonly carrierFallbackReason?: string;
  readonly launchProfile: BrowserLaunchProfile;
  readonly report: string;
  readonly backendRequested: CaptureBackend;
  readonly backend: CaptureBackendObserved;
  readonly fallbackReason?: string;
  readonly deterministicRequested: boolean;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
    readonly colorProfile: 'srgb';
    readonly colorScheme: 'light';
    readonly locale: 'en-US';
    readonly timezone: 'UTC';
  };
  readonly browser: { readonly version: string; readonly executable: string };
  readonly display: string | null;
  readonly lavapipeIcd: string | null;
  readonly captures: readonly BrowserCaptureRecord[];
  readonly requests: BrowserCaptureRequestReport;
  readonly singleHtml: BrowserCaptureRuntimeWitness['singleHtml'];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  /** Browser input limitations observed during an otherwise usable capture. */
  readonly inputWarnings: readonly string[];
  readonly closedAt?: string;
  readonly boundary: string;
}

export type BrowserCaptureTarget =
  | { readonly kind: 'project' }
  | { readonly kind: 'single-html'; readonly path: string };

export type BrowserLaunchProfile = 'development' | 'release';

export interface BrowserCaptureOpenOptions
  extends Pick<
    BrowserCaptureOptions,
    | 'backend'
    | 'browser'
    | 'width'
    | 'height'
    | 'port'
    | 'requireUi'
    | 'deterministic'
    | 'headless'
    | 'carrier'
    | 'carrierRun'
    | 'carrierGeneration'
  > {
  readonly outputDir?: string;
  readonly report?: string;
  readonly runId?: string;
  readonly target?: BrowserCaptureTarget;
  /** Use an already-running project server owned by the live project child. */
  readonly serverUrl?: string;
  /** Borrow an existing Host for this capture's main-thread project server. */
  readonly host?: DevKitHostBinding;
  /** Release omits unsafe WebGPU/file-access flags; development preserves the legacy lane. */
  readonly launchProfile?: BrowserLaunchProfile;
}

export interface BrowserCaptureCheckpointOptions {
  /** Live observation records failures; validation remains the default. */
  readonly purpose?: 'observe' | 'validate';
  /** Shared budget for frame, checkpoint, compositor and pixel waits. */
  readonly timeoutMs?: number;
  readonly output?: string;
  readonly waitMs?: number;
  readonly requireUi?: boolean;
  /** Require a frame submitted after this frame id before taking the image. */
  readonly afterFrameId?: number;
}

export interface BrowserCaptureSession {
  readonly page: Page;
  /**
   * The exact Engine execution realm. For a borrowed display host carrier this may be
   * a child Frame while `page` remains the stable owner document.
   */
  readonly execution?: BrowserExecutionTarget;
  readonly url: string;
  readonly reportPath: string;
  capture(
    checkpoint?: string,
    options?: BrowserCaptureCheckpointOptions,
  ): Promise<BrowserCaptureRecord>;
  report(): BrowserCaptureRunReport;
  close(): Promise<void>;
}

export interface BrowserCapture {
  open(options: BrowserCaptureOpenOptions): Promise<BrowserCaptureSession>;
  close(): Promise<void>;
}

class BrowserCaptureError extends Error implements CommandError {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${hint}`);
    this.name = 'BrowserCaptureError';
  }
}

function fail(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): never {
  throw new BrowserCaptureError(code, expected, hint, detail);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function reservePort(): Promise<number> {
  const reservation = createNetServer();
  await once(reservation.listen(0, '127.0.0.1'), 'listening');
  const address = reservation.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    reservation.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (port === 0) throw new Error('OS did not assign an ephemeral capture port');
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function startVirtualDisplay(width: number, height: number): Promise<VirtualDisplay> {
  if (process.platform !== 'linux' || process.env.DISPLAY !== undefined) {
    return {
      ...(process.env.DISPLAY === undefined ? {} : { value: process.env.DISPLAY }),
      async close() {},
    };
  }
  for (let offset = 0; offset < 100; offset += 1) {
    const number = 90 + ((process.pid + offset) % 100);
    const socket = `/tmp/.X11-unix/X${number}`;
    const lock = `/tmp/.X${number}-lock`;
    if ((await pathExists(socket)) || (await pathExists(lock))) continue;
    const display = `:${number}`;
    const child = spawn(
      'Xvfb',
      [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let diagnostic = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      diagnostic += chunk;
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error(`Xvfb did not create ${socket}: ${diagnostic.trim()}`)),
          5_000,
        );
        const poll = setInterval(() => {
          void pathExists(socket).then((exists) => {
            if (!exists) return;
            clearTimeout(timeout);
            clearInterval(poll);
            resolveReady();
          });
        }, 50);
        child.once('error', (error) => {
          clearTimeout(timeout);
          clearInterval(poll);
          rejectReady(
            new BrowserCaptureError(
              'browser-capture-display-unavailable',
              'Xvfb installed for a headed capture when Linux has no DISPLAY',
              'Use --headless true for unattended capture without X11, or install Xvfb for a virtual headed display. Keep Chromium sandboxing enabled and run as a non-root user.',
              { executable: 'Xvfb', reason: error.message },
            ),
          );
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          clearInterval(poll);
          rejectReady(
            new Error(`Xvfb exited before ready (${code ?? signal}): ${diagnostic.trim()}`),
          );
        });
      });
      return { value: display, close: () => stopProcess(child) };
    } catch (cause) {
      await stopProcess(child);
      throw cause;
    }
  }
  throw new Error('no free X11 display number was available for browser capture');
}

async function lavapipeIcd(): Promise<string | undefined> {
  for (const candidate of [
    '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json',
    '/usr/share/vulkan/icd.d/lvp_icd.aarch64.json',
  ]) {
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

function evidencePath(output: string): string {
  return output.toLowerCase().endsWith('.png') ? `${output.slice(0, -4)}.json` : `${output}.json`;
}

function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function isRecoverablePointerLockDiagnostic(message: string): boolean {
  return (
    message.includes('app-pointer-lock-failed') &&
    message.includes('path: w3c') &&
    /(WrongDocumentError|SecurityError|not allowed|not valid for pointer lock)/i.test(message)
  );
}

function checkpointSlug(checkpoint: string | undefined): string {
  const value = (checkpoint ?? 'capture')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return value.length === 0 ? 'capture' : value;
}

function captureDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** @internal Classify a reported adapter as a software or hardware lane. */
export function classifyCaptureAdapter(
  adapter: Readonly<Record<string, unknown>> | null,
): CaptureBackendObserved {
  if (adapter === null) return 'unknown';
  const witness = Object.values(adapter)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  return ['swiftshader', 'llvmpipe', 'lavapipe', 'software'].some((token) =>
    witness.includes(token),
  )
    ? 'software'
    : 'hardware';
}

/** @internal Shared browser discovery for live capture and resource preview. */
export async function resolveBrowserExecutable(
  requested: string | undefined,
): Promise<string | undefined> {
  if (requested !== undefined && requested.length > 0) {
    return (await pathExists(requested)) ? requested : undefined;
  }
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter((root): root is string => root !== undefined && root.length > 0)
      .flatMap((root) => [
        join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]),
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  // Playwright can supply a managed browser when its browser cache is present.
  // Leave executablePath unset so the caller receives Playwright's own diagnostic
  // rather than a misleading Chrome-Beta-only error.
  return undefined;
}

export function browserLaunchArgs(
  backend: CaptureBackend,
  profile: BrowserLaunchProfile,
  nativeWindow: boolean,
): string[] {
  const common = [
    '--force-color-profile=srgb',
    ...(nativeWindow ? [] : ['--force-device-scale-factor=1']),
  ];
  if (profile === 'development') {
    common.unshift(
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      // Expose supported adapter limits rather than Chrome's privacy tiers.
      '--disable-dawn-features=tiered_adapter_limits',
    );
  }
  if (backend !== 'software') return common;
  if (process.platform === 'win32') {
    return [...common, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'];
  }
  return [
    ...common,
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
    '--use-angle=swiftshader',
  ];
}

export function summarizeCapturePixels(
  rgba: Uint8Array,
  width: number,
  height: number,
): CapturePixelWitness {
  const pixelCount = width * height;
  const stride = Math.max(1, Math.floor(pixelCount / 4096));
  const histogram = new Uint32Array(16);
  let lumaMin = 255;
  let lumaMax = 0;
  let sampledPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    if (red === undefined || green === undefined || blue === undefined) break;
    const luma = Math.round((54 * red + 183 * green + 19 * blue) / 256);
    lumaMin = Math.min(lumaMin, luma);
    lumaMax = Math.max(lumaMax, luma);
    const bucket = Math.min(15, Math.floor(luma / 16));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    sampledPixels += 1;
  }
  const dominantPixels = histogram.reduce((largest, count) => Math.max(largest, count), 0);
  const varyingPixels = sampledPixels - dominantPixels;
  const lumaRange = lumaMax - lumaMin;
  const requiredVariation = Math.min(sampledPixels, Math.max(8, Math.ceil(sampledPixels * 0.002)));
  return {
    width,
    height,
    sampledPixels,
    lumaMin,
    lumaMax,
    lumaRange,
    varyingPixels,
    rendered: lumaRange >= 8 && varyingPixels >= requiredVariation,
  };
}

function inspectCapturePng(png: Uint8Array): CapturePixelWitness {
  const decoded = parseImage(png, 'image/png', { mipmap: false });
  if (!decoded.ok) throw decoded.error;
  return summarizeCapturePixels(decoded.value.bytes, decoded.value.width, decoded.value.height);
}

/**
 * Capture the exact Engine execution surface. A borrowed frame is captured
 * from its stable outer iframe surface; the frame remains the only realm that
 * Engine navigates and observes, while the owner page contributes only the
 * temporary compositor envelope needed for an exact PNG.
 */
async function captureBrowserExecutionSurfaceRaw(
  execution: BrowserExecutionTarget,
  deadline: number,
): Promise<Uint8Array> {
  if (execution.kind === 'frame') {
    // Capture the exact outer iframe surface. The envelope is installed by
    // `withCaptureEnvelope` so hidden/covered display targets are made
    // capturable without changing focus or navigating the owner document.
    return execution.ownerPage.locator(execution.surfaceSelector).screenshot({
      type: 'png',
      timeout: Math.max(1, deadline - Date.now()),
    });
  }
  return execution.realm.screenshot({
    type: 'png',
    caret: 'hide',
    timeout: Math.max(1, deadline - Date.now()),
  });
}

export async function captureBrowserExecutionSurface(
  execution: BrowserExecutionTarget,
  deadline: number,
  extent: { readonly width: number; readonly height: number },
): Promise<Uint8Array> {
  return withCaptureEnvelope(execution, extent, () =>
    captureBrowserExecutionSurfaceRaw(execution, deadline),
  );
}

async function withCaptureEnvelope<T>(
  execution: BrowserExecutionTarget,
  extent: { readonly width: number; readonly height: number },
  operation: () => Promise<T>,
): Promise<T> {
  if (execution.kind === 'page') return operation();
  const token = `forgeax-capture-${randomUUID()}`;
  await execution.ownerPage.evaluate(
    ({ selector, token, width, height }) => {
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLIFrameElement)) {
        throw new Error('browser capture surface selector did not resolve to an iframe');
      }
      const keep = new Set<Element>();
      for (let current: Element | null = target; current !== null; current = current.parentElement)
        keep.add(current);
      const records: Array<{ readonly element: HTMLElement; readonly style: string | null }> = [];
      for (const element of document.querySelectorAll<HTMLElement>('*')) {
        if (keep.has(element) || target.contains(element)) continue;
        records.push({ element, style: element.getAttribute('style') });
        element.style.setProperty('visibility', 'hidden', 'important');
        element.style.setProperty('pointer-events', 'none', 'important');
      }
      records.push({ element: target, style: target.getAttribute('style') });
      target.style.setProperty('display', 'block', 'important');
      target.style.setProperty('visibility', 'visible', 'important');
      target.style.setProperty('opacity', '1', 'important');
      target.style.setProperty('z-index', '2147483647', 'important');
      target.style.setProperty('position', 'relative', 'important');
      target.style.setProperty('width', `${width}px`, 'important');
      target.style.setProperty('height', `${height}px`, 'important');
      target.style.setProperty('box-sizing', 'border-box', 'important');
      target.style.setProperty('border', '0', 'important');
      const envelopes =
        (
          globalThis as unknown as {
            __forgeaxCaptureEnvelopes?: Map<
              string,
              Array<{ readonly element: HTMLElement; readonly style: string | null }>
            >;
          }
        ).__forgeaxCaptureEnvelopes ?? new Map();
      envelopes.set(token, records);
      (
        globalThis as unknown as { __forgeaxCaptureEnvelopes?: typeof envelopes }
      ).__forgeaxCaptureEnvelopes = envelopes;
    },
    { selector: execution.surfaceSelector, token, width: extent.width, height: extent.height },
  );
  try {
    return await operation();
  } finally {
    await execution.ownerPage
      .evaluate((captureToken) => {
        const scope = globalThis as unknown as {
          __forgeaxCaptureEnvelopes?: Map<
            string,
            Array<{ readonly element: HTMLElement; readonly style: string | null }>
          >;
        };
        const records = scope.__forgeaxCaptureEnvelopes?.get(captureToken);
        if (records === undefined) return;
        for (const record of records.reverse()) {
          if (record.style === null) record.element.removeAttribute('style');
          else record.element.setAttribute('style', record.style);
        }
        scope.__forgeaxCaptureEnvelopes?.delete(captureToken);
      }, token)
      .catch(() => undefined);
  }
}

async function screenshotCanvasWitness(
  execution: BrowserExecutionTarget,
  deadline: number,
  extent: { readonly width: number; readonly height: number },
): Promise<{ readonly png: Uint8Array; readonly pixels: CapturePixelWitness }> {
  const canvasPng = await withCaptureEnvelope(execution, extent, async () => {
    const bounds = await execution.realm.locator('canvas').first().boundingBox();
    if (bounds === null) {
      fail(
        'browser-capture-runtime-failed',
        'a visible Engine canvas',
        'Inspect the browser runtime before capturing canvas pixels.',
      );
    }
    // Sample live canvas pixels without element scrolling or layout-stability waits.
    // boundingBox is relative to the owner viewport, including for iframe canvases.
    const viewport = await execution.ownerPage.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const x = Math.max(0, bounds.x);
    const y = Math.max(0, bounds.y);
    const width = Math.min(viewport.width, bounds.x + bounds.width) - x;
    const height = Math.min(viewport.height, bounds.y + bounds.height) - y;
    if (width <= 0 || height <= 0) {
      fail(
        'browser-capture-runtime-failed',
        'Engine canvas pixels inside the browser viewport',
        'Keep the capture canvas visible in its owning document.',
      );
    }
    return execution.ownerPage.screenshot({
      type: 'png',
      clip: { x, y, width, height },
      timeout: Math.max(1, deadline - Date.now()),
      style: '* { visibility: hidden !important; } canvas { visibility: visible !important; }',
    });
  });
  return { png: canvasPng, pixels: inspectCapturePng(canvasPng) };
}

async function runtimeWitness(
  realm: Page | Frame,
  probeAdapter = true,
): Promise<BrowserCaptureRuntimeWitness> {
  return realm.evaluate(
    async ({ probeAdapter }) => {
      const canvas = document.querySelector('canvas');
      const progress = canvas?.forgeaxFrameProgress as BrowserFrameProgress | undefined;
      const uiRoot = document.querySelector('#game-ui');
      const shadowHosts = [...(uiRoot?.querySelectorAll('*') ?? [])].filter(
        (element) => element.shadowRoot?.childElementCount !== 0,
      );
      let adapter: Readonly<Record<string, unknown>> | null = null;
      let adapterError: string | null = null;
      if (probeAdapter) {
        try {
          const gpuAdapter = await navigator.gpu?.requestAdapter();
          if (gpuAdapter === null || gpuAdapter === undefined) {
            adapterError = 'navigator.gpu.requestAdapter() returned null';
          } else {
            const info = gpuAdapter.info;
            adapter = {
              vendor: info.vendor,
              architecture: info.architecture,
              device: info.device,
              description: info.description,
            };
          }
        } catch (cause) {
          adapterError = String(cause);
        }
      }
      const frameId = progress?.submitted?.frameId;
      const fatal = document.querySelector('#forgeax-fatal');
      const fatalError = fatal?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        ? (
            document.querySelector('#forgeax-fatal-details')?.textContent?.trim() ||
            fatal.textContent?.trim() ||
            'Engine execution failed'
          ).slice(0, 16_384)
        : null;
      const singleHtmlState = (
        globalThis as typeof globalThis & {
          __forgeaxSingleHtml?: {
            witness?: () => {
              ready: boolean;
              resourceHits: number;
              resourceMisses: readonly Readonly<Record<string, unknown>>[];
              externalRequests: readonly Readonly<Record<string, unknown>>[];
            };
          };
        }
      ).__forgeaxSingleHtml;
      return {
        title: document.title,
        canvas:
          canvas instanceof HTMLCanvasElement
            ? { width: canvas.width, height: canvas.height }
            : null,
        domUi: {
          rootChildren: uiRoot?.childElementCount ?? 0,
          openShadowRoots: shadowHosts.length,
          textWitness: shadowHosts
            .map((host) =>
              [...(host.shadowRoot?.children ?? [])]
                .filter((element) => !['STYLE', 'SCRIPT'].includes(element.tagName))
                .map((element) =>
                  element instanceof HTMLElement ? element.innerText : element.textContent,
                )
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim(),
            )
            .filter((text) => text.length > 0)
            .join(' | ')
            .slice(0, 500),
        },
        adapter,
        adapterError,
        engineFrameId:
          Number.isSafeInteger(frameId) && frameId !== undefined && frameId > 0 ? frameId : null,
        captureReady: document.documentElement.dataset.forgeaxCaptureReady ?? null,
        fatalError,
        singleHtml: singleHtmlState?.witness?.() ?? null,
        userAgent: navigator.userAgent,
      };
    },
    { probeAdapter },
  );
}

async function writeRunReport(report: BrowserCaptureRunReport): Promise<void> {
  await mkdir(dirname(report.report), { recursive: true });
  await writeFile(report.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

interface MutableRequestWitness extends BrowserCaptureRequestWitness {
  status: number | null;
  failed: boolean;
  failure: string | null;
  resourceMiss: boolean;
}

function requestProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

function requestRecord(
  request: Request,
  target: BrowserCaptureTarget,
  candidateUrl: string,
): MutableRequestWitness {
  const url = request.url();
  const protocol = requestProtocol(url);
  const requestDocument = url.split(/[?#]/, 1)[0];
  const candidateDocument = candidateUrl.split(/[?#]/, 1)[0];
  return {
    url,
    resourceType: request.resourceType(),
    status: null,
    failed: false,
    failure: null,
    resourceMiss:
      target.kind === 'single-html' &&
      protocol === 'file:' &&
      requestDocument !== candidateDocument,
  };
}

function pendingRequest(record: BrowserCaptureRequestWitness): boolean {
  return record.status === null && !record.failed;
}

function notableRequest(
  record: BrowserCaptureRequestWitness,
  target: BrowserCaptureTarget,
): boolean {
  const protocol = requestProtocol(record.url);
  return (
    record.failed ||
    record.resourceMiss ||
    pendingRequest(record) ||
    (record.status !== null && record.status >= 400) ||
    (target.kind === 'single-html' && (protocol === 'http:' || protocol === 'https:'))
  );
}

function summarizeRequests(
  records: readonly MutableRequestWitness[],
  target: BrowserCaptureTarget,
): BrowserCaptureRequestReport {
  return {
    total: records.length,
    documents: records.filter((record) => record.resourceType === 'document').length,
    http: records.filter((record) => requestProtocol(record.url) === 'http:').length,
    https: records.filter((record) => requestProtocol(record.url) === 'https:').length,
    failed: records.filter((record) => record.failed).length,
    resourceMisses: records.filter((record) => record.resourceMiss).length,
    pending: records.filter(pendingRequest).length,
    notable: records
      .filter((record) => notableRequest(record, target))
      .map((record) => ({ ...record })),
  };
}

/** A failed run keeps its complete request evidence. */
function reportedRequests(
  records: readonly MutableRequestWitness[],
  summary: BrowserCaptureRequestReport,
  ok: boolean,
): BrowserCaptureRequestReport {
  return ok ? summary : { ...summary, entries: records.map((record) => ({ ...record })) };
}

function singleHtmlRuntimeClean(
  target: BrowserCaptureTarget,
  runtime: BrowserCaptureRuntimeWitness | null,
  requests: BrowserCaptureRequestReport,
): boolean {
  if (target.kind !== 'single-html') return true;
  const singleHtml = runtime?.singleHtml;
  return (
    singleHtml?.ready === true &&
    singleHtml.resourceMisses.length === 0 &&
    singleHtml.externalRequests.length === 0 &&
    requests.http === 0 &&
    requests.https === 0 &&
    requests.failed === 0 &&
    requests.resourceMisses === 0
  );
}

function markResponse(
  records: ReadonlyMap<Request, MutableRequestWitness>,
  response: Response,
): void {
  const record = records.get(response.request());
  if (record === undefined) return;
  record.status = response.status();
  if (record.status >= 400) record.resourceMiss = true;
}

function markFailed(records: ReadonlyMap<Request, MutableRequestWitness>, request: Request): void {
  const record = records.get(request);
  if (record === undefined) return;
  record.failed = true;
  record.failure = request.failure()?.errorText ?? 'request failed';
  record.resourceMiss = true;
}

async function assertSingleHtmlCandidate(path: string): Promise<void> {
  if (!path.toLowerCase().endsWith('.html')) {
    fail(
      'browser-capture-target-invalid',
      'single-html target path to end with .html',
      'Pass the exact forgeax project package --format single-html candidate.',
      { path },
    );
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('target is not a regular file');
  } catch (cause) {
    fail(
      'browser-capture-target-missing',
      'single-html target path to exist',
      'Package the game first, then pass its candidate HTML path.',
      { path, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

/** The capture target after host-binding admission; a single-html candidate must be a real file. */
async function admitCaptureTarget(
  options: BrowserCaptureOpenOptions,
): Promise<BrowserCaptureTarget> {
  const requestedTarget = options.target ?? { kind: 'project' as const };
  if (
    options.host !== undefined &&
    (requestedTarget.kind !== 'project' || options.serverUrl !== undefined)
  ) {
    hostBindingError('host binding cannot modify an external server or a prebuilt HTML target');
  }
  if (requestedTarget.kind !== 'single-html') return { kind: 'project' };
  const path = resolve(requestedTarget.path);
  await assertSingleHtmlCandidate(path);
  return { kind: 'single-html', path };
}

async function readCaptureProjectFacts(root: string) {
  const facts = await readProjectFacts(root);
  if (!facts.ok) {
    throw new BrowserCaptureError(
      facts.error.code,
      facts.error.expected,
      facts.error.hint,
      facts.error.detail,
    );
  }
  return facts;
}

/** An explicitly requested browser must resolve; otherwise discovery may find none. */
async function resolveRequestedBrowser(browser: string | undefined): Promise<string | undefined> {
  const browserPath = await resolveBrowserExecutable(browser);
  if (browser !== undefined && browserPath === undefined) {
    fail(
      'browser-capture-browser-missing',
      `a runnable browser at ${browser}`,
      'Install Chrome/Chromium or pass --browser with an executable path.',
      { browser },
    );
  }
  return browserPath;
}

async function captureProjectPort(port: number | undefined): Promise<number> {
  return port === undefined || port === 0 ? await reservePort() : port;
}

// A Pack-backed project can publish its first catalog asynchronously.
// The page cannot recover from the one-shot 503 that precedes that
// publication, so wait for the owner generation before navigation.
async function waitForCaptureCatalog(
  server: ViteDevServer,
  port: number,
  projectId: string,
): Promise<void> {
  if (server.httpServer === undefined) return;
  const serverUrl = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${port}/`;
  try {
    await waitForRuntimeCatalog(serverUrl, projectId, 120_000);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'DevKitWorkspaceError') {
      const detail =
        'detail' in cause && cause.detail !== null && typeof cause.detail === 'object'
          ? cause.detail
          : {};
      throw new BrowserCaptureError(
        'browser-capture-catalog-not-ready',
        'the project Pack catalog to become ready before the browser page loads',
        'Wait for the project producer to finish, repair its diagnostics, and retry the capture.',
        detail as Readonly<Record<string, unknown>>,
      );
    }
    throw cause;
  }
}

async function openCaptureDisplay(
  headless: boolean | undefined,
  width: number,
  height: number,
): Promise<VirtualDisplay> {
  return headless === true ? { async close() {} } : await startVirtualDisplay(width, height);
}

function defaultHeadless(display: VirtualDisplay): boolean {
  return display.value === undefined && process.platform !== 'linux';
}

/** A headed development launch without an explicit viewport keeps the native window size. */
function usesNativeWindow(
  headless: boolean,
  launchProfile: BrowserLaunchProfile,
  viewport: { readonly width?: number | undefined; readonly height?: number | undefined },
): boolean {
  return (
    !headless &&
    launchProfile === 'development' &&
    viewport.width === undefined &&
    viewport.height === undefined
  );
}

function projectBaseUrl(
  serverUrl: string | undefined,
  server: ViteDevServer | undefined,
  port: number | undefined,
): URL {
  return new URL(serverUrl ?? server?.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port ?? 0}/`);
}

function assertObservedBackend(
  backend: CaptureBackend,
  observed: CaptureBackendObserved,
  runtime: BrowserCaptureRuntimeWitness,
  launchProfile: BrowserLaunchProfile,
  initialAdapterError: BrowserCaptureRuntimeWitness['adapterError'],
): void {
  if (backend !== 'auto' && observed !== backend) {
    fail(
      'browser-capture-backend-unavailable',
      `the explicitly requested ${backend} adapter`,
      'Use backend: auto to allow fallback, or repair the requested browser backend.',
      {
        requested: backend,
        actual: observed,
        adapter: runtime.adapter,
        cause: runtime.adapterError,
      },
    );
  }
  if (backend === 'auto' && observed === 'unknown') {
    fail(
      'browser-capture-backend-unavailable',
      'the browser to expose either a hardware or software WebGPU adapter',
      'The browser exposed no usable adapter for the requested launch profile; use development for the software fallback or repair the browser environment.',
      {
        requested: backend,
        actual: observed,
        launchProfile,
        initialAdapterError,
        fallbackAdapterError: runtime.adapterError,
      },
    );
  }
}

function captureEntryUrl(
  target: BrowserCaptureTarget,
  baseUrl: URL | undefined,
  deterministic: boolean,
): URL {
  const captureUrl =
    target.kind === 'single-html'
      ? new URL(pathToFileURL(target.path).href)
      : new URL(baseUrl?.href ?? 'http://127.0.0.1/');
  if (deterministic) captureUrl.searchParams.set('forgeaxCapture', '1');
  return captureUrl;
}

function carrierReportFields(
  carrierAttachment: { readonly target: BrowserCarrierTarget } | undefined,
  carrierFallbackReason: string | undefined,
): Pick<BrowserCaptureRunReport, 'carrier' | 'carrierTarget' | 'carrierFallbackReason'> {
  return {
    carrier: carrierAttachment === undefined ? 'private-browser' : 'borrowed',
    ...(carrierAttachment === undefined ? {} : { carrierTarget: carrierAttachment.target }),
    ...(carrierFallbackReason === undefined ? {} : { carrierFallbackReason }),
  };
}

function backendReportFields(
  backend: CaptureBackend,
  observed: CaptureBackendObserved,
  initialAdapterError: BrowserCaptureRuntimeWitness['adapterError'],
): Pick<BrowserCaptureRunReport, 'backendRequested' | 'backend' | 'fallbackReason'> {
  return {
    backendRequested: backend,
    backend: observed,
    ...(backend === 'auto' && observed === 'software'
      ? { fallbackReason: initialAdapterError ?? 'The browser selected a software adapter.' }
      : {}),
  };
}

function viewportReport(
  nativeViewport:
    | { readonly width: number; readonly height: number; readonly deviceScaleFactor: number }
    | undefined,
  width: number,
  height: number,
): BrowserCaptureRunReport['viewport'] {
  return {
    width: nativeViewport?.width ?? width,
    height: nativeViewport?.height ?? height,
    deviceScaleFactor: nativeViewport?.deviceScaleFactor ?? 1,
    colorProfile: 'srgb',
    colorScheme: 'light',
    locale: 'en-US',
    timezone: 'UTC',
  };
}

function browserReport(
  browser: Browser | undefined,
  carrierAttachment: object | undefined,
  browserPath: string | undefined,
): BrowserCaptureRunReport['browser'] {
  return {
    version: browser?.version() ?? 'borrowed-carrier',
    executable:
      carrierAttachment === undefined ? (browserPath ?? 'borrowed-carrier') : 'borrowed-carrier',
  };
}

/** Run identity and artifact locations, resolved against the project root. */
function captureRunLayout(
  projectRoot: string,
  options: Pick<BrowserCaptureOpenOptions, 'runId' | 'outputDir' | 'report'>,
): { readonly id: string; readonly outputDirectory: string; readonly reportPath: string } {
  const id = options.runId ?? newRunId();
  const outputDirectory = resolve(projectRoot, options.outputDir ?? `artifacts/playthrough/${id}`);
  const reportPath = resolve(projectRoot, options.report ?? resolve(outputDirectory, 'run.json'));
  return { id, outputDirectory, reportPath };
}

/** Auto relaunches its own browser on the software lane when no hardware adapter appeared. */
function fallsBackToSoftware(
  backend: CaptureBackend,
  observed: CaptureBackendObserved,
  borrowedCarrier: boolean,
): boolean {
  return backend === 'auto' && observed !== 'hardware' && !borrowedCarrier;
}

function assertCaptureSessionOpened(
  page: Page | undefined,
  browser: Browser | undefined,
  carrierAttachment: object | undefined,
): asserts page is Page {
  if (page === undefined || (browser === undefined && carrierAttachment === undefined)) {
    fail(
      'browser-capture-browser-unavailable',
      'the browser capture session to open',
      'Inspect the browser launch diagnostic and retry with --browser or --headless.',
    );
  }
}

async function openBrowserCaptureSession(
  root: string,
  options: BrowserCaptureOpenOptions,
): Promise<BrowserCaptureSession> {
  const backend: CaptureBackend = options.backend ?? 'auto';
  const launchProfile = options.launchProfile ?? 'development';
  const target = await admitCaptureTarget(options);
  const facts = await readCaptureProjectFacts(root);
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const browserPath = await resolveRequestedBrowser(options.browser);

  const { id, outputDirectory, reportPath } = captureRunLayout(facts.value.root, options);
  const port = target.kind === 'project' ? await captureProjectPort(options.port) : undefined;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let carrierAttachment:
    | {
        readonly page: Page;
        readonly target: BrowserCarrierTarget;
        readonly execution: BrowserExecutionTarget;
        readonly close: (reason?: string) => Promise<void>;
      }
    | undefined;
  let execution: BrowserExecutionTarget | undefined;
  let carrierFallbackReason: string | undefined;
  let display: VirtualDisplay | undefined;
  let removePageListeners = (): void => {};
  try {
    if (target.kind === 'project' && options.serverUrl === undefined) {
      const { createServer } = await import('vite');
      if (port === undefined) throw new Error('project capture did not reserve a port');
      server = await createServer(
        await createViteConfig(facts.value, 'serve', '/', {
          server: { port, strictPort: true },
          ...(options.host === undefined ? {} : { host: options.host }),
        }),
      );
      await server.listen(port);
      await waitForCaptureCatalog(server, port, facts.value.id);
    }
    display = await openCaptureDisplay(options.headless, width, height);
    const captureDisplay = display;
    const icd = await lavapipeIcd();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const inputWarnings: string[] = [];
    const requestRecords: MutableRequestWitness[] = [];
    const requestByObject = new Map<Request, MutableRequestWitness>();
    const pageListenerCleanups: Array<() => void> = [];
    removePageListeners = (): void => {
      for (const cleanup of pageListenerCleanups.splice(0)) cleanup();
    };
    const headless = options.headless ?? defaultHeadless(display);
    const nativeWindow = usesNativeWindow(headless, launchProfile, options);
    const baseUrl =
      target.kind === 'project' ? projectBaseUrl(options.serverUrl, server, port) : undefined;
    const openPage = async (
      launchBackend: CaptureBackend,
    ): Promise<BrowserCaptureRuntimeWitness> => {
      const useBorrowedCarrier = options.carrier !== undefined && options.headless === false;
      if (useBorrowedCarrier && carrierAttachment === undefined) {
        if (options.carrierRun === undefined || options.carrierGeneration === undefined) {
          fail(
            'browser-capture-carrier-input-invalid',
            'carrierRun and carrierGeneration for a borrowed headed page',
            'Pass the persistent Engine service/run identity and generation with the carrier adapter.',
          );
        }
        const captureUrl =
          target.kind === 'single-html'
            ? new URL(pathToFileURL(target.path).href)
            : new URL(baseUrl?.href ?? 'http://127.0.0.1/');
        if (options.deterministic === true) captureUrl.searchParams.set('forgeaxCapture', '1');
        const acquired = await acquireBrowserCarrierPage(
          options.carrier,
          {
            run: options.carrierRun,
            generation: options.carrierGeneration,
            headless: false,
            // `auto` is an intent, not a claim about the eventual adapter.
            // The page owner reports the observed backend after attachment.
            gpu: backend === 'software' ? 'software' : backend === 'hardware' ? 'hardware' : 'auto',
            width,
            height,
            url: captureUrl.href,
          },
          { releaseReason: 'engine-attach-failed' },
        );
        carrierAttachment = acquired.attachment;
        carrierFallbackReason = acquired.fallbackReason;
        if (carrierAttachment !== undefined) {
          page = carrierAttachment.page;
          execution = carrierAttachment.execution;
        }
      }
      const browserEnvironment: Record<string, string> = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...(launchBackend === 'software' ? { LIBGL_ALWAYS_SOFTWARE: '1' } : {}),
        ...(captureDisplay.value === undefined ? {} : { DISPLAY: captureDisplay.value }),
      };
      const launchOptions = {
        headless,
        env: browserEnvironment,
        args: browserLaunchArgs(launchBackend, launchProfile, nativeWindow),
        ...(browserPath === undefined ? {} : { executablePath: browserPath }),
      };
      if (page === undefined) {
        browser = await chromium.launch({ ...launchOptions, chromiumSandbox: true });
        page = await browser.newPage({
          ...(nativeWindow
            ? { viewport: null }
            : { viewport: { width, height }, screen: { width, height }, deviceScaleFactor: 1 }),
          colorScheme: 'light',
          locale: 'en-US',
          timezoneId: 'UTC',
        });
      }
      const activePage = page;
      if (activePage === undefined) throw new Error('browser carrier did not provide a page');
      const activeRealm = execution?.realm ?? activePage;
      const targetFrame = execution?.kind === 'frame' ? execution.realm : undefined;
      const captureUrl =
        target.kind === 'single-html'
          ? new URL(pathToFileURL(target.path).href)
          : new URL(baseUrl?.href ?? 'http://127.0.0.1/');
      if (options.deterministic === true) captureUrl.searchParams.set('forgeaxCapture', '1');
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== 'error') return;
        if (targetFrame !== undefined) {
          const location = message.location().url;
          const targetUrl = typeof targetFrame.url === 'function' ? targetFrame.url() : '';
          // Playwright does not expose a Frame on ConsoleMessage. The source
          // URL is the available attribution witness; unscoped owner-page
          // console output must never fail a borrowed target.
          if (location !== '' && targetUrl !== '' && location !== targetUrl) return;
        }
        const text = message.text();
        if (isRecoverablePointerLockDiagnostic(text)) inputWarnings.push(text);
        else consoleErrors.push(text);
      };
      const onPageError = (error: Error) => {
        // PageError has no frame accessor in Playwright. Keep owner-page
        // diagnostics for a page execution, but do not attribute unrelated
        // workspace errors to a borrowed child frame.
        if (targetFrame !== undefined) return;
        const text = String(error);
        if (isRecoverablePointerLockDiagnostic(text)) inputWarnings.push(text);
        else pageErrors.push(text);
      };
      const onRequest = (request: Request) => {
        if (targetFrame !== undefined && request.frame() !== targetFrame) return;
        const record = requestRecord(request, target, captureUrl.href);
        requestRecords.push(record);
        requestByObject.set(request, record);
      };
      const onResponse = (response: Response) => {
        if (targetFrame !== undefined && response.frame() !== targetFrame) return;
        markResponse(requestByObject, response);
      };
      const onRequestFailed = (request: Request) => {
        if (targetFrame !== undefined && request.frame() !== targetFrame) return;
        markFailed(requestByObject, request);
      };
      activePage.on('console', onConsole);
      activePage.on('pageerror', onPageError);
      activePage.on('request', onRequest);
      activePage.on('response', onResponse);
      activePage.on('requestfailed', onRequestFailed);
      pageListenerCleanups.push(
        () => activePage.off?.('console', onConsole),
        () => activePage.off?.('pageerror', onPageError),
        () => activePage.off?.('request', onRequest),
        () => activePage.off?.('response', onResponse),
        () => activePage.off?.('requestfailed', onRequestFailed),
      );
      await activeRealm.goto(captureUrl.href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      const readinessDeadline = Date.now() + 120_000;
      while (true) {
        await activeRealm.waitForFunction(
          (requireUi) => {
            if (document.querySelector('#forgeax-fatal')?.checkVisibility()) return true;
            const canvas = document.querySelector('canvas');
            if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || canvas.height <= 0)
              return false;
            if (!requireUi) return true;
            const uiRoot = document.querySelector('#game-ui');
            return uiRoot !== null && uiRoot.childElementCount > 0;
          },
          options.requireUi === true,
          { timeout: Math.max(1, readinessDeadline - Date.now()) },
        );
        try {
          return await runtimeWitness(activeRealm);
        } catch (error) {
          // A development reload can destroy the asynchronous adapter probe
          // after readiness. Recheck the replacement document within the same
          // startup budget; only this read-only startup observation is retried.
          if (
            !(error instanceof Error) ||
            !error.message.includes('Execution context was destroyed') ||
            Date.now() >= readinessDeadline
          ) {
            throw error;
          }
        }
      }
    };

    // Auto first preserves a physical adapter. If only software (or no adapter)
    // is available, use the same configured software lane as an explicit request. This
    // keeps the public capture contract portable without masking a flat frame.
    const initialLaunchBackend: CaptureBackend = backend === 'software' ? 'software' : 'hardware';
    let runtime = await openPage(initialLaunchBackend);
    let observed = classifyCaptureAdapter(runtime.adapter);
    const initialAdapterError = runtime.adapterError;
    if (fallsBackToSoftware(backend, observed, carrierAttachment !== undefined)) {
      removePageListeners();
      await browser?.close();
      browser = undefined;
      page = undefined;
      consoleErrors.length = 0;
      pageErrors.length = 0;
      inputWarnings.length = 0;
      requestRecords.length = 0;
      requestByObject.clear();
      runtime = await openPage('software');
      observed = classifyCaptureAdapter(runtime.adapter);
    }
    assertObservedBackend(backend, observed, runtime, launchProfile, initialAdapterError);
    const captureUrl = captureEntryUrl(target, baseUrl, options.deterministic === true);
    assertCaptureSessionOpened(page, browser, carrierAttachment);
    const nativeViewport = nativeWindow
      ? await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          deviceScaleFactor: window.devicePixelRatio,
        }))
      : undefined;

    const captures: BrowserCaptureRecord[] = [];
    let latestRuntime: BrowserCaptureRuntimeWitness | null = runtime;
    let closed = false;
    const report: BrowserCaptureRunReport = {
      schemaVersion: '3.0.0',
      runId: id,
      ok: false,
      mode: 'browser-compositor',
      root: facts.value.root,
      url: captureUrl.href,
      target,
      ...carrierReportFields(carrierAttachment, carrierFallbackReason),
      launchProfile,
      report: reportPath,
      ...backendReportFields(backend, observed, initialAdapterError),
      deterministicRequested: options.deterministic === true,
      viewport: viewportReport(nativeViewport, width, height),
      browser: browserReport(browser, carrierAttachment, browserPath),
      display: display.value ?? null,
      lavapipeIcd: icd ?? null,
      captures,
      requests: reportedRequests(requestRecords, summarizeRequests(requestRecords, target), false),
      singleHtml: runtime.singleHtml,
      consoleErrors,
      pageErrors,
      inputWarnings,
      boundary:
        'Browser-compositor capture is visual iteration evidence, not physical-GPU performance, HDR-display output, or release acceptance.',
    };
    await writeRunReport(report);

    const updateReport = async (): Promise<void> => {
      const requests = summarizeRequests(requestRecords, target);
      const ok =
        captures.length > 0 &&
        captures.every((capture) => capture.ok) &&
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        latestRuntime?.fatalError == null &&
        singleHtmlRuntimeClean(target, latestRuntime, requests);
      Object.assign(report, {
        requests: reportedRequests(requestRecords, requests, ok),
        singleHtml: latestRuntime?.singleHtml ?? null,
        ok,
      });
      await writeRunReport(report);
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      removePageListeners();
      await Promise.allSettled([
        browser?.close(),
        carrierAttachment?.close('engine-capture-close'),
        display?.close(),
        server?.close(),
      ]);
      Object.assign(report, { closedAt: new Date().toISOString() });
      await updateReport();
    };

    return {
      page,
      ...(execution === undefined ? {} : { execution }),
      url: captureUrl.href,
      reportPath,
      async capture(checkpoint, captureOptions = {}) {
        if (closed) {
          fail(
            'browser-capture-session-closed',
            'capture to run inside an open browser session',
            'Open one session, complete all checkpoints, then close it.',
            { report: reportPath },
          );
        }
        const activePage = page;
        if (activePage === undefined) {
          fail(
            'browser-capture-browser-unavailable',
            'an open Playwright page',
            'Inspect the browser launch diagnostic and retry the capture.',
          );
        }
        const activeRealm = execution?.realm ?? activePage;
        const index = captures.length + 1;
        const output = resolve(
          facts.value.root,
          captureOptions.output ??
            resolve(
              outputDirectory,
              `${String(index).padStart(3, '0')}-${checkpointSlug(checkpoint)}.png`,
            ),
        );
        let imageSaved = false;
        const expectedReady = checkpoint ?? (options.deterministic === true ? 'true' : undefined);
        const observe = captureOptions.purpose === 'observe';
        const timeoutMs = captureOptions.timeoutMs ?? 120_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
          fail(
            'browser-capture-timeout-invalid',
            'timeoutMs within (0, 120000]',
            'Pass a finite positive capture budget.',
          );
        }
        const deadline = Date.now() + timeoutMs;
        const withinBudget = async <T>(
          condition: string,
          operation: (remaining: number) => Promise<T>,
        ): Promise<T> => {
          const remaining = deadline - Date.now();
          const timeout = () =>
            new BrowserCaptureError(
              'browser-capture-timeout',
              condition,
              `Capture timed out waiting for ${condition}; inspect the run report.`,
              {
                condition,
                checkpoint: expectedReady ?? null,
                timeoutMs,
                report: reportPath,
                ...(imageSaved ? { output } : {}),
              },
            );
          if (remaining <= 0) throw timeout();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              operation(remaining),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(timeout()), remaining);
              }),
            ]);
          } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') throw timeout();
            throw error;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        };

        await withinBudget('a submitted frame', (remaining) =>
          activeRealm.waitForFunction(
            ({ afterFrameId }) => {
              const frameId =
                document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId;
              return (
                (Number.isSafeInteger(frameId) &&
                  frameId !== undefined &&
                  frameId > afterFrameId) ||
                document.querySelector('#forgeax-fatal')?.checkVisibility() === true
              );
            },
            { afterFrameId: captureOptions.afterFrameId ?? 0 },
            { timeout: remaining },
          ),
        );
        if (expectedReady !== undefined) {
          await withinBudget('the requested checkpoint', (remaining) =>
            activeRealm.waitForFunction(
              (expected) =>
                document.documentElement.dataset.forgeaxCaptureReady === expected ||
                document.querySelector('#forgeax-fatal')?.checkVisibility() === true,
              expectedReady,
              { timeout: remaining },
            ),
          );
        }
        const readFrame = async () => {
          // Native screenshots synchronize fonts and composition. A submitted image
          // must not depend on future callbacks from the game's animation scheduler.
          const image = await withinBudget('a canvas witness', () =>
            screenshotCanvasWitness(
              execution ?? { kind: 'page', ownerPage: activePage, realm: activePage },
              deadline,
              { width, height },
            ),
          );
          const runtime = await withinBudget('runtime diagnostics', () =>
            runtimeWitness(activeRealm, false),
          );
          return { ...image, runtime };
        };
        let captured = await readFrame();
        // Preserve the Canvas witness if readiness or a later settling delay fails.
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, captured.png);
        imageSaved = true;
        await updateReport();
        const waitForRendered = async () => {
          while (
            !observe &&
            !captured.pixels.rendered &&
            captured.runtime.fatalError === null &&
            Date.now() < deadline
          ) {
            try {
              await withinBudget('non-flat canvas pixels', (remaining) =>
                activeRealm.waitForTimeout(Math.min(500, remaining)),
              );
              captured = await readFrame();
            } catch (error) {
              if (error instanceof BrowserCaptureError && error.code === 'browser-capture-timeout')
                break;
              throw error;
            }
          }
        };
        await waitForRendered();
        const waitMs = captureOptions.waitMs ?? 0;
        if (waitMs > 0 && captured.runtime.fatalError === null) {
          await withinBudget('the requested delay', () => activeRealm.waitForTimeout(waitMs));
          captured = await readFrame();
          await waitForRendered();
        }
        let png = captured.png;
        let runtime = captured.runtime;
        if (observe || captured.pixels.rendered || runtime.fatalError !== null) {
          // Readiness polling must not repeatedly compose the complete page.
          // Successful/observed captures and fatal diagnostics still retain its UI.
          png = await withinBudget('a compositor screenshot', () =>
            captureBrowserExecutionSurface(
              execution ?? { kind: 'page', ownerPage: activePage, realm: activePage },
              deadline,
              { width, height },
            ),
          );
          runtime = await withinBudget('runtime diagnostics', () => runtimeWitness(activeRealm));
        }
        latestRuntime = runtime;
        const requestSummary = summarizeRequests(requestRecords, target);
        const uiPresent = runtime.domUi.rootChildren > 0;
        const requireUi = captureOptions.requireUi ?? options.requireUi ?? false;
        const captureBackend = classifyCaptureAdapter(runtime.adapter);
        if (captureBackend !== 'unknown') Object.assign(report, { backend: captureBackend });
        const backendMatches = backend === 'auto' || captureBackend === backend;
        const ok =
          runtime.canvas !== null &&
          (observe || captured.pixels.rendered) &&
          backendMatches &&
          runtime.engineFrameId !== null &&
          runtime.fatalError === null &&
          (observe || (consoleErrors.length === 0 && pageErrors.length === 0)) &&
          singleHtmlRuntimeClean(target, runtime, requestSummary) &&
          (expectedReady === undefined || runtime.captureReady === expectedReady) &&
          (!requireUi || uiPresent);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, png);
        const record: BrowserCaptureRecord = {
          index,
          checkpoint: checkpoint ?? null,
          ok,
          output,
          digest: captureDigest(png),
          pixels: captured.pixels,
          runtime,
        };
        captures.push(record);
        await updateReport();
        if (!ok) {
          fail(
            'browser-capture-runtime-failed',
            'non-flat canvas pixels, the requested browser backend/checkpoint, and no Engine or browser errors',
            'Inspect the run report and repair the first browser runtime failure.',
            { checkpoint: checkpoint ?? null, output, report: reportPath },
          );
        }
        return record;
      },
      report: () => report,
      close,
    };
  } catch (cause) {
    removePageListeners();
    await Promise.allSettled([
      browser?.close(),
      carrierAttachment?.close('engine-capture-failed'),
      display?.close(),
      server?.close(),
    ]);
    throw cause;
  }
}

export function createBrowserCapture(root: string): BrowserCapture {
  const sessions = new Set<BrowserCaptureSession>();
  return {
    async open(options) {
      const session = await openBrowserCaptureSession(root, options);
      sessions.add(session);
      return session;
    },
    async close() {
      await Promise.allSettled([...sessions].map((session) => session.close()));
      sessions.clear();
    },
  };
}

function captureCommandError(cause: unknown): CommandError {
  if (cause instanceof BrowserCaptureError) {
    return {
      code: cause.code,
      expected: cause.expected,
      hint: cause.hint,
      detail: cause.detail,
    };
  }
  return commandError(cause, 'browser-capture-failed');
}

export async function browserCaptureCommand(
  options: BrowserCaptureOptions,
): Promise<CommandResult<BrowserCaptureRunReport>> {
  const root = options.root ?? process.cwd();
  const output = resolve(root, options.output ?? 'artifacts/capture/game-ui.png');
  const browser = createBrowserCapture(root);
  let captureSession: BrowserCaptureSession | undefined;
  const artifacts = () =>
    (captureSession?.report().captures ?? []).map((record) => ({
      kind: 'png' as const,
      uri: record.output,
      mediaType: 'image/png',
      digest: record.digest,
    }));
  try {
    const backend = options.backend ?? 'auto';
    const session = await browser.open({
      backend,
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      width: options.width ?? 1280,
      height: options.height ?? 720,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.headless === undefined ? {} : { headless: options.headless }),
      ...(options.carrier === undefined ? {} : { carrier: options.carrier }),
      ...(options.carrierRun === undefined ? {} : { carrierRun: options.carrierRun }),
      ...(options.carrierGeneration === undefined
        ? {}
        : { carrierGeneration: options.carrierGeneration }),
      requireUi: options.requireUi === true,
      deterministic: options.deterministic === true,
      outputDir: dirname(output),
      report: evidencePath(output),
    });
    captureSession = session;
    await session.capture(options.deterministic === true ? 'true' : undefined, {
      output,
      waitMs: options.waitMs ?? 4000,
      requireUi: options.requireUi === true,
    });
    await session.close();
    return { ok: true, value: session.report(), artifacts: artifacts() };
  } catch (cause) {
    return { ok: false, error: captureCommandError(cause), artifacts: artifacts() };
  } finally {
    await browser.close();
  }
}
