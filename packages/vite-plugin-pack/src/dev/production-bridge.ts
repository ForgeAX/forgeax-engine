import { relative, resolve } from 'node:path';
import {
  buildCatalogResult,
  containsSourcePackageError,
  normalizeSourcePackageError,
  type ProducerReadiness,
  parseProducerReadiness,
} from '@forgeax/engine-import';
import {
  type CatalogProducerVisibility,
  metaPathForGuid,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
} from '@forgeax/engine-pack/build';
import { declaredSourceGuids } from '@forgeax/engine-pack/scanner';
import type { ScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import type { PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import { createPluginPackFailure } from '../errors.js';
import {
  createProductionSession,
  type ProductionDeclaration,
  type ProductionRunResult,
  type ProductionSession,
} from '../production/session.js';
import type { DevSession } from './dev-session.js';
import type {
  PluginServerCallbacks,
  PluginServerProjectionState,
  PluginServerRouteCallbacks,
  PluginServerState,
} from './plugin-server.js';
import { serialProductionSession } from './serial-production-session.js';
import { projectSourcePackageFailure } from './transport-routes.js';

type CatalogInventory = Awaited<ReturnType<typeof buildCatalogResult>>;

interface ProductionGenerationState {
  inventory: CatalogInventory | undefined;
  candidate: PluginServerProjectionState | undefined;
  authoredPublished: boolean;
}

function projectAcceptedEntries(
  raw: readonly PackIndexEntry[],
  accepted: readonly PackIndexEntry[],
  appendMissing = false,
): PackIndexEntry[] {
  const acceptedByGuid = new Map(
    accepted.map((entry) => [entry.guid.toLowerCase(), entry] as const),
  );
  const projected = raw.map((entry) => acceptedByGuid.get(entry.guid.toLowerCase()) ?? entry);
  if (!appendMissing) return projected;
  const seen = new Set(projected.map((entry) => entry.guid.toLowerCase()));
  for (const entry of accepted) {
    const key = entry.guid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push(entry);
  }
  return projected;
}

function declarationsForInventory(inventory: CatalogInventory): readonly ProductionDeclaration[] {
  return [...inventory.sourceDeclarations.values()].flatMap((sourceDeclaration) => {
    if (
      sourceDeclaration.format === 'meta.json' &&
      !inventory.declarations.has(sourceDeclaration.sourcePath)
    ) {
      return [];
    }
    const sourceKey = relative(process.cwd(), sourceDeclaration.sourcePath).replace(/\\/g, '/');
    const guids = declaredSourceGuids(sourceDeclaration);
    return [
      {
        sourceKey,
        sourcePath: sourceDeclaration.sourcePath,
        guids,
        format: sourceDeclaration.format,
      },
    ];
  });
}

export interface ProductionBridge {
  readonly session: ProductionSession<ProductionGenerationState>;
  readonly inventoryForRequest: (
    initial: boolean,
    session?: ProductionSession<ProductionGenerationState>,
  ) => Promise<CatalogInventory>;
  readonly replaceSession: () => ProductionSession<ProductionGenerationState>;
}

interface ProductionBridgeContext {
  readonly producerReadiness?: ProducerReadiness | undefined;
  readonly takeInitialSourceSnapshot?: (() => ScriptablePackSourceSnapshot | undefined) | undefined;
  readonly ignorePath?: ((path: string) => boolean) | undefined;
  /** Host-owned projection from physical paths to stable catalog identities. */
  readonly sourceIdentityFor?: ((sourcePath: string) => string) | undefined;
  readonly transportBase: () => string | undefined;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly runtimeBinding: () => RuntimeAssetBinding | undefined;
  readonly roots: () => readonly string[];
  readonly state: PluginServerState;
  readonly callbacks: PluginServerCallbacks;
}

export function createProductionBridge(context: ProductionBridgeContext): ProductionBridge {
  const {
    producerReadiness,
    takeInitialSourceSnapshot,
    ignorePath,
    sourceIdentityFor,
    transportBase,
    registeredImporterKeys,
    catalogVisibility,
    runtimeBinding,
    roots,
    state,
    callbacks,
  } = context;
  const readiness = parseProducerReadiness(producerReadiness);
  let startupSnapshot = takeInitialSourceSnapshot;
  const startupTiming = (
    stage: string,
    startedAt: number,
    detail: Record<string, unknown> = {},
  ): void => {
    if (process.env.FORGEAX_WORKSPACE_TIMING !== '1') return;
    console.error(
      '[forgeax.pack-startup.timing]',
      JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - startedAt), ...detail }),
    );
  };
  const createCandidateState = (
    catalogProjection: CatalogInventory,
    accepted: PluginServerProjectionState | undefined,
  ): PluginServerProjectionState => {
    return {
      catalogProjection: { ...catalogProjection, entries: [...catalogProjection.entries] },
      importedGuids: new Set(accepted?.importedGuids ?? state.importedGuids),
      metaPackBodies: new Map(accepted?.metaPackBodies ?? state.metaPackBodies),
      // Producers replace entries; published bodies are immutable. Keep their
      // identity so unrelated lazy imports reuse prepared HTTP representations.
      devArtifactBodies: new Map(accepted?.devArtifactBodies ?? state.devArtifactBodies),
      publicationCandidates: new Map(),
      pendingImportPublications: new Map(),
    };
  };

  const createSession = (): ProductionSession<ProductionGenerationState> => {
    const source = createProductionSession<ProductionGenerationState>({
      sourceKeys: () => [...roots()],
      // Materialization keeps the accepted publications. Only a fresh inventory
      // scan may project away rows whose authored source no longer exists.
      createState: ({ acceptedState }) => ({
        inventory: acceptedState?.inventory,
        authoredPublished: false,
        candidate:
          acceptedState?.candidate === undefined
            ? undefined
            : createCandidateState(
                acceptedState.candidate.catalogProjection,
                acceptedState.candidate,
              ),
      }),
      inventory: async ({ sourceKeys, state: generationState }) => {
        if (!readiness.ok) throw readiness.error;
        const inventoryStartedAt = performance.now();
        // The preparation snapshot is a one-shot candidate. Its scanner
        // verification rejects any intervening edit; a retry observes disk anew.
        const sourceSnapshot = startupSnapshot?.();
        startupSnapshot = undefined;
        const scanOptions = {
          // Catalog inventory needs source metadata only. Authored publication
          // reacquires a fresh build lease for every producer pass.
          scriptablePack: {
            ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
            metadataOnly: true,
            ...(sourceSnapshot === undefined ? {} : { sourceSnapshot }),
          },
          ...(ignorePath === undefined ? {} : { ignorePath }),
        };
        const inventory = await buildCatalogResult(
          sourceKeys,
          transportBase(),
          registeredImporterKeys,
          scanOptions,
          catalogVisibility,
          sourceIdentityFor,
        );
        startupTiming('inventory-total', inventoryStartedAt, {
          rootCount: sourceKeys.length,
          entryCount: inventory.entries.length,
          declarationCount: inventory.sourceDeclarations.size,
        });
        // A degraded scan is never an accepted production inventory, including
        // startup. Repair must publish a complete authoritative generation.
        if (inventory.authority !== 'authoritative') {
          throw createPluginPackFailure({
            code: 'scan-failed',
            expected: 'an authoritative Catalog projection before publishing a generation',
            hint: 'inspect catalog diagnostics, repair the root, rebuild, and retry',
            detail: { stage: 'scan', subject: 'catalog' },
            cause: inventory.diagnostics,
          });
        }
        generationState.inventory = inventory;
        const previousCatalog =
          generationState.candidate?.catalogProjection.entries ?? state.catalogProjection.entries;
        generationState.candidate = createCandidateState(
          { ...inventory, entries: projectAcceptedEntries(inventory.entries, previousCatalog) },
          generationState.candidate,
        );
        return declarationsForInventory(inventory);
      },
      produce: async ({ generation, declaration, intent, signal, state: generationState }) => {
        const inventory = generationState.inventory;
        const candidate = generationState.candidate;
        if (inventory === undefined || candidate === undefined) {
          throw createPluginPackFailure({
            code: 'produce-failed',
            expected: 'the production generation to retain its inventory declaration',
            hint: 'repair the generation candidate lifetime and retry the rebuild',
            detail: { stage: 'produce', subject: `generation:${generation}` },
          });
        }
        let producedEntries: readonly PackIndexEntry[] = [];
        if (declaration.format === 'meta.json') {
          if (!readiness.ok) throw readiness.error;
          if (intent === 'attempt' && readiness.value === 'on-demand') return;
          // Sibling requests can queue before the first request publishes the
          // complete Meta. Check the live accepted state after serialization;
          // its imported set also carries watcher invalidation.
          if (
            intent === 'materialize' &&
            declaration.guids.length > 0 &&
            declaration.guids.every((guid) => {
              const key = guid.toLowerCase();
              return (
                state.importedGuids.has(key) &&
                state.catalogProjection.entries.some(
                  (entry) => entry.guid.toLowerCase() === key && entry.lifecycle === 'current',
                )
              );
            })
          )
            return;
        }
        try {
          if (declaration.format === 'meta.json') {
            const metaPath =
              declaration.sourcePath ?? resolve(process.cwd(), declaration.sourceKey);
            const producerStartedAt = performance.now();
            try {
              producedEntries = await callbacks.ensureMetaImport(
                metaPath,
                inventory.declarations.get(metaPath),
                signal,
                candidate,
                runtimeBinding(),
              );
            } finally {
              startupTiming('meta-import', producerStartedAt, {
                generation,
                sourceKey: declaration.sourceKey,
              });
            }
          } else if (
            (declaration.format === 'pack.json' || declaration.format === 'pack.ts') &&
            !generationState.authoredPublished
          ) {
            generationState.authoredPublished = true;
            const producerStartedAt = performance.now();
            try {
              producedEntries = await callbacks.publishAuthoredDevPacks(
                inventory.entries.filter(
                  (entry) =>
                    entry.sourcePath.endsWith('.pack.json') ||
                    entry.sourcePath.endsWith('.pack.ts'),
                ),
                candidate,
                inventory.sourceDeclarations,
                signal,
                runtimeBinding(),
              );
            } finally {
              startupTiming('authored-pack-publication', producerStartedAt, {
                generation,
                scope: 'all-authored-packs',
                triggerSourceKey: declaration.sourceKey,
              });
            }
          }
        } catch (error) {
          // A malformed external source is one failed producer row, not a
          // reason to discard unrelated declarations in the same generation.
          // Authored Pack failures retain their existing all-or-nothing route.
          if (
            declaration.format !== 'meta.json' ||
            signal.aborted ||
            !containsSourcePackageError(error)
          ) {
            throw error;
          }
          const declarationMeta =
            declaration.sourcePath === undefined
              ? undefined
              : inventory.declarations.get(declaration.sourcePath);
          const sourcePath =
            declarationMeta?.source ?? declaration.sourcePath ?? declaration.sourceKey;
          const affectedGuids =
            declaration.guids.length > 0
              ? declaration.guids
              : inventory.entries
                  .filter((entry) => entry.sourcePath === sourcePath)
                  .map((entry) => entry.guid);
          const normalized = normalizeSourcePackageError(error, {
            sourceMeta: sourcePath,
            anchorGuid: affectedGuids[0] ?? sourcePath,
            affectedGuids,
            producer: 'vite-plugin-pack',
            importer: declarationMeta?.importer ?? 'unknown',
          });
          candidate.catalogProjection = {
            ...candidate.catalogProjection,
            entries: projectSourcePackageFailure(candidate.catalogProjection.entries, normalized),
          };
          return;
        }
        const candidateEntries = projectAcceptedEntries(
          candidate.catalogProjection.entries,
          producedEntries,
          true,
        );
        candidate.catalogProjection = { ...inventory, entries: candidateEntries };
      },
      publish: async ({ generation, signal, state: generationState }) => {
        if (signal.aborted) return;
        const publishStartedAt = performance.now();
        const inventory = generationState.inventory;
        const candidate = generationState.candidate;
        if (inventory === undefined || candidate === undefined) {
          throw createPluginPackFailure({
            code: 'commit-failed',
            expected: 'the accepted production candidate to retain its Catalog projection',
            hint: 'repair the generation candidate lifetime and retry the rebuild',
            detail: { stage: 'commit', subject: `generation:${generation}` },
          });
        }
        try {
          await callbacks.commitGeneration(candidate, signal);
        } finally {
          startupTiming('generation-commit', publishStartedAt, { generation });
        }
        if (signal.aborted) return;
        Object.assign(state, candidate);
      },
      discard: async ({ state: generationState }) => {
        const candidate = generationState.candidate;
        if (candidate !== undefined) {
          callbacks.discardPublications(candidate.publicationCandidates);
          await callbacks.discardImportPublications(candidate.pendingImportPublications);
        }
      },
    });
    return serialProductionSession(source);
  };

  let session = createSession();
  return {
    get session() {
      return session;
    },
    inventoryForRequest: async (initial, requestedSession = session) => {
      const requestStartedAt = performance.now();
      const result = initial
        ? await requestedSession.start()
        : await requestedSession.rebuild(roots().map((sourceKey) => ({ sourceKey })));
      startupTiming(initial ? 'production-start' : 'production-rebuild', requestStartedAt, {
        generation: result.generation,
        status: result.status,
      });
      if (result.status === 'failed') throw result.error;
      if (result.status === 'stale') {
        throw createPluginPackFailure({
          code: 'stale-generation',
          expected: 'the requested Catalog generation to remain current',
          hint: 'retry the rebuild after the active generation settles',
          detail: { stage: 'scan', subject: `generation:${result.generation}` },
        });
      }
      const inventory = requestedSession.acceptedState()?.inventory;
      if (inventory === undefined) {
        throw createPluginPackFailure({
          code: 'scan-failed',
          expected: 'the accepted ProductionSession to retain its inventory snapshot',
          hint: 'repair the production candidate lifetime and retry the rebuild',
          detail: { stage: 'scan', subject: `generation:${result.generation}` },
        });
      }
      return inventory;
    },
    replaceSession: () => {
      session = createSession();
      return session;
    },
  };
}

interface ProductionRouteBridgeContext {
  readonly callbacks: PluginServerCallbacks;
  readonly activeDevSession: DevSession;
  readonly roots: readonly string[];
  readonly producerReadiness?: ProducerReadiness | undefined;
  readonly freshnessBarrier?: (() => Promise<void>) | undefined;
  readonly state: PluginServerState;
}

function containsFailureCode(error: unknown, code: string, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const failure = error as { readonly code?: unknown; readonly cause?: unknown };
  return failure.code === code || containsFailureCode(failure.cause, code, seen);
}

export function createProductionRouteBridge(
  context: ProductionRouteBridgeContext,
): PluginServerRouteCallbacks {
  const { callbacks, activeDevSession, roots, producerReadiness, freshnessBarrier, state } =
    context;
  const acceptedEntries = (guid: string): readonly PackIndexEntry[] => {
    const guidLower = guid.toLowerCase();
    return state.catalogProjection.entries.filter(
      (entry) => entry.guid.toLowerCase() === guidLower,
    );
  };
  const entriesAfter = (guid: string, result: ProductionRunResult): readonly PackIndexEntry[] => {
    if (result.status === 'failed') {
      if (containsFailureCode(result.error, 'commit-failed')) {
        const accepted = acceptedEntries(guid);
        if (accepted.length > 0) return accepted;
      }
      throw result.error;
    }
    if (result.status === 'stale') {
      throw createPluginPackFailure({
        code: 'stale-generation',
        expected: 'the production generation to remain current',
        hint: 'retry the asset request after the active generation settles',
        detail: { stage: 'route', subject: guid },
      });
    }
    const entries = acceptedEntries(guid);
    if (entries.length === 0) {
      throw createPluginPackFailure({
        code: 'route-failed',
        expected: `the accepted Catalog to contain ${guid}`,
        hint: 'rebuild the Catalog and retry the declared asset request',
        detail: { stage: 'route', subject: guid },
      });
    }
    return entries;
  };
  const trackRoute = <T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> =>
    activeDevSession.track(
      signal === undefined ? task : task.then((entries) => (signal.aborted ? ([] as T) : entries)),
    );
  const beforeConsume = async (): Promise<void> => {
    await freshnessBarrier?.();
  };
  return {
    materializeAsset: (guid, signal) => {
      return trackRoute(
        beforeConsume()
          .then(() => activeDevSession.materializeProduction(guid))
          .then((result) => entriesAfter(guid, result)),
        signal,
      );
    },
    rebuildAsset: (guid, signal) => {
      const task = (async (): Promise<readonly PackIndexEntry[]> => {
        await beforeConsume();
        let result = await activeDevSession.rebuildProduction(
          roots.map((sourceKey) => ({ sourceKey })),
        );
        if (result.status === 'stale') {
          result = await activeDevSession.rebuildProduction(
            roots.map((sourceKey) => ({ sourceKey })),
          );
        }
        let entries = entriesAfter(guid, result);
        const readiness = parseProducerReadiness(producerReadiness);
        if (readiness.ok && readiness.value === 'on-demand') {
          const metaPath = metaPathForGuid(state.catalogProjection.declarations, guid);
          if (metaPath !== undefined) {
            entries = entriesAfter(guid, await activeDevSession.materializeProduction(guid));
          }
        }
        return entries;
      })();
      return trackRoute(task, signal);
    },
    ensureMetaPackBody: callbacks.ensureMetaPackBody,
  };
}
