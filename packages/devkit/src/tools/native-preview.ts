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
import { createNativePreviewHost, RESOURCE_PREVIEW_DEFAULT_SIZE } from '@forgeax/engine-preview';
import type {
  JsonValue,
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
  publishPreviewArtifacts,
  type ResourcePreviewReportInput,
  runBrowserResourcePreviewHost,
} from './browser-host.js';
import { createNativePreviewPlugin, nativePreviewPlugins } from './preview-catalog.js';

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
  readonly operations?: unknown;
  readonly publication?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  const operations = isRecord(row.operations) ? row.operations : undefined;
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

function failed(failure: {
  readonly code: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: unknown;
}): ToolTerminal<never> {
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
    artifacts: [],
  };
}

export async function runNativePreviewTool(
  contribution: ToolContribution<unknown, unknown>,
  args: unknown,
  options: ToolRunOptions,
  projectRoot: string,
  previewOptions: NativePreviewOptions = {},
): Promise<ToolTerminal<unknown>> {
  const kind = contribution.descriptor.id.split('.')[1];
  if (kind !== 'material' && kind !== 'mesh' && kind !== 'texture' && kind !== 'vfx') {
    throw new Error(`unsupported native preview operation ${contribution.descriptor.id}`);
  }
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
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return failed({
      code: 'tool-preview-extent-invalid',
      expected: 'preview width and height to be positive safe integers',
      hint: 'Pass positive --width and --height values.',
      detail: { width, height },
    });
  }
  // Resolve author/output identity before creating a Browser Host. This keeps
  // an unknown GUID or an unproduced output on the cheap structured failure
  // path instead of paying for a full WebGPU bootstrap first.
  const facts = await readProjectFacts(projectRoot);
  if (facts.ok) {
    const catalog = await readPreviewCatalogRow(projectRoot, guid);
    if (!catalog.ok) {
      return failed({
        code: catalog.code,
        expected: 'the project asset catalog to be readable',
        hint: 'Rebuild the project to regenerate dist/pack-index.json, then retry.',
        detail: catalog.detail,
      });
    }
    if (catalog.row !== undefined) {
      const catalogFailure = previewCatalogFailure(guid, catalog.row);
      if (catalogFailure !== undefined) {
        return failed({
          ...catalogFailure,
          expected:
            catalogFailure.code === 'asset-preview-disabled'
              ? 'the selected catalog asset to allow preview'
              : 'the selected asset to have a ready published output',
          hint:
            catalogFailure.code === 'asset-preview-disabled'
              ? 'Use the catalog-supported operation or publish a previewable projection.'
              : 'Run the owning producer, then retry the preview with the same GUID.',
        });
      }
    } else {
      const inspected = await assetInspectCommand({ root: projectRoot, subject: guid });
      if (!inspected.ok) return failed(inspected.error);
      const value = inspected.value;
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'status' in value &&
        value.status !== 'ready'
      ) {
        return failed({
          code: 'asset-preview-output-unavailable',
          expected: 'the selected asset to have a ready published output',
          hint: 'Run the owning producer, then retry the preview with the same GUID.',
          detail: { guid, status: value.status as JsonValue },
        });
      }
    }
  }
  const selectedPreviewPlugin = nativePreviewPlugins.find(
    ([, , tool]) => tool.descriptor.id === contribution.descriptor.id,
  );
  if (selectedPreviewPlugin === undefined) {
    throw new Error(`native preview plugin does not export ${contribution.descriptor.id}`);
  }
  const selectedPluginName = selectedPreviewPlugin[0];
  const snapshot = options.snapshot ?? { revision: 0, digest: `sha256:project:${projectRoot}` };
  const previewRunId = `${contribution.descriptor.id}:${crypto.randomUUID()}`;
  const previewController = new AbortController();
  const parentSignal = options.signal;
  const onParentAbort = (): void => previewController.abort(parentSignal?.reason);
  if (parentSignal?.aborted) previewController.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timeoutMs = options.deadlineMs ?? DEFAULT_NATIVE_PREVIEW_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    parentSignal?.removeEventListener('abort', onParentAbort);
    return failed({
      code: 'tool-preview-timeout-invalid',
      expected: 'deadlineMs within (0, 120000]',
      hint: 'Pass a finite positive preview deadline.',
      detail: { timeoutMs },
    });
  }
  const recipe = createToolPreviewRecipe({
    presentation: 'hidden',
    viewport: { width, height },
    frames: 32,
  });
  const runBrowser = (backend: CaptureBackend | undefined) =>
    runBrowserResourcePreviewHost(
      projectRoot,
      recipe,
      snapshot,
      previewRunId,
      previewController.signal,
      { kind, guid, size },
      {
        publish: false,
        ...(backend === undefined ? {} : { backend }),
        ...(previewOptions.headless === undefined ? {} : { headless: previewOptions.headless }),
      },
    );
  const requestedBackend = previewOptions.backend ?? 'auto';
  const browserPromise = (async () => {
    const first = await runBrowser(previewOptions.backend);
    if (
      first.ok ||
      requestedBackend !== 'auto' ||
      !/backend|webgpu|adapter|gpu/i.test(JSON.stringify(first.error.detail))
    ) {
      return { value: first, fallbackReason: undefined } as const;
    }
    const retry = await runBrowser('software');
    return {
      value: retry,
      fallbackReason: retry.ok
        ? 'hardware-first preview failed; software adapter was selected'
        : undefined,
    } as const;
  })();
  let timeout: ReturnType<typeof setTimeout> | number | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
  });
  let browserRace:
    | { readonly timedOut: false; readonly value: Awaited<typeof browserPromise> }
    | { readonly timedOut: true };
  try {
    browserRace = await Promise.race([
      browserPromise.then((value) => ({ timedOut: false as const, value })),
      timeoutPromise.then(() => ({ timedOut: true as const })),
    ]);
  } catch (cause) {
    if (timeout !== undefined) clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', onParentAbort);
    throw cause;
  }
  if (timeout !== undefined) clearTimeout(timeout);
  parentSignal?.removeEventListener('abort', onParentAbort);
  if (browserRace.timedOut) {
    previewController.abort(new Error('native preview deadline exceeded'));
    // A timeout ends the caller's wait, but the Browser Host still owns a
    // Vite/Chromium realm. Wait for that owner to observe cancellation and
    // dispose its resources before returning the terminal result; otherwise a
    // one-shot CLI can print JSON and keep its event loop alive behind it.
    await browserPromise.catch(() => undefined);
    return failed({
      code: 'tool-preview-timeout',
      expected: `the asset preview to complete within ${timeoutMs}ms`,
      hint: 'Inspect the preview bootstrap or producer output; retry only after the owner is ready.',
      detail: { guid, timeoutMs },
    });
  }
  const browser = browserRace.value.value;
  const backendFallbackReason = browserRace.value.fallbackReason;
  if (!browser.ok || browser.value.resource === undefined) {
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
      artifacts: [],
    };
  }
  const resource = browser.value.resource;
  const subjectDrawn = toolPreviewSubjectDrawn(kind, browser.value.drawCalls);
  const outputPath =
    previewOptions.output === undefined ? undefined : resolve(projectRoot, previewOptions.output);
  const publishFailureEvidence = async (): Promise<ToolTerminal<unknown>['artifacts']> => {
    try {
      const published = await publishPreviewArtifacts(projectRoot, previewRunId, browser.value);
      if (outputPath !== undefined) {
        const replayPath = resolve(projectRoot, published.png.uri);
        const replayBytes = await readFile(replayPath);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, replayBytes);
      }
      return published.artifacts;
    } catch {
      // Preserve the original owner failure when a secondary evidence write
      // fails. A failed publisher must not turn a precise domain diagnostic
      // into an opaque executor-threw result.
      return [];
    }
  };
  if (browser.value.capabilityFailure !== undefined) {
    const capabilityFailure = browser.value.capabilityFailure;
    return {
      outcome: 'failed',
      failure: domainFailureError(
        capabilityFailure.code,
        capabilityFailure.expected,
        capabilityFailure.hint,
        capabilityFailure.detail,
      ),
      artifacts: await publishFailureEvidence(),
    };
  }
  // A capability-limited subject may still produce a complete capture. Keep
  // that capture so the caller can inspect the evidence while returning the
  // original owner failure. There is no successful domain report for this
  // branch, so publication intentionally contains only capture artifacts.
  if (!subjectDrawn) {
    return {
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        expected:
          'the captured resource frame to contain a subject draw in addition to canonical presentation passes',
        hint: 'Inspect material readiness and the RHI tape before retrying the same GUID preview.',
        detail: {
          code: 'tool-preview-subject-not-rendered',
          payload: { kind, drawCalls: browser.value.drawCalls },
        },
      },
      artifacts: await publishFailureEvidence(),
    };
  }
  const ctx = new Context();
  try {
    await ctx.plugin(createToolApiPlugin());
    const api = ctx.get('toolApi', false) as ToolApi | undefined;
    if (api === undefined) throw new Error('native preview owner did not install ToolApi');
    const host = createNativePreviewHost({
      runId: `${contribution.descriptor.id}:native`,
      snapshot,
      projectRoot,
      backend: 'webgpu',
      signal: options.signal ?? new AbortController().signal,
      assets: {
        loadByGuid: async <TAsset>() => ({
          ok: true as const,
          value: resource.asset as TAsset,
          ...(resource.digest === undefined ? {} : { digest: resource.digest }),
          ...(resource.ownerFacts === undefined ? {} : { ownerFacts: resource.ownerFacts }),
        }),
      },
      renderer: {
        rendererReady: browser.value.trace.events.includes('renderer-created'),
        worldReady: browser.value.trace.events.includes('world-updated'),
        drawCalls: browser.value.drawCalls,
        nonBlackPixels: browser.value.nonBlackPixels,
        ...(resource.observation === undefined ? {} : { observation: resource.observation }),
        ...(kind === 'vfx' && resource.observation !== undefined
          ? {
              vfx: {
                dispatches:
                  typeof resource.observation.dispatches === 'number'
                    ? resource.observation.dispatches
                    : 0,
                indirectDraws:
                  typeof resource.observation.indirectDraws === 'number'
                    ? resource.observation.indirectDraws
                    : 0,
                subjectOutputs:
                  typeof resource.observation.subjectOutputs === 'number'
                    ? resource.observation.subjectOutputs
                    : 0,
              },
            }
          : {}),
        texture: { drawCalls: browser.value.drawCalls },
      },
      artifacts: browser.value.artifacts,
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
          record.descriptor.id === contribution.descriptor.id &&
          record.callable &&
          record.providerState === 'active',
      );
    if (provider === undefined) {
      return {
        outcome: 'failed',
        failure: {
          code: 'tool-domain-failed',
          expected: `the native preview provider for ${contribution.descriptor.id} to activate`,
          hint: 'Inspect the preview plugin Fiber and retry after it reports Callable.',
          detail: { code: 'tool-preview-provider-unavailable' },
        },
        artifacts: await publishFailureEvidence(),
      };
    }
    const terminal = await api.run(contribution.descriptor.id, args, {
      ...options,
      snapshot,
      providerId: provider.owner.providerId,
      sourceId: provider.owner.sourceId,
      capabilityResolver: createContextCapabilityResolver(ctx),
    }).terminal;
    if (terminal.outcome !== 'succeeded') {
      const evidence = await publishFailureEvidence();
      return {
        ...terminal,
        artifacts: evidence.length === 0 ? terminal.artifacts : evidence,
      };
    }
    const domainResult = terminal.result as {
      readonly subject: ResourcePreviewReportInput['subject'];
      readonly presentation: ResourcePreviewReportInput['presentation'];
      readonly oracle: ResourcePreviewReportInput['oracle'];
    };
    let published: Awaited<ReturnType<typeof publishPreviewArtifacts>>;
    try {
      published = await publishPreviewArtifacts(projectRoot, previewRunId, browser.value, {
        snapshot,
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
    if (outputPath !== undefined) {
      const replayPath = resolve(projectRoot, published.png.uri);
      const replayBytes = await readFile(replayPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, replayBytes);
    }
    const publishedTerminal: ToolTerminal<unknown> = {
      ...terminal,
      result: {
        ...(terminal.result as Record<string, unknown>),
        actualCarrier: browser.value.actualCarrier,
        ...(browser.value.backendRequested === undefined
          ? {}
          : { backendRequested: browser.value.backendRequested }),
        ...(browser.value.backendObserved === undefined
          ? {}
          : { backendObserved: browser.value.backendObserved }),
        ...(backendFallbackReason === undefined && browser.value.backendFallbackReason === undefined
          ? {}
          : {
              backendFallbackReason: backendFallbackReason ?? browser.value.backendFallbackReason,
            }),
        ...(outputPath === undefined ? {} : { output: outputPath }),
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
    return publishedTerminal;
  } finally {
    await ctx.fiber.dispose();
  }
}
