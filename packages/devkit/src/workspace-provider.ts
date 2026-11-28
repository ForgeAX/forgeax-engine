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
  type EngineWorkspacePreviewDisplay,
  type EngineWorkspaceProject,
  type EngineWorkspaceProjectDocument,
  type EngineWorkspaceProjectSession,
  type EngineWorkspaceProvider,
  type EngineWorkspaceTarget,
  engineWorkspaceResultService,
  type MaterialPreviewMesh,
  type MaterialPreviewState,
  type TextureViewInfo,
} from '@forgeax/engine-app';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { type BackendHost, createBackendHost } from '@forgeax/engine-host/backend';
import type { HostCallerIdentity } from '@forgeax/engine-host/transport';
import { encodePackData } from '@forgeax/engine-pack/runtime';
import { PACK_DRAFT_CHANGED_TOPIC, type PackDraftReply } from '@forgeax/engine-pack/source';
import { createScriptablePackMetadataCache } from '@forgeax/engine-pack/source-node';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import { assetInspectCommand } from './assets.js';
import { prepareRuntimePackProgram } from './build/pack-program.js';
import {
  createViteConfig,
  firstPackCatalogUrl,
  probePackCatalog,
  servingPackPlugin,
} from './host.js';
import { type DevKitHostBinding, DevKitProjectPages } from './host-binding.js';
import { rememberKnownProject } from './known-projects.js';
import { materializeViteDevPort } from './loopback.js';
import { readProjectFacts } from './project.js';
import { beforeDeadline } from './startup-budget.js';
import { createDeferred, TargetRequests } from './target-requests.js';
import type { CommandError, ProjectFacts } from './types.js';
import { createWorkspacePackAuthoring } from './workspace-pack-authoring.js';
import type { WorkspacePackCookPlugin } from './workspace-pack-cook.js';
import { createWorkspacePreparation } from './workspace-preparation.js';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
// Cold shader initialization shares the GPU with already running targets.
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function deferred<T>() {
  const pending = createDeferred<T>();
  void pending.promise.catch(() => {});
  return pending;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // A producer may close the session synchronously before returning its work.
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
  }
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

function workspaceFailure(error: CommandError): DevKitWorkspaceError {
  return new DevKitWorkspaceError(error.code, error.expected, error.hint, error.detail);
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
  signal?.throwIfAborted();
  if (!result.ok) throw workspaceFailure(result.error);
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

function hasFailedNativeCleanup(error: unknown): boolean {
  const cleanup = (error as { detail?: { cleanup?: string } } | undefined)?.detail?.cleanup;
  return cleanup === 'failed' || cleanup === 'timeout';
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

function catalogNotReady(detail: Readonly<Record<string, unknown>>): DevKitWorkspaceError {
  return new DevKitWorkspaceError(
    'engine-workspace-catalog-not-ready',
    'the project Pack catalog to become ready before the workspace page loads',
    'Wait for the project producer to finish, repair its diagnostics if it failed, and reopen the workspace.',
    detail,
  );
}

/** Observe producer readiness independently of the provisional page URL. */
async function awaitCatalogReady(
  server: ViteDevServer,
  serverUrl: string,
  scopeId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const pack = servingPackPlugin(server);
  if (typeof pack?.ready !== 'function') {
    await waitForRuntimeCatalog(serverUrl, scopeId, timeoutMs, signal);
    return;
  }
  signal?.throwIfAborted();
  const wait = new AbortController();
  const scope = signal === undefined ? wait.signal : AbortSignal.any([signal, wait.signal]);
  try {
    await beforeDeadline(
      () => abortable(pack.ready(), scope),
      timeoutMs,
      () => {
        throw catalogNotReady({
          timeoutMs,
          catalogUrl: firstPackCatalogUrl(serverUrl, scopeId).href,
        });
      },
    );
  } finally {
    wait.abort();
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
  signal?.throwIfAborted();
  const failure = await probePackCatalog(
    firstPackCatalogUrl(serverUrl, scopeId),
    timeoutMs,
    signal,
  );
  if (failure !== undefined) throw catalogNotReady(failure);
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

function normalizePreviewAsset(asset: unknown): EngineWorkspaceAsset | undefined {
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
  type BrowserOperation =
    | 'runtimePack'
    | 'inspectAsset'
    | 'listAssets'
    | 'openPreview'
    | 'startPlay';
  type SessionCapabilities = Pick<BrowserSession, 'borrowTarget' | 'ready'> & {
    [K in BrowserOperation]: (
      input: Parameters<NonNullable<BrowserSession[K]>>[0],
      admitted?: WorkspaceReadyResult,
    ) => ReturnType<NonNullable<BrowserSession[K]>>;
  };
  type ProjectServer = {
    readonly backend: BackendHost;
    readonly server: ViteDevServer;
    readonly pages: DevKitProjectPages;
    readonly catalogReady: Promise<void>;
  };
  const openSession = async (
    input: { root: string; generation: number; signal?: AbortSignal },
    parent?: ProjectServer,
  ): Promise<BrowserSession> => {
    input.signal?.throwIfAborted();
    if (failedCleanup !== undefined) throw failedCleanup;
    const opened = await readProjectFacts(input.root);
    if (!opened.ok) throw workspaceFailure(opened.error);
    const facts = opened.value;
    const registered = await rememberKnownProject(facts);
    if (!registered.ok) throw workspaceFailure(registered.error);
    input.signal?.throwIfAborted();
    const sessionId = `workspace-${randomUUID()}`;
    const targetId = `target-${randomUUID()}`;
    const project = {
      id: facts.id,
      root: facts.root,
      name: facts.name,
      assetRoots: facts.assetRoots,
    };
    const startupController = new AbortController();
    const listeners = new Set<() => void>();
    type AuthorPack = NonNullable<EngineWorkspaceProjectSession['authorPack']>;
    const authoring = deferred<AuthorPack>();
    const startupCapabilities = deferred<SessionCapabilities>();
    let authoringReady = false;
    let capabilities: SessionCapabilities | undefined;
    let cleanupOwner: (() => Promise<void>) | undefined;
    let failure: unknown;
    let ready: WorkspaceReadyResult | undefined;
    let browserDetached = false;
    const readBrowserAdmission = () => (browserDetached ? undefined : ready);
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
    const setStatus = (next: EngineWorkspaceProjectSession['status']): void => {
      if (next.sessionId !== sessionId || next.generation !== input.generation)
        throw new TypeError('Project status publication changed its session owner identity');
      status = next;
      notify();
    };
    const publishFailure = (cause: unknown): void => {
      failure = cause;
      setStatus({ ...status, phase: 'failed', failure: cause });
      authoring.reject(cause);
      startupCapabilities.reject(cause);
    };
    const closedError = (): DevKitWorkspaceError =>
      new DevKitWorkspaceError(
        'engine-workspace-session-closed',
        'the admitted project session to remain open',
        'Open a new project session before using its capabilities.',
        { sessionId, targetId },
      );
    const requireCapabilities = async (signal?: AbortSignal): Promise<SessionCapabilities> => {
      signal?.throwIfAborted();
      if (startupController.signal.aborted) throw failure ?? closedError();
      const resolved = capabilities ?? (await abortable(startupCapabilities.promise, signal));
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
          authoring.reject(error);
        }
        await startup.catch(() => {});
        try {
          await cleanupOwner?.();
        } catch (cause) {
          if (hasFailedNativeCleanup(cause)) failedCleanup = cause;
          throw cause;
        }
        listeners.clear();
        activeProjectSessions.delete(close);
      })());
    // The returned preparing session owns its continuing startup. A ToolRun
    // ends its execution signal even on success; only session close/disposal
    // may cancel work after this admission boundary.
    activeProjectSessions.add(close);
    const initializeBrowser = async (): Promise<void> => {
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
      const previews = new Map<
        string,
        EngineWorkspacePreview & { failure?: DevKitWorkspaceError }
      >();
      const queuedDraftChanges: { readonly sessionId: string; readonly reply: PackDraftReply }[] =
        [];
      let draftAuthoring: ReturnType<typeof createWorkspacePackAuthoring> | undefined;
      if (!parent)
        draftAuthoring = createWorkspacePackAuthoring({
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
            const pack = servingPackPlugin(server);
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
            const binding = servingPackPlugin(server)?.runtimeBinding?.();
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
      if (draftAuthoring) {
        authoringReady = true;
        authoring.resolve(draftAuthoring.execute);
      }
      let binding!: DevKitHostBinding;
      const pending = new TargetRequests<string, PendingResult>();
      let readyFailure: unknown;
      let pageLost = false;
      let browserGeneration = 0;
      let browserRetirement = Promise.resolve();
      let resultRegistration: (() => void) | undefined;
      let removePresentation: (() => void) | undefined;
      let acceptedCaller: HostCallerIdentity | undefined;
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
      const preparation = createWorkspacePreparation(() => publishStatus());
      const publishStatus = (): void => {
        const target = currentTarget;
        const progress = preparation.read();
        const session = {
          ...(progress === undefined ? {} : { preparation: progress }),
          sessionId,
          generation: input.generation,
        };
        if (pageLost || readyFailure !== undefined) {
          setStatus({
            phase: 'failed',
            ...session,
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
          return;
        }
        if (projectDocument === undefined) {
          setStatus({ phase: 'preparing', ...session });
          return;
        }
        const document = { ...session, document: projectDocument, browserGeneration };
        if (ready !== undefined) {
          setStatus({ phase: 'running', ...document, target: requireCurrentTarget() });
        } else {
          setStatus({
            phase: 'starting',
            ...document,
            ...(browserGeneration > 0 && target !== undefined ? { target } : {}),
          });
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
        if (!disposed && !sessionClosed && !startupController.signal.aborted) return;
        await closeResources();
        throw inactiveError();
      };

      const notifyTargetChanged = async (): Promise<void> => {
        publishStatus();
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
        for (const waiter of pending.values()) {
          if (waiter.targetId !== payload.targetId) continue;
          waiter.reject(preview.failure);
        }
        await notifyTargetChanged();
      };
      const settleTerminalBrowser = (error: unknown, stage: 'browser-lost' | 'browser-failed') => {
        pageLost = true;
        browserDetached = false;
        timing(stage);
        readyFailure = error;
        for (const waiter of pending.values()) waiter.reject(error);
        return notifyTargetChanged();
      };
      const settleLost = async (payload: WorkspacePageLostResult): Promise<void> => {
        if (payload.targetId !== targetId || (pageLost && acceptedCaller !== undefined)) return;
        if (hasFailedNativeCleanup(readyFailure)) return;
        // A disconnect must not erase the failure that made the live realm terminal.
        if (!sessionClosed && readyFailure !== undefined) {
          pageLost = true;
          return;
        }
        // A close already owns this session. Keep the terminal lost-target
        // record so a later reopen can prove the old page will not answer.
        if (sessionClosed) {
          return settleTerminalBrowser(
            new DevKitWorkspaceError(
              'engine-workspace-page-lost',
              'the Engine workspace browser page to remain connected',
              'The headed page was destroyed or navigated away; reopen the project instead of replaying commands.',
              { sessionId, targetId, cleanup: 'unconfirmed', reason: 'transport-lost' },
            ),
            'browser-lost',
          );
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
        for (const waiter of pending.values()) {
          if (waiter.operation === 'workspace readiness') continue;
          waiter.reject(detached);
        }
        browserRetirement = Promise.all([browserRetirement, notifyTargetChanged()]).then(
          () => undefined,
        );
      };
      const settleFailure = async (payload: WorkspacePageLostResult): Promise<void> => {
        if (payload.targetId !== targetId || pageLost || hasFailedNativeCleanup(readyFailure))
          return;
        return settleTerminalBrowser(
          wireError(payload.error, 'target execution'),
          'browser-failed',
        );
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
        for (const waiter of pending.values()) {
          if (waiter.operation !== 'workspace readiness') continue;
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
        if (payload.ok) waiter.resolve(payload.value);
        else {
          const error = wireError(payload.error, waiter.operation);
          waiter.reject(error);
          if (hasFailedNativeCleanup(error)) {
            readyFailure = error;
            publishStatus();
          }
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
        const connectionId = acceptedCaller?.connectionId;
        const cancelRequest = () => cancel(id, connectionId);
        return pending.open<T>(
          id,
          {
            cancel: cancelRequest,
            targetId: operationTargetId,
            ...(previewOwner === undefined ? {} : { previewOwner }),
            operation,
          },
          {
            ms: timeoutMs,
            error: () =>
              new DevKitWorkspaceError(
                'engine-workspace-result-timeout',
                `the browser workspace operation ${operation} to return a result`,
                'The headed Engine page did not answer before the workspace timeout.',
                { operation, sessionId, targetId: operationTargetId, timeoutMs },
              ),
          },
          signal,
          cancelRequest,
        );
      };

      const waitReady = async (signal?: AbortSignal): Promise<WorkspaceReadyResult> => {
        signal?.throwIfAborted();
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
        const closing = operation === 'closeWorkspace';
        const handshake = closing ? undefined : (admitted ?? (await waitReady(signal)));
        const target = closing ? currentTarget : handshake?.target;
        if (target === undefined)
          throw new DevKitWorkspaceError(
            'engine-workspace-capability-unavailable',
            'An authenticated Engine World target',
            'Wait for this exact project document to authenticate and publish its real World.',
            { sessionId, targetId, operation },
          );
        if (target.targetId !== targetId) {
          throw new DevKitWorkspaceError(
            'engine-workspace-target-mismatch',
            'the browser page target identity to remain current',
            'Treat the iframe as stale and reopen the project.',
            { expectedTargetId: targetId, receivedTargetId: target.targetId },
          );
        }
        signal?.throwIfAborted();
        if (handshake !== undefined) assertCurrentBrowser(handshake, operation);
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
          pending.get(id)?.reject(cause);
        }
        const value = await result;
        if (handshake !== undefined) assertCurrentBrowser(handshake, operation);
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
        startupController.abort(new Error('Project session closed'));
        sessionClosed = true;
        preparation.close();
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
          if (draftAuthoring !== undefined) await attemptCleanup(() => draftAuthoring.dispose());
          const playToClose = play;
          const closePlay = playToClose?.close;
          if (playToClose && closePlay) await attemptCleanup(() => closePlay.call(playToClose));
          play = undefined;
          removeBackendDispose?.();
          removeBackendDispose = undefined;
          for (const waiter of pending.values()) {
            waiter.reject(
              new DevKitWorkspaceError(
                'engine-workspace-session-closed',
                'the Engine workspace session to remain open',
                'Reopen the project before issuing another workspace operation.',
                { sessionId, targetId },
              ),
            );
            waiter.cancel();
          }
          for (const preview of [...previews.values()])
            await attemptCleanup(() => closePreview(preview));
          const retireBrowser = async () => {
            let cleanupFailure: unknown;
            if (hasFailedNativeCleanup(readyFailure)) {
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
                if (!acceptedCaller && !hasFailedNativeCleanup(cause)) retireLost();
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
          // A missing acknowledgment may still become a lost connection. Keep
          // observing that connection, without admitting a replacement caller.
          if (!cleanupFailure || hasFailedNativeCleanup(cleanupFailure)) removeClientDisconnect();
          if (ownsBackend && backendBound) await attemptCleanup(() => backend.dispose());
          if (cleanupFailure !== undefined) cleanupFailures.unshift(cleanupFailure);
          if (cleanupFailures.length === 1) throw cleanupFailures[0];
          if (cleanupFailures.length > 1)
            throw new AggregateError(cleanupFailures, 'Project resource cleanup failed');
        })();
        return sessionClosePromise;
      };
      cleanupOwner = closeResources;

      try {
        preparation.host('project-config');
        assertSessionActive();
        backend = parent?.backend ?? options.hostBinding?.backend ?? (await backendFactory());
        backendBound = true;
        startupController.signal.throwIfAborted();
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
          workspace: {
            sessionId,
            targetId,
            admissionToken,
            execution: parent ? 'game' : 'preview',
          },
          pages,
          ...(parent
            ? {}
            : {
                authoringSourceChanged: (path: string) =>
                  draftAuthoring?.sourceChanged(path) ?? false,
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
        if (!ownsBackend)
          removeBackendDispose = backend.subscribeDispose(() => {
            void close().catch(() => {});
          });
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
              onPreparation: (operation) => {
                if (!startupController.signal.aborted && !sessionClosed)
                  preparation.host(operation);
              },
              onShaderProgress: (event) => {
                if (!startupController.signal.aborted && !sessionClosed) preparation.shader(event);
              },
              onPackProgress: (event) => {
                if (!startupController.signal.aborted && !sessionClosed) preparation.observe(event);
              },
              scriptablePackMetadata,
            });
            timing('vite-config');
            await closeIfInactive();
            preparation.host('vite-server');
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
        // A transport-only server has no HTTP Catalog to await.
        const prepareCatalogReadiness = () => {
          if (!parent && server?.httpServer !== undefined) {
            catalogReady = awaitCatalogReady(
              server,
              serverUrl,
              facts.id,
              readyTimeoutMs,
              startupController.signal,
            );
            // Cancellation may arrive synchronously during the initial probe.
            // Join its eventual rejection even when admission stops before publication.
            void catalogReady.catch(() => {});
          }
        };
        prepareCatalogReadiness();
        startupController.signal.throwIfAborted();
        const workspaceUrl = new URL(parent ? 'game.html' : './', serverUrl);
        workspaceUrl.searchParams.set('forgeaxWorkspace', parent ? 'game' : '1');
        workspaceUrl.searchParams.set('forgeaxWorkspaceSession', sessionId);
        workspaceUrl.searchParams.set('forgeaxWorkspaceTarget', targetId);
        workspaceUrl.searchParams.set('forgeaxWorkspaceToken', admissionToken);
        workspaceUrl.searchParams.set('forgeaxWorkspaceWidth', String(width));
        workspaceUrl.searchParams.set('forgeaxWorkspaceHeight', String(height));
        workspaceUrl.searchParams.set('forgeaxWorkspaceHeaded', headed ? '1' : '0');
        projectDocument = { sessionId, targetId, url: workspaceUrl.href, browserGeneration };
        preparation.host('scene-connection');
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
          asset?: EngineWorkspaceAsset | undefined;
          assetBinding?: EngineWorkspacePreview['assetBinding'];
        }) => {
          const previewOwner = value.previewOwner;
          let ownerBrowserGeneration = Math.max(1, browserGeneration);
          let previewTarget = value.target;
          const deferred = previewTarget === undefined;
          const previewTargetId = previewTarget?.targetId ?? targetId;
          const previewAsset = value.asset;
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
            for (const waiter of pending.values()) {
              if (waiter.previewOwner !== previewOwner) continue;
              waiter.reject(closed);
              waiter.cancel();
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
          let adopted = !deferred;
          const awaitPlayTarget = async () => {
            assertSessionOpen();
            if (browserDetached)
              throw new DevKitWorkspaceError(
                'engine-workspace-browser-detached',
                'The replacement game page to authenticate',
                'Wait for the reloaded Play page.',
                { sessionId, targetId },
              );
            await waitReady();
            if (!adopted) {
              requireCurrentTarget();
              ownerBrowserGeneration = browserGeneration;
              previews.set(previewTargetId, preview);
              adopted = true;
            }
          };
          const sendPreview = <T>(
            operation: string,
            data: object = {},
            signal?: AbortSignal,
            target = previewTargetId,
          ): Promise<T> => {
            assertPreviewOpen();
            return command(operation, { ...data, targetId: target, previewOwner }, signal);
          };
          const onTarget = <Args extends unknown[], T>(run: (...args: Args) => Promise<T>) =>
            deferred
              ? async (...args: Args) => {
                  await awaitPlayTarget();
                  return run(...args);
                }
              : run;
          const camera = (operation: string) =>
            onTarget((input: EngineWorkspaceCameraInput) =>
              sendPreview(operation, commandInput(input), input.signal, input.targetId),
            );
          const controls = {
            setControl: camera('target.control'),
            tools: {
              pick: onTarget(({ signal, ...input }) => sendPreview('target.pick', input, signal)),
              highlight: onTarget((input) => sendPreview('entity.highlight', input)),
              tree: onTarget((input) => sendPreview('scene.tree.get', input)),
              inspect: onTarget(async ({ entityId, signal }) => {
                const result = await sendPreview<EngineWorkspaceEntityInspection>(
                  'entity.inspect',
                  { entityId },
                  signal,
                );
                signal?.throwIfAborted();
                assertPreviewOpen();
                return result;
              }),
              focus: onTarget((input) => sendPreview('entity.focus', input)),
              viewportOutput: {
                get: onTarget(() => sendPreview('viewport.output.get')),
                set: onTarget((input) => sendPreview('viewport.output.set', input)),
              },
            },
            getCamera: camera('camera.get'),
            beginCameraInteraction: camera('camera.begin'),
            updateCameraDraft: camera('camera.update'),
            commitCamera: camera('camera.commit'),
            abortCameraInteraction: camera('camera.abort'),
            revokeConnection: (input) => {
              if (
                sessionClosed ||
                previewClosed ||
                browserDetached ||
                (!parent && ownerBrowserGeneration !== Math.max(1, browserGeneration)) ||
                previews.get(previewTargetId) !== preview
              )
                return Promise.resolve();
              return sendPreview(
                'camera.revoke',
                { connectionId: input.connectionId },
                undefined,
                input.targetId,
              );
            },
            resize: onTarget(async (input) => {
              assertPreviewOpen();
              const result = await command('resize', { ...input, previewOwner }, input.signal);
              assertPreviewOpen();
              previewTarget = operationResultTarget(result, {
                ...dimensions,
                targetId: previewTargetId,
              });
              if (parent) currentTarget = previewTarget;
              return previewTarget;
            }),
            capture: onTarget(({ width, height, signal }) =>
              sendPreview('capture', { width, height }, signal),
            ),
          } satisfies Omit<EngineWorkspacePreview, 'target'>;
          const preview: EngineWorkspacePreview & { failure?: DevKitWorkspaceError } = {
            handle: previewOwner,
            ...controls,
            tools: {
              ...controls.tools,
              assistance: (input) => sendPreview('target.assistance', input),
            },
            async writeAssetField(fieldWrite) {
              await sendPreview('authoring.write', { fieldWrite });
            },
            async prepareAssetContent(content, signal) {
              assertPreviewOpen();
              return command<number>(
                'authoring.prepare',
                { targetId: previewTargetId, previewOwner, content: encodePackData(content) },
                signal,
              );
            },
            async commitAssetContent(preparation, fields) {
              await sendPreview('authoring.commit', { preparation, fields });
            },
            get target() {
              return !parent && previewTarget !== undefined
                ? previewTarget
                : requireCurrentTarget();
            },
            ...(previewAsset ? { asset: previewAsset } : {}),
            ...(value.assetBinding === undefined ? {} : { assetBinding: value.assetBinding }),
            ...(previewAsset?.kind !== 'material'
              ? {}
              : {
                  material: {
                    get: () => sendPreview<MaterialPreviewState>('preview.material.get'),
                    set: (mesh: MaterialPreviewMesh) =>
                      sendPreview<MaterialPreviewState>('preview.material.set', { mesh }),
                    rotate: (input: { readonly yaw: number; readonly pitch: number }) =>
                      sendPreview<MaterialPreviewState>('preview.material.rotate', input),
                    reset: () => sendPreview<MaterialPreviewState>('preview.material.reset'),
                  },
                }),
            display: {
              get: (options) =>
                sendPreview<EngineWorkspacePreviewDisplay>(
                  'preview.display.get',
                  options?.uvChannel === undefined ? {} : { uvChannel: options.uvChannel },
                  options?.signal,
                ),
              set: (display, options) =>
                sendPreview<EngineWorkspacePreviewDisplay>(
                  'preview.display.set',
                  { display },
                  options?.signal,
                ),
            },
            ...(texturePreviewKind(previewAsset?.kind)
              ? {
                  texture: {
                    get: () => sendPreview<TextureViewInfo>('preview.texture.get'),
                    set: (
                      options: Parameters<NonNullable<EngineWorkspacePreview['texture']>['set']>[0],
                    ) => sendPreview<TextureViewInfo>('preview.texture.set', { options }),
                  },
                }
              : {}),
            close: previewClose,
          };
          if (adopted) previews.set(previewTargetId, preview);
          return { preview, controls };
        };
        capabilities = {
          borrowTarget: async () => {
            const document = projectDocument;
            if (!document) throw new TypeError('Game document missing');
            const { controls } = proxyTarget({ previewOwner: sessionId });
            return {
              ...controls,
              revokeConnection: async (input) => controls.revokeConnection(input),
              get target() {
                return currentTarget ?? { ...dimensions, url: document.url };
              },
            };
          },
          ready: async (signal) => {
            if (parent) timing('game-ready-wait');
            await waitReady(signal);
            if (parent) timing('game-ready');
          },
          async startPlay({ signal }, admitted) {
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
              signal?.throwIfAborted();
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
              signal?.throwIfAborted();
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
              previewOwner: value.previewOwner,
              target: operationResultTarget(value, { ...dimensions, targetId: previewTargetId }),
              asset:
                normalizePreviewAsset(Reflect.get(value, 'asset')) ?? normalizePreviewAsset(asset),
              ...('assetBinding' in value
                ? { assetBinding: value.assetBinding as EngineWorkspacePreview['assetBinding'] }
                : {}),
            }).preview;
          },
        };
        startupCapabilities.resolve(capabilities);
        await catalogReady;
        timing('catalog-ready');
      } catch (cause) {
        publishFailure(cause);
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
    startup = initializeBrowser().catch((cause: unknown) => {
      if (failure === undefined) publishFailure(cause);
      throw cause;
    });
    void startup.catch(() => {});

    function withBrowser<Input extends { readonly signal?: AbortSignal } | undefined, T>(
      run: (
        owner: SessionCapabilities,
        input: Input,
        admitted?: WorkspaceReadyResult,
      ) => T | Promise<T>,
    ): (operation: Input) => Promise<T> {
      return async (operation) => {
        const admitted = readBrowserAdmission();
        return run(await requireCapabilities(operation?.signal), operation, admitted);
      };
    }

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
      runtimePack: withBrowser((owner, operation, admitted) =>
        owner.runtimePack(operation, admitted),
      ),
      inspectAsset: withBrowser((owner, operation, admitted) =>
        owner.inspectAsset(operation, admitted),
      ),
      listAssets: withBrowser((owner, operation, admitted) =>
        owner.listAssets(operation ?? {}, admitted),
      ),
      openPreview: withBrowser((owner, operation, admitted) =>
        owner.openPreview(operation, admitted),
      ),
      async close() {
        await close();
      },
      ...(!parent
        ? {
            async authorPack(
              operation: Parameters<NonNullable<EngineWorkspaceProjectSession['authorPack']>>[0],
            ) {
              const execute = await abortable(authoring.promise, operation.signal);
              if (startupController.signal.aborted)
                throw startupController.signal.reason ?? new Error('Project session is closed');
              return execute(operation);
            },
            startPlay: withBrowser((owner, operation, admitted) =>
              owner.startPlay(operation, admitted),
            ),
          }
        : {}),
    };
    return session;
  };
  const provider = createEngineWorkspaceProvider({
    openProjectSession: (input: { root: string; generation: number; signal?: AbortSignal }) =>
      trackOpening(async () => {
        if (disposed) throw new Error('Engine workspace provider is disposed');
        input.signal?.throwIfAborted();
        return openSession(input);
      }),
  });
  return Object.freeze({
    ...provider,
    async prepareRuntimePackProgram(
      input: Parameters<NonNullable<EngineWorkspaceProvider['prepareRuntimePackProgram']>>[0],
    ) {
      input.signal?.throwIfAborted();
      const prepared = prepareRuntimePackProgram(input.source).unwrap();
      input.signal?.throwIfAborted();
      return prepared;
    },
    async inspectAsset(input: Parameters<NonNullable<EngineWorkspaceProvider['inspectAsset']>>[0]) {
      input.signal?.throwIfAborted();
      // The live Registry owns runtime-only payloads and their current facts.
      if (input.handle !== undefined) {
        const inspection = await provider.inspectAsset?.(input);
        input.signal?.throwIfAborted();
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
      input.signal?.throwIfAborted();
      if (!result.ok) throw workspaceFailure(result.error);
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
