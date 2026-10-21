import { createProfiler } from '@forgeax/engine-profiler';
import {
  buildTapeIndex,
  decodeTape,
  decodeToRgba8,
  openReplay,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import {
  type ArtifactRef,
  createPreviewArtifactManifest,
  type PreviewArtifactManifest,
  type SnapshotRef,
  type ToolTiming,
} from '@forgeax/engine-tool-runtime';
import { encodeBase64, err, ok, type Result } from '@forgeax/engine-types';
import { createApp } from '../browser';
import { createBrowserRhiDebugRuntime } from '../internal/browser-rhi-debug-runtime';
import type { App, BundlerOptions, CreateAppOptions } from '../types';
import {
  createToolPreviewRecipe,
  type ToolPreviewAction,
  type ToolPreviewRecipe,
  type ToolPreviewTrace,
} from './recipe';

export type ToolPreviewResourceKind = 'material' | 'mesh' | 'texture' | 'vfx';

export interface ToolPreviewResourceRequest {
  readonly kind: ToolPreviewResourceKind;
  readonly guid: string;
  readonly size?: number;
}

export interface ToolPreviewResourceFacts
  extends Pick<ToolPreviewResourceRequest, 'kind' | 'guid'> {
  readonly asset: unknown;
  readonly digest?: string;
  readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
  readonly observation?: Readonly<Record<string, string | number | boolean | readonly number[]>>;
}

export interface ToolPreviewHostOptions {
  readonly runId?: string;
  readonly recipe: ToolPreviewRecipe;
  readonly snapshot: SnapshotRef;
  readonly canvas?: HTMLCanvasElement;
  readonly root?: Document | HTMLElement;
  readonly app?: Omit<CreateAppOptions, 'rhi'>;
  readonly bundler?: BundlerOptions;
  readonly resource?: ToolPreviewResourceRequest;
  readonly prepare?: (
    app: App,
  ) => void | ToolPreviewResourceFacts | Promise<void | ToolPreviewResourceFacts>;
  /** Refresh producer-owned resource facts after the bounded real frame run. */
  readonly collectResourceFacts?: (
    app: App,
    current: ToolPreviewResourceFacts | undefined,
  ) => void | ToolPreviewResourceFacts | Promise<void | ToolPreviewResourceFacts>;
  /** Dispose producer-owned preview attachments before the App. */
  readonly onDispose?: (app: App) => void | Promise<void>;
  readonly executeAction?: (action: ToolPreviewAction, app: App) => boolean | Promise<boolean>;
}

export interface ToolPreviewHostError {
  readonly code: 'tool-preview-capability-unavailable' | 'tool-preview-bootstrap-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly phase: string; readonly cause?: unknown };
}

export interface ToolPreviewHost {
  readonly app: App;
  readonly recipe: ToolPreviewRecipe;
  readonly trace: ToolPreviewTrace;
  capture(): Promise<Result<ToolPreviewCaptureResult, ToolPreviewHostError>>;
  run(): Promise<Result<ToolPreviewRunResult, ToolPreviewHostError>>;
  dispose(): Promise<Result<void, ToolPreviewHostError>>;
}

export interface ToolPreviewCaptureResult {
  readonly recipe: ToolPreviewRecipe;
  readonly snapshot: SnapshotRef;
  readonly trace: ToolPreviewTrace;
  readonly captureId: string;
  readonly actionTrace: readonly ToolPreviewAction[];
  readonly tape: {
    readonly runId: string;
    readonly jsonUri: string;
    readonly blobUri: string;
    readonly byteLength: number;
  };
  readonly profile: { readonly captureId: string; readonly uri: string };
  readonly capturePng: { readonly uri: string; readonly width: number; readonly height: number };
  readonly executeDurationMs: number;
  readonly captureDurationMs: number;
  readonly browserJsHeapBytes?: number;
  readonly appErrors: readonly unknown[];
  readonly resource?: ToolPreviewResourceFacts;
}

export interface ToolPreviewRunResult
  extends Pick<
    ToolPreviewCaptureResult,
    'trace' | 'captureId' | 'actionTrace' | 'tape' | 'profile' | 'capturePng' | 'resource'
  > {
  readonly drawCalls: number;
  readonly committedDrawIndex: number;
  readonly nonBlackPixels: number;
  readonly png: ToolPreviewCaptureResult['capturePng'];
  readonly manifest: PreviewArtifactManifest;
  readonly artifacts: readonly ArtifactRef[];
  readonly operationTiming: ToolTiming;
}

function layoutCanvas(canvas: HTMLCanvasElement, recipe: ToolPreviewRecipe): void {
  canvas.width = recipe.viewport.width;
  canvas.height = recipe.viewport.height;
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = `${recipe.viewport.width}px`;
  canvas.style.height = `${recipe.viewport.height}px`;
  canvas.style.opacity = '1';
  canvas.style.visibility = 'visible';
  canvas.style.pointerEvents = 'auto';
}

function appendCanvas(canvas: HTMLCanvasElement, root: Document | HTMLElement | undefined): void {
  if (canvas.isConnected) return;
  const parent =
    typeof Document !== 'undefined' && root instanceof Document
      ? root.body
      : (root ?? (typeof document === 'undefined' ? undefined : document.body));
  parent?.appendChild(canvas);
}

function removeOwnedCanvas(canvas: HTMLCanvasElement, owned: boolean): void {
  if (owned && canvas.isConnected) canvas.remove();
}

function bytesToDataUri(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${encodeBase64(bytes)}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer as ArrayBuffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function dataUriBytes(uri: string): Uint8Array {
  const encoded = uri.slice(uri.indexOf(',') + 1);
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function generateRunId(): string {
  return `preview-${crypto.randomUUID()}`;
}

function countDrawCalls(tape: V7Tape): number {
  return buildTapeIndex(tape).works.filter((work) => isRenderDraw(work.kind)).length;
}

function lastRenderDrawIndex(tape: V7Tape): number {
  const works = buildTapeIndex(tape).works;
  return works.reduce((last, work) => (isRenderDraw(work.kind) ? work.workIndex : last), -1);
}

function isRenderDraw(kind: ReturnType<typeof buildTapeIndex>['works'][number]['kind']): boolean {
  return (
    kind === 'draw' ||
    kind === 'drawIndexed' ||
    kind === 'drawIndirect' ||
    kind === 'drawIndexedIndirect'
  );
}

function resourceSubjectDigest(resource: ToolPreviewResourceFacts | undefined): string | undefined {
  if (resource === undefined) return undefined;
  const asset =
    typeof resource.asset === 'object' && resource.asset !== null
      ? (resource.asset as Record<string, unknown>)
      : undefined;
  const candidates = [
    resource.observation?.subjectDigest,
    resource.digest,
    asset?.digest,
    asset?.programFingerprint,
  ];
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
}

const TOOL_PREVIEW_SUBJECT_DRAW_MINIMUMS: Readonly<Record<ToolPreviewResourceKind, number>> = {
  material: 2,
  mesh: 0,
  texture: 0,
  vfx: 2,
};

/**
 * Apply the shared preview draw policy to tape and native evidence. Mesh and
 * texture previews accept one render draw; material previews retain the
 * two-draw canonical-only guard.
 */
export function toolPreviewSubjectDrawn(kind: ToolPreviewResourceKind, drawCalls: number): boolean {
  return drawCalls > TOOL_PREVIEW_SUBJECT_DRAW_MINIMUMS[kind];
}

function resourceSubjectDrawn(resource: ToolPreviewResourceFacts, drawCalls: number): boolean {
  if (resource.kind !== 'vfx') return toolPreviewSubjectDrawn(resource.kind, drawCalls);
  return resource.observation !== undefined;
}

function isPreviewCapabilityUnavailable(cause: unknown): cause is {
  readonly code: 'tool-preview-capability-unavailable';
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: unknown;
} {
  return (
    cause !== null &&
    typeof cause === 'object' &&
    (cause as { readonly code?: unknown }).code === 'tool-preview-capability-unavailable'
  );
}

const TOOL_PREVIEW_FRAME_CREDIT_TIMEOUT_MS = 30_000;

/**
 * Deterministic preview stepping shares the App frame authority with rAF.
 * Renderer receipts are asynchronous, so a paused sequence must yield and
 * retry when the authority reports exhausted frame credit.
 */
export async function stepToolPreviewFrame(
  app: App,
  deltaSeconds: number,
): Promise<ReturnType<App['stepFrame']>> {
  const startedAtMs = performance.now();
  for (;;) {
    const stepped = app.stepFrame(deltaSeconds);
    if (stepped.ok) return stepped;
    if (
      stepped.error.code !== 'app-frame-step-invalid' ||
      stepped.error.detail.reason !== 'credit'
    ) {
      return stepped;
    }
    if (performance.now() - startedAtMs >= TOOL_PREVIEW_FRAME_CREDIT_TIMEOUT_MS) return stepped;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

export async function replayToolPreviewCapture(
  capture: ToolPreviewCaptureResult,
): Promise<Result<ToolPreviewRunResult, ToolPreviewHostError>> {
  const analyzeStartedAtMs = performance.now();
  const tapeBytes = dataUriBytes(capture.tape.jsonUri);
  const parsed = decodeTape(tapeBytes);
  if (!parsed.ok) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the finalized tape to deserialize for fresh-device replay',
      hint: parsed.error.hint,
      detail: { phase: 'tape-parse', cause: parsed.error },
    });
  }
  const drawCalls = countDrawCalls(parsed.value);
  const resource =
    capture.resource !== undefined &&
    capture.resource.kind !== 'texture' &&
    capture.resource.observation === undefined &&
    capture.resource.ownerFacts !== undefined &&
    resourceSubjectDrawn(capture.resource, drawCalls)
      ? { ...capture.resource, observation: capture.resource.ownerFacts }
      : capture.resource;
  const subjectDigest = resourceSubjectDigest(resource);
  if (resource !== undefined && subjectDigest === undefined) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the resource owner to publish a subject identity before evidence publication',
      hint: 'repair AssetRegistry owner facts or post-frame observation; recipe and trace are not subject identity',
      detail: {
        phase: 'resource-identity',
        cause: {
          kind: resource.kind,
          drawCalls,
          ownerFactsPublished: resource.ownerFacts !== undefined,
          observationPublished: resource.observation !== undefined,
        },
      },
    });
  }
  let runtime: Awaited<ReturnType<typeof createBrowserRhiDebugRuntime>>;
  try {
    runtime = await createBrowserRhiDebugRuntime();
  } catch (cause) {
    return err({
      code: 'tool-preview-capability-unavailable',
      expected: 'a fresh browser WebGPU runtime for offline replay',
      hint: 'Run replay in an isolated browser process; do not reuse the capture device.',
      detail: { phase: 'replay-runtime', cause },
    });
  }
  const replayDevice = await runtime.createReplayDevice(parsed.value);
  if (!replayDevice.ok) {
    return err({
      code: 'tool-preview-capability-unavailable',
      expected: 'a fresh WebGPU device for offline replay',
      hint: 'the capture device cannot be reused as a substitute for fresh-device replay',
      detail: { phase: 'replay-device', cause: replayDevice.error },
    });
  }
  const replayResult = await openReplay(parsed.value, {
    device: replayDevice.value,
    createShaderModule: runtime.createShaderModule,
  });
  if (!replayResult.ok) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the self-contained tape to replay on a fresh WebGPU device',
      hint: replayResult.error.hint,
      detail: { phase: 'replay-create', cause: replayResult.error },
    });
  }
  const replay = replayResult.value;
  if (drawCalls === 0) {
    await replay.dispose();
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the preview recipe to submit at least one render draw',
      hint: 'seed a visible mesh and camera before capturing the preview frame',
      detail: { phase: 'replay-draws', cause: { appErrors: capture.appErrors } },
    });
  }
  const committedDrawIndex = lastRenderDrawIndex(parsed.value);
  if (committedDrawIndex < 0) {
    await replay.dispose();
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the preview tape to contain a render draw after compute work',
      hint: 'seed a visible render output after simulation dispatches before capturing the preview frame',
      detail: { phase: 'replay-draws', cause: { appErrors: capture.appErrors } },
    });
  }
  const committed = await replay.inspectWork(committedDrawIndex, ['pixels']);
  if (!committed.ok || committed.value.attachment === undefined) {
    await replay.dispose();
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the fresh replay session to expose a color attachment for the final render work',
      hint: committed.ok
        ? 'the tape contains no readable color attachment for PNG evidence'
        : committed.error.hint,
      detail: { phase: 'replay-inspect', cause: committed.ok ? undefined : committed.error },
    });
  }
  const attachment = committed.value.attachment;
  const width = attachment.width ?? 0;
  const height = attachment.height ?? 0;
  const rgba =
    attachment.format === undefined
      ? undefined
      : decodeToRgba8(attachment.bytes, attachment.format, width, height);
  if (rgba === null || rgba === undefined || width <= 0 || height <= 0) {
    await replay.dispose();
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the replayed color attachment to have a supported display format',
      hint: 'move PNG encoding to the producer-owned preview shell for unsupported formats',
      detail: { phase: 'png-readback', cause: { format: attachment.format, width, height } },
    });
  }
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext('2d');
  if (outputContext === null) {
    await replay.dispose();
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the browser to provide a 2D canvas context for replay PNG encoding',
      hint: 'enable the browser canvas 2D context before running the preview host',
      detail: { phase: 'png-encode' },
    });
  }
  outputContext.putImageData(new ImageData(rgba, width, height), 0, 0);
  await replay.dispose();
  const pixels = outputContext.getImageData(0, 0, width, height).data;
  let nonBlackPixels = 0;
  if (pixels !== undefined) {
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if ((pixels[offset] ?? 0) + (pixels[offset + 1] ?? 0) + (pixels[offset + 2] ?? 0) > 0) {
        nonBlackPixels += 1;
      }
    }
  }
  if (nonBlackPixels === 0) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the replayed PNG to contain non-black pixels',
      hint: 'inspect the RHI tape and renderer draw submission before accepting the preview',
      detail: { phase: 'png-non-black' },
    });
  }
  const analyzeDurationMs = performance.now() - analyzeStartedAtMs;
  const finalizeStartedAtMs = performance.now();
  const pngUri = outputCanvas.toDataURL('image/png');
  const pngBytes = dataUriBytes(pngUri);
  if (
    !capture.capturePng.uri.startsWith('data:image/png') ||
    capture.capturePng.width <= 0 ||
    capture.capturePng.height <= 0
  ) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the capture browser to provide a PNG before fresh replay',
      hint: 'capture the rendered canvas before closing the capture carrier; do not reuse the replay PNG',
      detail: { phase: 'capture-png' },
    });
  }
  const capturePngBytes = dataUriBytes(capture.capturePng.uri);
  if (capturePngBytes.byteLength === 0) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the capture PNG to contain encoded bytes',
      hint: 'repair the capture carrier readback before publishing evidence',
      detail: { phase: 'capture-png' },
    });
  }
  const profileBytes = dataUriBytes(capture.profile.uri);
  const tapeDigest = await sha256(tapeBytes);
  const capturePngDigest = await sha256(capturePngBytes);
  const pngDigest = await sha256(pngBytes);
  const profileDigest = await sha256(profileBytes);
  const presentationDigest = await sha256(new TextEncoder().encode(capture.trace.presentation));
  const manifest = createPreviewArtifactManifest({
    schemaVersion: '2.0.0',
    identity: {
      runId: capture.tape.runId,
      snapshotDigest: capture.snapshot.digest,
      subjectDigest: subjectDigest ?? capture.snapshot.digest,
      presentationDigest,
      frameId: 0,
      captureId: capture.captureId,
    },
    artifacts: [
      {
        owner: 'rhi-debug',
        kind: 'rhi-tape',
        role: 'rhi-tape',
        uri: capture.tape.jsonUri,
        digest: tapeDigest,
        byteLength: tapeBytes.byteLength,
        mediaType: 'application/json',
        derivedFrom: [],
      },
      {
        owner: 'visual',
        kind: 'png',
        role: 'capture',
        uri: capture.capturePng.uri,
        digest: capturePngDigest,
        byteLength: capturePngBytes.byteLength,
        mediaType: 'image/png',
        derivedFrom: [tapeDigest],
      },
      {
        owner: 'rhi-debug-replay',
        kind: 'png',
        role: 'fresh-replay',
        uri: pngUri,
        digest: pngDigest,
        byteLength: pngBytes.byteLength,
        mediaType: 'image/png',
        derivedFrom: [tapeDigest, capturePngDigest],
      },
      {
        owner: 'profiler',
        kind: 'profile-capture',
        role: 'profile-capture',
        uri: capture.profile.uri,
        digest: profileDigest,
        byteLength: profileBytes.byteLength,
        mediaType: 'application/json',
        derivedFrom: [],
      },
    ],
  });
  const finalizeDurationMs = performance.now() - finalizeStartedAtMs;
  const durationMs =
    capture.executeDurationMs + capture.captureDurationMs + analyzeDurationMs + finalizeDurationMs;
  const memory = (
    performance as Performance & {
      readonly memory?: { readonly usedJSHeapSize?: number };
    }
  ).memory?.usedJSHeapSize;
  const browserJsHeapBytes =
    typeof memory === 'number' && Number.isFinite(memory) && memory >= 0
      ? Math.max(Math.round(memory), capture.browserJsHeapBytes ?? 0)
      : capture.browserJsHeapBytes;
  return ok({
    trace: capture.trace,
    captureId: capture.captureId,
    drawCalls,
    committedDrawIndex,
    nonBlackPixels,
    actionTrace: capture.actionTrace,
    tape: capture.tape,
    profile: capture.profile,
    capturePng: capture.capturePng,
    png: { uri: pngUri, width: outputCanvas.width, height: outputCanvas.height },
    manifest,
    artifacts: manifest.artifacts.flatMap((artifact) => {
      if (
        artifact.kind !== 'rhi-tape' &&
        artifact.kind !== 'png' &&
        artifact.kind !== 'profile-capture'
      ) {
        return [];
      }
      return [
        {
          kind: artifact.kind,
          digest: artifact.digest,
          uri: artifact.uri,
          sizeBytes: artifact.byteLength,
        },
      ];
    }),
    operationTiming: {
      startedAtMs: 0,
      endedAtMs: durationMs,
      durationMs,
      phases: {
        lookup: { status: 'not-applicable' },
        lease: { status: 'not-applicable' },
        transport: { status: 'not-applicable' },
        execute: {
          status: 'observed',
          durationMs: capture.executeDurationMs,
          workUnits: capture.recipe.frames,
        },
        capture: { status: 'observed', durationMs: capture.captureDurationMs },
        finalize: { status: 'observed', durationMs: finalizeDurationMs },
        analyze: { status: 'observed', durationMs: analyzeDurationMs },
      },
      unattributedMs: 0,
      resources: {
        'node-rss': { status: 'not-applicable' },
        'browser-js-heap':
          browserJsHeapBytes === undefined
            ? { status: 'unavailable', reason: 'performance.memory is not exposed' }
            : {
                status: 'observed',
                bytes: browserJsHeapBytes,
                source: 'maximum performance.memory.usedJSHeapSize across capture and replay',
              },
        'artifact-bytes': {
          status: 'observed',
          bytes:
            tapeBytes.byteLength +
            dataUriBytes(capture.capturePng.uri).byteLength +
            pngBytes.byteLength +
            profileBytes.byteLength,
          source: 'browser-produced artifact payloads',
        },
        'gpu-memory': {
          status: 'unavailable',
          reason: 'WebGPU does not expose portable allocation totals',
        },
      },
    },
    ...(resource === undefined ? {} : { resource }),
  });
}

export async function createToolPreviewHost(
  options: ToolPreviewHostOptions,
): Promise<Result<ToolPreviewHost, ToolPreviewHostError>> {
  const recipe = createToolPreviewRecipe(options.recipe);
  const runId = options.runId ?? generateRunId();
  const doc = options.root ?? (typeof document === 'undefined' ? undefined : document);
  if (options.canvas === undefined && doc === undefined) {
    return err({
      code: 'tool-preview-capability-unavailable',
      expected: 'a DOM document or caller-owned HTMLCanvasElement',
      hint: 'run the browser host or provide an attached canvas; headless does not mean RHI-null',
      detail: { phase: 'canvas' },
    });
  }
  const canvas =
    options.canvas ??
    (typeof Document !== 'undefined' && doc instanceof Document
      ? doc.createElement('canvas')
      : undefined);
  const ownsCanvas = options.canvas === undefined;
  if (canvas === undefined) {
    return err({
      code: 'tool-preview-capability-unavailable',
      expected: 'root document can create an HTMLCanvasElement',
      hint: 'provide a document root or an existing canvas',
      detail: { phase: 'canvas' },
    });
  }
  layoutCanvas(canvas, recipe);
  appendCanvas(canvas, options.root);
  if (!canvas.isConnected) {
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'preview canvas is connected before App creation',
      hint: 'attach the canvas to the document or pass a connected caller-owned canvas',
      detail: { phase: 'canvas' },
    });
  }

  let runtime: Awaited<ReturnType<typeof createBrowserRhiDebugRuntime>>;
  try {
    runtime = await createBrowserRhiDebugRuntime();
  } catch (cause) {
    removeOwnedCanvas(canvas, ownsCanvas);
    return err({
      code: 'tool-preview-capability-unavailable',
      expected: 'a real WebGPU adapter and device',
      hint: 'install or enable WebGPU; do not replace this route with RHI-null',
      detail: { phase: 'rhi-debug', cause },
    });
  }
  const profiler = createProfiler();
  const appResult = await createApp(
    canvas,
    {
      ...(options.app ?? {}),
      rhi: runtime.rhi,
      rhiInstrumentation: runtime.rhiInstrumentation,
      profiler,
    },
    options.bundler,
  );
  if (!appResult.ok) {
    await runtime.attachment.dispose();
    removeOwnedCanvas(canvas, ownsCanvas);
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'createApp constructs a real WebGPU Renderer',
      hint: 'inspect the structured App/RHI error; the preview must not fall back to RHI-null',
      detail: { phase: 'renderer', cause: appResult.error },
    });
  }
  const app = appResult.value;
  const appErrors: unknown[] = [];
  const unsubscribeAppErrors = app.onError((error) => appErrors.push(error));
  let resourceFacts: ToolPreviewResourceFacts | undefined;
  try {
    const prepared = await options.prepare?.(app);
    if (prepared !== undefined) resourceFacts = prepared;
  } catch (cause) {
    unsubscribeAppErrors();
    await app.dispose();
    await runtime.attachment.dispose();
    removeOwnedCanvas(canvas, ownsCanvas);
    const bootstrapFailure =
      options.resource === undefined
        ? {
            expected: 'the project bootstrap to prepare the preview World',
            hint: 'Repair the project Entry, assets, or scene before retrying the same recipe.',
            phase: 'project-bootstrap',
          }
        : {
            expected: 'the resource preview bootstrap to prepare the preview World',
            hint: 'Repair the resource owner, cooked payload, or preview environment before retrying the same recipe.',
            phase: 'resource-bootstrap',
          };
    return err({
      code: isPreviewCapabilityUnavailable(cause)
        ? 'tool-preview-capability-unavailable'
        : 'tool-preview-bootstrap-failed',
      expected: isPreviewCapabilityUnavailable(cause)
        ? (cause.expected ?? 'the preview resource capability')
        : bootstrapFailure.expected,
      hint: isPreviewCapabilityUnavailable(cause)
        ? (cause.hint ??
          'Use a supported preview representation or inspect the producer limitation.')
        : bootstrapFailure.hint,
      detail: {
        phase: bootstrapFailure.phase,
        cause: isPreviewCapabilityUnavailable(cause) ? (cause.detail ?? cause) : cause,
      },
    });
  }
  const attached = app.renderer.attach(app.world);
  if (!attached.ok) {
    unsubscribeAppErrors();
    await app.dispose();
    await runtime.attachment.dispose();
    removeOwnedCanvas(canvas, ownsCanvas);
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the preview World to attach to the real Renderer before stepping',
      hint: attached.error.hint,
      detail: { phase: 'world-attach', cause: attached.error },
    });
  }
  const profileSession = profiler.startCapture({ frameLimit: recipe.frames, eventLimit: 1024 });
  if (!profileSession.ok) {
    await app.dispose();
    await runtime.attachment.dispose();
    removeOwnedCanvas(canvas, ownsCanvas);
    return err({
      code: 'tool-preview-bootstrap-failed',
      expected: 'the App profiler to start a bounded capture',
      hint: profileSession.error.hint,
      detail: { phase: 'profiler', cause: profileSession.error },
    });
  }
  const detach = runtime.attachRenderer(app.renderer);
  const trace: ToolPreviewTrace = {
    events: ['canvas-created', 'rhi-debug-armed', 'renderer-created'],
    presentation: recipe.presentation,
  };
  let disposed = false;
  const capturePreview = async (): Promise<
    Result<ToolPreviewCaptureResult, ToolPreviewHostError>
  > => {
    if (disposed) {
      return err({
        code: 'tool-preview-bootstrap-failed',
        expected: 'preview host remains alive until capture completes',
        hint: 'create a new preview host after dispose',
        detail: { phase: 'capture' },
      });
    }
    const started = app.start();
    if (!started.ok)
      return err({
        ...started.error,
        code: 'tool-preview-bootstrap-failed',
        detail: { phase: 'start', cause: started.error },
      });
    const paused = app.pause();
    if (!paused.ok)
      return err({
        ...paused.error,
        code: 'tool-preview-bootstrap-failed',
        detail: { phase: 'pause', cause: paused.error },
      });
    const executeStartedAtMs = performance.now();
    const actionTrace: ToolPreviewAction[] = [];
    let encodedCapture: ReturnType<typeof runtime.attachment.captureFrame> | undefined;
    for (let frame = 0; frame < recipe.frames; frame += 1) {
      for (const action of recipe.actions.filter((candidate) => candidate.frame === frame)) {
        let accepted = false;
        try {
          accepted = (await options.executeAction?.(action, app)) === true;
        } catch (cause) {
          return err({
            code: 'tool-preview-bootstrap-failed',
            expected: `project action '${action.name}' to execute at frame ${frame}`,
            hint: 'Repair the project-owned preview action handler and rerun the same recipe.',
            detail: { phase: 'action', cause },
          });
        }
        if (!accepted) {
          return err({
            code: 'tool-preview-bootstrap-failed',
            expected: `project action '${action.name}' to have a registered handler`,
            hint: 'Register the action in the project plugin or remove it from the recipe.',
            detail: { phase: 'action', cause: { frame, name: action.name } },
          });
        }
        actionTrace.push(action);
      }
      if (frame === recipe.frames - 1) {
        encodedCapture = runtime.attachment.captureFrame();
        const snapshot = await runtime.attachment.frameBoundary();
        if (!snapshot.ok)
          return err({
            code: 'tool-preview-bootstrap-failed',
            expected: 'RHI-debug snapshots live resources before the captured frame',
            hint: snapshot.error.hint,
            detail: { phase: 'rhi-snapshot', cause: snapshot.error },
          });
      }
      const stepped = await stepToolPreviewFrame(app, recipe.deltaSeconds);
      if (!stepped.ok)
        return err({
          ...stepped.error,
          code: 'tool-preview-bootstrap-failed',
          detail: { phase: 'frame', cause: stepped.error },
        });
      // Render features may start an asynchronous shader/module bake on their
      // first prepare pass. Yield once between bounded frames so the bake can
      // settle before the next retry; a synchronous tight loop would capture
      // only the feature's intentional `next-frame` pending state.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const finalized = await runtime.attachment.frameBoundary();
    if (!finalized.ok)
      return err({
        code: 'tool-preview-bootstrap-failed',
        expected: 'RHI-debug finalizes the captured frame',
        hint: finalized.error.hint,
        detail: { phase: 'rhi-finalize', cause: finalized.error },
      });
    if (options.collectResourceFacts !== undefined) {
      try {
        const collected = await options.collectResourceFacts(app, resourceFacts);
        if (collected !== undefined) resourceFacts = collected;
      } catch (cause) {
        return err({
          code: 'tool-preview-bootstrap-failed',
          expected: 'the resource owner to publish post-frame preview facts',
          hint: 'Repair the producer-owned preview observation and retry the same recipe.',
          detail: { phase: 'resource-observation', cause },
        });
      }
    }
    const executeDurationMs = performance.now() - executeStartedAtMs;
    const finalTrace: ToolPreviewTrace = {
      ...trace,
      events: [...trace.events, 'world-updated', 'draw-submitted', 'validation-complete'],
    };
    const captureStartedAtMs = performance.now();
    const profile = profileSession.value.finish();
    if (!profile.ok) {
      return err({
        code: 'tool-preview-bootstrap-failed',
        expected: 'the bounded App profiler to finish with ProfileCapture',
        hint: profile.error.hint,
        detail: { phase: 'profiler-finish', cause: profile.error },
      });
    }
    if (encodedCapture === undefined) {
      return err({
        code: 'tool-preview-bootstrap-failed',
        expected: 'a positive-frame recipe to arm one captured frame',
        hint: 'validate the recipe before running the preview host',
        detail: { phase: 'rhi-capture' },
      });
    }
    const tape = await encodedCapture;
    if (!tape.ok)
      return err({
        code: 'tool-preview-bootstrap-failed',
        expected: 'RHI-debug produces a self-contained tape',
        hint: tape.error.hint,
        detail: { phase: 'rhi-finalize', cause: tape.error },
      });
    const captureDurationMs = performance.now() - captureStartedAtMs;
    const tapeBytes = tape.value.bytes;
    const profileBytes = new TextEncoder().encode(JSON.stringify(profile.value));
    const capturePng = {
      uri: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
    };
    const memory = (
      performance as Performance & {
        readonly memory?: { readonly usedJSHeapSize?: number };
      }
    ).memory?.usedJSHeapSize;
    return ok({
      recipe,
      snapshot: options.snapshot,
      trace: finalTrace,
      captureId: profile.value.captureId,
      actionTrace,
      tape: {
        runId,
        jsonUri: bytesToDataUri(tapeBytes, 'application/octet-stream'),
        blobUri: bytesToDataUri(new Uint8Array(), 'application/octet-stream'),
        byteLength: tapeBytes.byteLength,
      },
      profile: {
        captureId: profile.value.captureId,
        uri: bytesToDataUri(profileBytes, 'application/json'),
      },
      capturePng,
      executeDurationMs,
      captureDurationMs,
      ...(typeof memory === 'number' && Number.isFinite(memory) && memory >= 0
        ? { browserJsHeapBytes: Math.round(memory) }
        : {}),
      appErrors,
      ...(resourceFacts === undefined ? {} : { resource: resourceFacts }),
    });
  };
  return ok({
    app,
    recipe,
    trace,
    capture: capturePreview,
    async run() {
      const capture = await capturePreview();
      if (!capture.ok) return capture;
      return replayToolPreviewCapture(capture.value);
    },
    async dispose() {
      if (disposed) return ok(undefined);
      disposed = true;
      detach();
      unsubscribeAppErrors();
      let disposeError: unknown;
      try {
        await options.onDispose?.(app);
      } catch (cause) {
        disposeError = cause;
      }
      const result = await app.dispose();
      removeOwnedCanvas(canvas, ownsCanvas);
      if (disposeError !== undefined) {
        return err({
          code: 'tool-preview-bootstrap-failed',
          expected: 'producer-owned preview attachments to dispose before the App',
          hint: 'Repair the preview owner lifecycle and retry the same operation.',
          detail: { phase: 'producer-dispose', cause: disposeError },
        });
      }
      return result.ok
        ? ok(undefined)
        : err({
            code: 'tool-preview-bootstrap-failed',
            expected: 'preview app disposes cleanly',
            hint: result.error.hint,
            detail: { phase: 'dispose', cause: result.error },
          });
    },
  });
}
