import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createToolPreviewRecipe, toolPreviewSubjectDrawn } from '@forgeax/engine-app';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import {
  Context,
  createContextCapabilityResolver,
  createToolApiPlugin,
  startNativePlugin,
} from '@forgeax/engine-plugin';
import {
  createPreviewHost,
  type PreviewHostMechanisms,
  type PreviewRenderRuntime,
  RESOURCE_PREVIEW_DEFAULT_SIZE,
} from '@forgeax/engine-preview';
import type {
  ArtifactRef,
  JsonValue,
  SnapshotRef,
  ToolApi,
  ToolContribution,
  ToolRunOptions,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { domainFailureError } from '@forgeax/engine-tool-runtime';
import { readCatalogRows } from '@forgeax/engine-types';
import { assetInspectCommand } from '../assets.js';
import { readProjectFacts } from '../project.js';
import type { CaptureBackend } from '../types.js';
import {
  type BrowserHostResult,
  publishPreviewArtifacts,
  type ResourcePreviewReportInput,
  runBrowserResourcePreviewHost,
} from './browser-host.js';
import { createNativePreviewPlugin, nativePreviewPlugins } from './preview-catalog.js';
import type { PreviewHostResult } from './preview-host.js';

const DEFAULT_NATIVE_PREVIEW_TIMEOUT_MS = 120_000;

export interface NativePreviewOptions {
  readonly backend?: CaptureBackend;
  readonly headless?: boolean;
  readonly width?: number;
  readonly height?: number;
  /** Copy the validated fresh-replay PNG to this project-relative path. */
  readonly output?: string;
}

interface NativePreviewCatalogRow {
  readonly guid?: unknown;
  readonly lifecycle?: unknown;
  readonly projection?: unknown;
  readonly publication?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function adapterUnavailable(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  return (
    (isRecord(value) && value.code === 'adapter-unavailable') ||
    Object.values(value).some((nested) => adapterUnavailable(nested, depth + 1))
  );
}

type PreviewCatalogLookup =
  | { readonly ok: true; readonly row: NativePreviewCatalogRow | undefined }
  | { readonly ok: false; readonly code: string; readonly detail: Record<string, unknown> };

async function readPreviewCatalogRow(root: string, guid: string): Promise<PreviewCatalogLookup> {
  const indexPath = resolve(root, 'dist', 'pack-index.json');
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, row: undefined };
    }
    return {
      ok: false,
      code: 'asset-index-unreadable',
      detail: { indexPath, reason: cause instanceof Error ? cause.message : String(cause) },
    };
  }
  let parsed: unknown;
  try {
    const decoded = decodeCatalogWire(JSON.parse(raw));
    if (!decoded.ok) {
      return {
        ok: false,
        code: 'asset-index-invalid',
        detail: { indexPath, code: decoded.error.code, detail: decoded.error.detail },
      };
    }
    parsed = decoded.value;
  } catch (cause) {
    return {
      ok: false,
      code: 'asset-index-invalid',
      detail: { indexPath, reason: cause instanceof Error ? cause.message : String(cause) },
    };
  }
  const rows = readCatalogRows(parsed);
  if (rows === undefined) {
    return { ok: false, code: 'asset-index-invalid', detail: { indexPath, actual: typeof parsed } };
  }
  const row = rows.find(
    (candidate): candidate is NativePreviewCatalogRow =>
      isRecord(candidate) &&
      typeof candidate.guid === 'string' &&
      candidate.guid.toLowerCase() === guid.toLowerCase(),
  );
  return { ok: true, row };
}

function previewCatalogFailure(
  guid: string,
  row: NativePreviewCatalogRow,
): { readonly code: string; readonly detail: Record<string, unknown> } | undefined {
  const projection = isRecord(row.projection) ? row.projection : undefined;
  const operations =
    projection !== undefined && isRecord(projection.operations) ? projection.operations : undefined;
  const preview =
    operations !== undefined && isRecord(operations.preview) ? operations.preview : undefined;
  if (preview?.enabled === false) {
    return {
      code: 'asset-preview-disabled',
      detail: { guid, reason: preview.reason ?? 'catalog disabled preview' },
    };
  }
  const publication = isRecord(row.publication) ? row.publication : undefined;
  const current =
    publication !== undefined && isRecord(publication.current) ? publication.current : undefined;
  if (
    row.lifecycle !== 'current' ||
    typeof current?.packageUrl !== 'string' ||
    current.packageUrl.length === 0
  ) {
    return {
      code: 'asset-preview-output-unavailable',
      detail: { guid, lifecycle: row.lifecycle ?? null },
    };
  }
  return undefined;
}

function failed(
  failure: {
    readonly code: string;
    readonly expected?: string;
    readonly hint?: string;
    readonly detail?: unknown;
  },
  artifacts: readonly ArtifactRef[] = [],
): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-domain-failed',
      expected: failure.expected ?? 'the asset preview to complete',
      hint: failure.hint ?? 'Inspect the preview owner failure and retry.',
      detail: {
        code: failure.code,
        ...(failure.detail === undefined ? {} : { payload: failure.detail as JsonValue }),
      },
    },
    artifacts,
  };
}

type NativePreviewKind = 'material' | 'mesh' | 'texture' | 'vfx';
type NativePreviewResource = NonNullable<PreviewHostResult['resource']>;

/** One native preview run: its operation, subject and the identity its artifacts carry. */
interface NativePreviewRun {
  readonly operationId: string;
  readonly kind: NativePreviewKind;
  readonly guid: string;
  readonly projectRoot: string;
  readonly runId: string;
  readonly snapshot: SnapshotRef;
  /** Project-resolved copy target for the validated fresh-replay PNG. */
  readonly outputPath: string | undefined;
}

/** A completed browser capture whose resource bootstrap returned AssetRegistry owner facts. */
interface NativePreviewCapture {
  readonly result: PreviewHostResult;
  readonly resource: NativePreviewResource;
  readonly asset: Record<string, unknown>;
  readonly backendFallbackReason: string | undefined;
}

function nativePreviewKind(operationId: string): NativePreviewKind {
  const kind = operationId.split('.')[1];
  if (kind !== 'material' && kind !== 'mesh' && kind !== 'texture' && kind !== 'vfx') {
    throw new Error(`unsupported native preview operation ${operationId}`);
  }
  return kind;
}

function isPositiveExtent(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0;
}

/**
 * Resolve author/output identity before creating a Browser Host. This keeps
 * an unknown GUID or an unproduced output on the cheap structured failure
 * path instead of paying for a full WebGPU bootstrap first.
 */
async function previewCatalogAdmission(
  projectRoot: string,
  guid: string,
): Promise<ToolTerminal<never> | undefined> {
  const facts = await readProjectFacts(projectRoot);
  if (!facts.ok) return undefined;
  const catalog = await readPreviewCatalogRow(projectRoot, guid);
  if (!catalog.ok) {
    return failed({
      code: catalog.code,
      expected: 'the project asset catalog to be readable',
      hint: 'Rebuild the project to regenerate dist/pack-index.json, then retry.',
      detail: catalog.detail,
    });
  }
  if (catalog.row === undefined) return inspectedOutputAdmission(projectRoot, guid);
  const catalogFailure = previewCatalogFailure(guid, catalog.row);
  if (catalogFailure === undefined) return undefined;
  const disabled = catalogFailure.code === 'asset-preview-disabled';
  return failed({
    ...catalogFailure,
    expected: disabled
      ? 'the selected catalog asset to allow preview'
      : 'the selected asset to have a ready published output',
    hint: disabled
      ? 'Use the catalog-supported operation or publish a previewable projection.'
      : 'Run the owning producer, then retry the preview with the same GUID.',
  });
}

/** Without a built catalog row, the asset owner's inspection decides output readiness. */
async function inspectedOutputAdmission(
  projectRoot: string,
  guid: string,
): Promise<ToolTerminal<never> | undefined> {
  const inspected = await assetInspectCommand({ root: projectRoot, subject: guid });
  if (!inspected.ok) return failed(inspected.error);
  const value = inspected.value;
  if (isRecord(value) && 'status' in value && value.status !== 'ready') {
    return failed({
      code: 'asset-preview-output-unavailable',
      expected: 'the selected asset to have a ready published output',
      hint: 'Run the owning producer, then retry the preview with the same GUID.',
      detail: { guid, status: value.status as JsonValue },
    });
  }
  return undefined;
}

function selectedNativePreviewPlugin(operationId: string): string {
  const selectedPreviewPlugin = nativePreviewPlugins.find(
    ([, , tool]) => tool.descriptor.id === operationId,
  );
  if (selectedPreviewPlugin === undefined) {
    throw new Error(`native preview plugin does not export ${operationId}`);
  }
  return selectedPreviewPlugin[0];
}

/** Forward a caller abort into the preview-owned controller; the result unlinks it. */
function linkParentAbort(
  parentSignal: AbortSignal | undefined,
  previewController: AbortController,
): () => void {
  const onParentAbort = (): void => previewController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) previewController.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  return () => parentSignal?.removeEventListener('abort', onParentAbort);
}

interface PreviewBrowserRun {
  readonly value: BrowserHostResult;
  readonly fallbackReason: string | undefined;
}

/** Auto retries once on the software adapter when the first lane exposed no adapter. */
async function runWithSoftwareFallback(
  runBrowser: (backend: CaptureBackend | undefined) => Promise<BrowserHostResult>,
  signal: AbortSignal,
  backend: CaptureBackend | undefined,
): Promise<PreviewBrowserRun> {
  const first = await runBrowser(backend);
  if (
    first.ok ||
    signal.aborted ||
    (backend ?? 'auto') !== 'auto' ||
    (first.artifacts?.length ?? 0) > 0 ||
    !adapterUnavailable(first.error)
  ) {
    return { value: first, fallbackReason: undefined };
  }
  const retry = await runBrowser('software');
  return {
    value: retry,
    fallbackReason: retry.ok
      ? 'hardware-first preview failed; software adapter was selected'
      : undefined,
  };
}

async function raceDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  let timeout: ReturnType<typeof setTimeout> | number | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      timeoutPromise.then(() => ({ timedOut: true as const })),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function timedOutPreview(
  previewController: AbortController,
  browserPromise: Promise<PreviewBrowserRun>,
  guid: string,
  timeoutMs: number,
): Promise<ToolTerminal<never>> {
  previewController.abort(new Error('native preview deadline exceeded'));
  // A timeout ends the caller's wait, but the Browser Host still owns a
  // Vite/Chromium realm. Wait for that owner to observe cancellation and
  // dispose its resources before returning the terminal result; otherwise a
  // one-shot CLI can print JSON and keep its event loop alive behind it.
  const retired = await browserPromise.catch(() => undefined);
  return failed(
    {
      code: 'tool-preview-timeout',
      expected: `the asset preview to complete within ${timeoutMs}ms`,
      hint: 'Inspect the preview bootstrap or producer output; retry only after the owner is ready.',
      detail: { guid, timeoutMs },
    },
    retired && !retired.value.ok ? (retired.value.artifacts ?? []) : [],
  );
}

function admittedCapture(run: PreviewBrowserRun): NativePreviewCapture | undefined {
  const browser = run.value;
  if (!browser.ok) return undefined;
  const resource = browser.value.resource;
  if (resource === undefined || !isRecord(resource.asset)) return undefined;
  return {
    result: browser.value,
    resource,
    asset: resource.asset,
    backendFallbackReason: run.fallbackReason,
  };
}

function browserBootstrapFailure(browser: BrowserHostResult): ToolTerminal<never> {
  const failure = browser.ok
    ? {
        code: 'tool-preview-bootstrap-failed',
        expected: 'the Browser resource bootstrap to return AssetRegistry owner facts',
        hint: 'Inspect resource-bootstrap and retry after the owner publishes the GUID payload.',
        detail: { phase: 'resource-owner' },
      }
    : browser.error;
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-domain-failed',
      expected: failure.expected ?? 'the Browser resource bootstrap to succeed',
      hint: failure.hint ?? 'Inspect the Browser resource bootstrap failure and retry.',
      detail: {
        code: failure.code,
        ...(failure.detail === undefined ? {} : { payload: failure.detail }),
      },
    },
    artifacts: browser.ok ? [] : (browser.artifacts ?? []),
  };
}

async function copyReplayOutput(
  projectRoot: string,
  published: PreviewHostResult,
  outputPath: string | undefined,
): Promise<void> {
  if (outputPath === undefined) return;
  const replayPath = resolve(projectRoot, published.png.uri);
  const replayBytes = await readFile(replayPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, replayBytes);
}

function previewSubject(
  guid: string,
  asset: Record<string, unknown>,
  resource: NativePreviewResource,
): NonNullable<PreviewHostMechanisms['subject']> {
  return {
    guid,
    asset,
    ...(resource.digest === undefined ? {} : { digest: resource.digest }),
    ...(resource.ownerFacts === undefined ? {} : { ownerFacts: resource.ownerFacts }),
  };
}

function observedCount(
  observation: NonNullable<NativePreviewResource['observation']>,
  key: string,
): number {
  const value = observation[key];
  return typeof value === 'number' ? value : 0;
}

/** Renderer facts the native preview executor reads back from the actual browser run. */
function previewRendererFacts(
  kind: NativePreviewKind,
  browser: PreviewHostResult,
  resource: NativePreviewResource,
): PreviewRenderRuntime {
  const observation = resource.observation;
  return {
    rendererReady: browser.trace.events.includes('renderer-created'),
    worldReady: browser.trace.events.includes('world-updated'),
    drawCalls: browser.drawCalls,
    nonBlackPixels: browser.nonBlackPixels,
    ...(observation === undefined ? {} : { observation }),
    ...(kind === 'vfx' && observation !== undefined
      ? {
          vfx: {
            dispatches: observedCount(observation, 'dispatches'),
            indirectDraws: observedCount(observation, 'indirectDraws'),
            subjectOutputs: observedCount(observation, 'subjectOutputs'),
          },
        }
      : {}),
    texture: { drawCalls: browser.drawCalls },
  };
}

/** Host-observed lane facts appended to the domain result. */
function browserLaneResultFields(
  browser: PreviewHostResult,
  backendFallbackReason: string | undefined,
  outputPath: string | undefined,
): Record<string, unknown> {
  const fallbackReason = backendFallbackReason ?? browser.backendFallbackReason;
  return {
    actualCarrier: browser.actualCarrier,
    ...(browser.backendRequested === undefined
      ? {}
      : { backendRequested: browser.backendRequested }),
    ...(browser.backendObserved === undefined ? {} : { backendObserved: browser.backendObserved }),
    ...(fallbackReason === undefined ? {} : { backendFallbackReason: fallbackReason }),
    ...(outputPath === undefined ? {} : { output: outputPath }),
  };
}

function previewDeadlineFailure(timeoutMs: number): ToolTerminal<never> | undefined {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000) return undefined;
  return failed({
    code: 'tool-preview-timeout-invalid',
    expected: 'deadlineMs within (0, 120000]',
    hint: 'Pass a finite positive preview deadline.',
    detail: { timeoutMs },
  });
}

async function publishFailureEvidence(
  run: NativePreviewRun,
  capture: NativePreviewCapture,
): Promise<ToolTerminal<unknown>['artifacts']> {
  try {
    const published = await publishPreviewArtifacts(run.projectRoot, run.runId, capture.result);
    await copyReplayOutput(run.projectRoot, published, run.outputPath);
    return published.artifacts;
  } catch {
    // Preserve the original owner failure when a secondary evidence write
    // fails. A failed publisher must not turn a precise domain diagnostic
    // into an opaque executor-threw result.
    return [];
  }
}

export async function runNativePreviewTool(
  contribution: ToolContribution<unknown, unknown>,
  args: unknown,
  options: ToolRunOptions,
  projectRoot: string,
  previewOptions: NativePreviewOptions = {},
): Promise<ToolTerminal<unknown>> {
  const kind = nativePreviewKind(contribution.descriptor.id);
  const parsed = contribution.descriptor.argsSchema.parse(args);
  if (!parsed.ok) {
    return {
      outcome: 'failed',
      failure: {
        code: 'tool-invalid-args',
        expected: 'preview arguments to match the operation argsSchema',
        hint: 'Pass { guid } and an optional power-of-two size from AssetRegistry catalog identity.',
        detail: { message: parsed.error, value: null },
      },
      artifacts: [],
    };
  }
  const request = parsed.value as { readonly guid: string; readonly size?: number };
  const { guid, size = RESOURCE_PREVIEW_DEFAULT_SIZE } = request;
  const width = previewOptions.width ?? size;
  const height = previewOptions.height ?? size;
  if (!isPositiveExtent(width, height)) {
    return failed({
      code: 'tool-preview-extent-invalid',
      expected: 'preview width and height to be positive safe integers',
      hint: 'Pass positive --width and --height values.',
      detail: { width, height },
    });
  }
  const admissionFailure = await previewCatalogAdmission(projectRoot, guid);
  if (admissionFailure !== undefined) return admissionFailure;
  const selectedPluginName = selectedNativePreviewPlugin(contribution.descriptor.id);
  const run: NativePreviewRun = {
    operationId: contribution.descriptor.id,
    kind,
    guid,
    projectRoot,
    runId: `${contribution.descriptor.id}:${crypto.randomUUID()}`,
    snapshot: options.snapshot ?? { revision: 0, digest: `sha256:project:${projectRoot}` },
    outputPath:
      previewOptions.output === undefined ? undefined : resolve(projectRoot, previewOptions.output),
  };
  const timeoutMs = options.deadlineMs ?? DEFAULT_NATIVE_PREVIEW_TIMEOUT_MS;
  const deadlineFailure = previewDeadlineFailure(timeoutMs);
  if (deadlineFailure !== undefined) return deadlineFailure;
  const previewController = new AbortController();
  const unlinkParentAbort = linkParentAbort(options.signal, previewController);
  const recipe = createToolPreviewRecipe({
    presentation: 'hidden',
    viewport: { width, height },
    frames: 32,
  });
  const runBrowser = (backend: CaptureBackend | undefined) =>
    runBrowserResourcePreviewHost(
      projectRoot,
      recipe,
      run.snapshot,
      run.runId,
      previewController.signal,
      { kind, guid, size },
      {
        publish: false,
        ...(backend === undefined ? {} : { backend }),
        ...(previewOptions.headless === undefined ? {} : { headless: previewOptions.headless }),
      },
    );
  const browserPromise = runWithSoftwareFallback(
    runBrowser,
    previewController.signal,
    previewOptions.backend,
  );
  let browserRace: Awaited<ReturnType<typeof raceDeadline<PreviewBrowserRun>>>;
  try {
    browserRace = await raceDeadline(browserPromise, timeoutMs);
  } finally {
    unlinkParentAbort();
  }
  if (browserRace.timedOut)
    return timedOutPreview(previewController, browserPromise, guid, timeoutMs);
  const capture = admittedCapture(browserRace.value);
  if (capture === undefined) return browserBootstrapFailure(browserRace.value.value);
  return executeNativePreview(run, capture, selectedPluginName, args, options);
}

/** Run the selected native preview executor over the captured resource and publish its report. */
async function executeNativePreview(
  run: NativePreviewRun,
  capture: NativePreviewCapture,
  selectedPluginName: string,
  args: unknown,
  options: ToolRunOptions,
): Promise<ToolTerminal<unknown>> {
  const browser = capture.result;
  if (browser.capabilityFailure !== undefined) {
    const capabilityFailure = browser.capabilityFailure;
    return {
      outcome: 'failed',
      failure: domainFailureError(
        capabilityFailure.code,
        capabilityFailure.expected,
        capabilityFailure.hint,
        capabilityFailure.detail,
      ),
      artifacts: await publishFailureEvidence(run, capture),
    };
  }
  // A capability-limited subject may still produce a complete capture. Keep
  // that capture so the caller can inspect the evidence while returning the
  // original owner failure. There is no successful domain report for this
  // branch, so publication intentionally contains only capture artifacts.
  if (!toolPreviewSubjectDrawn(run.kind, browser.drawCalls)) {
    return {
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        expected:
          'the captured resource frame to contain a subject draw in addition to canonical presentation passes',
        hint: 'Inspect material readiness and the RHI tape before retrying the same GUID preview.',
        detail: {
          code: 'tool-preview-subject-not-rendered',
          payload: { kind: run.kind, drawCalls: browser.drawCalls },
        },
      },
      artifacts: await publishFailureEvidence(run, capture),
    };
  }
  const ctx = new Context();
  try {
    await ctx.plugin(createToolApiPlugin());
    const api = ctx.get('toolApi', false) as ToolApi | undefined;
    if (api === undefined) throw new Error('native preview owner did not install ToolApi');
    const host = createPreviewHost({
      runId: `${run.operationId}:native`,
      snapshot: run.snapshot,
      projectRoot: run.projectRoot,
      backend: 'webgpu',
      signal: options.signal ?? new AbortController().signal,
      subject: previewSubject(run.guid, capture.asset, capture.resource),
      renderer: previewRendererFacts(run.kind, browser, capture.resource),
      artifacts: browser.artifacts,
    });
    const installed = await startNativePlugin(
      ctx,
      createNativePreviewPlugin(host, selectedPluginName),
    );
    if (!installed.ok) throw installed.error;
    const provider = api
      .list()
      .find(
        (record) =>
          record.descriptor.id === run.operationId &&
          record.callable &&
          record.providerState === 'active',
      );
    if (provider === undefined) {
      return {
        outcome: 'failed',
        failure: {
          code: 'tool-domain-failed',
          expected: `the native preview provider for ${run.operationId} to activate`,
          hint: 'Inspect the preview plugin Fiber and retry after it reports Callable.',
          detail: { code: 'tool-preview-provider-unavailable' },
        },
        artifacts: await publishFailureEvidence(run, capture),
      };
    }
    const terminal = await api.run(run.operationId, args, {
      ...options,
      snapshot: run.snapshot,
      providerId: provider.owner.providerId,
      sourceId: provider.owner.sourceId,
      capabilityResolver: createContextCapabilityResolver(ctx),
    }).terminal;
    if (terminal.outcome !== 'succeeded') {
      const evidence = await publishFailureEvidence(run, capture);
      return {
        ...terminal,
        artifacts: evidence.length === 0 ? terminal.artifacts : evidence,
      };
    }
    return await publishSucceededPreview(run, capture, terminal);
  } finally {
    await ctx.fiber.dispose();
  }
}

/** Publish the domain report with every capture artifact atomically, then attach host lane facts. */
async function publishSucceededPreview(
  run: NativePreviewRun,
  capture: NativePreviewCapture,
  terminal: Extract<ToolTerminal<unknown>, { readonly outcome: 'succeeded' }>,
): Promise<ToolTerminal<unknown>> {
  const domainResult = terminal.result as {
    readonly subject: ResourcePreviewReportInput['subject'];
    readonly presentation: ResourcePreviewReportInput['presentation'];
    readonly oracle: ResourcePreviewReportInput['oracle'];
  };
  let published: Awaited<ReturnType<typeof publishPreviewArtifacts>>;
  try {
    published = await publishPreviewArtifacts(run.projectRoot, run.runId, capture.result, {
      snapshot: run.snapshot,
      subject: domainResult.subject,
      presentation: domainResult.presentation,
      oracle: domainResult.oracle,
    });
  } catch (cause) {
    return {
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        expected: 'the preview report and all capture artifacts to publish atomically',
        hint: 'Inspect the artifact manifest identity or digest failure and retry the same ToolRun.',
        detail: {
          code: 'tool-artifact-manifest-invalid',
          payload: cause instanceof Error ? cause.message : String(cause),
        },
      },
      artifacts: [],
    };
  }
  const report = published.manifest.artifacts.find((artifact) => artifact.role === 'report');
  if (report === undefined) {
    throw new Error('resource preview publisher returned no report artifact');
  }
  await copyReplayOutput(run.projectRoot, published, run.outputPath);
  return {
    ...terminal,
    result: {
      ...(terminal.result as Record<string, unknown>),
      ...browserLaneResultFields(capture.result, capture.backendFallbackReason, run.outputPath),
      report: {
        kind: 'tool-result' as const,
        digest: report.digest,
        uri: report.uri,
        mediaType: report.mediaType,
        sizeBytes: report.byteLength,
      },
      artifacts: published.artifacts,
    },
    artifacts: published.artifacts,
  };
}
