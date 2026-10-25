import { readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  createAssetRuntimeAssembly,
  type EngineWorkspacePreview,
  type EngineWorkspaceProvider,
} from '@forgeax/engine-app';
import {
  AssetRegistry,
  type CatalogSource,
  retainAssetPublications,
} from '@forgeax/engine-assets-runtime';
import { prepareRuntimePackContent, type RuntimePackContent } from '@forgeax/engine-import';
import {
  createFileSystemPackDrafts,
  type PackDraftGenerationInput,
  readPackAuthoringDeclaration,
} from '@forgeax/engine-pack/build';
import {
  AssetGuid,
  applyPackParameterBindings,
  type DirectPackJson,
  definePackageId,
  type PackDraftReply,
  type PackOutputMap,
  type PackParameterDefinition,
  packGenerationValues,
  type ScriptablePackSceneComponentInput,
} from '@forgeax/engine-pack/source';
import {
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
  SCRIPTABLE_PACK_BUILD_TIMEOUT_MS,
} from '@forgeax/engine-pack/source-node';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  SpotLight,
} from '@forgeax/engine-render';
import { Name, sceneFieldWritable, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';

// Conservative automatic discovery; explicit TS bindings still use the target's full vocabulary.
const directSceneComponents = new Map(
  [Camera, DirectionalLight, PointLight, SpotLight, MeshFilter, MeshRenderer, Name, Transform].map(
    (component) => [component.name as string, component],
  ),
);

interface GeneratedPack {
  readonly data:
    | { outputs: PackOutputMap; sceneComponents?: readonly ScriptablePackSceneComponentInput[] }
    | { content: RuntimePackContent };
  readonly parameters: readonly PackParameterDefinition[];
  readonly dependencies: Readonly<Record<string, string>>;
}

/** Node author owner composes existing source execution and exact browser preview capabilities. */
export function createWorkspacePackAuthoring(options: {
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly catalog?: () => CatalogSource | undefined;
  readonly preview: (targetId: string) => EngineWorkspacePreview | undefined;
  readonly publishSource?: (sourcePath: string) => Promise<void>;
  readonly changed?: (reply: PackDraftReply) => void;
}) {
  const bindings = new Map<string, EngineWorkspacePreview>();
  const dependencySources = new Map<string, Set<string>>();
  const dependenciesOf = new Map<string, Set<string>>();
  const observe = (source: string, path: string) => {
    const absolute = resolve(options.root, path);
    if (absolute === resolve(options.root, source)) return;
    let owners = dependencySources.get(absolute);
    if (!owners) {
      owners = new Set();
      dependencySources.set(absolute, owners);
    }
    owners.add(source);
    let paths = dependenciesOf.get(source);
    if (!paths) {
      paths = new Set();
      dependenciesOf.set(source, paths);
    }
    paths.add(absolute);
  };
  const forget = (source: string) => {
    for (const path of dependenciesOf.get(source) ?? []) {
      const owners = dependencySources.get(path);
      if (!owners) continue;
      owners.delete(source);
      if (!owners.size) dependencySources.delete(path);
    }
    dependenciesOf.delete(source);
  };
  const targetFor = (sourcePath: string) => {
    const binding = bindings.get(sourcePath);
    if (!binding) return undefined;
    if (options.preview(binding.target.targetId) !== binding)
      throw new Error('Authoring preview target has retired');
    return binding;
  };
  const requireTarget = (sourcePath: string) => {
    const target = targetFor(sourcePath);
    if (!target) throw new Error('Open this asset preview before applying live fields');
    return target;
  };
  const generate = async ({
    document,
    values,
    signal,
  }: PackDraftGenerationInput): Promise<GeneratedPack> => {
    const source = manager.sourceAt(document.sourcePath);
    if (!source) throw new Error('Authoring source was closed');
    if (document.format === 'direct') {
      const json = JSON.parse(source.write(new Map(Object.entries(values)))) as DirectPackJson;
      const blobs: Record<string, Uint8Array<ArrayBuffer>> = {};
      const dependencies: Record<string, string> = {};
      const projectRoot = await realpath(options.root);
      const own = new Set(
        Object.keys(json.assets).map((key) =>
          AssetGuid.format(AssetGuid.derive(definePackageId(json.packageId), key)),
        ),
      );
      const refs = new Set<string>();
      for (const asset of Object.values(json.assets)) {
        for (const ref of asset.refs ?? []) if (!own.has(ref)) refs.add(ref);
        for (const artifact of Object.values(asset.artifacts ?? {})) {
          const path = artifact.path;
          if (typeof path !== 'string' || Object.hasOwn(blobs, path)) continue;
          const absolute = await realpath(
            resolve(options.root, dirname(document.sourcePath), path),
          );
          if (!absolute.startsWith(`${projectRoot}${sep}`))
            throw new TypeError('Pack artifact is outside the project');
          signal.throwIfAborted();
          blobs[path] = new Uint8Array(await readFile(absolute));
          observe(document.sourcePath, absolute);
        }
      }
      if (refs.size) {
        const catalog = options.catalog?.();
        if (!catalog) throw new Error('Generation requires an accepted project asset source');
        let entries = (await catalog.enumerate()).unwrap();
        for (const ref of refs) {
          let row = entries.find((entry) => entry.guid === ref);
          if (!row?.publication && catalog.get) {
            (await catalog.get(ref)).unwrap();
            entries = (await catalog.enumerate()).unwrap();
            row = entries.find((entry) => entry.guid === ref);
          }
          signal.throwIfAborted();
          const digest = row?.publication?.outputs.find((output) => output.guid === ref)?.digest;
          if (!digest || !row) throw new Error(`Missing saved dependency ${ref}`);
          dependencies[ref] = digest;
          observe(document.sourcePath, row.sourcePath);
        }
      }
      return {
        data: { content: { source: json, blobs, dependencies } },
        parameters: document.fields.filter((field) => typeof field.apply === 'object'),
        dependencies,
      };
    }
    const generator = source.generator ?? {
      sourcePath: document.sourcePath,
      source: source.source,
    };
    const snapshot = createScriptablePackSourceSnapshot();
    const absolute = resolve(options.root, generator.sourcePath);
    await snapshot.inventory(absolute, generator.source);
    for (const path of snapshot.paths) observe(document.sourcePath, path);
    signal.throwIfAborted();
    let reader: ReturnType<typeof createAssetRuntimeAssembly> | undefined;
    let registry: AssetRegistry | undefined;
    try {
      const definition = (
        await loadScriptablePack(absolute, {
          sourceSnapshot: snapshot,
          buildTimeoutMs: SCRIPTABLE_PACK_BUILD_TIMEOUT_MS,
          signal,
        })
      ).unwrap();
      const parameters = 'parameters' in definition ? definition.parameters : [];
      const dependencies: Record<string, string> = {};
      const reads = new Map<string, { asset: object; digest: string }>();
      const built = await definition.build({
        packageId: definePackageId(document.packageId),
        ...(parameters.length ? { values: packGenerationValues(parameters, values) } : {}),
        async readByGuid(guid: import('@forgeax/engine-types').AssetGuid) {
          signal.throwIfAborted();
          const text = AssetGuid.format(guid);
          let read = reads.get(text);
          if (!read) {
            const catalog = options.catalog?.();
            if (!catalog) throw new Error('Generation requires an accepted project asset source');
            if (!registry) {
              registry = new AssetRegistry();
              reader = createAssetRuntimeAssembly(undefined, { registry, catalogSource: catalog });
              reader.unwrap();
            }
            let entries = (await registry.enumerateCatalog()).unwrap();
            if (!registry.catalogEntry(text)?.publication && catalog.get) {
              (await catalog.get(text)).unwrap();
              signal.throwIfAborted();
              (await registry.reconcileCatalog()).unwrap();
              entries = (await registry.enumerateCatalog()).unwrap();
            }
            const row = registry.catalogEntry(text);
            const digest = row?.publication?.outputs.find((output) => output.guid === text)?.digest;
            if (!digest) throw new Error(`Generation dependency has no saved publication: ${text}`);
            if (!reader) throw new Error('Generation asset reader is unavailable');
            const retained = await retainAssetPublications(
              registry,
              new Map([[text, digest]]),
              entries,
              catalog,
              reader.unwrap().fetcher,
              { signal },
            );
            const pin = retained.get(text);
            if (!pin) throw new Error(`Missing retained dependency ${text}`);
            read = {
              asset: typeof pin.asset === 'function' ? await pin.asset() : pin.asset,
              digest: pin.digest,
            };
            observe(document.sourcePath, pin.row.sourcePath);
            reads.set(text, read);
          }
          dependencies[text] = read.digest;
          return ok(structuredClone(read.asset));
        },
      } as never);
      signal.throwIfAborted();
      if (!built.ok) throw built.error;
      for (const path of snapshot.paths) {
        const before = await snapshot.readText(path);
        const after = await readFile(path, 'utf8');
        if (before === after) continue;
        const oldDeclaration = readPackAuthoringDeclaration(path, before);
        const newDeclaration = readPackAuthoringDeclaration(path, after);
        if (
          !oldDeclaration.ok ||
          !newDeclaration.ok ||
          oldDeclaration.value.generationSource !== newDeclaration.value.generationSource
        )
          throw new Error(`Generation source changed: ${path}`);
      }
      return {
        data: {
          outputs: built.value,
          ...(definition.sceneComponents ? { sceneComponents: definition.sceneComponents } : {}),
        },
        parameters,
        dependencies,
      };
    } finally {
      snapshot.releaseResolvers();
      if (reader?.ok) reader.value.dispose();
      registry?.dispose();
    }
  };
  const manager = createFileSystemPackDrafts<GeneratedPack>({
    gameRoot: options.root,
    sourceRoots: options.sourceRoots,
    liveField: (kind, path, value) =>
      (kind === 'material' &&
        path.length === 2 &&
        path[0] === 'values' &&
        typeof value !== 'string') ||
      (kind === 'scene' &&
        path[0] === 'entities' &&
        ((path.length === 5 && path[2] === 'components') ||
          (path.length === 8 &&
            path[2] === 'instance' &&
            path[3] === 'overrides' &&
            path[5] === 'components')) &&
        sceneFieldWritable(
          directSceneComponents.get(path[path.length - 2] ?? ''),
          path.at(-1) ?? '',
        )),
    owner(document) {
      return {
        generate,
        async adopt(result, values, signal, currentValues) {
          if (!targetFor(document.sourcePath)) return false;
          const content =
            'content' in result.data
              ? result.data.content
              : (
                  await prepareRuntimePackContent(
                    document.packageId,
                    applyPackParameterBindings(
                      result.parameters,
                      result.data.outputs,
                      values,
                    ).unwrap(),
                    {
                      dependencies: result.dependencies,
                      ...(result.data.sceneComponents
                        ? { sceneComponents: result.data.sceneComponents }
                        : {}),
                    },
                  )
                ).unwrap();
          signal.throwIfAborted();
          const target = requireTarget(document.sourcePath);
          if (!target.prepareAssetContent || !target.commitAssetContent)
            throw new Error('This preview cannot adopt generated content');
          const preparation = await target.prepareAssetContent(content, signal);
          signal.throwIfAborted();
          const latest = currentValues();
          const fields = result.parameters.flatMap((field) =>
            typeof field.apply !== 'object'
              ? []
              : [
                  {
                    guid: AssetGuid.format(
                      AssetGuid.derive(definePackageId(document.packageId), field.apply.asset),
                    ),
                    path: field.apply.path,
                    value: latest[field.name],
                  },
                ],
          );
          await target.commitAssetContent(preparation, fields);
          return true;
        },
        async preview(field, value) {
          if (typeof field.apply !== 'object') return;
          const guid = AssetGuid.format(
            AssetGuid.derive(definePackageId(document.packageId), field.apply.asset),
          );
          const target = requireTarget(document.sourcePath);
          if (!target.writeAssetField) throw new Error('This preview cannot write asset fields');
          await target.writeAssetField({ guid, path: field.apply.path, value });
        },
      };
    },
  });
  return {
    async execute(input: Parameters<NonNullable<EngineWorkspaceProvider['authorPack']>>[0]) {
      input.signal?.throwIfAborted();
      const source = input.request.sourcePath
        ? relative(options.root, resolve(options.root, input.request.sourcePath))
            .split('\\')
            .join('/')
        : input.request.draftId
          ? manager.source(input.request.draftId)?.document.sourcePath
          : undefined;
      let rebound = false;
      if (input.previewTargetId && source) {
        const target = options.preview(input.previewTargetId);
        if (!target) throw new Error('The requested authoring preview is unavailable');
        const targetSource = target.asset?.path;
        if (!targetSource || resolve(options.root, targetSource) !== resolve(options.root, source))
          throw new Error('The preview belongs to another Pack source');
        rebound = bindings.get(source) !== target;
        bindings.set(source, target);
      }
      let result = await manager.execute(input.request);
      if (source && input.request.action === 'save')
        await options.publishSource?.(resolve(options.root, source));
      if (rebound && source && !('closed' in result))
        result = (await manager.previewSource(source)) ?? result;
      if ('closed' in result && source) {
        bindings.delete(source);
        forget(source);
      }
      if (source && (input.request.action === 'open' || input.request.action === 'refresh')) {
        const generator = manager.sourceAt(source)?.generator;
        if (generator)
          for (const path of generator.paths ?? [generator.sourcePath]) observe(source, path);
      }
      options.changed?.(result);
      return result;
    },
    async sourceChanged(path: string): Promise<boolean> {
      const requested = resolve(options.root, path);
      const projectRoot = await realpath(options.root);
      const rootAlias = resolve(options.root);
      let absolute = requested;
      try {
        absolute = await realpath(requested);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      const within = (base: string, candidate: string) =>
        candidate === base || candidate.startsWith(`${base}${sep}`);
      const source = relative(within(projectRoot, absolute) ? projectRoot : rootAlias, absolute)
        .split('\\')
        .join('/');
      const projectAlias = resolve(rootAlias, source);
      const dependentSources = new Set([
        ...(dependencySources.get(requested) ?? []),
        ...(dependencySources.get(absolute) ?? []),
        ...(dependencySources.get(projectAlias) ?? []),
      ]);
      const dependents = dependentSources.size > 0 ? dependentSources : undefined;
      for (const dependentSource of dependents ?? []) {
        const reply = manager.invalidateGeneration(dependentSource);
        if (reply) options.changed?.(reply);
        void manager.refreshSource(dependentSource).then((reply) => {
          if (reply) options.changed?.(reply);
        });
      }
      const active = async (source: string) => {
        const binding = bindings.get(source);
        if (!binding) return false;
        const current = options.preview(binding.target.targetId);
        if (!current) return false;
        if (current === binding) return true;
        const currentPath = current.asset?.path;
        if (
          current.target.targetId !== binding.target.targetId ||
          current.target.generation !== binding.target.generation ||
          !currentPath
        )
          return false;
        let boundPath: string;
        let activePath: string;
        try {
          [boundPath, activePath] = await Promise.all([
            realpath(resolve(options.root, source)),
            realpath(resolve(options.root, currentPath)),
          ]);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw cause;
        }
        if (boundPath !== activePath) return false;
        // Preview wrappers can be renewed for the same still-live target. Keep
        // the binding attached to that exact source and target generation.
        bindings.set(source, current);
        return true;
      };
      if (!(await manager.hasSource(path))) {
        // A legacy declaration can fail its first draft open. Keep the exact
        // preview binding and retry only when that source changes to editable TS.
        if (await active(source)) {
          try {
            await manager.execute({ action: 'open', sourcePath: source });
          } catch {
            // Unsupported source still follows ordinary build/hot-reload handling.
            return false;
          }
          if (!(await active(source))) return false;
          const reply = await manager.previewSource(source);
          if (reply) options.changed?.(reply);
          return true;
        }
        for (const dependent of dependents ?? []) if (await active(dependent)) return true;
        return false;
      }
      const reply = await manager.refreshSource(path, (prepared) => options.changed?.(prepared));
      if (reply) options.changed?.(reply);
      return await active(source);
    },
    dispose() {
      manager.dispose();
      bindings.clear();
      dependencySources.clear();
      dependenciesOf.clear();
    },
  };
}
