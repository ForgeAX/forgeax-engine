import { withMeshAabb } from '@forgeax/engine-geometry';
import {
  copyPackData,
  createPackageResponse,
  createRuntimePackPublication,
  decodePackBlob,
  encodePackBlob,
  type FixedPackPublication,
  loadPackProgram,
  type PackBlob,
  type PackProgram,
  type PackProgramHost,
  type PackProgramImport,
  type PackProgramSource,
  packProgramModuleIdentity,
  parsePackV2,
  projectPackageCatalog,
  type RuntimePackPublication,
  validateArtifactPath,
  validateFixedPackPublication,
  verifyPackProgram,
} from '@forgeax/engine-pack/runtime';
import {
  AssetGuid,
  type DirectPackJson,
  definePackageId,
  isScriptablePackAssetKind,
  isValidPackSourceKey,
  lowerPluginToolContract,
  PackageId,
  type PackInstanceJson,
  type PackOutputMap,
  type PluginAssetSource,
  type PluginModuleReference,
  parsePackSourceJson,
  projectDirectPackJson,
  projectScriptablePackMeta,
  projectScriptablePackSceneComponents,
  type ResolvedPackParameterInheritance,
  resolvePackParameterValues,
  type ScriptablePackSceneComponentInput,
  type ScriptablePackSourceMeta,
  validatePackDefinition,
  validatePluginAssetSource,
} from '@forgeax/engine-pack/source';
import { isEngineMaterial } from '@forgeax/engine-shader';
import type { ToolCommandContract } from '@forgeax/engine-tool-runtime';
import {
  type Asset,
  AssetError,
  type AssetPublicationEnvelope,
  type AssetPublicationOutput,
  type CatalogDelta,
  type CatalogEntry,
  err,
  ImportError,
  ok,
  type PackageFetcher,
  type PluginBuildTarget,
  type Result,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { projectImportedAssetPayload } from './import-product.js';
import { normaliseForPack } from './import-runner.js';
import { producePluginAsset } from './plugin-asset-output.js';
import {
  runtimeGeneratorDefinition as generatorDefinition,
  parseRuntimePackContent,
  parseRuntimePackInstance,
  parseRuntimePackSnapshot,
} from './runtime-pack-content.js';
import { encodeRuntimePackData, type RuntimePackBinary } from './runtime-pack-data.js';
import {
  collectRuntimePackDependencies,
  matchesRuntimePackPin as matchesPinnedPublication,
  type RuntimePackPinnedAsset,
  type RuntimePackRecipe,
  type RuntimePackSavedRecipe,
  saveRuntimePackSnapshot,
} from './runtime-pack-snapshot.js';
import {
  createScriptablePackFingerprinter,
  scriptablePackFingerprint as fingerprint,
  scriptablePackFingerprintAsync as fingerprintAsync,
} from './scriptable-pack-fingerprint.js';
import {
  createAssetOutputProducerRegistry,
  meshAssetDataProducer,
  meshAssetOutputProducer,
} from './scriptable-pack-output-producers.js';

export type { RuntimePackPinnedAsset, RuntimePackRecipe } from './runtime-pack-snapshot.js';
export { createFixedRuntimePackSnapshot } from './runtime-pack-snapshot.js';

/** The verified artifact is the execution authority; JS originals need no duplicate copy. */
export interface RuntimePackProgram {
  readonly artifact: PackProgram;
  /** Optional author text archive. Runtime validation does not prove TS compilation equivalence. */
  readonly source?: PackProgramSource;
}
export interface RuntimeScriptablePackSource extends ScriptablePackSourceMeta {
  readonly program: string;
  readonly sceneComponents?: readonly ScriptablePackSceneComponentInput[];
}
/** Durable author content. No realm, GPU handles, Fiber, or disposable cache entries. */
export interface RuntimePackContent {
  readonly source: DirectPackJson | RuntimeScriptablePackSource;
  readonly programs?: Readonly<Record<string, RuntimePackProgram>>;
  readonly blobs?: Readonly<Record<string, PackBlob>>;
  /** Content versions of the complete declared asset closure. */
  readonly dependencies?: Readonly<Record<string, string>>;
}
export interface RuntimePackSnapshot {
  readonly schemaVersion: 'runtime-pack-source/2';
  readonly binary?: RuntimePackBinary;
  readonly packs: readonly RuntimePackContent[];
  readonly instances: readonly PackInstanceJson[];
  /** Fixed output selections use the same recipes as historical dependencies. */
  readonly recipeRoots?: readonly string[];
  /** Only reachable fixed dependency versions; generator recipes retain inputs, not full variants. */
  readonly closure?: {
    readonly contents: Readonly<Record<string, RuntimePackContent>>;
    readonly recipes: Readonly<Record<string, RuntimePackSavedRecipe>>;
    readonly bindings: Readonly<Record<string, Readonly<Record<string, string>>>>;
  };
}
export interface RuntimePackPublicationState {
  readonly packageId?: string;
  readonly status: 'admitted' | 'withdrawn';
  readonly content: RuntimePackContent | FixedPackPublication;
  readonly publication?: RuntimePackPublication;
  readonly rows: readonly CatalogEntry[];
}
/** Operation result is publication evidence; source bytes are exported explicitly. */
export interface RuntimePackPublicationReceipt {
  readonly packageId?: string;
  readonly status: RuntimePackPublicationState['status'];
  readonly publication?: AssetPublicationEnvelope;
  readonly rows: readonly CatalogEntry[];
}
function publicationReceipt(state: RuntimePackPublicationState): RuntimePackPublicationReceipt {
  return structuredClone({
    ...(state.packageId === undefined ? {} : { packageId: state.packageId }),
    status: state.status,
    ...(state.publication ? { publication: state.publication.publication } : {}),
    rows: state.rows,
  });
}

export interface RuntimePackExecution {
  readonly instance: PackInstanceJson;
  readonly request: number;
  readonly status: 'pending' | 'current' | 'failed' | 'cancelled' | 'withdrawn';
  readonly lastKnownGood?: {
    readonly values: PackInstanceJson['values'];
    readonly generation: number;
  };
  readonly error?: RuntimePackError;
}
export interface RuntimePackError {
  readonly code:
    | 'runtime-pack-invalid'
    | 'runtime-pack-conflict'
    | 'runtime-pack-dependency-unavailable'
    | 'runtime-pack-execution-failed'
    | 'runtime-pack-cancelled';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly packageId: string; readonly cause: unknown };
}
export interface RuntimePackCacheEntry {
  readonly inputFingerprint: string;
  readonly digest: string;
  readonly content: RuntimePackContent;
}
export interface RuntimePackProducerOptions {
  /** Selects fixed plugin execution attachments; generator replay retains its normal semantics. */
  readonly target?: PluginBuildTarget;
  readonly scopeId: string;
  readonly baseUrl?: string;
  readonly imports?: Readonly<Record<string, PackProgramImport>>;
  readonly programHost?: PackProgramHost;
  readonly assetSource?: {
    /** The source owner exports the requested immutable version, including original programs and bytes. */
    exportSource?(
      versions: ReadonlyMap<string, string>,
      signal?: AbortSignal,
    ): Promise<RuntimePackSnapshot>;
    /** Retain owner-verified versions directly; export remains the portable source boundary. */
    retain?(
      versions: ReadonlyMap<string, string>,
      signal?: AbortSignal,
    ): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>>;
    /** Current consumer-visible version. Required only when generated outputs retain this GUID. */
    currentRow?(guid: string): CatalogEntry | undefined;
  };
  /** Verify every artifact's decoded integrity and actual domain payloads before visibility. */
  readonly validate: (
    publication: RuntimePackPublicationState,
    fetcher: PackageFetcher,
    dependencies: ReadonlyMap<
      string,
      { readonly asset: Asset | (() => Promise<Asset>); readonly row: CatalogEntry }
    >,
  ) => Promise<Result<ReadonlyMap<string, Asset | (() => Promise<Asset>)>, unknown>>;
  /** The realm owner updates its existing program projection before Catalog notification. */
  readonly onCommit?: (publication: RuntimePackPublicationState) => void;
  readonly cache?: Map<string, RuntimePackCacheEntry>;
}
function failure(
  code: RuntimePackError['code'],
  packageId: string,
  cause: unknown,
): RuntimePackError {
  return {
    code,
    expected: 'one validated Pack and its fixed program/dependency closure',
    hint: 'inspect the failed candidate and repair its producer inputs before retrying',
    detail: {
      packageId,
      cause:
        cause instanceof Error ? { ...cause, name: cause.name, message: cause.message } : cause,
    },
  };
}
async function bytesDigest(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const input =
      bytes.buffer instanceof ArrayBuffer
        ? (bytes as Uint8Array<ArrayBuffer>)
        : new Uint8Array(bytes);
    return `sha256:${bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)))}`;
  }
  return `sha256:${bytesToHex(sha256(bytes))}`;
}
function json<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, child) =>
      child instanceof Uint8Array ? encodePackBlob(child) : child,
    ),
  ) as T;
}
function assertOutputSet(
  actual: readonly AssetPublicationOutput[],
  expected: readonly AssetPublicationOutput[],
): void {
  const normalize = (outputs: readonly AssetPublicationOutput[]) =>
    [...outputs].sort((a, b) => a.guid.localeCompare(b.guid));
  if (fingerprint(normalize(actual)) !== fingerprint(normalize(expected)))
    throw new TypeError('restored dependency output set differs');
}
interface RuntimeBody {
  readonly bytes: Uint8Array | (() => Promise<Uint8Array>);
  readonly mediaType: string;
}
async function bodyBytes(body: RuntimeBody): Promise<Uint8Array> {
  return typeof body.bytes === 'function' ? body.bytes() : body.bytes;
}

function bodyFetcher(bodies: ReadonlyMap<string, RuntimeBody>): PackageFetcher {
  return async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const body = bodies.get(input);
    return body === undefined
      ? createPackageResponse(new Uint8Array(), { status: 404 })
      : createPackageResponse(await bodyBytes(body), {
          mediaType: body.mediaType,
        });
  };
}
function isGenerator(source: RuntimePackContent['source']): source is RuntimeScriptablePackSource {
  return 'kind' in source && source.kind === 'scriptable-pack-source';
}
function publicationKey(content: RuntimePackPublicationState['content']): string {
  return 'source' in content ? content.source.packageId : fingerprint(content);
}
function pluginProgram(
  programs: RuntimePackContent['programs'],
  module: PluginModuleReference,
): string | undefined {
  const entry = module.specifier.replace(/^\.\//, '');
  const matches = Object.entries(programs ?? {}).filter(
    ([, value]) =>
      (value.source?.entry ?? value.artifact.entry) === entry &&
      value.artifact.export === (module.export ?? 'default'),
  );
  if (matches.length > 1) throw new TypeError(`ambiguous plugin module ${module.specifier}`);
  return matches[0]?.[0];
}

/** Derived native tool contracts; the inline source remains the only durable declaration. */
export function projectRuntimePackTools(
  content: RuntimePackContent,
): ReadonlyMap<string, ToolCommandContract> {
  const tools = new Map<string, ToolCommandContract>();
  if (!('assets' in content.source)) return tools;
  const packageId = definePackageId(content.source.packageId);
  for (const [sourceKey, asset] of Object.entries(content.source.assets)) {
    if (asset.kind !== 'plugin') continue;
    const source = validatePluginAssetSource({ ...asset.payload, kind: 'plugin' }).unwrap();
    const contract = source.toolContract ?? { schemaVersion: '1.0.0', commands: [] };
    if ('specifier' in contract)
      throw new TypeError('runtime tool contracts must be prepared as inline declaration data');
    const lowered = lowerPluginToolContract(contract, (reference) => {
      const key = pluginProgram(content.programs, reference);
      if (!key) throw new TypeError(`missing tool executor program ${reference.specifier}`);
      return key;
    }).unwrap();
    tools.set(AssetGuid.format(AssetGuid.derive(packageId, sourceKey)), lowered);
  }
  return tools;
}

async function contentFromOutputs(
  packageId: string,
  submitted: PackOutputMap,
  programs?: RuntimePackContent['programs'],
  sceneComponents?: readonly ScriptablePackSceneComponentInput[],
): Promise<RuntimePackContent> {
  // Take the entire output graph before the first producer can yield.
  const owned = copyPackData(submitted) as PackOutputMap;
  const producers = runtimeOutputProducers(programs, sceneComponents);
  const assets: Record<string, DirectPackJson['assets'][string]> = {};
  const blobs: Record<string, PackBlob> = {};
  for (const [sourceKey, asset] of Object.entries(owned)) {
    if (!isValidPackSourceKey(sourceKey)) throw new TypeError('invalid runtime sourceKey');
    if (
      !asset ||
      typeof asset !== 'object' ||
      !isScriptablePackAssetKind(asset.kind) ||
      'execution' in asset
    )
      throw new TypeError('runtime outputs must be prepared assets, not build-only source');
    if (asset.kind === 'material' && Array.isArray(asset.passes) && !isEngineMaterial(asset))
      throw new TypeError('authored material programs require build-time Cook');
    const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), sourceKey));
    const producer = producers.get(asset.kind);
    if (!producer) throw new TypeError(`no runtime asset producer for ${asset.kind}`);
    const product = (await producer.produce({ guid, sourceKey, asset })).unwrap();
    const artifacts: Record<string, Record<string, unknown>> = {};
    for (const [key, artifact] of Object.entries(product.artifacts)) {
      const path = `${guid}/${key}`;
      const bytes = new Uint8Array(artifact.bytes);
      blobs[path] = bytes;
      artifacts[key] = {
        path,
        mediaType: artifact.mediaType,
        byteLength: bytes.byteLength,
        contentEncoding: 'identity',
        integrity: { algorithm: 'sha256', digest: await bytesDigest(bytes) },
        ...(artifact.assetCodec ? { assetCodec: artifact.assetCodec } : {}),
      };
    }
    const imported = { ...product, kind: asset.kind, guid };
    assets[sourceKey] = {
      kind: asset.kind,
      payload:
        asset.kind === 'plugin' && 'module' in asset
          ? (asset as unknown as Record<string, unknown>)
          : projectImportedAssetPayload(imported),
      ...(asset.kind === 'plugin' ? {} : { refs: product.refs.map((ref) => ref.guid) }),
      artifacts,
    };
  }
  const content = {
    source: { schemaVersion: '3.0.0' as const, packageId, assets },
    ...(programs ? { programs } : {}),
    blobs,
  };
  parsePackSourceJson(content.source).unwrap();
  return content;
}

export function prepareRuntimePackAnchor(
  input: RuntimePackContent,
  resolved: ResolvedPackParameterInheritance,
): Result<RuntimePackContent, RuntimePackError> {
  let id = '';
  try {
    const content = parseRuntimePackContent(input);
    const source = content.source;
    id = PackageId.format(resolved.packageId);
    if (!isGenerator(source) || source.packageId !== PackageId.format(resolved.rootPackageId))
      throw new TypeError('resolved inheritance must belong to this ScriptablePack root');
    const definition = generatorDefinition(source, () => ok({}));
    if (!('parameters' in definition)) throw new TypeError('anchor requires parameter capability');
    const resolvedContract = validatePackDefinition({
      ...definition,
      parameters: resolved.parameters,
    }).unwrap();
    if (
      fingerprint(projectScriptablePackMeta(definition, source.source).parameters) !==
      fingerprint(projectScriptablePackMeta(resolvedContract, source.source).parameters)
    )
      throw new TypeError('resolved parameter contract differs from the root');
    if (
      fingerprint(Object.keys(resolved.values).sort()) !==
      fingerprint(definition.parameters.map((parameter) => parameter.name).sort())
    )
      throw new TypeError('resolved values must contain exactly every parameter');
    const anchor = validatePackDefinition({
      ...definition,
      packageId: resolved.packageId,
      parameters: definition.parameters.map((parameter) => ({
        ...parameter,
        default: resolved.values[parameter.name],
      })),
    }).unwrap();
    // The existing metadata projection converts branded GUID defaults back to JSON.
    return ok(
      parseRuntimePackContent({
        ...content,
        source: { ...source, ...projectScriptablePackMeta(anchor, source.source) },
      }),
    );
  } catch (cause) {
    return err(failure('runtime-pack-invalid', id, cause));
  }
}

function runtimeOutputProducers(
  programs: RuntimePackContent['programs'],
  sceneComponents?: readonly ScriptablePackSceneComponentInput[],
) {
  const outputs = createAssetOutputProducerRegistry(
    projectScriptablePackSceneComponents(sceneComponents),
  );
  outputs.register(meshAssetDataProducer);
  outputs.register({
    kind: 'plugin',
    version: 'plugin-definition/1',
    produce(input) {
      if (!('module' in input.asset))
        return err(
          new ImportError({
            code: 'import-internal-error',
            expected: 'PluginAssetSource with its original module reference',
            hint: 'provide the source definition before lowering',
            detail: { reason: 'missing module source' },
          }),
        );
      const source = input.asset;
      const program = pluginProgram(programs, source.module);
      if (!program)
        return err(
          new ImportError({
            code: 'import-internal-error',
            expected: 'the referenced plugin module in this Pack program closure',
            hint: 'prepare the selected JS/TS module before admitting the Pack',
            detail: { reason: 'missing program artifact' },
          }),
        );
      return producePluginAsset(input, program);
    },
  });
  return outputs;
}

/** Direct agent-created data uses the ordinary output producers and native Pack source form. */
export async function prepareRuntimePackContent(
  packageId: string,
  assets: PackOutputMap,
  options: {
    readonly programs?: RuntimePackContent['programs'];
    readonly sceneComponents?: readonly ScriptablePackSceneComponentInput[];
    readonly dependencies?: RuntimePackContent['dependencies'];
  } = {},
): Promise<Result<RuntimePackContent, RuntimePackError>> {
  try {
    const content = {
      ...(await contentFromOutputs(packageId, assets, options.programs, options.sceneComponents)),
      ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    };
    projectRuntimePackTools(content);
    return ok(content);
  } catch (cause) {
    return err(failure('runtime-pack-invalid', packageId, cause));
  }
}

/** Producer state only. Both runtime readers consume its ordinary Catalog and bytes. */
export class RuntimePackProducer {
  private readonly packs = new Map<
    string,
    {
      content: RuntimePackContent;
      digest: string;
      dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
    }
  >();
  private readonly published = new Map<string, RuntimePackPublicationState>();
  private readonly executions = new Map<string, RuntimePackExecution>();
  private readonly listeners = new Set<(delta: CatalogDelta) => void>();
  private readonly bodies = new Map<string, ReadonlyMap<string, RuntimeBody>>();
  private readonly programs = new Map<string, RuntimePackProgram>();
  private readonly loadedPrograms = new Map<string, ReturnType<typeof loadPackProgram>>();
  private readonly snapshots = new Map<string, RuntimePackPinnedAsset>();
  private readonly admissions = new Map<string, AbortController>();
  private closed = false;
  private request = 0;
  readonly catalog = {
    openPackage: (packageUrl: string): PackageFetcher | undefined => {
      const bodies = this.bodies.get(packageUrl);
      return bodies === undefined ? undefined : bodyFetcher(bodies);
    },
    enumerate: async (): Promise<Result<readonly CatalogEntry[], AssetError>> => ok(this.rows()),
    subscribe: (listener: (delta: CatalogDelta) => void): (() => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
  readonly fetch: PackageFetcher = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const key = input;
    const body = [...this.bodies.values()]
      .map((bodies) => bodies.get(key))
      .find((body) => body !== undefined);
    return body === undefined
      ? createPackageResponse(new Uint8Array(), { status: 404 })
      : createPackageResponse(await bodyBytes(body), {
          mediaType: body.mediaType,
        });
  };
  constructor(private readonly options: RuntimePackProducerOptions) {
    if (!options.scopeId)
      throw new TypeError('Runtime Pack producer requires the active scope identity');
  }
  rows(): readonly CatalogEntry[] {
    return json([...this.published.values()].flatMap((value) => value.rows));
  }
  inspect(): {
    /** Public module identities supported by this Host; transport URLs remain Host-owned. */
    readonly imports: Readonly<Record<string, string>>;
    readonly packs: readonly RuntimePackContent[];
    readonly executions: readonly RuntimePackExecution[];
  } {
    return json({
      imports: Object.fromEntries(
        Object.entries(this.options.imports ?? {}).map(([specifier, binding]) => [
          specifier,
          binding.identity,
        ]),
      ),
      packs: [...this.packs.values()].map((value) => value.content),
      executions: [...this.executions.values()],
    });
  }
  programEntries(): ReadonlyMap<string, RuntimePackProgram> {
    return new Map([...this.programs].map(([key, value]) => [key, json(value)]));
  }
  snapshot(): RuntimePackSnapshot {
    return encodeRuntimePackData(
      saveRuntimePackSnapshot(
        [...this.packs.values()],
        [...this.executions.values()].flatMap((value) =>
          value.status !== 'withdrawn' && value.lastKnownGood
            ? [{ ...value.instance, values: value.lastKnownGood.values }]
            : [],
        ),
        [
          ...new Set(
            [...this.snapshots.values()].flatMap((pin) =>
              pin.recipe && 'fixed' in pin.recipe ? [pin.recipe] : [],
            ),
          ),
        ],
      ),
    );
  }
  private currentPublication(id: string): RuntimePackPublicationReceipt {
    const state = this.published.get(id);
    if (!state) throw new TypeError(`admitted Pack has no publication ${id}`);
    return publicationReceipt(state);
  }
  private currentRow(guid: string): CatalogEntry | undefined {
    return this.snapshots.get(guid)?.row ?? this.options.assetSource?.currentRow?.(guid);
  }
  async exportSource(versions: ReadonlyMap<string, string>): Promise<RuntimePackSnapshot> {
    const recipes = new Set<RuntimePackRecipe>();
    for (const [guid, digest] of versions) {
      const pin = this.snapshots.get(guid);
      if (pin?.digest !== digest || !pin.recipe)
        throw new TypeError(`source version unavailable ${guid}@${digest}`);
      recipes.add(pin.recipe);
    }
    return encodeRuntimePackData(saveRuntimePackSnapshot([], [], [...recipes]));
  }
  private reusableDependency(
    pin: RuntimePackPinnedAsset,
    visited: Set<RuntimePackRecipe>,
  ): boolean {
    const recipe = pin.recipe;
    const current = this.currentRow(pin.row.guid);
    if (
      !current ||
      !matchesPinnedPublication({ ...current, guid: pin.row.guid }, pin) ||
      !recipe ||
      !('fixed' in recipe)
    )
      return false;
    if (recipe.outputs.some((output) => output.kind === 'plugin')) return false;
    if (visited.has(recipe)) return true;
    visited.add(recipe);
    // Complete sibling publications and historical inputs remain part of the
    // retained source. A changed or unavailable version is a cache miss.
    for (const output of recipe.outputs) {
      const row = this.currentRow(output.guid);
      if (
        !row ||
        !matchesPinnedPublication(
          { ...row, guid: output.guid },
          { ...pin, digest: output.digest },
        ) ||
        JSON.stringify(row.publication?.externalEvidence) !==
          JSON.stringify(pin.row.publication?.externalEvidence)
      )
        return false;
    }
    for (const edge of pin.row.publication?.externalEvidence ?? []) {
      if (edge.usage === 'content') continue;
      const publication = this.currentRow(edge.guid)?.publication;
      if (
        (edge.generation !== undefined && publication?.generation !== edge.generation) ||
        (edge.digest !== undefined &&
          publication?.outputs.find((output) => output.guid === edge.guid)?.digest !== edge.digest)
      )
        return false;
    }
    return [...recipe.dependencies.values()].every((dependency) =>
      this.reusableDependency(dependency, visited),
    );
  }
  private async readDependencies(
    versions: Readonly<Record<string, string>>,
    recovery?: (guid: string, digest: string) => Promise<RuntimePackPinnedAsset>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>> {
    const dependencies = new Map<string, RuntimePackPinnedAsset>();
    const missing = new Map<string, string>();
    for (const [guid, digest] of Object.entries(versions)) {
      signal?.throwIfAborted();
      if (recovery) {
        const pin = await recovery(guid, digest);
        if (pin.digest !== digest) throw new TypeError(`dependency version mismatch ${guid}`);
        dependencies.set(guid, pin);
        continue;
      }
      let pin = this.snapshots.get(guid);
      if (pin?.digest !== digest) {
        pin = undefined;
        for (const owner of this.packs.values()) {
          const retained = owner.dependencies.get(guid);
          if (retained?.digest === digest && this.reusableDependency(retained, new Set())) {
            pin = retained;
            break;
          }
        }
      }
      if (pin) dependencies.set(guid, pin);
      else missing.set(guid, digest);
    }
    if (!missing.size) return dependencies;
    const source = this.options.assetSource;
    if (source?.retain) {
      const retained = await source.retain(new Map(missing), signal);
      signal?.throwIfAborted();
      for (const [guid, digest] of missing) {
        const pin = retained.get(guid);
        if (!pin || pin.digest !== digest || !pin.recipe)
          throw new TypeError(`retained dependency version differs ${guid}`);
        dependencies.set(guid, pin);
      }
      return dependencies;
    }
    if (!source?.exportSource)
      throw new TypeError('dependencies require their producer exportSource for durable admission');
    const saved = parseRuntimePackSnapshot(await source.exportSource(new Map(missing), signal));
    signal?.throwIfAborted();
    // One complete graph is verified once before any recipe is reconstructed.
    const resolver = await this.restoreDependencyResolver(saved, signal);
    const selections = new Map<string, string>();
    for (const root of saved.recipeRoots ?? []) {
      for (const output of saved.closure?.recipes[root]?.outputs ?? []) {
        if (!missing.has(output.guid)) continue;
        if (selections.has(output.guid) || output.digest !== missing.get(output.guid))
          throw new TypeError(`exported dependency version differs ${output.guid}`);
        selections.set(output.guid, root);
      }
    }
    for (const guid of missing.keys())
      if (!selections.has(guid)) throw new TypeError(`exported dependency missing ${guid}`);
    const restored = new Map<string, RuntimePackPinnedAsset>();
    for (const root of saved.recipeRoots ?? []) {
      const outputs = await resolver.root(root);
      for (const [guid, digest] of missing) {
        const output = outputs.get(guid);
        if (!output) continue;
        if (restored.has(guid) || output.digest !== digest)
          throw new TypeError(`exported dependency version differs ${guid}`);
        restored.set(guid, output);
      }
    }
    for (const guid of missing.keys()) {
      const pin = restored.get(guid);
      if (!pin) throw new TypeError(`exported dependency missing ${guid}`);
      dependencies.set(guid, pin);
    }
    return dependencies;
  }
  /** Reconstruct in a private fixed closure, without asserting visibility in the live Catalog. */
  private async rebuildRecipe(
    content: RuntimePackContent,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
    instance?: PackInstanceJson,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>> {
    signal?.throwIfAborted();
    const { onCommit: _commit, cache: _cache, assetSource: _source, ...options } = this.options;
    let current = new Map<string, CatalogEntry>();
    const privateProducer = new RuntimePackProducer({
      ...options,
      assetSource: {
        currentRow: (guid) => current.get(guid),
        exportSource: async () => {
          throw new TypeError('private rebuild must use its fixed dependency pins');
        },
      },
      validate: (state, fetcher, pins) => {
        current = new Map(
          [...pins].map(([guid, pin]) => {
            const output = pin.row.publication?.outputs.find((output) => output.guid === guid);
            if (!output) throw new TypeError(`missing private dependency evidence ${guid}`);
            return [guid, pin.row];
          }),
        );
        return options.validate(state, fetcher, pins);
      },
    });
    try {
      (
        await privateProducer.admitContent(
          content,
          async (guid, digest) => {
            const value = dependencies.get(guid);
            if (!value || value.digest !== digest)
              throw new TypeError('saved recipe has an undeclared read');
            return value;
          },
          undefined,
          signal,
        )
      ).unwrap();
      signal?.throwIfAborted();
      if (instance) (await privateProducer.generate(instance, signal)).unwrap();
      signal?.throwIfAborted();
      return new Map(privateProducer.snapshots);
    } finally {
      privateProducer.dispose();
    }
  }

  private async candidate(
    content: RuntimePackContent,
    revision: string,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset> = new Map(),
    hash = createScriptablePackFingerprinter(),
  ): Promise<{
    state: RuntimePackPublicationState;
    bodies: Map<string, RuntimeBody>;
    decoded: ReadonlyMap<string, Asset | (() => Promise<Asset>)>;
  }> {
    const packageId = content.source.packageId;
    const bodies = new Map<string, RuntimeBody>();
    if (isGenerator(content.source))
      return {
        state: { packageId, status: 'admitted', content, rows: [] },
        bodies,
        decoded: new Map(),
      };
    const parsed = parsePackSourceJson(content.source).unwrap();
    if (parsed.format !== 'direct') throw new TypeError('expected a direct source');
    projectRuntimePackTools(content);
    const projection = projectDirectPackJson(parsed);
    const assets = [];
    for (const asset of projection.assets) {
      if (asset.kind === 'plugin' && 'module' in asset.payload) {
        const source = {
          kind: asset.kind,
          ...asset.payload,
        } as unknown as PluginAssetSource;
        const program = pluginProgram(content.programs, source.module);
        if (!program) throw new TypeError('plugin source module missing from program closure');
        const lowered = producePluginAsset(
          { guid: asset.guid, sourceKey: asset.sourceKey, asset: source },
          program,
        ).unwrap();
        assets.push({
          ...asset,
          payload: lowered.payload,
          refs: lowered.refs.map((ref) => ref.guid),
        });
      } else if (asset.kind === 'mesh' && asset.payload.vertices instanceof Float32Array) {
        // Fingerprint the portable domain result, including derived bounds. Source author data stays unchanged.
        assets.push({
          ...asset,
          payload: withMeshAabb({
            ...asset.payload,
          } as unknown as import('@forgeax/engine-types').MeshAsset),
        });
      } else assets.push(asset);
    }
    const projected = {
      ...projection,
      assets: assets.map((asset) => ({
        ...asset,
        artifacts: Object.fromEntries(
          Object.entries(asset.artifacts ?? {}).map(([key, value]) => [
            key,
            { contentEncoding: 'identity', ...(value as object) },
          ]),
        ),
      })),
    };
    const packageUrl = new URL(
      `${encodeURIComponent(packageId)}/${revision.slice(revision.indexOf(':') + 1)}/pack.json`,
      this.options.baseUrl ?? 'https://runtime-pack.invalid/',
    ).href;
    const sourcePath = `runtime/${packageId}`;
    for (const [path, values] of Object.entries(content.blobs ?? {})) {
      bodies.set(new URL(path, packageUrl).href, {
        bytes: decodePackBlob(values),
        mediaType: 'application/octet-stream',
      });
    }
    const own = new Set(projected.assets.map((asset) => asset.guid));
    const roots = new Set(
      projected.assets.flatMap((asset) => asset.refs).filter((guid) => !own.has(guid)),
    );
    const pins = collectRuntimePackDependencies(dependencies, roots);
    const externalEvidence = [
      ...new Set([...Object.keys(content.dependencies ?? {}), ...pins.keys()]),
    ]
      .sort()
      .map((guid) => {
        const pin = pins.get(guid) ?? dependencies.get(guid);
        if (!pin) throw new TypeError(`missing dependency evidence ${guid}`);
        return {
          guid,
          digest: pin.digest,
          usage: pins.has(guid)
            ? content.dependencies?.[guid] === undefined
              ? ('reference' as const)
              : ('both' as const)
            : ('content' as const),
        };
      });
    const outputFacts = await Promise.all(
      projected.assets.map(async (asset) => {
        // Interleaved vertices are a verified projection of canonical attributes. Hash their
        // source once; validation rejects any inconsistent projection before publication.
        let payload = asset.payload;
        if (
          asset.kind === 'mesh' &&
          'vertices' in payload &&
          payload.vertices instanceof Float32Array
        ) {
          const { vertices: _vertices, ...domain } = payload;
          payload = domain;
        }
        return {
          guid: asset.guid,
          sourceKey: asset.sourceKey,
          kind: asset.kind,
          digest: await hash({
            kind: asset.kind,
            payload,
            refs: asset.refs,
            artifacts: asset.artifacts,
          }),
          refs: asset.refs,
        };
      }),
    );
    const publication = createRuntimePackPublication({
      digest: await hash(outputFacts),
      outputs: outputFacts,
      pack: { assets: projected.assets.map(({ sourceKey: _key, ...asset }) => asset) },
      scopeId: this.options.scopeId,
      sourcePath,
      sourceRevision: revision,
      packageUrl,
      externalEvidence,
      sourceKeys: new Map(projected.assets.map((asset) => [asset.guid, asset.sourceKey])),
    });
    parsePackV2({
      schemaVersion: publication.pack.schemaVersion,
      kind: publication.pack.kind,
      assets: publication.pack.assets,
    }).unwrap();
    for (const asset of publication.pack.assets)
      for (const descriptor of Object.values(asset.artifacts)) {
        const value = descriptor as {
          path: string;
          byteLength: number;
          integrity: { digest: string };
        };
        const body = bodies.get(new URL(value.path, packageUrl).href);
        if (
          !body ||
          (await bodyBytes(body)).byteLength !== value.byteLength ||
          (await bytesDigest(await bodyBytes(body))) !== value.integrity?.digest
        )
          throw new TypeError(`artifact integrity mismatch ${value.path}`);
      }
    let encoded: Promise<Uint8Array> | undefined;
    bodies.set(packageUrl, {
      bytes: () =>
        (encoded ??= (async () => {
          const assets = [];
          for (const asset of publication.pack.assets) {
            if (
              asset.kind !== 'mesh' ||
              !((asset.payload as Record<string, unknown>).vertices instanceof Float32Array)
            ) {
              assets.push(asset);
              continue;
            }
            if (asset.artifacts.body !== undefined)
              throw new TypeError('native Mesh cannot also declare a body artifact');
            const { distanceField, ...geometry } = asset.payload as Record<string, unknown>;
            const produced = (
              await meshAssetOutputProducer.produce({
                guid: asset.guid,
                sourceKey: asset.guid,
                asset: geometry as unknown as Asset,
              })
            ).unwrap();
            const artifacts: Record<string, unknown> = { ...asset.artifacts };
            for (const [key, body] of Object.entries(produced.artifacts)) {
              const root = `${asset.guid}/${key}`;
              let path = root;
              for (let suffix = 1; Object.hasOwn(content.blobs ?? {}, path); suffix++)
                path = `${root}-${suffix}`;
              bodies.set(new URL(path, packageUrl).href, {
                bytes: body.bytes,
                mediaType: body.mediaType,
              });
              artifacts[key] = {
                path,
                byteLength: body.bytes.byteLength,
                mediaType: body.mediaType,
                contentEncoding: 'identity',
                integrity: { algorithm: 'sha256', digest: await bytesDigest(body.bytes) },
                ...(body.assetCodec ? { assetCodec: body.assetCodec } : {}),
              };
            }
            assets.push({
              ...asset,
              payload: {
                kind: asset.kind,
                ...(distanceField === undefined ? {} : { distanceField }),
              },
              artifacts,
            });
          }
          return new TextEncoder().encode(
            JSON.stringify(normaliseForPack({ ...publication.pack, assets })),
          );
        })().catch((error) => {
          encoded = undefined;
          throw error;
        })),
      mediaType: 'application/json',
    });
    const rows = projectPackageCatalog(
      projected.assets.map((asset) => ({ ...asset, packageId, sourcePath })),
      packageUrl,
    ).map((row) => ({ ...row, publication: publication.publication }));
    const state = { packageId, status: 'admitted' as const, content, publication, rows };
    const fetcher: PackageFetcher = async (input) => {
      const body = bodies.get(input);
      return body
        ? createPackageResponse(await bodyBytes(body), {
            mediaType: body.mediaType,
          })
        : this.fetch(input);
    };
    const pinned = new Map(
      [...pins].map(([guid, pin]) => [guid, { asset: pin.asset, row: pin.row }]),
    );
    const validation = await this.options.validate(state, fetcher, pinned);
    if (!validation.ok) throw validation.error;
    return { state, bodies, decoded: validation.value };
  }
  private async fixedCandidate(
    fixed: FixedPackPublication,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
  ): Promise<Awaited<ReturnType<RuntimePackProducer['candidate']>>> {
    validateFixedPackPublication(fixed).unwrap();
    const execution =
      this.options.target === undefined ? undefined : fixed.executions?.[this.options.target];
    for (const program of Object.values(execution?.programs ?? {})) {
      for (const [specifier, identity] of Object.entries(program.imports ?? {}))
        if (this.options.imports?.[specifier]?.identity !== identity)
          throw new TypeError(`host dependency mismatch ${specifier}`);
    }
    const original = fixed.rows[0]?.publication;
    if (!original) throw new TypeError('fixed publication missing');
    const own = new Set(original.outputs.map((output) => output.guid));
    const roots = new Set(
      original.outputs.flatMap((output) => output.refs).filter((guid) => !own.has(guid)),
    );
    const pins = collectRuntimePackDependencies(dependencies, roots);
    for (const evidence of original.externalEvidence) {
      if (evidence.usage === 'content') continue;
      const pin = pins.get(evidence.guid);
      if (
        !pin ||
        (evidence.digest !== undefined && evidence.digest !== pin.digest) ||
        (evidence.generation !== undefined && evidence.generation !== pin.generation)
      )
        throw new TypeError(`fixed dependency version differs ${evidence.guid}`);
    }
    const packageUrl = new URL(
      `fixed/${(await fingerprintAsync(fixed)).slice(7)}/pack.json`,
      this.options.baseUrl ?? 'https://runtime-pack.invalid/',
    ).href;
    const publication = {
      ...original,
      ...(original.current ? { current: { ...original.current, packageUrl } } : {}),
    };
    const pack = { ...fixed.pack, scopeId: this.options.scopeId };
    const rows = fixed.rows.map((row) => ({ ...row, packageUrl, publication }));
    const bodies = new Map<string, RuntimeBody>();
    bodies.set(packageUrl, {
      bytes: new TextEncoder().encode(JSON.stringify(pack)),
      mediaType: 'application/json',
    });
    for (const [path, bytes] of Object.entries(fixed.blobs))
      bodies.set(
        new URL(
          validateArtifactPath(path, {
            packageRoot: packageUrl,
            guid: '',
            artifactKey: path,
          }).unwrap(),
          packageUrl,
        ).href,
        {
          bytes: decodePackBlob(bytes),
          mediaType: 'application/octet-stream',
        },
      );
    const packageId = fixed.rows[0]?.packageId;
    const state: RuntimePackPublicationState = {
      ...(packageId ? { packageId } : {}),
      status: 'admitted',
      content: fixed,
      rows,
      publication: { pack, publication },
    };
    const validated = await this.options.validate(
      state,
      bodyFetcher(bodies),
      new Map([...pins].map(([guid, pin]) => [guid, { row: pin.row, asset: pin.asset }])),
    );
    if (!validated.ok) throw validated.error;
    return { state, bodies, decoded: validated.value };
  }
  private async rebuildFixed(
    fixed: FixedPackPublication,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>> {
    signal?.throwIfAborted();
    const candidate = await this.fixedCandidate(fixed, dependencies);
    signal?.throwIfAborted();
    const recipe: RuntimePackRecipe = {
      fixed,
      dependencies,
      outputs: candidate.state.publication?.publication.outputs ?? [],
      assets: candidate.decoded,
    };
    return new Map(
      candidate.state.rows.map((row) => {
        const asset = recipe.assets.get(row.guid);
        const output = recipe.outputs.find((output) => output.guid === row.guid);
        if (!asset || !output) throw new TypeError(`fixed output not decoded ${row.guid}`);
        return [
          row.guid,
          { row, asset, digest: output.digest, generation: fixed.pack.generation, recipe },
        ];
      }),
    );
  }
  private commit(
    candidate: Awaited<ReturnType<RuntimePackProducer['candidate']>>,
    install?: () => void,
    recipe?: RuntimePackRecipe,
  ): void {
    const { state, bodies } = candidate;
    if (this.closed && state.status !== 'withdrawn')
      throw new TypeError('runtime Pack producer is disposed');
    const key = publicationKey(state.content);
    const before = this.published.get(key);
    if (recipe && 'fixed' in recipe)
      for (const [guid, pin] of collectRuntimePackDependencies(
        recipe.dependencies,
        recipe.dependencies.keys(),
      )) {
        const current = this.currentRow(guid);
        if (!current || !matchesPinnedPublication(current, pin))
          throw new TypeError(`fixed reference is not consumer-current ${guid}`);
      }
    for (const evidence of state.publication?.publication.externalEvidence ?? []) {
      if (evidence.usage === 'content') continue;
      const row = this.currentRow(evidence.guid);
      const actual = row?.publication?.outputs.find((output) => output.guid === evidence.guid);
      if (
        !actual ||
        (evidence.digest !== undefined && actual.digest !== evidence.digest) ||
        (evidence.generation !== undefined && row?.publication?.generation !== evidence.generation)
      )
        throw new TypeError(`referenced dependency is not consumer-current ${evidence.guid}`);
    }
    // Prepare all potentially failing clones and evidence before the first public mutation.
    const snapshots = [...candidate.decoded].map(([guid, asset]) => {
      const publication = state.publication;
      const row = state.rows.find((row) => row.guid === guid);
      const output = publication?.publication.outputs.find((output) => output.guid === guid);
      if (!publication || !row || !output) throw new TypeError(`missing output evidence ${guid}`);
      return [
        guid,
        {
          asset: recipe?.assets.get(guid) ?? asset,
          digest: output.digest,
          generation: publication.pack.generation,
          row,
          ...(recipe === undefined ? {} : { recipe }),
        },
      ] as const;
    });
    for (const row of state.rows) {
      const collision = [...this.published].some(
        ([owner, state]) =>
          owner !== key && state.rows.some((previous) => previous.guid === row.guid),
      );
      if (collision) throw new TypeError(`GUID collision ${row.guid}`);
    }
    this.options.onCommit?.(state);
    if (state.status === 'withdrawn') this.published.delete(key);
    else this.published.set(key, state);
    for (const row of before?.rows ?? []) this.snapshots.delete(row.guid);
    for (const [guid, snapshot] of snapshots) this.snapshots.set(guid, snapshot);
    for (const row of before?.rows ?? []) this.bodies.delete(row.packageUrl);
    const first = state.rows[0];
    if (first) this.bodies.set(first.packageUrl, bodies);
    install?.();
    const oldGuids = new Set(before?.rows.map((row) => row.guid));
    const newGuids = new Set(state.rows.map((row) => row.guid));
    const delta: CatalogDelta = {
      added: state.rows.filter((row) => !oldGuids.has(row.guid)),
      changed: state.rows.filter((row) => oldGuids.has(row.guid)),
      removed: [...oldGuids].filter((guid) => !newGuids.has(guid)),
    };
    for (const listener of this.listeners) {
      try {
        listener(json(delta));
      } catch {
        /* An observer cannot roll back a producer commit. */
      }
    }
  }
  async admit(
    input: RuntimePackContent,
    signal?: AbortSignal,
  ): Promise<Result<RuntimePackPublicationReceipt, RuntimePackError>> {
    return this.admitContent(input, undefined, undefined, signal);
  }
  private async admitContent(
    input: RuntimePackContent,
    recovery?: (guid: string, digest: string) => Promise<RuntimePackPinnedAsset>,
    expectedOutputs?: readonly AssetPublicationOutput[],
    signal?: AbortSignal,
  ): Promise<Result<RuntimePackPublicationReceipt, RuntimePackError>> {
    let id = '';
    try {
      const content = parseRuntimePackContent(input);
      id = content.source.packageId;
      if (this.closed || signal?.aborted)
        return err(failure('runtime-pack-cancelled', id, 'producer disposed or request cancelled'));
      const lifetime = this.admissions.get(id) ?? new AbortController();
      this.admissions.set(id, lifetime);
      const hash = createScriptablePackFingerprinter();
      const digest = await hash(content);
      if (this.closed || lifetime.signal.aborted || signal?.aborted)
        return err(failure('runtime-pack-cancelled', id, 'admission cancelled while hashing'));
      const previous = this.packs.get(id);
      if (previous && !recovery)
        return previous.digest === digest
          ? ok(this.currentPublication(id))
          : err(failure('runtime-pack-conflict', id, 'same identity has different content'));
      if (this.executions.has(id))
        return err(failure('runtime-pack-conflict', id, 'identity belongs to an instance'));
      for (const [name, program] of Object.entries(content.programs ?? {})) {
        if (!name) throw new TypeError('program identity is empty');
        verifyPackProgram(program.artifact).unwrap();
        for (const [specifier, identity] of Object.entries(program.artifact.imports ?? {}))
          if (this.options.imports?.[specifier]?.identity !== identity)
            throw new TypeError(`host dependency mismatch ${specifier}`);
        const installed = this.programs.get(name);
        if (installed && fingerprint(installed) !== fingerprint(program))
          return err(failure('runtime-pack-conflict', id, `program ${name}`));
      }
      if (isGenerator(content.source)) {
        const source = content.source;
        generatorDefinition(source, () => ok({}));
        if (!source.runtime || !content.programs?.[source.program])
          throw new TypeError('generator requires runtime capability and a local program artifact');
        const declared = [...source.runtime.dependencies].sort();
        if (
          JSON.stringify(declared) !==
          JSON.stringify(Object.keys(content.dependencies ?? {}).sort())
        )
          throw new TypeError('complete runtime dependency versions are required');
      }
      const dependencies = await this.readDependencies(
        content.dependencies ?? {},
        recovery,
        signal,
      );
      const matches = (value: {
        content: RuntimePackContent;
        digest: string;
        dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
      }) =>
        value.digest === digest &&
        (!recovery ||
          fingerprint(saveRuntimePackSnapshot([value], [])) ===
            fingerprint(saveRuntimePackSnapshot([{ content, dependencies }], [])));
      const retained = this.packs.get(id);
      if (this.closed || lifetime.signal.aborted || signal?.aborted)
        return err(
          failure('runtime-pack-cancelled', id, 'admission cancelled during dependency recovery'),
        );
      if (retained)
        return matches(retained)
          ? ok(this.currentPublication(id))
          : err(
              failure(
                'runtime-pack-conflict',
                id,
                'saved source bindings conflict with admitted content',
              ),
            );
      const candidate = await this.candidate(content, digest, dependencies, hash);
      if (expectedOutputs)
        assertOutputSet(candidate.state.publication?.publication.outputs ?? [], expectedOutputs);
      const internal = new Set(candidate.state.rows.map((row) => row.guid));
      for (const asset of candidate.state.publication?.pack.assets ?? []) {
        for (const ref of asset.refs)
          if (!internal.has(ref) && !dependencies.has(ref))
            throw new TypeError(`undeclared reference ${ref}`);
        if (asset.kind === 'plugin') {
          const program = (asset.payload as { program: string }).program;
          if (!content.programs?.[program])
            throw new TypeError(`missing plugin program ${program}`);
        }
      }
      if (this.closed || lifetime.signal.aborted || signal?.aborted)
        return err(
          failure('runtime-pack-cancelled', id, 'admission withdrawn, disposed or cancelled'),
        );
      if (this.executions.has(id))
        return err(failure('runtime-pack-conflict', id, 'concurrent instance claimed identity'));
      const raced = this.packs.get(id);
      if (raced)
        return matches(raced)
          ? ok(this.currentPublication(id))
          : err(failure('runtime-pack-conflict', id, 'concurrent admission differs'));
      for (const [name, program] of Object.entries(content.programs ?? {})) {
        const installed = this.programs.get(name);
        if (installed && fingerprint(installed) !== fingerprint(program))
          return err(failure('runtime-pack-conflict', id, `concurrent program ${name}`));
      }
      const reply = publicationReceipt(candidate.state);
      this.commit(
        candidate,
        () => {
          this.packs.set(id, { content, digest, dependencies });
          for (const [name, program] of Object.entries(content.programs ?? {}))
            this.programs.set(name, program);
        },
        this.recipe(content, dependencies, candidate),
      );
      return ok(reply);
    } catch (cause) {
      return err(
        failure(signal?.aborted ? 'runtime-pack-cancelled' : 'runtime-pack-invalid', id, cause),
      );
    }
  }
  async generate(
    input: PackInstanceJson,
    signal?: AbortSignal,
  ): Promise<Result<RuntimePackPublicationReceipt, RuntimePackError>> {
    return this.generateInstance(input, signal);
  }
  private async generateInstance(
    input: PackInstanceJson,
    signal?: AbortSignal,
    expectedOutputs?: readonly AssetPublicationOutput[],
  ): Promise<Result<RuntimePackPublicationReceipt, RuntimePackError>> {
    let id = '';
    const request = ++this.request;
    let instance: PackInstanceJson;
    let old: RuntimePackExecution | undefined;
    try {
      instance = parseRuntimePackInstance(input);
      id = instance.packageId;
      old = this.executions.get(id);
      if (this.packs.has(id))
        return err(failure('runtime-pack-conflict', id, 'identity belongs to an admitted Pack'));
      const owner = this.packs.get(instance.parent);
      if (!owner || !isGenerator(owner.content.source))
        throw new TypeError('parent must be an admitted ScriptablePack anchor');
      if (old && old.instance.parent !== instance.parent)
        return err(failure('runtime-pack-conflict', id, 'instance parent cannot change'));
      this.executions.set(id, {
        instance,
        request,
        status: 'pending',
        ...(old?.lastKnownGood === undefined ? {} : { lastKnownGood: old.lastKnownGood }),
      });
      const cancelled = () =>
        this.closed ||
        this.packs.get(instance.parent) !== owner ||
        signal?.aborted === true ||
        this.executions.get(id)?.request !== request ||
        this.executions.get(id)?.status === 'withdrawn';
      if (cancelled()) return this.cancelled(id, request, 'generation cancelled');
      const source = owner.content.source;
      const metadata = generatorDefinition(source, () => ok({}));
      if (!('parameters' in metadata))
        throw new TypeError('instances require a parameter capability');
      const values = resolvePackParameterValues(metadata, instance.values).unwrap();
      const program = owner.content.programs?.[source.program]?.artifact;
      if (!program) throw new TypeError(`missing admitted generator program ${source.program}`);
      const outputs = runtimeOutputProducers(owner.content.programs, source.sceneComponents);
      const key = fingerprint({
        sourceRevision: owner.digest,
        packageId: id,
        program: program.digest,
        values,
        dependencies: owner.content.dependencies ?? {},
        producers: outputs.versions(),
      });
      const cached = this.options.cache?.get(key);
      let content: RuntimePackContent | undefined;
      let candidate: Awaited<ReturnType<RuntimePackProducer['candidate']>> | undefined;
      if (cached) {
        try {
          const saved = parseRuntimePackContent(cached.content);
          const { inputFingerprint, digest } = cached;
          if (
            inputFingerprint !== key ||
            digest !== (await fingerprintAsync(saved)) ||
            saved.source.packageId !== id ||
            fingerprint(saved.programs ?? {}) !== fingerprint(owner.content.programs ?? {}) ||
            isGenerator(saved.source)
          )
            throw new TypeError('invalid cache envelope');
          content = saved;
          candidate = await this.candidate(content, key, owner.dependencies);
        } catch {
          // Derived bytes are disposable even when their envelope integrity is valid.
          this.options.cache?.delete(key);
          content = undefined;
        }
      }
      let dependencyFault: unknown;
      if (!content) {
        const moduleKey = `${packProgramModuleIdentity(program, this.options.imports).unwrap()}/${program.entry}#${program.export}`;
        let loading = this.loadedPrograms.get(moduleKey);
        if (!loading) {
          loading = loadPackProgram(program, this.options.imports, this.options.programHost);
          this.loadedPrograms.set(moduleKey, loading);
        }
        const loaded = await loading;
        if (!loaded.ok) this.loadedPrograms.delete(moduleKey);
        if (!loaded.ok) throw loaded.error;
        if (cancelled()) return this.cancelled(id, request, 'program loaded after cancellation');
        const definition = generatorDefinition(source, loaded.value);
        const readByGuid = async <TAsset = Asset>(
          guid: import('@forgeax/engine-types').AssetGuid,
        ): Promise<Result<TAsset, unknown>> => {
          const value = owner.dependencies.get(AssetGuid.format(guid));
          if (value)
            return ok(
              structuredClone(
                typeof value.asset === 'function' ? await value.asset() : value.asset,
              ) as TAsset,
            );
          const error = new AssetError({
            code: 'asset-not-found',
            expected: 'an explicitly declared, pinned dependency',
            hint: 'add every parameter branch dependency to runtime.dependencies before admission',
          });
          dependencyFault = error;
          return err(error);
        };
        const built = await definition.build({
          packageId: definePackageId(instance.packageId),
          values,
          readByGuid,
        } as never);
        if (!built || typeof built.ok !== 'boolean')
          throw new TypeError('Pack build must return a Result');
        if (!built.ok) throw built.error;
        if (dependencyFault !== undefined) throw dependencyFault;
        content = {
          ...(await contentFromOutputs(
            id,
            built.value,
            owner.content.programs,
            source.sceneComponents,
          )),
          dependencies: owner.content.dependencies ?? {},
        };
      }
      if (content.source.packageId !== id || isGenerator(content.source))
        throw new TypeError('cache does not belong to this instance');
      candidate ??= await this.candidate(content, key, owner.dependencies);
      if (cancelled()) return this.cancelled(id, request, 'late generation result');
      const accepted = candidate;
      const publication = accepted.state.publication;
      if (!publication) throw new TypeError(`missing generated publication ${id}`);
      if (expectedOutputs) assertOutputSet(publication.publication.outputs, expectedOutputs);
      const cachedContent = this.options.cache
        ? {
            inputFingerprint: key,
            digest: await fingerprintAsync(content),
            content: copyPackData(content) as RuntimePackContent,
          }
        : undefined;
      if (cancelled()) return this.cancelled(id, request, 'late cache preparation');
      const reply = publicationReceipt(candidate.state);
      this.commit(
        candidate,
        () =>
          this.executions.set(id, {
            instance,
            request,
            status: 'current',
            lastKnownGood: {
              values: instance.values,
              generation: publication.pack.generation,
            },
          }),
        this.recipe(owner.content, owner.dependencies, accepted, instance),
      );
      if (cachedContent) this.options.cache?.set(key, cachedContent);
      return ok(reply);
    } catch (cause) {
      const error = failure('runtime-pack-execution-failed', id, cause);
      const current = this.executions.get(id);
      if (current?.request === request && current.status !== 'withdrawn')
        this.executions.set(id, { ...current, status: 'failed', error });
      return err(error);
    }
  }
  private cancelled(id: string, request: number, cause: string): Result<never, RuntimePackError> {
    const error = failure('runtime-pack-cancelled', id, cause);
    const current = this.executions.get(id);
    if (current?.request === request && current.status !== 'withdrawn')
      this.executions.set(id, { ...current, status: 'cancelled', error });
    return err(error);
  }
  private recipe(
    content: RuntimePackContent,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
    candidate: Awaited<ReturnType<RuntimePackProducer['candidate']>>,
    instance?: PackInstanceJson,
  ): RuntimePackRecipe {
    return {
      content,
      dependencies,
      ...(instance === undefined ? {} : { instance }),
      assets: candidate.decoded,
      outputs: candidate.state.publication?.publication.outputs ?? [],
    };
  }
  withdraw(packageId: string): void {
    this.admissions.get(packageId)?.abort();
    this.admissions.delete(packageId);
    const pack = this.packs.get(packageId);
    this.packs.delete(packageId);
    if (pack) {
      for (const [id, state] of this.executions)
        if (state.instance.parent === packageId) this.withdraw(id);
      for (const name of Object.keys(pack.content.programs ?? {}))
        if (![...this.packs.values()].some((value) => value.content.programs?.[name]))
          this.programs.delete(name);
    }
    const current = this.executions.get(packageId);
    if (current)
      this.executions.set(packageId, { ...current, request: ++this.request, status: 'withdrawn' });
    const previous = this.published.get(packageId);
    if (!previous) return;
    const { publication: _publication, ...rest } = previous;
    this.commit({
      state: { ...rest, status: 'withdrawn', rows: [] },
      bodies: new Map(),
      decoded: new Map(),
    });
    for (const row of previous.rows) this.snapshots.delete(row.guid);
  }
  /** Restores source first; activation remains an explicit consumer operation. */
  async restore(
    input: RuntimePackSnapshot,
    signal?: AbortSignal,
  ): Promise<Result<void, RuntimePackError>> {
    let snapshot: RuntimePackSnapshot;
    try {
      snapshot = parseRuntimePackSnapshot(input);
    } catch (cause) {
      return err(failure('runtime-pack-invalid', '', cause));
    }
    try {
      if (signal?.aborted) return err(failure('runtime-pack-cancelled', '', 'request cancelled'));
      const recovery = await this.restoreDependencyResolver(snapshot, signal);
      return await this.restoreCurrent(snapshot, recovery, signal);
    } catch (cause) {
      return err(
        failure(
          signal?.aborted ? 'runtime-pack-cancelled' : 'runtime-pack-dependency-unavailable',
          '',
          cause,
        ),
      );
    }
  }
  private async restoreDependencyResolver(
    snapshot: RuntimePackSnapshot,
    signal?: AbortSignal,
    completed = new Map<string, Promise<ReadonlyMap<string, RuntimePackPinnedAsset>>>(),
  ) {
    const contents = new Map<string, RuntimePackContent>();
    const roots = new Set<string>();
    for (const content of snapshot.packs) {
      const digest = await fingerprintAsync(content);
      signal?.throwIfAborted();
      contents.set(digest, content);
      roots.add(digest);
    }
    for (const [digest, content] of Object.entries(snapshot.closure?.contents ?? {})) {
      if ((await fingerprintAsync(content)) !== digest)
        throw new TypeError('saved source integrity mismatch');
      signal?.throwIfAborted();
      contents.set(digest, content);
    }
    const recipes = new Map<string, RuntimePackSavedRecipe>();
    for (const [id, recipe] of Object.entries(snapshot.closure?.recipes ?? {})) {
      if (
        (await fingerprintAsync(recipe)) !== id ||
        ('content' in recipe && !contents.has(recipe.content))
      )
        throw new TypeError('saved dependency recipe integrity mismatch');
      signal?.throwIfAborted();
      recipes.set(id, recipe);
    }
    const verifyEdges = (content: RuntimePackContent, edges: Readonly<Record<string, string>>) => {
      const versions = content.dependencies ?? {};
      if (fingerprint(Object.keys(edges).sort()) !== fingerprint(Object.keys(versions).sort()))
        throw new TypeError('saved dependency bindings differ from declared inputs');
      for (const [guid, digest] of Object.entries(versions)) {
        const recipe = recipes.get(edges[guid] ?? '');
        if (!recipe || recipe.outputs.find((output) => output.guid === guid)?.digest !== digest)
          throw new TypeError(`saved dependency binding unavailable ${guid}@${digest}`);
      }
    };
    const versions = (recipe: RuntimePackSavedRecipe): Readonly<Record<string, string>> => {
      if ('content' in recipe) {
        const content = contents.get(recipe.content);
        if (!content) throw new TypeError('saved recipe content unavailable');
        return content.dependencies ?? {};
      }
      const own = new Set(recipe.fixed.pack.assets.map((asset) => asset.guid));
      const refs = new Set(
        recipe.fixed.pack.assets.flatMap((asset) => asset.refs).filter((guid) => !own.has(guid)),
      );
      if (fingerprint([...refs].sort()) !== fingerprint(Object.keys(recipe.dependencies).sort()))
        throw new TypeError('fixed dependency bindings differ from retained references');
      return Object.fromEntries(
        [...refs].map((guid) => {
          const target = recipes.get(recipe.dependencies[guid] ?? '');
          const output = target?.outputs.find((output) => output.guid === guid);
          const evidence = recipe.fixed.rows[0]?.publication?.externalEvidence.find(
            (entry) => entry.guid === guid,
          );
          if (
            !output ||
            (evidence?.usage !== 'content' &&
              evidence?.digest !== undefined &&
              evidence.digest !== output.digest)
          )
            throw new TypeError(`fixed dependency binding unavailable ${guid}`);
          return [guid, output.digest];
        }),
      );
    };
    for (const recipe of recipes.values()) {
      if ('content' in recipe) {
        const content = contents.get(recipe.content);
        if (!content) throw new TypeError('saved recipe content unavailable');
        verifyEdges(content, recipe.dependencies);
      } else versions(recipe);
    }
    for (const key of Object.keys(snapshot.closure?.bindings ?? {}))
      if (!roots.has(key)) throw new TypeError('saved bindings have no current source');
    for (const [digest, content] of contents)
      if (roots.has(digest)) verifyEdges(content, snapshot.closure?.bindings[digest] ?? {});
    for (const root of snapshot.recipeRoots ?? [])
      if (!recipes.has(root)) throw new TypeError('saved root recipe unavailable');
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new TypeError('saved dependency recipe cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const child of Object.values(recipes.get(id)?.dependencies ?? {})) visit(child);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of recipes.keys()) visit(id);
    const resolve = async (
      guid: string,
      digest: string,
      recipeId: string,
      ancestors = new Set<string>(),
    ): Promise<RuntimePackPinnedAsset> => {
      signal?.throwIfAborted();
      const selected = recipes.get(recipeId);
      if (!selected || selected.outputs.find((output) => output.guid === guid)?.digest !== digest)
        throw new TypeError(`saved dependency source missing ${guid}@${digest}`);
      if (ancestors.has(recipeId)) throw new TypeError('saved dependency recipe cycle');
      let pending = completed.get(recipeId);
      if (!pending) {
        const chain = new Set(ancestors).add(recipeId);
        pending = (async () => {
          const dependencies = new Map<string, RuntimePackPinnedAsset>();
          for (const [guid, digest] of Object.entries(versions(selected)))
            dependencies.set(
              guid,
              await resolve(guid, digest, selected.dependencies[guid] ?? '', chain),
            );
          const content = 'content' in selected ? contents.get(selected.content) : undefined;
          const result =
            'fixed' in selected
              ? await this.rebuildFixed(selected.fixed, dependencies, signal)
              : content
                ? await this.rebuildRecipe(content, dependencies, selected.instance, signal)
                : (() => {
                    throw new TypeError('missing saved content');
                  })();
          const actual = result.get(guid)?.recipe?.outputs;
          assertOutputSet(actual ?? [], selected.outputs);
          return result;
        })();
        completed.set(recipeId, pending);
      }
      const value = (await pending).get(guid);
      signal?.throwIfAborted();
      if (!value || value.digest !== digest)
        throw new TypeError(`restored dependency unavailable ${guid}`);
      return {
        ...value,
        asset: structuredClone(
          typeof value.asset === 'function' ? await value.asset() : value.asset,
        ),
      };
    };
    return {
      dependency: async (content: RuntimePackContent, guid: string, digest: string) =>
        resolve(
          guid,
          digest,
          snapshot.closure?.bindings[await fingerprintAsync(content)]?.[guid] ?? '',
        ),
      root: async (id: string): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>> => {
        signal?.throwIfAborted();
        const first = recipes.get(id)?.outputs[0];
        if (!first) throw new TypeError(`saved root recipe missing ${id}`);
        await resolve(first.guid, first.digest, id);
        const result = completed.get(id);
        if (!result) throw new TypeError(`saved root recipe not rebuilt ${id}`);
        return result;
      },
    };
  }
  private async restoreCurrent(
    snapshot: RuntimePackSnapshot,
    recovery: Awaited<ReturnType<RuntimePackProducer['restoreDependencyResolver']>>,
    signal?: AbortSignal,
  ): Promise<Result<void, RuntimePackError>> {
    const plans = new Map<
      string,
      {
        content: RuntimePackContent;
        dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
        identity: string;
      }
    >();
    const savedInstances = new Map<string, PackInstanceJson>();
    const pending: {
      content: RuntimePackContent;
      dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
      instance?: PackInstanceJson;
    }[] = [];
    const scheduled = new Set<string>();
    const expectedOutputs = new Map<string, readonly AssetPublicationOutput[]>();
    const fixedPlans = new Map<
      string,
      Extract<RuntimePackRecipe, { fixed: FixedPackPublication }>
    >();
    const includeRecipe = (recipe: RuntimePackRecipe): void => {
      if ('fixed' in recipe) {
        const key = fingerprint(recipe.fixed);
        if (fixedPlans.has(key)) return;
        for (const output of recipe.outputs) {
          const row = this.currentRow(output.guid);
          if (
            row &&
            (row.publication?.generation !== recipe.fixed.pack.generation ||
              row.publication?.digest !== recipe.fixed.pack.digest ||
              row.publication?.outputSetDigest !== recipe.fixed.pack.outputSetDigest)
          )
            throw new TypeError(`fixed restore conflicts with current publication ${output.guid}`);
        }
        fixedPlans.set(key, recipe);
        const existing = recipe.outputs.filter((output) => this.currentRow(output.guid));
        if (existing.length && existing.length !== recipe.outputs.length)
          throw new TypeError('partial fixed publication already exists');
        for (const pin of collectRuntimePackDependencies(
          recipe.dependencies,
          recipe.dependencies.keys(),
        ).values()) {
          if (!pin.recipe) throw new TypeError('fixed reference lacks recovery recipe');
          const current = this.currentRow(pin.row.guid);
          if (current && !matchesPinnedPublication(current, pin))
            throw new TypeError(
              `fixed reference conflicts with current publication ${pin.row.guid}`,
            );
          if (!current || 'fixed' in pin.recipe) includeRecipe(pin.recipe);
        }
      } else include(recipe.content, recipe.dependencies, recipe.instance, recipe.outputs);
    };
    const include = (
      content: RuntimePackContent,
      dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
      instance?: PackInstanceJson,
      outputs?: readonly AssetPublicationOutput[],
    ) => {
      const id = content.source.packageId;
      if (outputs) {
        const outputId = instance?.packageId ?? id;
        const previous = expectedOutputs.get(outputId);
        if (previous) assertOutputSet(outputs, previous);
        expectedOutputs.set(outputId, outputs);
      }
      const identity = fingerprint(saveRuntimePackSnapshot([{ content, dependencies }], []));
      const admitted = this.packs.get(id);
      if (admitted && fingerprint(saveRuntimePackSnapshot([admitted], [])) !== identity)
        throw new TypeError(`restore source bindings conflict with admitted content ${id}`);
      const prior = plans.get(id);
      if (prior && prior.identity !== identity)
        throw new TypeError(`restore requires conflicting source versions ${id}`);
      if (!prior) plans.set(id, { content, dependencies, identity });
      if (instance) {
        const previous = savedInstances.get(instance.packageId);
        if (previous && fingerprint(previous) !== fingerprint(instance))
          throw new TypeError(
            `restore requires conflicting instance versions ${instance.packageId}`,
          );
        savedInstances.set(instance.packageId, instance);
      }
      const run = fingerprint({ identity, instance: instance ?? null });
      if (!scheduled.has(run)) {
        scheduled.add(run);
        pending.push({ content, dependencies, ...(instance ? { instance } : {}) });
      }
    };
    for (const content of snapshot.packs) {
      signal?.throwIfAborted();
      const dependencies = await this.readDependencies(
        content.dependencies ?? {},
        snapshot.closure ? (guid, digest) => recovery.dependency(content, guid, digest) : undefined,
        signal,
      );
      include(content, dependencies);
    }
    for (const instance of snapshot.instances) {
      const owner = plans.get(instance.parent) ?? this.packs.get(instance.parent);
      if (!owner) throw new TypeError(`saved instance has no source ${instance.packageId}`);
      include(owner.content, owner.dependencies, instance);
    }
    for (const id of snapshot.recipeRoots ?? []) {
      const pins = await recovery.root(id);
      const recipe = pins.values().next().value?.recipe;
      if (!recipe) throw new TypeError(`saved root has no reconstructed recipe ${id}`);
      includeRecipe(recipe);
    }
    // Discover the actual retained-reference closure from private rebuilt outputs.
    // Content-only inputs never become public merely because they are needed to rebuild.
    for (const plan of pending) {
      const outputs = await this.rebuildRecipe(
        plan.content,
        plan.dependencies,
        plan.instance,
        signal,
      );
      const outputId = plan.instance?.packageId ?? plan.content.source.packageId;
      const actual = [...outputs.values()].flatMap(
        (pin) => pin.recipe?.outputs.filter((output) => output.guid === pin.row.guid) ?? [],
      );
      const expected = expectedOutputs.get(outputId);
      if (expected) assertOutputSet(actual, expected);
      expectedOutputs.set(outputId, actual);
      const own = new Set(outputs.keys());
      const closure = collectRuntimePackDependencies(outputs, outputs.keys());
      const visited = new Set<string>();
      const reference = (guid: string) => {
        if (own.has(guid) || visited.has(guid)) return;
        visited.add(guid);
        const pin = closure.get(guid);
        if (!pin?.recipe) throw new TypeError(`saved reference has no producer source ${guid}`);
        const row = this.currentRow(guid);
        const actual = row?.publication?.outputs.find((output) => output.guid === guid)?.digest;
        if (row && !matchesPinnedPublication(row, pin))
          throw new TypeError(`restore reference conflicts with current version ${guid}`);
        if (actual === undefined) includeRecipe(pin.recipe);
        const output = pin.recipe.outputs.find((output) => output.guid === guid);
        if (!output) throw new TypeError(`saved reference has no output evidence ${guid}`);
        for (const ref of output.refs) reference(ref);
      };
      for (const pin of outputs.values()) {
        const output = pin.recipe?.outputs.find((output) => output.guid === pin.row.guid);
        if (!output) throw new TypeError(`missing rebuilt output ${pin.row.guid}`);
        for (const ref of output.refs) reference(ref);
      }
    }
    const packs = [...plans.values()];
    const instances = [...savedInstances.values()];
    const fixed = [...fixedPlans.values()];
    while (packs.length || instances.length || fixed.length) {
      if (signal?.aborted) return err(failure('runtime-pack-cancelled', '', 'request cancelled'));
      let progress = false;
      let last: RuntimePackError | undefined;
      for (const recipe of [...fixed]) {
        try {
          for (const output of recipe.outputs) {
            const current = this.currentRow(output.guid);
            const row = recipe.fixed.rows.find((row) => row.guid === output.guid);
            if (
              !row ||
              (current &&
                !matchesPinnedPublication(current, {
                  row,
                  digest: output.digest,
                  generation: recipe.fixed.pack.generation,
                }))
            )
              throw new TypeError(`fixed restore version changed ${output.guid}`);
          }
          const existing = recipe.outputs.filter((output) => this.currentRow(output.guid));
          if (existing.length && existing.length !== recipe.outputs.length)
            throw new TypeError('partial fixed publication already exists');
          if (!existing.length) {
            const candidate = await this.fixedCandidate(recipe.fixed, recipe.dependencies);
            signal?.throwIfAborted();
            this.commit(candidate, undefined, recipe);
          }
          fixed.splice(fixed.indexOf(recipe), 1);
          progress = true;
        } catch (cause) {
          if (signal?.aborted) return err(failure('runtime-pack-cancelled', '', cause));
          last = failure('runtime-pack-dependency-unavailable', '', cause);
        }
      }
      for (const plan of [...packs]) {
        const result = await this.admitContent(
          plan.content,
          async (guid, digest) => {
            const pin = plan.dependencies.get(guid);
            if (!pin || pin.digest !== digest)
              throw new TypeError(`saved dependency unavailable ${guid}`);
            return pin;
          },
          expectedOutputs.get(plan.content.source.packageId),
          signal,
        );
        if (!result.ok) {
          last = result.error;
          continue;
        }
        packs.splice(packs.indexOf(plan), 1);
        progress = true;
      }
      for (const instance of [...instances]) {
        const result = await this.generateInstance(
          instance,
          signal,
          expectedOutputs.get(instance.packageId),
        );
        if (!result.ok) {
          last = result.error;
          continue;
        }
        instances.splice(instances.indexOf(instance), 1);
        progress = true;
      }
      if (!progress)
        return err(last ?? failure('runtime-pack-invalid', '', 'restore made no progress'));
    }
    return ok(undefined);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.admissions.values()) controller.abort();
    const failures: unknown[] = [];
    for (const id of [...this.published.keys()]) {
      try {
        this.withdraw(id);
      } catch (cause) {
        failures.push(cause);
      }
    }
    this.listeners.clear();
    this.bodies.clear();
    this.published.clear();
    this.snapshots.clear();
    this.packs.clear();
    this.programs.clear();
    this.loadedPrograms.clear();
    this.admissions.clear();
    if (failures.length)
      throw new AggregateError(failures, 'Runtime Pack publication cleanup failed');
  }
}
