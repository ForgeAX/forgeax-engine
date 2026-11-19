import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  createEngineWorkspaceProvider,
  ENGINE_WORKSPACE_COMMAND_TOPIC,
  type EngineWorkspaceAsset,
  type EngineWorkspaceCameraInput,
  type EngineWorkspaceEntityInspection,
  type EngineWorkspacePlay,
  type EngineWorkspacePreview,
  type EngineWorkspaceProject,
  type EngineWorkspaceProjectDocument,
  type EngineWorkspaceProjectSession,
  type EngineWorkspaceProvider,
  type EngineWorkspaceTarget,
  engineWorkspaceResultService,
} from '@forgeax/engine-app';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import type { HostCallerIdentity } from '@forgeax/engine-host/transport';
import { encodePackData } from '@forgeax/engine-pack/runtime';
import { PACK_DRAFT_CHANGED_TOPIC, type PackDraftReply } from '@forgeax/engine-pack/source';
import { createScriptablePackMetadataCache } from '@forgeax/engine-pack/source-node';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { assetInspectCommand } from './assets.js';
import { prepareRuntimePackProgram } from './build/pack-program.js';
import { createViteConfig, materializeViteDevPort } from './host.js';
import { type DevKitHostBinding, DevKitProjectPages } from './host-binding.js';
import { rememberKnownProject } from './known-projects.js';
import { readProjectFacts } from './project.js';
import type { ProjectFacts } from './types.js';
import { createWorkspacePackAuthoring } from './workspace-pack-authoring.js';
import type { WorkspacePackCookPlugin } from './workspace-pack-cook.js';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
// Cold shader initialization shares the GPU with already running targets.
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', aborted);
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export interface DevKitWorkspaceProviderOptions {
  readonly width?: number;
  readonly height?: number;
  /** Select the presentation target. The provider never infers this from the browser. */
  readonly headed?: boolean;
  /** `0` asks Vite for an OS-assigned loopback port. */
  readonly port?: number;
  /** Bound the browser-page readiness handshake and every command result. */
  readonly readyTimeoutMs?: number;
  /** Notify the workspace owner when browser readiness or loss changes a target. */
  readonly onTargetChanged?: () => void | Promise<void>;
  /**
   * Test/host injection points. Production defaults use the real Vite server
   * and backend Host; the provider never launches a browser of its own. The
   * target document is the only browser App/World/AssetRegistry/renderer realm.
   */
  readonly backendFactory?: () => Promise<BackendHost>;
  /**
   * Borrow an already assembled Engine BackendHost for this workspace. The
   * provider owns only the project server, bridge, and command resources when
   * this binding is supplied.
   */
  readonly hostBinding?: DevKitHostBinding;
  readonly viteServerFactory?: (config: InlineConfig) => Promise<ViteDevServer>;
}

export interface DevKitWorkspaceTargetOptions {
  readonly sessionId: string;
  readonly targetId: string;
  readonly width: number;
  readonly height: number;
  readonly headed: boolean;
}

interface WorkspaceCommand {
  readonly kind: 'command' | 'cancel';
  readonly id: string;
  readonly sessionId: string;
  readonly operation?: string;
  readonly input?: unknown;
}

interface WorkspaceReadyResult {
  readonly kind: 'ready';
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly project: EngineWorkspaceProject;
  readonly target: EngineWorkspaceTarget;
}

interface WorkspaceOperationResult {
  readonly kind: 'result';
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly code?: string;
    readonly expected?: string;
    readonly hint?: string;
    readonly detail?: unknown;
  };
}

interface WorkspacePageLostResult {
  readonly kind: 'lost' | 'failed';
  readonly error?: WorkspaceOperationResult['error'];
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
}

type WorkspaceResult = WorkspaceReadyResult | WorkspaceOperationResult | WorkspacePageLostResult;

interface PendingResult {
  readonly cancel: () => void;
  readonly targetId: string;
  readonly previewOwner?: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
  readonly operation: string;
}

/** A structured failure from the one browser-page workspace transport. */
export class DevKitWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${hint}`);
    this.name = 'DevKitWorkspaceError';
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  if (signal === undefined) return undefined;
  if (signal.reason !== undefined) return signal.reason;
  return Object.assign(new Error('engine workspace operation was cancelled'), {
    name: 'AbortError',
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function inspectAuthoredPack(
  root: string,
  sourcePath: string,
  sourceKey: string,
  guid: string,
  signal?: AbortSignal,
): Promise<{ meta: Record<string, unknown>; revision?: string }> {
  const result = await assetInspectCommand({ root, subject: sourcePath, sourceKey });
  throwIfAborted(signal);
  if (!result.ok)
    throw new DevKitWorkspaceError(
      result.error.code,
      result.error.expected,
      result.error.hint,
      result.error.detail,
    );
  if (
    !isRecord(result.value) ||
    typeof result.value.guid !== 'string' ||
    result.value.guid.toLowerCase() !== guid.toLowerCase()
  )
    throw new DevKitWorkspaceError(
      'asset-inspect-identity-mismatch',
      'the authored Pack output GUID to match the inspected Catalog GUID',
      'Refresh the Catalog or repair the source locator before inspecting this asset.',
      {
        guid,
        sourcePath,
        sourceKey,
        sourceGuid: isRecord(result.value) ? result.value.guid : null,
      },
    );
  const source = result.value;
  const properties = isRecord(source.payload)
    ? source.payload
    : isRecord(source.effectiveValues)
      ? source.effectiveValues
      : undefined;
  return {
    meta: {
      ...(typeof source.packageId === 'string' ? { packageId: source.packageId } : {}),
      ...(typeof source.format === 'string' ? { format: source.format } : {}),
      ...(typeof source.parentPackageId === 'string'
        ? { parentPackageId: source.parentPackageId }
        : {}),
      ...(Array.isArray(source.parameters) ? { parameters: source.parameters } : {}),
      ...(properties === undefined ? {} : { properties }),
    },
    ...(typeof source.revision === 'string' ? { revision: source.revision } : {}),
  };
}

function workspaceCallerSource(sessionId: string, targetId: string): string {
  return `forgeax-workspace:${sessionId}:${targetId}`;
}

function assertWorkspaceCaller(
  caller: HostCallerIdentity,
  sessionId: string,
  targetId: string,
  acceptedCaller: HostCallerIdentity | undefined,
): void {
  const expected = workspaceCallerSource(sessionId, targetId);
  if (
    caller.kind === 'frontend' &&
    caller.sourceId === expected &&
    acceptedCaller !== undefined &&
    caller.connectionId === acceptedCaller.connectionId &&
    caller.capability === acceptedCaller.capability
  )
    return;
  throw new DevKitWorkspaceError(
    'engine-workspace-caller-mismatch',
    'the Engine workspace result caller to match the active session and target',
    'Discard results from an old, shell, or unassociated host connection and use the active display host page.',
    {
      expectedSource: expected,
      receivedKind: caller.kind,
      receivedSource: caller.sourceId ?? null,
      receivedConnectionId: caller.connectionId,
      sessionId,
      targetId,
    },
  );
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new DevKitWorkspaceError(
      'engine-workspace-invalid-extent',
      `${name} to be a positive safe integer`,
      `Pass a positive ${name} when opening the Engine workspace.`,
      { [name]: value ?? null },
    );
  }
  return result;
}

function wireError(error: unknown, operation: string): DevKitWorkspaceError {
  const failure = isRecord(error) ? error : undefined;
  return new DevKitWorkspaceError(
    typeof failure?.code === 'string' ? failure.code : 'engine-workspace-browser-failure',
    typeof failure?.expected === 'string'
      ? failure.expected
      : `the browser workspace operation ${operation} to complete`,
    typeof failure?.hint === 'string' ? failure.hint : 'Inspect the browser page failure details.',
    failure?.detail !== null && typeof failure?.detail === 'object'
      ? (failure.detail as Readonly<Record<string, unknown>>)
      : {},
  );
}

function assertProject(value: unknown, facts: ProjectFacts): EngineWorkspaceProject {
  if (value === null || typeof value !== 'object') {
    throw new DevKitWorkspaceError(
      'engine-workspace-project-invalid',
      'the browser page to return a project identity',
      'Inspect the generated Engine workspace page and reopen the project.',
      {},
    );
  }
  const project = value as Partial<EngineWorkspaceProject>;
  if (project.id !== facts.id || project.root !== facts.root) {
    throw new DevKitWorkspaceError(
      'engine-workspace-project-mismatch',
      'the browser project identity to match the opened project',
      'Treat the headed target as stale and reopen the project.',
      {
        expectedId: facts.id,
        receivedId: project.id ?? null,
        expectedRoot: facts.root,
        receivedRoot: project.root ?? null,
      },
    );
  }
  return {
    id: facts.id,
    root: facts.root,
    assetRoots: facts.assetRoots,
    ...(typeof project.name === 'string' ? { name: project.name } : { name: facts.name }),
    ...(typeof project.revision === 'string' ? { revision: project.revision } : {}),
  };
}

function assertTarget(
  value: unknown,
  expected: DevKitWorkspaceTargetOptions,
): EngineWorkspaceTarget {
  if (value === null || typeof value !== 'object') {
    throw new DevKitWorkspaceError(
      'engine-workspace-target-invalid',
      'the browser page to return a stable workspace target',
      'Reopen the project and wait for the Engine browser realm to become ready.',
      {},
    );
  }
  const target = value as Partial<EngineWorkspaceTarget>;
  const targetWidth = target.width;
  const targetHeight = target.height;
  if (
    target.targetId !== expected.targetId ||
    target.sessionId !== expected.sessionId ||
    typeof target.worldId !== 'string' ||
    target.worldId.length === 0 ||
    target.headed !== expected.headed ||
    typeof targetWidth !== 'number' ||
    !Number.isSafeInteger(targetWidth) ||
    targetWidth < 1 ||
    typeof targetHeight !== 'number' ||
    !Number.isSafeInteger(targetHeight) ||
    targetHeight < 1
  ) {
    throw new DevKitWorkspaceError(
      'engine-workspace-target-mismatch',
      'the browser target identity and dimensions to match the opened session',
      'Treat the workspace target as stale and reopen the project.',
      {
        expectedSessionId: expected.sessionId,
        receivedSessionId: target.sessionId ?? null,
        expectedTargetId: expected.targetId,
        receivedTargetId: target.targetId ?? null,
      },
    );
  }
  return {
    targetId: expected.targetId,
    sessionId: expected.sessionId,
    worldId: target.worldId,
    headed: expected.headed,
    width: targetWidth,
    height: targetHeight,
    ...(typeof target.frameId === 'number' ? { frameId: target.frameId } : {}),
    ...(typeof target.url === 'string' ? { url: target.url } : {}),
  };
}

function localServerUrl(server: ViteDevServer): string {
  const local = server.resolvedUrls?.local?.[0];
  if (typeof local === 'string' && local.length !== 0) return local;
  const address = server.httpServer?.address();
  if (address !== null && typeof address === 'object' && address.port > 0) {
    return `http://127.0.0.1:${address.port}/`;
  }
  throw new DevKitWorkspaceError(
    'engine-workspace-server-url-missing',
    'the Engine Vite server to publish a loopback URL',
    'Inspect the DevKit server startup diagnostics and reopen the project.',
    {},
  );
}

/**
 * Pack startup is asynchronous. The workspace page cannot recover from a
 * one-shot catalog miss, so the URL is published only after generation 1 is
 * accepted. Production servers expose that as the in-process Pack plugin
 * `ready()` promise. The HTTP poll remains for hosts that do not.
 */
function packPluginReady(server: ViteDevServer): (() => Promise<void>) | undefined {
  const plugin = server.config?.plugins?.find((entry) => entry.name === 'forgeax:pack') as
    | { readonly ready?: () => Promise<void> }
    | undefined;
  return typeof plugin?.ready === 'function' ? plugin.ready.bind(plugin) : undefined;
}

async function awaitCatalogReady(
  server: ViteDevServer,
  serverUrl: string,
  scopeId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const ready = packPluginReady(server);
  if (ready === undefined) {
    await waitForRuntimeCatalog(serverUrl, scopeId, timeoutMs, signal);
    return;
  }
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DevKitWorkspaceError(
          'engine-workspace-catalog-not-ready',
          'the project Pack catalog to become ready before the workspace page loads',
          'Wait for the project producer to finish, repair its diagnostics if it failed, and reopen the workspace.',
          {
            timeoutMs,
            catalogUrl: new URL(
              `/__pack/scopes/${encodeURIComponent(scopeId)}/1/catalog.json`,
              serverUrl,
            ).href,
          },
        ),
      );
    }, timeoutMs);
  });
  const abort = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([ready(), timeout, abort]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * HTTP stand-in for {@link awaitCatalogReady} when a server has no Pack plugin
 * handle. A 503 means generation 1 is still scanning; any other status is terminal.
 */
export async function waitForRuntimeCatalog(
  serverUrl: string,
  scopeId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const catalogUrl = new URL(
    `/__pack/scopes/${encodeURIComponent(scopeId)}/1/catalog.json`,
    serverUrl,
  );
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastFailure: string | undefined;
  let lastResponseBody: string | undefined;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const remaining = deadline - Date.now();
    const requestController = new AbortController();
    const requestTimeout = setTimeout(
      () => requestController.abort(),
      Math.min(5_000, Math.max(1, remaining)),
    );
    const onAbort = (): void => requestController.abort(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(catalogUrl, {
        signal: requestController.signal,
      });
      throwIfAborted(signal);
      lastStatus = response.status;
      if (response.ok) {
        if (response.body !== null) await response.body.cancel().catch(() => {});
        return;
      }
      // Preserve the producer's bounded structured diagnostic. A 503 can be
      // either a transient generation or a terminal producer failure; the
      // caller needs the code/cause to distinguish those cases after the
      // bounded wait expires.
      try {
        const body = await response.text();
        if (body.length > 0) lastResponseBody = body.slice(0, 8_192);
      } catch (cause) {
        lastFailure = cause instanceof Error ? cause.message : String(cause);
      }
      if (response.status !== 503) break;
    } catch (cause) {
      if (signal?.aborted) throw abortReason(signal);
      lastFailure = cause instanceof Error ? cause.message : String(cause);
    } finally {
      clearTimeout(requestTimeout);
      signal?.removeEventListener('abort', onAbort);
    }
    const delay = Math.min(100, Math.max(1, remaining));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      const onDelayAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onDelayAbort);
        reject(abortReason(signal));
      };
      function done(): void {
        signal?.removeEventListener('abort', onDelayAbort);
        resolve();
      }
      signal?.addEventListener('abort', onDelayAbort, { once: true });
      if (signal?.aborted) onDelayAbort();
    });
  }
  throw new DevKitWorkspaceError(
    'engine-workspace-catalog-not-ready',
    'the project Pack catalog to become ready before the workspace page loads',
    'Wait for the project producer to finish, repair its diagnostics if it failed, and reopen the workspace.',
    {
      catalogUrl: catalogUrl.href,
      timeoutMs,
      ...(lastStatus === undefined ? {} : { lastStatus }),
      ...(lastFailure === undefined ? {} : { lastFailure }),
      ...(lastResponseBody === undefined ? {} : { lastResponseBody }),
    },
  );
}

function commandInput(value: EngineWorkspaceCameraInput): Record<string, unknown> {
  const { signal: _signal, ...rest } = value;
  return rest as Record<string, unknown>;
}

function operationResultTarget(
  value: unknown,
  expected: DevKitWorkspaceTargetOptions,
): EngineWorkspaceTarget {
  if (value === null || typeof value !== 'object') {
    throw new DevKitWorkspaceError(
      'engine-workspace-preview-invalid',
      'the browser page to return preview metadata',
      'Retry only after the Engine workspace target is ready.',
      {},
    );
  }
  return assertTarget((value as { readonly target?: unknown }).target, expected);
}

function operationResultAsset(value: unknown): EngineWorkspaceAsset | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const asset = (value as { readonly asset?: unknown }).asset;
  if (asset === null || typeof asset !== 'object') return undefined;
  const candidate = asset as Partial<EngineWorkspaceAsset>;
  if (typeof candidate.guid !== 'string' || typeof candidate.kind !== 'string') return undefined;
  return {
    guid: candidate.guid,
    kind: candidate.kind,
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
    ...(typeof candidate.revision === 'string' ? { revision: candidate.revision } : {}),
    ...(typeof candidate.previewable === 'boolean' ? { previewable: candidate.previewable } : {}),
  };
}

/**
 * Create the DevKit workspace provider used by a real project server.
 *
 * The provider starts one Vite + Host service and returns its URL before the
 * browser is ready. A host navigates its target document to that URL; the generated
 * page creates the sole App/World/AssetRegistry/renderer realm and sends a
 * readiness result over the existing Host transport. Node retains only
 * serializable project/target data and pending command results.
 */
export function createDevKitWorkspaceProvider(
  options: DevKitWorkspaceProviderOptions = {},
): EngineWorkspaceProvider {
  const width = positiveInteger(options.width, DEFAULT_WIDTH, 'width');
  const height = positiveInteger(options.height, DEFAULT_HEIGHT, 'height');
  const headed = options.headed ?? true;
  const readyTimeoutMs = positiveInteger(
    options.readyTimeoutMs,
    DEFAULT_READY_TIMEOUT_MS,
    'readyTimeoutMs',
  );
  const backendFactory = options.backendFactory ?? (() => createBackendHost());
  if (options.hostBinding !== undefined && options.backendFactory !== undefined) {
    throw new TypeError('DevKit workspace provider cannot combine hostBinding and backendFactory');
  }
  const serverFactory =
    options.viteServerFactory ?? ((config: InlineConfig) => createViteServer(config));
  let disposed = false;
  // Every Play re-reads and digests sources; unchanged closures skip metadata Workers.
  const scriptablePackMetadata = createScriptablePackMetadataCache();
  const openings = new Set<Promise<unknown>>();
  const activeProjectSessions = new Set<() => Promise<void>>();
  let failedCleanup: unknown;
  const trackOpening = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operation();
    openings.add(pending);
    void pending.then(
      () => openings.delete(pending),
      () => openings.delete(pending),
    );
    return pending;
  };

  type BrowserSession = EngineWorkspaceProjectSession & {
    readonly phase: EngineWorkspacePlay['phase'];
    readonly browserGeneration: number;
    borrowTarget(
      signal?: AbortSignal,
    ): Promise<
      Omit<EngineWorkspacePreview, 'target'> & { readonly target: EngineWorkspacePlay['target'] }
    >;
    ready(signal?: AbortSignal): Promise<void>;
  };
  type SessionCapabilities = {
    readonly borrowTarget: BrowserSession['borrowTarget'];
    readonly ready: BrowserSession['ready'];
    readonly runtimePack: (
      input: Parameters<NonNullable<BrowserSession['runtimePack']>>[0],
      admitted?: WorkspaceReadyResult,
    ) => ReturnType<NonNullable<BrowserSession['runtimePack']>>;
    readonly inspectAsset: (
      input: Parameters<NonNullable<BrowserSession['inspectAsset']>>[0],
      admitted?: WorkspaceReadyResult,
    ) => ReturnType<NonNullable<BrowserSession['inspectAsset']>>;
    readonly listAssets: (
      input: Parameters<NonNullable<BrowserSession['listAssets']>>[0],
      admitted?: WorkspaceReadyResult,
    ) => ReturnType<NonNullable<BrowserSession['listAssets']>>;
    readonly openPreview: (
      input: Parameters<NonNullable<BrowserSession['openPreview']>>[0],
      admitted?: WorkspaceReadyResult,
    ) => ReturnType<NonNullable<BrowserSession['openPreview']>>;
    readonly startPlay?: (
      input: { signal?: AbortSignal },
      admitted?: WorkspaceReadyResult,
    ) => Promise<EngineWorkspacePlay>;
  };
  type ProjectServer = {
    readonly backend: BackendHost;
    readonly server: ViteDevServer;
    readonly pages: DevKitProjectPages;
    readonly catalogReady: Promise<void>;
  };
  const createBrowserSession = async (
    input: {
      root: string;
      generation: number;
      startupController: AbortController;
      onAuthoringReady?: (
        execute: NonNullable<EngineWorkspaceProjectSession['authorPack']>,
      ) => void;
      publishStatus: (status: EngineWorkspaceProjectSession['status']) => void;
      publishFailure: (cause: unknown) => void;
      publishCapabilities: (capabilities: SessionCapabilities) => void;
      publishCleanup: (close: () => Promise<void>) => void;
      publishBrowserAdmission: (read: () => WorkspaceReadyResult | undefined) => void;
      onBackendDisposed: () => void;
    },
    parent: ProjectServer | undefined,
    facts: ProjectFacts,
    sessionId: string,
    targetId: string,
  ): Promise<void> => {
    const startupAt = performance.now();
    let lastStageAt = startupAt;
    if (disposed) {
      throw new DevKitWorkspaceError(
        'engine-workspace-provider-disposed',
        'the Engine workspace provider to remain active',
        'Create a new workspace provider before opening another project.',
        {},
      );
    }
    const timing = (stage: string): void => {
      const game = parent !== undefined;
      if (!game && process.env.FORGEAX_WORKSPACE_TIMING !== '1') return;
      const now = performance.now();
      console.error(
        game ? '[forgeax.play]' : '[forgeax.workspace.timing]',
        JSON.stringify({
          root: facts.root,
          sessionId,
          targetId,
          execution: game ? 'game' : 'preview',
          stage,
          totalMs: Math.round(now - startupAt),
          stageMs: Math.round(now - lastStageAt),
        }),
      );
      lastStageAt = now;
    };
    timing('project-facts');
    const admissionToken = randomUUID();
    const dimensions = {
      sessionId,
      targetId,
      width,
      height,
      headed,
    } satisfies DevKitWorkspaceTargetOptions;
    const ownsBackend = parent === undefined && options.hostBinding === undefined;
    let backend!: BackendHost;
    let backendBound = false;
    let server: ViteDevServer | undefined;
    const pages = parent?.pages ?? new DevKitProjectPages();
    let revokePage: (() => void) | undefined;
    const previews = new Map<string, EngineWorkspacePreview & { failure?: DevKitWorkspaceError }>();
    const queuedDraftChanges: { readonly sessionId: string; readonly reply: PackDraftReply }[] = [];
    let authoring: ReturnType<typeof createWorkspacePackAuthoring> | undefined;
    if (!parent)
      authoring = createWorkspacePackAuthoring({
        root: facts.root,
        sourceRoots: facts.assetRoots,
        prepareContent: async (input) => {
          const cooker = server?.config.plugins.find(
            (entry) => entry.name === 'forgeax:workspace-pack-cook',
          ) as WorkspacePackCookPlugin | undefined;
          if (!cooker) throw new Error('The project draft cooker is unavailable');
          return cooker.prepareContent(input);
        },
        publishSource: async (sourcePath) => {
          const pack = server?.config.plugins.find((entry) => entry.name === 'forgeax:pack') as
            | import('@forgeax/engine-vite-plugin-pack').PluginPack
            | undefined;
          if (!pack)
            throw new DevKitWorkspaceError(
              'engine-workspace-capability-unavailable',
              'The project Pack catalog publisher',
              'The source draft is saved; retry publication after its project server is prepared.',
              { sessionId, targetId, capability: 'catalog-publisher' },
            );
          if (await pack.rebuildCatalogInPlace([sourcePath]))
            backend.context.get('engineWorkspaceCatalog')?.notePublished();
        },
        catalog: () => {
          if (!server) return undefined;
          const plugin = server.config.plugins.find((entry) => entry.name === 'forgeax:pack') as
            | { runtimeBinding?: () => RuntimeAssetBinding | undefined }
            | undefined;
          const binding = plugin?.runtimeBinding?.();
          if (!binding) return undefined;
          const base = localServerUrl(server);
          return createCatalogSource({
            url: new URL(binding.catalogUrl, base).href,
            expectedScope: binding,
            importTransport: createDevImportTransport({
              ...binding,
              importUrlBase: new URL(binding.importUrlBase, base).href,
            }),
          });
        },
        preview: (id) => previews.get(id),
        changed: (reply) => {
          if (backend) backend.transport.publish(PACK_DRAFT_CHANGED_TOPIC, { sessionId, reply });
          else queuedDraftChanges.push({ sessionId, reply });
        },
      });
    if (authoring) input.onAuthoringReady?.(authoring.execute);
    let binding!: DevKitHostBinding;
    const pending = new Map<string, PendingResult>();
    let ready: WorkspaceReadyResult | undefined;
    let readyFailure: unknown;
    let pageLost = false;
    let browserDetached = false;
    let browserGeneration = 0;
    let browserRetirement = Promise.resolve();
    input.publishBrowserAdmission(() => (browserDetached ? undefined : ready));
    let resultRegistration: (() => void) | undefined;
    let removePresentation: (() => void) | undefined;
    let acceptedCaller: HostCallerIdentity | undefined;
    const statusListeners = new Set<() => void>();
    const expectedCallerSource = workspaceCallerSource(sessionId, targetId);
    let removeClientConnect = (): void => {};
    let removeClientDisconnect = (): void => {};
    const installClientListeners = (): void => {
      removeClientConnect = backend.transport.onClientConnect((caller) => {
        if (caller.kind === 'frontend' && caller.sourceId === expectedCallerSource) {
          if (acceptedCaller && acceptedCaller.connectionId !== caller.connectionId) {
            const previous = acceptedCaller;
            acceptedCaller = undefined;
            void settleResult({
              kind: 'lost',
              id: `replaced:${previous.connectionId}`,
              sessionId,
              targetId,
            });
          }
          acceptedCaller = caller;
        }
      });
      removeClientDisconnect = backend.transport.onClientDisconnect((caller) => {
        if (acceptedCaller?.connectionId === caller.connectionId) {
          acceptedCaller = undefined;
          void settleResult({
            kind: 'lost',
            id: `disconnect:${caller.connectionId}`,
            sessionId,
            targetId,
          });
        }
      });
    };
    let removeBackendDispose: (() => void) | undefined;
    let serverClosed = false;
    let sessionClosed = false;
    let sessionClosePromise: Promise<void> | undefined;
    let catalogReady: Promise<void> = Promise.resolve();
    let play: EngineWorkspacePlay | undefined;
    let currentTarget: EngineWorkspaceTarget | undefined;
    let projectDocument: EngineWorkspaceProjectDocument | undefined;
    const requireCurrentTarget = (): EngineWorkspaceTarget => {
      if (currentTarget === undefined)
        throw new DevKitWorkspaceError(
          'engine-workspace-capability-unavailable',
          'An authenticated Engine World target',
          'Wait for this exact project document to authenticate and publish its real World.',
          { sessionId, targetId },
        );
      return currentTarget;
    };
    const publishStatus = (): void => {
      const target = currentTarget;
      if (pageLost || readyFailure !== undefined) {
        input.publishStatus({
          phase: 'failed',
          sessionId,
          generation: input.generation,
          ...(projectDocument === undefined ? {} : { document: projectDocument }),
          ...(target === undefined ? {} : { target }),
          failure:
            readyFailure ??
            new DevKitWorkspaceError(
              'engine-workspace-page-lost',
              'the Engine workspace browser page to remain connected',
              'Reopen the project in the same View session.',
            ),
          ...(browserGeneration === 0 ? {} : { browserGeneration }),
        });
      } else if (ready !== undefined && projectDocument !== undefined) {
        input.publishStatus({
          phase: 'running',
          sessionId,
          generation: input.generation,
          document: projectDocument,
          target: requireCurrentTarget(),
          browserGeneration,
        });
      } else if (projectDocument !== undefined) {
        input.publishStatus({
          phase: 'starting',
          sessionId,
          generation: input.generation,
          document: projectDocument,
          ...(browserGeneration > 0 && target !== undefined ? { target } : {}),
          browserGeneration,
        });
      } else {
        input.publishStatus({ phase: 'preparing', sessionId, generation: input.generation });
      }
    };

    const inactiveError = (): DevKitWorkspaceError =>
      disposed
        ? new DevKitWorkspaceError(
            'engine-workspace-provider-disposed',
            'the Engine workspace provider to remain active',
            'Create a new workspace provider before opening another project.',
            { sessionId, targetId },
          )
        : new DevKitWorkspaceError(
            'engine-workspace-session-closed',
            'the Engine workspace session to remain open',
            'Reopen the project before issuing another workspace operation.',
            { sessionId, targetId },
          );
    const assertSessionActive = (): void => {
      if (disposed || sessionClosed) throw inactiveError();
    };
    const closeIfInactive = async (): Promise<void> => {
      if (!disposed && !sessionClosed && !input.startupController.signal.aborted) return;
      await closeResources();
      throw inactiveError();
    };

    const notifyTargetChanged = async (): Promise<void> => {
      publishStatus();
      for (const listener of statusListeners) {
        try {
          listener();
        } catch {
          // Observers do not own session progress or resource cleanup.
        }
      }
      try {
        await options.onTargetChanged?.();
      } catch (error) {
        // A failed notification must not replace an existing cleanup failure
        // or recurse when publishing that failure also rejects.
        if (pageLost || sessionClosed) return;
        await settleResult({
          kind: 'failed',
          id: 'browser-retirement',
          sessionId,
          targetId,
          error: wireError(error, 'browser retirement'),
        });
      }
    };

    const settlePreviewFailure = async (payload: WorkspacePageLostResult): Promise<void> => {
      const preview = previews.get(payload.targetId);
      if (!preview || preview.failure) return;
      preview.failure = wireError(payload.error, 'target execution');
      for (const [id, waiter] of pending) {
        if (waiter.targetId !== payload.targetId) continue;
        pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(preview.failure);
      }
      await notifyTargetChanged();
    };
    const settleLost = async (payload: WorkspacePageLostResult): Promise<void> => {
      if (payload.targetId !== targetId || (pageLost && acceptedCaller !== undefined)) return;
      const cleanup = (readyFailure as { detail?: { cleanup?: string } } | undefined)?.detail
        ?.cleanup;
      if (cleanup === 'failed' || cleanup === 'timeout') return;
      // A disconnect must not erase the failure that made the live realm terminal.
      if (!sessionClosed && readyFailure !== undefined) {
        pageLost = true;
        return;
      }
      // A close already owns this session. Keep the terminal lost-target
      // record so a later reopen can prove the old page will not answer.
      if (sessionClosed || readyFailure !== undefined) {
        pageLost = true;
        browserDetached = false;
        timing('browser-lost');
        readyFailure = new DevKitWorkspaceError(
          'engine-workspace-page-lost',
          'the Engine workspace browser page to remain connected',
          'The headed page was destroyed or navigated away; reopen the project instead of replaying commands.',
          {
            sessionId,
            targetId,
            ...(sessionClosed ? { cleanup: 'unconfirmed', reason: 'transport-lost' } : {}),
          },
        );
        for (const [id, waiter] of pending) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', waiter.onAbort);
          waiter.reject(readyFailure);
        }
        await notifyTargetChanged();
        return;
      }
      // A refresh destroys the browser realm, not the Vite server or the
      // accepted catalog. Fail commands already sent to the old page, and
      // let the replacement page's ready resume new ones.
      browserDetached = true;
      // pagehide precedes socket closure. Its retiring realm must no longer
      // publish readiness or teardown failures into the replacement's session.
      acceptedCaller = undefined;
      ready = undefined;
      timing('browser-detached');
      const detached = new DevKitWorkspaceError(
        'engine-workspace-browser-detached',
        'the replacement Engine workspace page to become ready',
        'The headed page is reloading. Wait for it instead of replaying commands or reopening the project.',
        { sessionId, targetId },
      );
      for (const [id, waiter] of pending) {
        if (waiter.operation === 'workspace readiness') continue;
        pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(detached);
      }
      browserRetirement = Promise.all([browserRetirement, notifyTargetChanged()]).then(
        () => undefined,
      );
    };
    const settleFailure = async (payload: WorkspacePageLostResult): Promise<void> => {
      if (payload.targetId !== targetId || pageLost) return;
      const cleanup = (readyFailure as { detail?: { cleanup?: string } } | undefined)?.detail
        ?.cleanup;
      if (cleanup === 'failed' || cleanup === 'timeout') return;
      pageLost = true;
      browserDetached = false;
      timing('browser-failed');
      readyFailure = wireError(payload.error, 'target execution');
      for (const [id, waiter] of pending) {
        pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        waiter.reject(readyFailure);
      }
      await notifyTargetChanged();
    };
    const settleReady = async (
      payload: Extract<WorkspaceResult, { kind: 'ready' }>,
    ): Promise<void> => {
      if (payload.targetId !== targetId || pageLost || (ready !== undefined && !browserDetached))
        return;
      const caller = acceptedCaller;
      let retirement: Promise<void>;
      do {
        retirement = browserRetirement;
        await retirement;
      } while (retirement !== browserRetirement);
      if (
        sessionClosed ||
        pageLost ||
        caller !== acceptedCaller ||
        (ready !== undefined && !browserDetached)
      )
        return;
      try {
        const project = assertProject(payload.project, facts);
        const target = assertTarget(payload.target, dimensions);
        ready = { ...payload, project, target };
        browserDetached = false;
        browserGeneration += 1;
        if (projectDocument !== undefined)
          projectDocument = { ...projectDocument, browserGeneration };
        timing('browser-ready');
        const url = target.url ?? currentTarget?.url ?? projectDocument?.url;
        currentTarget = {
          ...target,
          ...(url === undefined ? {} : { url }),
        };
      } catch (error) {
        readyFailure = error;
      }
      // Readiness is a session-level event, not a request result. Every
      // caller that was waiting for this one browser page must settle from
      // the same event; using sessionId as a pending-map key would let
      // concurrent callers overwrite one another.
      for (const [id, waiter] of pending) {
        if (waiter.operation !== 'workspace readiness') continue;
        pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        if (readyFailure !== undefined) waiter.reject(readyFailure);
        else waiter.resolve(ready);
      }
      await notifyTargetChanged();
    };
    const settleCommandResult = (payload: Extract<WorkspaceResult, { kind: 'result' }>): void => {
      const waiter = pending.get(payload.id);
      if (
        waiter === undefined ||
        (payload.targetId !== targetId && payload.targetId !== waiter.targetId)
      )
        return;
      pending.delete(payload.id);
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      if (payload.ok) waiter.resolve(payload.value);
      else {
        const error = wireError(payload.error, waiter.operation);
        if (error.detail.cleanup === 'failed' || error.detail.cleanup === 'timeout') {
          readyFailure = error;
          publishStatus();
          for (const listener of statusListeners) {
            try {
              listener();
            } catch {
              // Status observers do not own the command result.
            }
          }
        }
        waiter.reject(error);
      }
    };

    const settleResult = async (payload: WorkspaceResult): Promise<void> => {
      if (
        payload.sessionId !== sessionId ||
        (payload.kind !== 'result' &&
          payload.targetId !== targetId &&
          !previews.has(payload.targetId))
      )
        return;
      if (payload.kind === 'failed' && payload.targetId !== targetId)
        return settlePreviewFailure(payload);
      if (payload.kind === 'lost') return settleLost(payload);
      if (payload.kind === 'failed') return settleFailure(payload);
      if (
        pageLost &&
        !(payload.kind === 'result' && pending.get(payload.id)?.operation === 'closeWorkspace')
      )
        return;
      if (payload.kind === 'ready') return settleReady(payload);
      if (payload.kind === 'result') settleCommandResult(payload);
    };

    const installBackendListeners = (): void => {
      // A headed target samples one presentation lease. Replacing that provider
      // retires its frontend identity; independent game sessions have no such lease.
      if (!parent && binding.frontendAssembly !== undefined) {
        removePresentation = backend.context.on(
          'internal/service',
          (name) => {
            if (
              name !== 'devkitWorkspaceFrontend' ||
              sessionClosed ||
              pageLost ||
              options.hostBinding?.frontendAssembly === binding.frontendAssembly
            )
              return;
            settleResult({
              kind: 'failed',
              id: `presentation:${targetId}`,
              sessionId,
              targetId,
              error: {
                code: 'engine-workspace-page-lost',
                expected: 'the sampled frontend presentation lease to remain active',
                hint: 'The presentation provider changed. Reopen this exact lost target without replaying writes.',
                detail: { sessionId, targetId, stage: 'presentation' },
              },
            });
          },
          { global: true },
        );
      }

      resultRegistration = backend.transport.register(
        engineWorkspaceResultService(targetId),
        async ({ payload, caller }) => {
          assertWorkspaceCaller(caller, sessionId, targetId, acceptedCaller);
          if (payload !== null && typeof payload === 'object')
            await settleResult(payload as WorkspaceResult);
          return { accepted: true };
        },
      );
    };

    const cancel = (id: string, connectionId?: string): void => {
      if (!connectionId) return;
      backend.transport.publish(
        ENGINE_WORKSPACE_COMMAND_TOPIC,
        {
          kind: 'cancel',
          id,
          sessionId,
        } satisfies WorkspaceCommand,
        { connectionId },
      );
    };

    const waitFor = <T>(
      id: string,
      operation: string,
      signal: AbortSignal | undefined,
      timeoutMs = options.readyTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      operationTargetId = targetId,
      previewOwner?: string,
    ): Promise<T> => {
      throwIfAborted(signal);
      const connectionId = acceptedCaller?.connectionId;
      return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = (): void => {
          pending.delete(id);
          clearTimeout(timer);
          cancel(id, connectionId);
          reject(abortReason(signal));
        };
        timer = setTimeout(() => {
          pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
          cancel(id, connectionId);
          reject(
            new DevKitWorkspaceError(
              'engine-workspace-result-timeout',
              `the browser workspace operation ${operation} to return a result`,
              'The headed Engine page did not answer before the workspace timeout.',
              { operation, sessionId, targetId: operationTargetId, timeoutMs },
            ),
          );
        }, timeoutMs);
        pending.set(id, {
          cancel: () => cancel(id, connectionId),
          targetId: operationTargetId,
          ...(previewOwner === undefined ? {} : { previewOwner }),
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
          ...(signal === undefined ? {} : { signal }),
          onAbort,
          operation,
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    };

    const waitReady = async (signal?: AbortSignal): Promise<WorkspaceReadyResult> => {
      throwIfAborted(signal);
      if (pageLost) throw readyFailure;
      if (readyFailure !== undefined) throw readyFailure;
      if (ready !== undefined && !browserDetached) return ready;
      return waitFor<WorkspaceReadyResult>(
        `workspace-ready-${randomUUID()}`,
        'workspace readiness',
        signal,
        readyTimeoutMs,
      );
    };

    const assertCurrentBrowser = (handshake: WorkspaceReadyResult, operation?: string): void => {
      // Session disposal still sends closePreview to its original browser.
      if (operation !== 'closePreview') assertSessionActive();
      if (pageLost || readyFailure !== undefined) throw readyFailure;
      if (ready === handshake && !browserDetached && acceptedCaller) return;
      throw new DevKitWorkspaceError(
        'engine-workspace-browser-detached',
        'the browser that admitted this operation to remain current',
        'Retry explicitly after the replacement Editor becomes ready.',
        { sessionId, targetId },
      );
    };

    const command = async <T>(
      operation: string,
      commandPayload: unknown,
      signal?: AbortSignal,
      admitted?: WorkspaceReadyResult,
    ): Promise<T> => {
      const handshake =
        operation === 'closeWorkspace'
          ? { target: currentTarget }
          : (admitted ?? (await waitReady(signal)));
      if (handshake.target === undefined)
        throw new DevKitWorkspaceError(
          'engine-workspace-capability-unavailable',
          'An authenticated Engine World target',
          'Wait for this exact project document to authenticate and publish its real World.',
          { sessionId, targetId, operation },
        );
      if (handshake.target.targetId !== targetId) {
        throw new DevKitWorkspaceError(
          'engine-workspace-target-mismatch',
          'the browser page target identity to remain current',
          'Treat the iframe as stale and reopen the project.',
          { expectedTargetId: targetId, receivedTargetId: handshake.target.targetId },
        );
      }
      throwIfAborted(signal);
      if (operation !== 'closeWorkspace')
        assertCurrentBrowser(handshake as WorkspaceReadyResult, operation);
      const connectionId = acceptedCaller?.connectionId;
      if (!connectionId) throw inactiveError();
      const destination = commandPayload as { targetId?: string; previewOwner?: string };
      if (
        operation !== 'closePreview' &&
        destination.previewOwner !== undefined &&
        previews.get(destination.targetId ?? targetId)?.handle !== destination.previewOwner
      )
        throw new DevKitWorkspaceError(
          'engine-workspace-preview-closed',
          'this preview owner to remain active when its command is published',
          'Open the asset again before issuing preview operations.',
          { sessionId, targetId: destination.targetId ?? targetId },
        );
      const id = randomUUID();
      const result = waitFor<T>(
        id,
        operation,
        signal,
        operation === 'openPreview' ? readyTimeoutMs : undefined,
        destination.targetId ?? targetId,
        destination.previewOwner,
      );
      try {
        backend.transport.publish(
          ENGINE_WORKSPACE_COMMAND_TOPIC,
          {
            kind: 'command',
            id,
            sessionId,
            operation,
            input: commandPayload,
          } satisfies WorkspaceCommand,
          { connectionId },
        );
      } catch (cause) {
        const waiter = pending.get(id);
        if (waiter !== undefined) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          signal?.removeEventListener('abort', waiter.onAbort);
          waiter.reject(cause);
        }
      }
      const value = await result;
      if (operation !== 'closeWorkspace')
        assertCurrentBrowser(handshake as WorkspaceReadyResult, operation);
      return value;
    };

    const closePreview = async (preview: EngineWorkspacePreview): Promise<void> => {
      if (previews.get(preview.target.targetId) !== preview) return;
      await Promise.resolve(preview.close?.({ targetId: preview.target.targetId }));
      if (previews.get(preview.target.targetId) === preview)
        previews.delete(preview.target.targetId);
    };

    const retireLost = () => {
      // Retiring a lost transport is not proof of native cleanup. Keep the
      // existing lost-target recovery category on the old session handle.
      readyFailure = new DevKitWorkspaceError(
        'engine-workspace-page-lost',
        'The old Workspace connection was lost',
        'The session is retired; native cleanup is unconfirmed. Do not replay its commands.',
        { targetId, sessionId, cleanup: 'unconfirmed', reason: 'transport-lost' },
      );
      publishStatus();
    };
    const closeResources = async (): Promise<void> => {
      if (sessionClosePromise !== undefined) {
        return sessionClosePromise;
      }
      input.startupController.abort(new Error('Project session closed'));
      sessionClosed = true;
      removePresentation?.();
      removePresentation = undefined;
      removeClientConnect();
      sessionClosePromise = (async () => {
        const cleanupFailures: unknown[] = [];
        const attemptCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (cause) {
            cleanupFailures.push(cause);
          }
        };
        if (authoring !== undefined) await attemptCleanup(() => authoring?.dispose());
        const playToClose = play;
        const closePlay = playToClose?.close;
        if (playToClose && closePlay) await attemptCleanup(() => closePlay.call(playToClose));
        play = undefined;
        removeBackendDispose?.();
        removeBackendDispose = undefined;
        for (const [id, waiter] of pending) {
          pending.delete(id);
          clearTimeout(waiter.timer);
          waiter.signal?.removeEventListener('abort', waiter.onAbort);
          waiter.cancel();
          waiter.reject(
            new DevKitWorkspaceError(
              'engine-workspace-session-closed',
              'the Engine workspace session to remain open',
              'Reopen the project before issuing another workspace operation.',
              { sessionId, targetId },
            ),
          );
        }
        for (const preview of [...previews.values()])
          await attemptCleanup(() => closePreview(preview));
        const retireBrowser = async () => {
          let cleanupFailure: unknown;
          const priorCleanup = (readyFailure as { detail?: { cleanup?: string } } | undefined)
            ?.detail?.cleanup;
          if (priorCleanup === 'failed' || priorCleanup === 'timeout') {
            cleanupFailure = readyFailure;
          } else if (ready !== undefined && acceptedCaller === undefined) {
            retireLost();
          } else if (ready !== undefined) {
            try {
              const cleanup = await command<{ cleanup?: string }>('closeWorkspace', { targetId });
              if (cleanup?.cleanup !== 'completed')
                throw new DevKitWorkspaceError(
                  'engine-workspace-cleanup-incomplete',
                  'The old Workspace plugin scopes to report completed cleanup',
                  'Inspect the old browser session before considering project closure complete.',
                  { targetId, cleanup },
                );
            } catch (cause) {
              const reportedCleanup = (cause as { detail?: { cleanup?: string } } | undefined)
                ?.detail?.cleanup;
              if (!acceptedCaller && reportedCleanup !== 'failed' && reportedCleanup !== 'timeout')
                retireLost();
              else {
                cleanupFailure = cause;
                readyFailure = cause;
              }
            }
          }
          return cleanupFailure;
        };
        const cleanupFailure = await retireBrowser();
        revokePage?.();
        revokePage = undefined;
        if (!parent && server !== undefined && !serverClosed) {
          serverClosed = true;
          const serverToClose = server;
          await attemptCleanup(() => serverToClose.close());
        }
        // Finish an accepted cleanup response before invalidating its result service.
        await setImmediate();
        resultRegistration?.();
        resultRegistration = undefined;
        statusListeners.clear();
        const failedCleanup = (cleanupFailure as { detail?: { cleanup?: string } } | undefined)
          ?.detail?.cleanup;
        // A missing acknowledgment may still become a lost connection. Keep
        // observing that connection, without admitting a replacement caller.
        if (!cleanupFailure || failedCleanup === 'failed' || failedCleanup === 'timeout')
          removeClientDisconnect();
        if (ownsBackend && backendBound) await attemptCleanup(() => backend.dispose());
        if (cleanupFailure !== undefined) cleanupFailures.unshift(cleanupFailure);
        if (cleanupFailures.length === 1) throw cleanupFailures[0];
        if (cleanupFailures.length > 1)
          throw new AggregateError(cleanupFailures, 'Project resource cleanup failed');
      })();
      return sessionClosePromise;
    };
    input.publishCleanup(closeResources);

    try {
      assertSessionActive();
      backend = parent?.backend ?? options.hostBinding?.backend ?? (await backendFactory());
      backendBound = true;
      throwIfAborted(input.startupController.signal);
      if (disposed)
        throw new DevKitWorkspaceError(
          'engine-workspace-provider-disposed',
          'the Engine workspace provider to remain active',
          'Create a new workspace provider before opening another project.',
          { sessionId, targetId },
        );
      timing('backend-bound');
      const browserHostBinding = (): DevKitHostBinding => ({
        ...(parent ? { backend } : (options.hostBinding ?? { backend })),
        ...(parent && options.hostBinding?.frontendModule?.prepare
          ? { frontendModule: options.hostBinding.frontendModule }
          : {}),
        workspace: { sessionId, targetId, admissionToken, execution: parent ? 'game' : 'preview' },
        pages,
        ...(parent
          ? {}
          : {
              authoringSourceChanged: (path: string) => authoring?.sourceChanged(path) ?? false,
            }),
      });
      binding = browserHostBinding();
      const workspacePage = binding.workspace;
      if (!workspacePage) throw new TypeError('Workspace page identity missing');
      installClientListeners();
      installBackendListeners();
      for (const change of queuedDraftChanges)
        backend.transport.publish(PACK_DRAFT_CHANGED_TOPIC, change);
      queuedDraftChanges.length = 0;
      if (!ownsBackend) removeBackendDispose = backend.subscribeDispose(input.onBackendDisposed);
      const prepareServer = async () => {
        if (parent) {
          server = parent.server;
          catalogReady = parent.catalogReady;
          const assembly = await pages.prepareGame?.();
          await closeIfInactive();
          revokePage = pages.register({ ...workspacePage, ...(assembly ? { assembly } : {}) });
          timing('project-server-reused');
        } else {
          revokePage = pages.register(workspacePage);
          const config = await createViteConfig(facts, 'serve', '/', {
            server: {
              port: await materializeViteDevPort(options.port ?? 0),
              strictPort: true,
            },
            host: binding,
            scriptablePackMetadata,
          });
          timing('vite-config');
          await closeIfInactive();
          server = await serverFactory(config);
          timing('vite-server-created');
          await closeIfInactive();
          assertSessionActive();
          await server.listen();
          timing('vite-listening');
          await closeIfInactive();
        }
      };
      await prepareServer();
      if (!server) throw new TypeError('Workspace project server missing');
      const serverUrl = localServerUrl(server);
      // Unit providers may intentionally supply a transport-only fake
      // server. A real Vite server exposes httpServer; only that production
      // path waits for the accepted catalog before publishing the page URL.
      const prepareCatalogReadiness = () => {
        if (!parent && server?.httpServer !== undefined) {
          catalogReady = awaitCatalogReady(
            server,
            serverUrl,
            facts.id,
            readyTimeoutMs,
            input.startupController.signal,
          );
          // Cancellation may arrive synchronously during the initial probe.
          // Join its eventual rejection even when admission stops before publication.
          void catalogReady.catch(() => {});
        }
      };
      prepareCatalogReadiness();
      throwIfAborted(input.startupController.signal);
      const workspaceUrl = new URL(parent ? 'game.html' : './', serverUrl);
      workspaceUrl.searchParams.set('forgeaxWorkspace', parent ? 'game' : '1');
      workspaceUrl.searchParams.set('forgeaxWorkspaceSession', sessionId);
      workspaceUrl.searchParams.set('forgeaxWorkspaceTarget', targetId);
      workspaceUrl.searchParams.set('forgeaxWorkspaceToken', admissionToken);
      workspaceUrl.searchParams.set('forgeaxWorkspaceWidth', String(width));
      workspaceUrl.searchParams.set('forgeaxWorkspaceHeight', String(height));
      workspaceUrl.searchParams.set('forgeaxWorkspaceHeaded', headed ? '1' : '0');
      projectDocument = { sessionId, targetId, url: workspaceUrl.href, browserGeneration };
      publishStatus();
      timing('target-url-published');

      const assertSessionOpen = (): void => {
        if (sessionClosed) {
          throw new DevKitWorkspaceError(
            'engine-workspace-session-closed',
            'the Engine workspace session to remain open',
            'Reopen the project before issuing another workspace operation.',
            { sessionId, targetId },
          );
        }
      };
      const proxyTarget = (value: {
        previewOwner: string;
        target?: EngineWorkspaceTarget;
        asset?: EngineWorkspaceAsset;
        assetBinding?: EngineWorkspacePreview['assetBinding'];
      }): EngineWorkspacePreview => {
        const previewOwner = value.previewOwner;
        const ownerBrowserGeneration = Math.max(1, browserGeneration);
        const previewInput = (input: EngineWorkspaceCameraInput) => ({
          ...commandInput(input),
          previewOwner,
        });
        let previewTarget = operationResultTarget(value, {
          ...dimensions,
          targetId: value.target?.targetId ?? targetId,
        });
        const previewTargetId = previewTarget.targetId;
        const previewAsset = operationResultAsset(value);
        let previewClosed = false;
        let previewClosePromise: Promise<void> | undefined;
        const previewClose = async (): Promise<void> => {
          if (previewClosePromise !== undefined) return previewClosePromise;
          previewClosed = true;
          // Preview replacement keeps targetId stable. An older returned
          // wrapper must not close the newer browser preview occupying the
          // same target; only the currently adopted wrapper owns the
          // close command.
          if (previews.get(preview.target.targetId) !== preview) return;
          previews.delete(previewTargetId);
          const closed = new DevKitWorkspaceError(
            'engine-workspace-preview-closed',
            'the Engine workspace preview to remain open',
            'Open the asset again before issuing preview operations.',
            { sessionId, targetId: previewTargetId },
          );
          for (const [id, waiter] of pending) {
            if (waiter.previewOwner !== previewOwner) continue;
            pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            waiter.cancel();
            waiter.reject(closed);
          }
          previewClosePromise = (
            ready &&
            !pageLost &&
            !browserDetached &&
            (parent || ownerBrowserGeneration === Math.max(1, browserGeneration))
              ? command('closePreview', { targetId: previewTargetId, previewOwner }, undefined)
              : Promise.resolve()
          ).then(
            () => undefined,
            (error: unknown) => {
              // Page retirement also interrupts a close already sent by the
              // Shell. It owns no resource in the replacement browser realm.
              if (
                error instanceof DevKitWorkspaceError &&
                error.code === 'engine-workspace-browser-detached' &&
                (browserDetached || ownerBrowserGeneration !== Math.max(1, browserGeneration))
              )
                return;
              throw error;
            },
          );
          return previewClosePromise;
        };
        const assertPreviewOpen = (): void => {
          assertSessionOpen();
          if (preview.failure) throw preview.failure;
          if (browserDetached) {
            throw new DevKitWorkspaceError(
              'engine-workspace-browser-detached',
              'the replacement Engine workspace page to become ready',
              'The headed page is reloading. Wait for it before issuing another command.',
              { sessionId, targetId },
            );
          }
          if (
            previewClosed ||
            (!parent && ownerBrowserGeneration !== Math.max(1, browserGeneration))
          ) {
            throw new DevKitWorkspaceError(
              'engine-workspace-preview-closed',
              'the Engine workspace preview to remain open',
              'Open the asset again before issuing camera or capture operations.',
              { targetId },
            );
          }
          if (previews.get(previewTargetId) !== preview) {
            throw new DevKitWorkspaceError(
              'engine-workspace-preview-closed',
              'this Engine workspace preview to remain the active preview',
              'The preview was replaced; reopen the asset before issuing camera or capture operations.',
              { targetId, reason: 'replaced' },
            );
          }
        };
        const preview: EngineWorkspacePreview & { failure?: DevKitWorkspaceError } = {
          handle: previewOwner,
          async writeAssetField(fieldWrite) {
            assertPreviewOpen();
            await command('authoring.write', {
              targetId: previewTargetId,
              previewOwner,
              fieldWrite,
            });
          },
          async prepareAssetContent(content, signal) {
            assertPreviewOpen();
            return await command<number>(
              'authoring.prepare',
              { targetId: previewTargetId, previewOwner, content: encodePackData(content) },
              signal,
            );
          },
          async commitAssetContent(preparation, fields) {
            assertPreviewOpen();
            await command('authoring.commit', {
              targetId: previewTargetId,
              previewOwner,
              preparation,
              fields,
            });
          },

          get target() {
            return parent ? requireCurrentTarget() : previewTarget;
          },
          ...(previewAsset ? { asset: previewAsset } : {}),
          ...(value.assetBinding === undefined ? {} : { assetBinding: value.assetBinding }),
          ...(previewAsset?.kind !== 'material'
            ? {}
            : {
                material: {
                  get() {
                    assertPreviewOpen();
                    return command('preview.material.get', {
                      targetId: previewTargetId,
                      previewOwner,
                    }) as Promise<import('@forgeax/engine-app').MaterialPreviewState>;
                  },
                  set(mesh: import('@forgeax/engine-app').MaterialPreviewMesh) {
                    assertPreviewOpen();
                    return command('preview.material.set', {
                      targetId: previewTargetId,
                      previewOwner,
                      mesh,
                    }) as Promise<import('@forgeax/engine-app').MaterialPreviewState>;
                  },
                  rotate(input: { readonly yaw: number; readonly pitch: number }) {
                    assertPreviewOpen();
                    return command('preview.material.rotate', {
                      targetId: previewTargetId,
                      previewOwner,
                      ...input,
                    }) as Promise<import('@forgeax/engine-app').MaterialPreviewState>;
                  },
                  reset() {
                    assertPreviewOpen();
                    return command('preview.material.reset', {
                      targetId: previewTargetId,
                      previewOwner,
                    }) as Promise<import('@forgeax/engine-app').MaterialPreviewState>;
                  },
                },
              }),
          display: {
            get(options) {
              assertPreviewOpen();
              return command(
                'preview.display.get',
                {
                  targetId: previewTargetId,
                  previewOwner,
                  ...(options?.uvChannel === undefined ? {} : { uvChannel: options.uvChannel }),
                },
                options?.signal,
              ) as Promise<import('@forgeax/engine-app').EngineWorkspacePreviewDisplay>;
            },
            set(display, options) {
              assertPreviewOpen();
              return command(
                'preview.display.set',
                { targetId: previewTargetId, previewOwner, display },
                options?.signal,
              ) as Promise<import('@forgeax/engine-app').EngineWorkspacePreviewDisplay>;
            },
          },
          setControl: (input) => {
            assertPreviewOpen();
            return command('target.control', previewInput(input), input.signal);
          },
          tools: {
            assistance(input) {
              assertPreviewOpen();
              return command('target.assistance', {
                ...input,
                targetId: previewTargetId,
                previewOwner,
              });
            },
            pick(input) {
              assertPreviewOpen();
              return command('target.pick', { ...input, targetId: previewTargetId, previewOwner });
            },
            highlight(input) {
              assertPreviewOpen();
              return command('entity.highlight', {
                ...input,
                targetId: previewTargetId,
                previewOwner,
              });
            },
            tree(input = {}) {
              assertPreviewOpen();
              return command('scene.tree.get', {
                ...input,
                targetId: previewTargetId,
                previewOwner,
              });
            },
            async inspect({ entityId, signal }) {
              assertPreviewOpen();
              const result = await command<EngineWorkspaceEntityInspection>(
                'entity.inspect',
                { entityId, targetId: previewTargetId, previewOwner },
                signal,
              );
              throwIfAborted(signal);
              assertPreviewOpen();
              return result;
            },
            focus(input) {
              assertPreviewOpen();
              return command('entity.focus', { ...input, targetId: previewTargetId, previewOwner });
            },
          },
          ...(texturePreviewKind(previewAsset?.kind)
            ? {
                texture: {
                  get: () => {
                    assertPreviewOpen();
                    return command(
                      'preview.texture.get',
                      previewInput({ targetId: previewTargetId }),
                    ) as Promise<import('@forgeax/engine-app').TextureViewInfo>;
                  },
                  set: (options) => {
                    assertPreviewOpen();
                    return command('preview.texture.set', {
                      ...previewInput({ targetId: previewTargetId }),
                      options,
                    }) as Promise<import('@forgeax/engine-app').TextureViewInfo>;
                  },
                },
              }
            : {}),
          getCamera: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.get', previewInput(cameraInput), cameraInput.signal);
          },
          beginCameraInteraction: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.begin', previewInput(cameraInput), cameraInput.signal);
          },
          updateCameraDraft: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.update', previewInput(cameraInput), cameraInput.signal);
          },
          commitCamera: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.commit', previewInput(cameraInput), cameraInput.signal);
          },
          abortCameraInteraction: (cameraInput) => {
            assertPreviewOpen();
            return command('camera.abort', previewInput(cameraInput), cameraInput.signal);
          },
          revokeConnection: (input) => {
            // A browser disconnect can arrive while the owning workspace is
            // already closing. Revocation only releases live camera input;
            // closing the preview/session has already released its target.
            if (
              sessionClosed ||
              previewClosed ||
              browserDetached ||
              (!parent && ownerBrowserGeneration !== Math.max(1, browserGeneration)) ||
              previews.get(previewTargetId) !== preview
            )
              return Promise.resolve();
            assertPreviewOpen();
            return command('camera.revoke', previewInput(input));
          },
          async resize(input: Parameters<NonNullable<EngineWorkspacePreview['resize']>>[0]) {
            assertPreviewOpen();
            const result = await command('resize', { ...input, previewOwner }, input.signal);
            assertPreviewOpen();
            previewTarget = operationResultTarget(result, {
              ...dimensions,
              targetId: previewTargetId,
            });
            if (parent) currentTarget = previewTarget;
            return previewTarget;
          },
          capture: (captureInput) => {
            assertPreviewOpen();
            // The browser realm owns the real canvas/renderer. The result
            // is a serializable PNG produced by that canvas, never a Node
            // screenshot or a second browser capture surface.
            return command(
              'capture',
              {
                targetId: previewTargetId,
                previewOwner,
                width: captureInput.width,
                height: captureInput.height,
              },
              captureInput.signal,
            );
          },
          close: previewClose,
        };
        previews.set(previewTargetId, preview);
        return preview;
      };
      const capabilities: SessionCapabilities = {
        borrowTarget: async () => {
          if (!parent)
            return proxyTarget({ previewOwner: sessionId, target: requireCurrentTarget() });
          let live: EngineWorkspacePreview | undefined;
          const runtime = async () => {
            assertSessionOpen();
            if (browserDetached)
              throw new DevKitWorkspaceError(
                'engine-workspace-browser-detached',
                'The replacement game page to authenticate',
                'Wait for the reloaded Play page.',
                { sessionId, targetId },
              );
            await waitReady();
            live ??= proxyTarget({
              previewOwner: sessionId,
              target: requireCurrentTarget(),
            });
            return live;
          };
          const document = projectDocument;
          if (!document) throw new TypeError('Game document missing');
          const tools = async () => {
            const targetTools = (await runtime()).tools;
            if (!targetTools) throw new TypeError('Game target tools missing');
            return targetTools;
          };
          return {
            get target() {
              return currentTarget ?? { ...dimensions, url: document.url };
            },
            getCamera: async (value) => (await runtime()).getCamera(value),
            beginCameraInteraction: async (value) =>
              (await runtime()).beginCameraInteraction?.(value),
            updateCameraDraft: async (value) => (await runtime()).updateCameraDraft?.(value),
            commitCamera: async (value) => (await runtime()).commitCamera?.(value),
            abortCameraInteraction: async (value) =>
              (await runtime()).abortCameraInteraction?.(value),
            revokeConnection: async (value) => live?.revokeConnection?.(value),
            setControl: async (value) => (await runtime()).setControl?.(value),
            resize: async (value) => {
              const resize = (await runtime()).resize;
              if (!resize) throw new TypeError('Game resize missing');
              return resize(value);
            },
            capture: async (value) => (await runtime()).capture?.(value),
            tools: {
              tree: async (value) => (await tools()).tree(value),
              inspect: async (value) => (await tools()).inspect(value),
              pick: async (value) => (await tools()).pick?.(value),
              highlight: async (value) => (await tools()).highlight?.(value),
              focus: async (value) => (await tools()).focus?.(value),
            },
          };
        },
        ready: async (signal) => {
          if (parent) timing('game-ready-wait');
          await waitReady(signal);
          if (parent) timing('game-ready');
        },
        ...(!parent
          ? {
              async startPlay(
                { signal }: { signal?: AbortSignal },
                admitted?: WorkspaceReadyResult,
              ) {
                assertSessionOpen();
                const playStarted = performance.now();
                const playLog = (stage: string): void => {
                  console.error(
                    '[forgeax.play]',
                    JSON.stringify({
                      root: facts.root,
                      sessionId,
                      targetId,
                      execution: 'editor',
                      stage,
                      totalMs: Math.round(performance.now() - playStarted),
                    }),
                  );
                };
                playLog('editor-ready-wait');
                const editorBrowser = admitted ?? (await waitReady(signal));
                playLog('editor-ready');
                assertCurrentBrowser(editorBrowser);
                if (play)
                  throw new DevKitWorkspaceError(
                    'engine-workspace-target-busy',
                    'One Play per project',
                    'Stop the current Play first.',
                  );
                let game: BrowserSession | undefined;
                try {
                  throwIfAborted(signal);
                  playLog('game-session-open');
                  const projectServer = server;
                  if (!projectServer) throw new TypeError('Project server missing');
                  game = await openSession(
                    {
                      root: facts.root,
                      generation: input.generation,
                      ...(signal ? { signal } : {}),
                    },
                    { backend, server: projectServer, pages, catalogReady },
                  );
                  const target = await game.borrowTarget(signal);
                  playLog('game-session-opened');
                  throwIfAborted(signal);
                  assertSessionOpen();
                  assertCurrentBrowser(editorBrowser);
                  const owned = game;
                  let closing: Promise<void> | undefined;
                  const next: EngineWorkspacePlay = {
                    ...target,
                    get target() {
                      return target.target;
                    },
                    get phase() {
                      return owned.phase;
                    },
                    get browserGeneration() {
                      return owned.browserGeneration;
                    },
                    ready: owned.ready,
                    close() {
                      if (closing) return closing;
                      closing = Promise.resolve(owned.close?.()).then(() => {
                        if (play === next) play = undefined;
                      });
                      return closing;
                    },
                  };
                  play = next;
                  return next;
                } catch (error) {
                  await game?.close?.();
                  throw error;
                }
              },
            }
          : {}),
        runtimePack: async (input, admitted) => {
          assertSessionOpen();
          await catalogReady;
          const handshake = admitted ?? (await waitReady(input.signal));
          assertSessionOpen();
          assertCurrentBrowser(handshake);
          const target = requireCurrentTarget();
          if (input.targetId !== targetId || input.worldId !== target.worldId)
            throw new DevKitWorkspaceError(
              'engine-workspace-target-stale',
              'The current project App and World',
              'Refresh engine.workspace.get before submitting runtime content.',
              { target },
            );
          return command(
            'runtimePack',
            {
              targetId,
              worldId: input.worldId,
              request: input.request,
              ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            },
            input.signal,
            handshake,
          );
        },
        inspectAsset: async ({ guid, signal }, admitted) => {
          assertSessionOpen();
          return command('inspectAsset', { targetId, guid }, signal, admitted);
        },
        listAssets: async ({ signal } = {}, admitted) => {
          assertSessionOpen();
          await catalogReady;
          const result = await command<readonly EngineWorkspaceAsset[]>(
            'listAssets',
            { targetId },
            signal,
            admitted,
          );
          if (!Array.isArray(result)) {
            throw new DevKitWorkspaceError(
              'engine-workspace-assets-invalid',
              'the browser page to return an asset array',
              'Inspect the generated Engine workspace page and retry.',
              {},
            );
          }
          return result;
        },
        openPreview: async (
          { asset, width: previewWidth, height: previewHeight, signal },
          admitted,
        ) => {
          assertSessionOpen();
          await catalogReady;
          const editorBrowser = admitted ?? (await waitReady(signal));
          assertCurrentBrowser(editorBrowser);
          // Scene editing owns the project surface. Type previews always get
          // their own surface, including the first asset opened in a project.
          const previewTargetId =
            asset.kind === 'scene' ? targetId : `${targetId}:preview:${randomUUID()}`;
          const value = await command<unknown>(
            'openPreview',
            { targetId, previewTargetId, asset, width: previewWidth, height: previewHeight },
            signal,
            editorBrowser,
          );
          assertCurrentBrowser(editorBrowser);
          if (
            !value ||
            typeof value !== 'object' ||
            !('previewOwner' in value) ||
            typeof value.previewOwner !== 'string'
          ) {
            throw new DevKitWorkspaceError(
              'engine-workspace-preview-invalid',
              'the Engine browser preview allocation identity',
              'Use the matching generated Engine workspace document.',
              {},
            );
          }
          return proxyTarget({
            previewOwner: value.previewOwner as string,
            target: operationResultTarget(value, { ...dimensions, targetId: previewTargetId }),
            asset: operationResultAsset(value) ?? asset,
            ...('assetBinding' in value
              ? { assetBinding: value.assetBinding as EngineWorkspacePreview['assetBinding'] }
              : {}),
          });
        },
      };
      input.publishCapabilities(capabilities);
      await catalogReady;
      timing('catalog-ready');
    } catch (cause) {
      input.publishFailure(cause);
      try {
        await closeResources();
      } catch (cleanupCause) {
        throw new AggregateError([cause, cleanupCause], 'Project startup and cleanup failed', {
          cause,
        });
      }
      throw cause;
    }
  };
  const openSession = async (
    input: { root: string; generation: number; signal?: AbortSignal },
    parent?: ProjectServer,
  ): Promise<BrowserSession> => {
    throwIfAborted(input.signal);
    if (failedCleanup !== undefined) throw failedCleanup;
    const facts = await readProjectFacts(input.root);
    if (!facts.ok) {
      const error = facts.error;
      throw new DevKitWorkspaceError(error.code, error.expected, error.hint, error.detail);
    }
    const registered = await rememberKnownProject(facts.value);
    if (!registered.ok)
      throw new DevKitWorkspaceError(
        registered.error.code,
        registered.error.expected,
        registered.error.hint,
        registered.error.detail,
      );
    throwIfAborted(input.signal);
    const sessionId = `workspace-${randomUUID()}`;
    const targetId = `target-${randomUUID()}`;
    const project = {
      id: facts.value.id,
      root: facts.value.root,
      name: facts.value.name,
      assetRoots: facts.value.assetRoots,
    };
    const startupController = new AbortController();
    const listeners = new Set<() => void>();
    type AuthorPack = NonNullable<EngineWorkspaceProjectSession['authorPack']>;
    let resolveAuthoring!: (execute: AuthorPack) => void;
    let rejectAuthoring!: (cause: unknown) => void;
    let authoringReady = false;
    const authoring = new Promise<AuthorPack>((resolve, reject) => {
      resolveAuthoring = resolve;
      rejectAuthoring = reject;
    });
    void authoring.catch(() => {});
    let resolveCapabilities!: (value: SessionCapabilities) => void;
    let rejectCapabilities!: (cause: unknown) => void;
    let capabilitiesReady = false;
    const capabilitiesPromise = new Promise<SessionCapabilities>((resolve, reject) => {
      resolveCapabilities = resolve;
      rejectCapabilities = reject;
    });
    void capabilitiesPromise.catch(() => {});
    let capabilities: SessionCapabilities | undefined;
    let cleanupOwner: (() => Promise<void>) | undefined;
    let failure: unknown;
    let readBrowserAdmission: () => WorkspaceReadyResult | undefined = () => undefined;
    let closing: Promise<void> | undefined;
    let status: EngineWorkspaceProjectSession['status'] = {
      phase: 'preparing',
      sessionId,
      generation: input.generation,
    };
    const notify = (): void => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Observers cannot stop the session owner from publishing to others.
        }
      }
    };
    const publishStatus = (next: EngineWorkspaceProjectSession['status']): void => {
      if (next.sessionId !== sessionId || next.generation !== input.generation)
        throw new TypeError('Project status publication changed its session owner identity');
      status = next;
      notify();
    };
    const publishFailure = (cause: unknown): void => {
      failure = cause;
      const prior = status;
      publishStatus({
        phase: 'failed',
        sessionId,
        generation: input.generation,
        ...('document' in prior && prior.document ? { document: prior.document } : {}),
        ...('target' in prior && prior.target ? { target: prior.target } : {}),
        failure: cause,
        ...('browserGeneration' in prior && prior.browserGeneration !== undefined
          ? { browserGeneration: prior.browserGeneration }
          : {}),
      } as EngineWorkspaceProjectSession['status']);
      if (!authoringReady) rejectAuthoring(cause);
      if (!capabilitiesReady) rejectCapabilities(cause);
    };
    const publishCapabilities = (next: SessionCapabilities): void => {
      capabilities = next;
      capabilitiesReady = true;
      resolveCapabilities(next);
    };
    const closedError = (): DevKitWorkspaceError =>
      new DevKitWorkspaceError(
        'engine-workspace-session-closed',
        'the admitted project session to remain open',
        'Open a new project session before using its capabilities.',
        { sessionId, targetId },
      );
    const requireCapabilities = async (signal?: AbortSignal): Promise<SessionCapabilities> => {
      throwIfAborted(signal);
      if (startupController.signal.aborted) throw failure ?? closedError();
      const resolved = capabilities ?? (await abortable(capabilitiesPromise, signal));
      if (startupController.signal.aborted) throw failure ?? closedError();
      return resolved;
    };
    let startup!: Promise<void>;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        startupController.abort(new Error('Project session closed'));
        if (!authoringReady && failure === undefined) {
          const error = new DevKitWorkspaceError(
            'engine-workspace-session-closed',
            'The Engine workspace session to remain open',
            'Reopen the project before issuing another workspace operation.',
            { sessionId, targetId },
          );
          rejectAuthoring(error);
        }
        await startup.catch(() => {});
        try {
          await cleanupOwner?.();
        } catch (cause) {
          const cleanup = (cause as { detail?: { cleanup?: string } })?.detail?.cleanup;
          if (cleanup === 'failed' || cleanup === 'timeout') failedCleanup = cause;
          throw cause;
        }
        listeners.clear();
        activeProjectSessions.delete(close);
      })());
    // The returned preparing session owns its continuing startup. A ToolRun
    // ends its execution signal even on success; only session close/disposal
    // may cancel work after this admission boundary.
    activeProjectSessions.add(close);
    startup = createBrowserSession(
      {
        root: facts.value.root,
        generation: input.generation,
        startupController,
        publishStatus,
        publishFailure,
        publishCapabilities,
        publishBrowserAdmission: (read) => {
          readBrowserAdmission = read;
        },
        publishCleanup: (close) => {
          cleanupOwner = close;
        },
        onBackendDisposed: () => {
          void close().catch(() => {});
        },
        onAuthoringReady: (execute) => {
          authoringReady = true;
          resolveAuthoring(execute);
        },
      },
      parent,
      facts.value,
      sessionId,
      targetId,
    ).catch((cause: unknown) => {
      if (failure === undefined) publishFailure(cause);
      throw cause;
    });
    void startup.catch(() => {});

    const session: BrowserSession = {
      project,
      get status() {
        return status;
      },
      subscribeStatus(listener) {
        if (closing) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get phase() {
        return status.phase === 'failed'
          ? 'failed'
          : status.phase === 'running'
            ? 'running'
            : 'starting';
      },
      get browserGeneration() {
        return 'browserGeneration' in status ? (status.browserGeneration ?? 0) : 0;
      },
      async borrowTarget(signal) {
        return (await requireCapabilities(signal)).borrowTarget(signal);
      },
      async ready(signal) {
        await (await requireCapabilities(signal)).ready(signal);
      },
      async runtimePack(operation) {
        const admitted = readBrowserAdmission();
        return (await requireCapabilities(operation.signal)).runtimePack(operation, admitted);
      },
      async inspectAsset(operation) {
        const admitted = readBrowserAdmission();
        return (await requireCapabilities(operation.signal)).inspectAsset(operation, admitted);
      },
      async listAssets(operation = {}) {
        const admitted = readBrowserAdmission();
        return (await requireCapabilities(operation.signal)).listAssets(operation, admitted);
      },
      async openPreview(operation) {
        const admitted = readBrowserAdmission();
        return (await requireCapabilities(operation.signal)).openPreview(operation, admitted);
      },
      async close() {
        await close();
      },
      ...(!parent
        ? {
            async authorPack(
              operation: Parameters<NonNullable<EngineWorkspaceProjectSession['authorPack']>>[0],
            ) {
              const execute = await abortable(authoring, operation.signal);
              if (startupController.signal.aborted)
                throw startupController.signal.reason ?? new Error('Project session is closed');
              return execute(operation);
            },
            async startPlay(operation: { readonly signal?: AbortSignal }) {
              const admitted = readBrowserAdmission();
              const prepared = await requireCapabilities(operation.signal);
              if (!prepared.startPlay)
                throw new DevKitWorkspaceError(
                  'engine-workspace-capability-unavailable',
                  'Play from this project session',
                  'Open a headed editor project before starting Play.',
                  { sessionId, targetId },
                );
              return prepared.startPlay(operation, admitted);
            },
          }
        : {}),
    };
    return session;
  };
  const provider = createEngineWorkspaceProvider({
    openProjectSession: (input: { root: string; generation: number; signal?: AbortSignal }) =>
      trackOpening(async () => {
        if (disposed) throw new Error('Engine workspace provider is disposed');
        throwIfAborted(input.signal);
        return openSession(input);
      }),
  });
  return Object.freeze({
    ...provider,
    async prepareRuntimePackProgram(
      input: Parameters<NonNullable<EngineWorkspaceProvider['prepareRuntimePackProgram']>>[0],
    ) {
      throwIfAborted(input.signal);
      const prepared = prepareRuntimePackProgram(input.source).unwrap();
      throwIfAborted(input.signal);
      return prepared;
    },
    async inspectAsset(input: Parameters<NonNullable<EngineWorkspaceProvider['inspectAsset']>>[0]) {
      throwIfAborted(input.signal);
      // The live Registry owns runtime-only payloads and their current facts.
      if (input.handle !== undefined) {
        const inspection = await provider.inspectAsset?.(input);
        throwIfAborted(input.signal);
        if (!isRecord(inspection) || !isRecord(inspection.asset)) return inspection;
        const asset = inspection.asset;
        const sourcePath = typeof asset.path === 'string' ? asset.path : undefined;
        // Internal delivery containers share the suffix but have no authored
        // output identity. Only the producer's packageId + sourceKey admits enrichment.
        if (
          !sourcePath?.endsWith('.pack.json') ||
          typeof asset.packageId !== 'string' ||
          typeof asset.sourceKey !== 'string'
        )
          return inspection;
        const authored = await inspectAuthoredPack(
          input.project.root,
          sourcePath,
          asset.sourceKey,
          input.guid,
          input.signal,
        );
        return {
          ...inspection,
          source: {
            ...(isRecord(inspection.source) ? inspection.source : {}),
            path: sourcePath,
            ...(authored.revision === undefined ? {} : { revision: authored.revision }),
          },
          meta: { ...(isRecord(inspection.meta) ? inspection.meta : {}), ...authored.meta },
          ...(authored.revision === undefined ? {} : { revision: authored.revision }),
        };
      }
      const result = await assetInspectCommand({ root: input.project.root, subject: input.guid });
      throwIfAborted(input.signal);
      if (!result.ok)
        throw new DevKitWorkspaceError(
          result.error.code,
          result.error.expected,
          result.error.hint,
          result.error.detail,
        );
      const asset = result.value as Record<string, unknown>;
      const sourcePath = typeof asset.sourcePath === 'string' ? asset.sourcePath : undefined;
      const authored =
        sourcePath?.endsWith('.pack.json') && typeof asset.sourceKey === 'string'
          ? await inspectAuthoredPack(
              input.project.root,
              sourcePath,
              asset.sourceKey,
              input.guid,
              input.signal,
            )
          : undefined;
      const revision = authored?.revision ?? asset.revision;
      return {
        guid: input.guid,
        asset,
        ...(sourcePath === undefined
          ? {}
          : {
              source: {
                path: sourcePath,
                ...(sourcePath.endsWith('.pack.ts') ? { kind: 'pack.ts' } : {}),
                ...(revision === undefined ? {} : { revision }),
              },
            }),
        ...(authored === undefined ? {} : { meta: authored.meta }),
        ...(revision === undefined ? {} : { revision }),
        ...(asset.cookReceiptUrl === undefined
          ? {}
          : { ddc: { receiptUrl: asset.cookReceiptUrl } }),
      };
    },
    async dispose() {
      const cleanupFailures: unknown[] = [];
      const closeOwned = async (owners: readonly (() => Promise<void>)[]): Promise<void> => {
        const results = await Promise.allSettled(owners.map((close) => close()));
        for (const result of results) {
          if (result.status !== 'rejected' || cleanupFailures.includes(result.reason)) continue;
          cleanupFailures.push(result.reason);
        }
      };
      disposed = true;
      const opening = [...openings];
      try {
        await closeOwned([...activeProjectSessions]);
      } finally {
        await Promise.allSettled(opening);
        await closeOwned([...activeProjectSessions]);
        scriptablePackMetadata.clear();
      }
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      if (cleanupFailures.length > 1)
        throw new AggregateError(cleanupFailures, 'DevKit project resource cleanup failed');
    },
  });
}

function texturePreviewKind(kind: string | undefined): boolean {
  return (
    kind === 'texture' ||
    kind === 'gpu-texture' ||
    kind === 'equirect' ||
    kind === 'texture-generator'
  );
}
