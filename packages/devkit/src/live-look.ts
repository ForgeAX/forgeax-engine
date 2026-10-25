import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type CaptureRendererError,
  RENDERER_ERROR_RECENT_FRAMES,
} from './capture-render-failure.js';
import { type LookMetrics, lookFindings, summarizeLook } from './look-report.js';
import { parsePlayViewports } from './play-layout.js';
import type { BrowserExecutionTarget } from './tools/display-carrier.js';

/** A fixed observation camera for one look, in `dev camera set` form. */
export interface LookCamera {
  readonly name?: string;
  readonly position: readonly number[];
  readonly target: readonly number[];
  readonly up?: readonly number[];
  readonly lens?: Readonly<Record<string, unknown>>;
}

export interface LookViewport {
  readonly width: number;
  readonly height: number;
}

export interface LookRequest {
  /** Omit to look through the game camera. */
  readonly cameras?: readonly LookCamera[];
  /** Omit to keep the page's current viewport. */
  readonly viewports?: readonly LookViewport[];
  /** Hide the game's DOM UI (`#game-ui`) so the image and metrics show the scene alone. */
  readonly hideUi?: boolean;
}

export interface LookView {
  readonly name: string;
  readonly screenshot: string;
  readonly digest: string;
  readonly metrics: LookMetrics;
  readonly findings: readonly string[];
}

export interface LookResult {
  readonly views: readonly LookView[];
  /** The latest renderer error when it is recent enough to explain the frame. */
  readonly rendererError: CaptureRendererError | null;
}

/** Live-owner operations a look needs; the owner keeps the bridge and revision checks. */
export interface LookDriver {
  readonly execution: BrowserExecutionTarget;
  readonly outputDir: string;
  /** Resolves after the realm submits a frame newer than the current one; rejects after timeoutMs. */
  nextFrame(timeoutMs: number): Promise<void>;
  cameraControl(): Promise<'game' | 'observer'>;
  setCamera(camera: LookCamera): Promise<void>;
  releaseCamera(): Promise<void>;
}

export class LookRequestError extends Error {
  constructor(
    readonly code: string,
    readonly hint: string,
  ) {
    super(`${code}: ${hint}`);
    this.name = 'LookRequestError';
  }
}

const MAX_VIEWS = 8;
const FRAME_WAIT_MS = 10_000;

function isVector(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length >= 3 && value.every((item) => Number.isFinite(item));
}

function parseCamera(value: unknown): LookCamera {
  const camera = value as Partial<LookCamera> | null;
  if (camera === null || typeof camera !== 'object' || !isVector(camera.position))
    throw new LookRequestError('live-look-invalid-camera', 'Each camera needs position [x,y,z].');
  if (!isVector(camera.target))
    throw new LookRequestError('live-look-invalid-camera', 'Each camera needs target [x,y,z].');
  if (camera.up !== undefined && !isVector(camera.up))
    throw new LookRequestError('live-look-invalid-camera', 'A camera up must be [x,y,z].');
  return camera as LookCamera;
}

function parseList<T>(value: unknown, name: string, parse: (item: unknown) => T): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0)
    throw new LookRequestError(`live-look-invalid-${name}`, `--${name} expects a non-empty array.`);
  return value.map(parse);
}

/** The `project play` viewport form, `WxH[,WxH...]`. */
function parseViewports(value: unknown): readonly LookViewport[] | undefined {
  if (value === undefined) return undefined;
  const parsed = parsePlayViewports(typeof value === 'string' ? value : '');
  if (!parsed.ok) throw new LookRequestError('live-look-invalid-viewports', parsed.message);
  return parsed.value;
}

/** Validate `dev look` arguments before the live instance is touched. */
export function parseLookRequest(input: Readonly<Record<string, unknown>>): LookRequest {
  const cameras = parseList(input.cameras, 'cameras', parseCamera);
  const viewports = parseViewports(input.viewports);
  if ((cameras?.length ?? 1) * (viewports?.length ?? 1) > MAX_VIEWS)
    throw new LookRequestError(
      'live-look-too-many-views',
      `cameras x viewports is at most ${MAX_VIEWS}; split the look.`,
    );
  if (input.hideUi !== undefined && typeof input.hideUi !== 'boolean')
    throw new LookRequestError('live-look-invalid-hide-ui', '--hide-ui expects true or false.');
  return {
    ...(cameras ? { cameras } : {}),
    ...(viewports ? { viewports } : {}),
    ...(input.hideUi === true ? { hideUi: true } : {}),
  };
}

function viewName(
  index: number,
  viewport: LookViewport | undefined,
  camera: LookCamera | undefined,
  cameraIndex: number,
): string {
  const size = viewport === undefined ? 'current' : `${viewport.width}x${viewport.height}`;
  const lens = camera === undefined ? 'game' : (camera.name ?? `camera-${cameraIndex + 1}`);
  const slug = `${size}-${lens}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${String(index).padStart(2, '0')}-${slug}`;
}

function recentRendererError(error: CaptureRendererError | null): CaptureRendererError | null {
  return error !== null && error.framesAgo <= RENDERER_ERROR_RECENT_FRAMES ? error : null;
}

async function captureView(
  driver: LookDriver,
  name: string,
  extent: LookViewport,
  deadline: number,
  hideUi: boolean,
): Promise<{ readonly view: LookView; readonly rendererError: CaptureRendererError | null }> {
  // A fresh revision fades its startup overlay over the first frames; the look
  // is of the game, so wait until the generated host removes it.
  await driver.execution.realm.waitForFunction(
    () => document.querySelector('#forgeax-loading')?.checkVisibility() !== true,
    undefined,
    { timeout: Math.max(1, deadline - Date.now()) },
  );
  // Two submissions: the first may predate a resize or camera change. A
  // stalled frame loop still yields the image, flagged as possibly stale.
  const fresh = await driver
    .nextFrame(FRAME_WAIT_MS)
    .then(() => driver.nextFrame(FRAME_WAIT_MS))
    .then(
      () => true,
      () => false,
    );
  // Loaded on use, like every browser owner the live daemon reaches.
  const [{ captureBrowserExecutionSurface, runtimeWitness }, { parseImage }] = await Promise.all([
    import('./browser-capture.js'),
    import('@forgeax/engine-image/parse-image'),
  ]);
  const png = await withUiHidden(driver.execution.realm, hideUi, () =>
    captureBrowserExecutionSurface(driver.execution, deadline, extent),
  );
  const runtime = await runtimeWitness(driver.execution.realm, false);
  const decoded = parseImage(png, 'image/png', { mipmap: false });
  if (!decoded.ok) throw decoded.error;
  const metrics = summarizeLook(decoded.value.bytes, decoded.value.width, decoded.value.height);
  const rendererError = recentRendererError(runtime.rendererError);
  const blockers = [
    ...(runtime.fatalError === null ? [] : [`fatal startup page: ${runtime.fatalError}`]),
    ...(fresh ? [] : [`stalled: no new frame within ${FRAME_WAIT_MS} ms; the image may be stale`]),
  ];
  const screenshot = resolve(driver.outputDir, `${name}.png`);
  await writeFile(screenshot, png);
  return {
    view: {
      name,
      screenshot,
      digest: `sha256:${createHash('sha256').update(png).digest('hex')}`,
      metrics,
      findings: [...blockers, ...lookFindings(metrics, rendererError)],
    },
    rendererError,
  };
}

async function withUiHidden<T>(
  realm: BrowserExecutionTarget['realm'],
  hide: boolean,
  capture: () => Promise<T>,
): Promise<T> {
  const toggle = (hidden: boolean) =>
    realm.evaluate((value) => {
      const root = document.querySelector<HTMLElement>('#game-ui');
      if (root === null) return;
      if (value) root.style.setProperty('visibility', 'hidden', 'important');
      else root.style.removeProperty('visibility');
    }, hidden);
  if (!hide) return capture();
  await toggle(true);
  try {
    return await capture();
  } finally {
    await toggle(false).catch(() => undefined);
  }
}

async function assertLookAdmissible(driver: LookDriver, request: LookRequest): Promise<void> {
  if (
    request.viewports !== undefined &&
    (driver.execution.kind !== 'page' || driver.execution.ownerPage.viewportSize() === null)
  )
    throw new LookRequestError(
      'live-look-viewport-unavailable',
      'Only a headless dev page (dev start --headless true) can change size; omit --viewports.',
    );
  if (request.cameras !== undefined && (await driver.cameraControl()) === 'observer')
    throw new LookRequestError(
      'live-look-camera-held',
      'An observation camera is held; run dev camera release first or omit --cameras.',
    );
}

/**
 * Capture the current live frame once per viewport x camera, each after fresh
 * submissions, then restore the page size and return control to the game camera.
 */
export async function lookAtLive(
  driver: LookDriver,
  request: LookRequest,
  timeoutMs = 60_000,
): Promise<LookResult> {
  await assertLookAdmissible(driver, request);
  await mkdir(driver.outputDir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const page = driver.execution.ownerPage;
  // Headed native windows (viewport null) are only captured at their own size.
  const original = page.viewportSize() ?? (await currentViewport(page));
  const views: LookView[] = [];
  let rendererError: CaptureRendererError | null = null;
  try {
    for (const viewport of request.viewports ?? [undefined]) {
      if (viewport !== undefined) await page.setViewportSize(viewport);
      const cameras = request.cameras ?? [undefined];
      for (const [cameraIndex, camera] of cameras.entries()) {
        if (camera !== undefined) await driver.setCamera(camera);
        const name = viewName(views.length + 1, viewport, camera, cameraIndex);
        const extent = viewport ?? original;
        const captured = await captureView(driver, name, extent, deadline, request.hideUi === true);
        views.push(captured.view);
        rendererError ??= captured.rendererError;
      }
    }
  } finally {
    if (request.cameras !== undefined) await driver.releaseCamera().catch(() => undefined);
    if (request.viewports !== undefined)
      await page.setViewportSize(original).catch(() => undefined);
  }
  return { views, rendererError };
}

async function currentViewport(page: BrowserExecutionTarget['ownerPage']): Promise<LookViewport> {
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}
