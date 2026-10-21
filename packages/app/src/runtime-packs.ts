import {
  CatalogReplica,
  type CatalogSource,
  captureAssetPublication,
  createCatalogSource,
  type PackageFetcher,
  retainAssetPublications,
  validateAssetPublication,
} from '@forgeax/engine-assets-runtime';
import {
  projectRuntimePackTools,
  type RuntimePackPinnedAsset,
  RuntimePackProducer,
  type RuntimePackProducerOptions,
} from '@forgeax/engine-import';
import { loadPackProgram } from '@forgeax/engine-pack/runtime';
import type { Context, PluginPrograms } from '@forgeax/engine-plugin';
import {
  AssetError,
  type CatalogDelta,
  err,
  ok,
  type PluginBuildTarget,
} from '@forgeax/engine-types';
import type { AssetRuntimeAssembly } from './assets-runtime-assembly.js';

export type RuntimePackOptions = Omit<
  RuntimePackProducerOptions,
  'validate' | 'onCommit' | 'target'
>;

/** A producer and its read-only merged Catalog share the existing realm lifetime. */
export interface RuntimePackAssembly {
  readonly producer: RuntimePackProducer;
  readonly catalog: CatalogSource;
  readonly fetcher: PackageFetcher;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    runtimePacks?: RuntimePackAssembly;
  }
}

/** Attach production to the existing asset and program providers in this Cordis realm. */
export function assembleRuntimePacks(
  context: Context,
  assembly: AssetRuntimeAssembly,
  requestedOptions: RuntimePackOptions,
): RuntimePackAssembly {
  const inherited = context.pluginPrograms;
  const options: RuntimePackOptions = {
    ...(inherited?.imports ? { imports: inherited.imports } : {}),
    ...(inherited?.programHost ? { programHost: inherited.programHost } : {}),
    ...requestedOptions,
  };
  const base = assembly.catalogSource;
  if (base.expectedScope && base.expectedScope.scopeId !== options.scopeId)
    throw new TypeError('Runtime Pack scope must match the active asset realm');
  const expectedScope = base.expectedScope ?? { scopeId: options.scopeId, generation: 0 };
  const baseFetcher = assembly.fetcher;
  const assetSource = options.assetSource;
  const ownedPrograms = new Map<string, string>();
  const ownedDefinitions = new Map<string, ReadonlyMap<string, string>>();
  const listeners = new Set<(delta: CatalogDelta) => void>();
  let stopped = false;
  const retainBase = async (
    requested: ReadonlyMap<string, string>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>> => {
    (await baseReplica.start()).unwrap();
    const baseline = baseReplica.snapshot();
    if (baseline.stale) throw new TypeError('cannot retain a stale base Catalog');
    const provider = context.pluginPrograms;
    const executions = provider
      ? [
          {
            target: provider.target,
            programs: new Map(
              [...provider.programs].map(([name, entry]) => [
                name,
                entry.exportSource ? { exportSource: entry.exportSource } : {},
              ]),
            ),
            tools: structuredClone(new Map(provider.tools)),
            definitions: structuredClone(new Map(provider.definitions)),
          },
        ]
      : [];
    return retainAssetPublications(
      assembly.registry,
      requested,
      baseline.entries,
      base,
      baseFetcher,
      { ...(signal ? { signal } : {}), executions },
    );
  };

  const notify = (delta: CatalogDelta) => {
    for (const listener of listeners) {
      try {
        listener({ ...delta, ...expectedScope });
      } catch {
        /* Observers do not own publication. */
      }
    }
  };
  const producer: RuntimePackProducer = new RuntimePackProducer({
    ...options,
    ...(inherited ? { target: inherited.target } : {}),
    assetSource: {
      ...(assetSource ?? { retain: retainBase }),
      currentRow: (guid) => baseReplica.get(guid),
    },
    validate: async (state, fetcher, dependencies) => {
      const baseline = await baseReplica.start();
      if (!baseline.ok) return baseline;
      if (baseReplica.snapshot().stale) {
        const reconciled = await baseReplica.reconcile();
        if (!reconciled.ok) return reconciled;
      }
      // Ordinary loaders verify every artifact, including unused attachments.
      // Plugin definition reads skip that path, so retain their complete capture.
      if (!('source' in state.content) && state.rows.some((row) => row.kind === 'plugin')) {
        const fixed = state.content;
        const row = state.rows[0];
        if (!row) throw new TypeError('fixed publication is empty');
        const captured = await captureAssetPublication(
          row,
          state.rows,
          {
            enumerate: async () => ok(state.rows),
            subscribe: () => () => {},
            openPackage: () => fetcher,
          },
          fetcher,
          {
            executions: Object.entries(fixed.executions ?? {}).map(([target, execution]) => ({
              target: target as PluginBuildTarget,
              programs: new Map(
                Object.entries(execution.programs).map(([name, program]) => [
                  name,
                  { exportSource: async () => program },
                ]),
              ),
              tools: new Map(Object.entries(execution.tools)),
              definitions: new Map(
                state.rows.map((row) => [
                  row.guid,
                  {
                    kind: 'publication' as const,
                    publication: {
                      scopeId: options.scopeId,
                      generation: fixed.pack.generation,
                      digest: fixed.pack.digest,
                      outputSetDigest: fixed.pack.outputSetDigest,
                    },
                  },
                ]),
              ),
            })),
          },
        );
        if (!captured.ok) return captured;
      }
      // The pinned closure supplies payloads. Only its reference evidence needs
      // live external rows; validating one mesh must not rebuild the whole game Catalog.
      const references = new Set(
        [...state.rows, ...[...dependencies.values()].map((pin) => pin.row)]
          .flatMap((row) => [
            ...(row.refs ?? []),
            ...(row.publication?.outputs.find(
              (output) => output.guid.toLowerCase() === row.guid.toLowerCase(),
            )?.refs ?? []),
            ...(row.publication?.externalEvidence
              .filter((edge) => edge.usage !== 'content')
              .map((edge) => edge.guid) ?? []),
          ])
          .map((guid) => guid.toLowerCase()),
      );
      return validateAssetPublication(
        state.rows,
        fetcher,
        {
          catalog: createCatalogSource({
            entries: [...references].flatMap((guid) => {
              const row = baseReplica.get(guid) ?? producer.rows().find((row) => row.guid === guid);
              return row ? [row] : [];
            }),
          }),
          fetcher: fetchContent,
        },
        {
          registry: assembly.registry,
          shaderRegistry: assembly.registry.shaderRegistry,
          pack: state.publication?.pack,
          dependencies,
        },
      );
    },
    onCommit(state) {
      if (state.status !== 'withdrawn') {
        const conflict = validateBase(state.rows.map((row) => row.guid));
        if (conflict) throw conflict;
      }
      const plugins =
        state.status === 'withdrawn'
          ? []
          : (state.publication?.pack.assets.filter((asset) => asset.kind === 'plugin') ?? []);
      const key =
        'source' in state.content ? state.content.source.packageId : state.content.pack.digest;
      const retired = ownedDefinitions.get(key) ?? new Map();
      if (!plugins.length && !retired.size) {
        if (state.status !== 'withdrawn' && state.publication)
          assembly.registry.commitPreparedPublication(state.publication.pack);
        return;
      }
      const current = context.pluginPrograms;
      if (!current)
        throw new TypeError('Plugin asset admission requires the realm pluginPrograms provider');
      const definitions = new Map(current.definitions);
      const programs = new Map(current.programs);
      const tools = new Map(current.tools);
      const programDigests = new Map(ownedPrograms);
      for (const guid of retired.keys()) {
        definitions.delete(guid);
        tools.delete(guid);
      }
      const nextOwned = new Map(ownedDefinitions);
      const nextDefinitions = new Map(
        plugins.map((asset) => [asset.guid, (asset.payload as { program: string }).program]),
      );
      nextOwned.set(key, nextDefinitions);
      const requiredPrograms = new Set<string>();
      const sourceTools =
        'source' in state.content ? projectRuntimePackTools(state.content) : undefined;
      const execution =
        'source' in state.content ? undefined : state.content.executions?.[current.target];
      for (const asset of plugins) {
        const publication = state.publication?.pack;
        if (!publication) throw new TypeError('plugin output requires a Pack publication');
        definitions.set(asset.guid, {
          kind: 'publication',
          publication: {
            scopeId: publication.scopeId,
            generation: publication.generation,
            digest: publication.digest,
            outputSetDigest: publication.outputSetDigest,
          },
        });
        if (!('source' in state.content) && !Object.hasOwn(execution?.tools ?? {}, asset.guid))
          continue;
        const name = (asset.payload as { program: string }).program;
        requiredPrograms.add(name);
        const contract =
          'source' in state.content
            ? {
                schemaVersion: '1.0.0' as const,
                commands: (sourceTools?.get(asset.guid)?.commands ?? []).filter(
                  (command) => command.realm === current.target,
                ),
              }
            : execution?.tools[asset.guid];
        if (!contract) throw new TypeError(`missing fixed plugin tools ${asset.guid}`);
        for (const declaration of contract.commands) {
          if (declaration.realm !== current.target)
            throw new TypeError(`plugin tool target mismatch ${asset.guid}`);
          if (declaration.executor) requiredPrograms.add(declaration.executor);
        }
        tools.set(asset.guid, contract);
      }
      for (const name of requiredPrograms) {
        if (programs.has(name) && !ownedPrograms.has(name))
          throw new TypeError(`runtime program conflicts with delivered program ${name}`);
        const artifact =
          'source' in state.content
            ? state.content.programs?.[name]?.artifact
            : execution?.programs[name];
        if (!artifact) throw new TypeError(`missing fixed plugin program ${name}`);
        if (ownedPrograms.has(name) && ownedPrograms.get(name) !== artifact.digest)
          throw new TypeError(`runtime program identity changed ${name}`);
        if (!programs.has(name))
          programs.set(name, {
            exportSource: async () => artifact,
            load: async () =>
              (await loadPackProgram(artifact, options.imports, options.programHost)).unwrap(),
          });
        programDigests.set(name, artifact.digest);
      }
      const livePrograms = new Set(
        [...nextOwned.values()].flatMap((definitions) =>
          [...definitions]
            .filter(([guid]) => tools.has(guid))
            .flatMap(([guid, program]) => [
              program,
              ...(tools
                .get(guid)
                ?.commands.flatMap((command) => (command.executor ? [command.executor] : [])) ??
                []),
            ]),
        ),
      );
      const retiredPrograms = [...ownedPrograms.keys()].filter((name) => !livePrograms.has(name));
      for (const name of retiredPrograms) {
        programs.delete(name);
        programDigests.delete(name);
      }
      const next: PluginPrograms = { ...current, definitions, programs, tools };
      // Native Cordis only permits the original providing Fiber to replace this value.
      try {
        if (state.status !== 'withdrawn' && state.publication)
          assembly.registry.commitPreparedPublication(state.publication.pack, () =>
            context.set('pluginPrograms', next),
          );
        else context.set('pluginPrograms', next);
      } catch (error) {
        if (context.pluginPrograms === next) context.set('pluginPrograms', current);
        throw error;
      }
      ownedPrograms.clear();
      for (const [name, digest] of programDigests) ownedPrograms.set(name, digest);
      if (plugins.length) ownedDefinitions.set(key, nextDefinitions);
      else ownedDefinitions.delete(key);
    },
  });
  const fetchContent: PackageFetcher = async (input, init) => {
    const result = await producer.fetch(input, init);
    return result.status === 404 ? baseFetcher(input, init) : result;
  };
  const collisionError = () =>
    new AssetError({
      code: 'asset-parse-failed',
      expected: 'one current realm Catalog with distinct delivered and runtime GUIDs',
      hint: 'reconcile the base Catalog and choose a distinct Pack packageId before admission',
    });
  const baseReplica: CatalogReplica = new CatalogReplica({
    ...base,
    async enumerate() {
      const snapshot = await base.enumerate();
      if (!snapshot.ok) return snapshot;
      const runtime = new Set(producer.rows().map((row) => row.guid.toLowerCase()));
      return snapshot.value.some((row) => runtime.has(row.guid.toLowerCase()))
        ? err(collisionError())
        : snapshot;
    },
    subscribe(listener) {
      return base.subscribe((delta) => {
        const runtime = new Set(producer.rows().map((row) => row.guid.toLowerCase()));
        const safe = {
          ...delta,
          removed: delta.removed.filter((guid) => !runtime.has(guid.toLowerCase())),
        };
        if ([...delta.added, ...delta.changed].some((row) => runtime.has(row.guid.toLowerCase()))) {
          listener({
            ...delta,
            added: [],
            changed: [],
            removed: [],
            authority: 'degraded',
            diagnostics: [
              {
                code: 'catalog-revision-conflict',
                severity: 'blocking',
                authority: 'catalog',
                expected: 'delivered GUIDs distinct from admitted runtime Packs',
                hint: 'repair the conflicting producer and reconcile the Catalog',
              },
            ],
          });
        } else listener(safe);
      });
    },
  });
  function validateBase(guids: readonly string[]): AssetError | undefined {
    const snapshot = baseReplica.snapshot();
    const baseGuids = new Set(snapshot.entries.map((row) => row.guid.toLowerCase()));
    return snapshot.stale || guids.some((guid) => baseGuids.has(guid.toLowerCase()))
      ? collisionError()
      : undefined;
  }
  const catalog: CatalogSource = {
    expectedScope,
    openPackage: (url) =>
      producer.catalog.openPackage(url) ?? base.openPackage?.(url) ?? baseFetcher,
    async enumerate() {
      const original = await (baseReplica.snapshot().stale
        ? baseReplica.reconcile()
        : baseReplica.start());
      if (!original.ok) return original;
      const current = baseReplica.snapshot();
      if (current.stale) return err(collisionError());
      const runtime = await producer.catalog.enumerate();
      if (!runtime.ok) return runtime;
      return Object.assign(ok([...current.entries, ...runtime.value]), {
        revisions: [...current.revisions, ...runtime.revisions],
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const stopBase = baseReplica.subscribe((delta) =>
    notify(
      baseReplica.snapshot().stale
        ? {
            ...delta,
            added: [],
            changed: [],
            removed: [],
            authority: 'degraded',
            diagnostics: baseReplica.snapshot().diagnostics,
          }
        : delta,
    ),
  );
  const stopProducer = producer.catalog.subscribe(notify);
  assembly.registry.setCatalogSource(catalog, fetchContent);
  context.effect(
    () => () => {
      if (stopped) return;
      stopped = true;
      try {
        producer.dispose();
      } finally {
        stopProducer();
        stopBase();
        baseReplica.dispose();
        listeners.clear();
        assembly.registry.clearCatalogSource();
      }
    },
    'runtime-pack/producer',
  );
  return { producer, catalog, fetcher: fetchContent };
}
