import { resolve } from 'node:path';
import type { ImportPublicationInput, RunImportMeta } from '@forgeax/engine-import';
import type { CatalogBuildResult, CatalogProducerVisibility } from '@forgeax/engine-pack/build';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import type {
  AssetPublicationEnvelope,
  CatalogDelta,
  PackIndexEntry,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import type { ViteDevServer } from 'vite';
import { resolvePackBuildInputs } from '../build-inputs.js';
import {
  appendPluginPackCleanup,
  createPluginPackFailure,
  type PluginPackFailure,
} from '../errors.js';
import type { HttpArtifactCompression } from '../http-artifact.js';
import type { PluginPackInternalOptions } from '../plugin-contract.js';
import { projectRuntimeDiagnostics } from '../runtime-diagnostics.js';
import type { DispatcherServer, MiddlewareDispatcher } from './dispatcher.js';
import { createMiddlewareDispatcher } from './dispatcher.js';
import {
  createConfigureServer,
  type PluginServerLifecycleState,
} from './plugin-server-configure.js';
import { createProductionBridge, type ProductionBridge } from './production-bridge.js';

function isPluginPackFailure(error: unknown): error is PluginPackFailure {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'expected' in error &&
    'hint' in error &&
    'detail' in error
  );
}

function normalizeRebindFailure(error: unknown, subject: string): PluginPackFailure {
  if (isPluginPackFailure(error)) return error;
  return createPluginPackFailure({
    code: 'watch-failed',
    expected: 'the replacement watcher to complete its ready barrier',
    hint: 'inspect the watcher diagnostic, repair the root, rebuild, verify, and retry',
    detail: { stage: 'watch', subject },
    cause: error,
  });
}

function cleanupFailure(error: unknown, subject: string): PluginPackFailure {
  return createPluginPackFailure({
    code: 'cleanup-failed',
    expected: 'the failed dev generation watcher and session to close',
    hint: 'inspect the cleanup diagnostic, close the failed generation, and retry the rebind',
    detail: { stage: 'cleanup', subject },
    cause: error,
  });
}

async function closeGeneration(
  stopWatcher: () => Promise<void>,
  session: { close(): Promise<void> } | undefined,
  subject: string,
): Promise<PluginPackFailure | undefined> {
  // Abort intake before watcher callbacks drain the generation they may await.
  const closingSession = Promise.resolve().then(() => session?.close());
  const [watcher, closedSession] = await Promise.allSettled([
    Promise.resolve().then(stopWatcher),
    closingSession,
  ]);
  let failure =
    watcher.status === 'rejected'
      ? cleanupFailure(watcher.reason, `${subject}-watcher`)
      : undefined;
  if (closedSession.status === 'rejected') {
    const sessionFailure = cleanupFailure(closedSession.reason, `${subject}-session`);
    failure =
      failure === undefined ? sessionFailure : appendPluginPackCleanup(failure, sessionFailure);
  }
  return failure;
}

export interface PluginServerLike extends DispatcherServer {
  readonly environments?: ViteDevServer['environments'];
  readonly ws?: {
    send(payload: { type: string } & Record<string, unknown>): void;
  };
}

export interface PluginServerState {
  readonly artifactCompression?: HttpArtifactCompression;
  catalogProjection: CatalogBuildResult;
  importedGuids: Set<string>;
  metaPackBodies: Map<string, string | Uint8Array>;
  devArtifactBodies: Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>;
}

export type PluginServerProjectionState = PluginServerState & {
  publicationCandidates: Map<string, AssetPublicationEnvelope>;
  pendingImportPublications: Map<string, ImportPublicationInput>;
};

export interface PluginServerCallbacks {
  publishAuthoredDevPacks(
    entries: readonly PackIndexEntry[],
    projection: PluginServerProjectionState,
    declarations?: ReadonlyMap<string, ScanSourceDeclaration>,
    signal?: AbortSignal,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<readonly PackIndexEntry[]>;
  ensureMetaImport(
    metaPath: string,
    declaration?: RunImportMeta,
    signal?: AbortSignal,
    projection?: PluginServerProjectionState,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<PackIndexEntry[]>;
  commitGeneration(candidate: PluginServerProjectionState, signal?: AbortSignal): Promise<void>;
  discardPublications(candidates: ReadonlyMap<string, AssetPublicationEnvelope>): void;
  discardImportPublications(candidates: Map<string, ImportPublicationInput>): Promise<void>;
  ensureMetaPackBody(
    url: string,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<string | undefined>;
  setCatalogDeltaPublisher(publisher: (delta: CatalogDelta) => void): void;
}

export interface PluginServerRouteCallbacks {
  materializeAsset(guid: string, signal?: AbortSignal): Promise<readonly PackIndexEntry[]>;
  rebuildAsset(guid: string, signal?: AbortSignal): Promise<readonly PackIndexEntry[]>;
  ensureMetaPackBody(
    url: string,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<string | undefined>;
}

export interface PluginServerContext {
  readonly opts: PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  /** Current project DDC root used by importer/publication callbacks. */
  readonly projectDdcRoot: string;
  /** Replace the project DDC root before starting the next runtime generation. */
  readonly setProjectDdcRoot: (root: string) => void;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly resetState: () => void;
  readonly scopedPackageUrl: (binding: RuntimeAssetBinding, packageUrl: string) => string;
  readonly scopedCatalogEntry: (
    binding: RuntimeAssetBinding,
    entry: PackIndexEntry,
  ) => PackIndexEntry;
  readonly scopedCatalogBody: (binding: RuntimeAssetBinding) => string;
  readonly state: PluginServerState;
  readonly callbacks: PluginServerCallbacks;
  readonly setSourceRefresh: (refresh: (sourcePath: string) => Promise<void>) => void;
}

export function createPluginServer(context: PluginServerContext) {
  const { opts, registeredImporterKeys, catalogVisibility, state, callbacks } = context;
  // Vite may close and then reuse the same plugin object when hosts create
  // sequential servers (for example a preview probe followed by dev/HMR).
  // Keep the old dispatcher terminally closed so its middleware remains a
  // truthful 410, and route the next server through a fresh dispatcher.
  let activeDispatcher = createMiddlewareDispatcher();
  const dispatcher: MiddlewareDispatcher = {
    get registrationCount() {
      return activeDispatcher.registrationCount;
    },
    install(server) {
      activeDispatcher.install(server);
    },
    replace(handler) {
      activeDispatcher.replace(handler);
    },
    close() {
      return activeDispatcher.close();
    },
  };
  const configuredServers = new Set<PluginServerLike>();
  const lifecycle: PluginServerLifecycleState = {
    roots: [...resolvePackBuildInputs({ roots: opts.roots, base: context.transportBase }).roots],
    startupReady: Promise.resolve(),
    stopWatcher: async () => {},
    watchEpoch: 0,
    readyFailedEpoch: undefined,
    configuredServer: undefined,
    devSession: undefined,
    rebuildCatalogInPlace: async () => false,
  };
  const productionBridge: ProductionBridge = createProductionBridge({
    producerReadiness: opts.producerReadiness,
    takeInitialSourceSnapshot: opts.takeInitialSourceSnapshot,
    ignorePath: opts.ignorePath,
    sourceIdentityFor: opts.sourceIdentityFor,
    transportBase: () => context.transportBase,
    registeredImporterKeys,
    catalogVisibility,
    runtimeBinding: () => lifecycle.devSession?.runtimeScope(),
    roots: () => lifecycle.roots,
    state,
    callbacks,
  });
  const configureServer = createConfigureServer({
    context,
    productionBridge,
    lifecycle,
    configuredServers,
    dispatcher,
    runtimeDiagnostics: projectRuntimeDiagnostics,
  });
  let generationClosed = false;
  let closeInFlight: Promise<void> | undefined;

  const configureServerForGeneration: typeof configureServer = (...args) => {
    generationClosed = false;
    configureServer(...args);
  };

  const rebind = async (
    binding: RuntimeAssetBinding,
    nextRoots: readonly string[],
    nextProjectDdcRoot?: string,
  ): Promise<RuntimeAssetBinding> => {
    const server = lifecycle.configuredServer;
    if (server === undefined) {
      throw new Error('forgeax:pack rebind requires configureServer first');
    }
    const previousProjectDdcRoot = context.projectDdcRoot;
    if (nextProjectDdcRoot !== undefined) {
      context.setProjectDdcRoot(resolve(nextProjectDdcRoot));
    }
    const previousRuntime = lifecycle.devSession?.runtimeScope();
    const previousRoots = [...lifecycle.roots];
    const previousSession = lifecycle.devSession;
    const stopPreviousWatcher = lifecycle.stopWatcher;
    lifecycle.watchEpoch += 1;
    await stopPreviousWatcher();
    await previousSession?.close();
    productionBridge.replaceSession();
    context.resetState();
    configureServerForGeneration(server, nextRoots, binding);
    let startupFailure: PluginPackFailure | undefined;
    try {
      await lifecycle.startupReady;
    } catch (error) {
      startupFailure = normalizeRebindFailure(error, lifecycle.roots[0] ?? 'watcher');
    }
    const failedRebindState = lifecycle.devSession?.state();
    if (startupFailure !== undefined || failedRebindState?.status === 'failed') {
      const failedRebindFailure =
        startupFailure ??
        (failedRebindState?.status === 'failed' ? failedRebindState.error : undefined);
      if (failedRebindFailure === undefined) {
        throw createPluginPackFailure({
          code: 'watch-failed',
          expected: 'the replacement watcher to complete its ready barrier',
          hint: 'inspect the watcher diagnostic, repair the root, rebuild, verify, and retry',
          detail: { stage: 'watch', subject: lifecycle.roots[0] ?? 'watcher' },
        });
      }
      const rebindDiagnostics = projectRuntimeDiagnostics([
        {
          code: failedRebindFailure.code,
          cause: failedRebindFailure,
          message: failedRebindFailure.expected,
          hint: failedRebindFailure.hint,
        },
      ]);
      const failedRebindSession = lifecycle.devSession;
      if (
        startupFailure === undefined &&
        previousRuntime === undefined &&
        failedRebindSession !== undefined
      ) {
        const failedBinding = failedRebindSession.runtimeScope();
        if (failedBinding !== undefined) {
          failedRebindSession.publishRuntime('degraded', 'degraded', rebindDiagnostics);
          return failedRebindSession.runtimeScope() ?? binding;
        }
      }
      // Capture the failed generation's watcher before configureServer can
      // replace the lifecycle handle during rollback. Its async close is part
      // of the rollback fence, not a best-effort background cleanup.
      const stopFailedWatcher = lifecycle.stopWatcher;
      const cleanupError = await closeGeneration(
        stopFailedWatcher,
        failedRebindSession,
        'failed-rebind',
      );
      if (cleanupError !== undefined) {
        throw appendPluginPackCleanup(failedRebindFailure, cleanupError);
      }
      productionBridge.replaceSession();
      context.resetState();
      lifecycle.roots = previousRoots;
      context.setProjectDdcRoot(previousProjectDdcRoot);
      configureServerForGeneration(server, previousRoots, previousRuntime);
      try {
        await lifecycle.startupReady;
      } catch (error) {
        const restoreFailure = normalizeRebindFailure(error, lifecycle.roots[0] ?? 'watcher');
        const restoredSession = lifecycle.devSession;
        const stopRestoredWatcher = lifecycle.stopWatcher;
        const restoreCleanup = await closeGeneration(
          stopRestoredWatcher,
          restoredSession,
          'restored',
        );
        throw restoreCleanup === undefined
          ? restoreFailure
          : appendPluginPackCleanup(restoreFailure, restoreCleanup);
      }
      const restoredSession = lifecycle.devSession;
      const restoredState = restoredSession?.state();
      if (restoredState?.status === 'failed') {
        const restoreFailure = restoredState.error;
        const restoreCleanup = await closeGeneration(
          lifecycle.stopWatcher,
          restoredSession,
          'restored',
        );
        throw restoreCleanup === undefined
          ? restoreFailure
          : appendPluginPackCleanup(restoreFailure, restoreCleanup);
      }
      if (previousRuntime === undefined && restoredSession?.runtimeScope() === undefined) {
        throw failedRebindFailure;
      }
      if (restoredSession !== undefined) {
        const restoredBinding = restoredSession.runtimeScope();
        const restoredDiagnostics = [...(restoredBinding?.diagnostics ?? []), ...rebindDiagnostics];
        restoredSession.publishRuntime('degraded', 'degraded', restoredDiagnostics);
      }
      return restoredSession?.runtimeScope() ?? binding;
    }
    return lifecycle.devSession?.runtimeScope() ?? binding;
  };

  // Keep the active scope observable through the same Pack producer that owns
  // rebinding. Consumers must not reach into the private DevSession to decide
  // whether a catalog has been published.
  const runtimeBinding = (): RuntimeAssetBinding | undefined =>
    lifecycle.devSession?.runtimeScope();

  const close = (): Promise<void> => {
    if (closeInFlight !== undefined) return closeInFlight;
    if (generationClosed) return Promise.resolve();
    generationClosed = true;
    const closingDispatcher = activeDispatcher;
    closeInFlight = (async () => {
      lifecycle.watchEpoch += 1;
      await Promise.all([
        lifecycle.devSession?.close(),
        productionBridge.session.close(),
        lifecycle.stopWatcher(),
      ]);
      configuredServers.clear();
      context.resetState();
      lifecycle.configuredServer = undefined;
      lifecycle.devSession = undefined;
      lifecycle.startupReady = Promise.resolve();
      await closingDispatcher.close();
      activeDispatcher = createMiddlewareDispatcher();
      productionBridge.replaceSession();
    })().finally(() => {
      closeInFlight = undefined;
    });
    return closeInFlight;
  };

  return {
    invalidateModules(ids: readonly string[]): void {
      for (const server of configuredServers) {
        for (const { moduleGraph } of Object.values(server.environments ?? {})) {
          for (const id of ids) {
            const module = moduleGraph.getModuleById(id);
            if (module !== undefined) moduleGraph.invalidateModule(module);
          }
        }
      }
    },
    configureServer: configureServerForGeneration,
    async ready() {
      await lifecycle.startupReady;
      const state = lifecycle.devSession?.state();
      if (state?.status === 'failed') throw state.error;
    },
    rebind,
    runtimeBinding,
    rebuildCatalogInPlace: (filenames: readonly string[]) =>
      lifecycle.rebuildCatalogInPlace(filenames),
    close,
  };
}
