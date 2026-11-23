import { isStandaloneStaticMesh, withMeshAabb } from '@forgeax/engine-geometry';
import {
  copyPackData,
  copyPackOutputData,
  createPackageResponse,
  createRuntimePackPublication,
  decodePackBlob,
  encodePackData,
  type FixedPackPublication,
  fixedPublicationDependencies,
  loadPackProgram,
  matchesFixedDependency,
  type PackBinary,
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
  executePackBuild,
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
  type ScriptablePackRuntime,
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
  type CatalogRevisionPoint,
  encodeBase64,
  err,
  ImportError,
  type ImportedArtifactBody,
  type MeshAsset,
  ok,
  type PackageFetcher,
  type PluginBuildTarget,
  type Result,
  type TaskContext,
  type TaskExecutor,
  type TaskHandle,
  type TaskModule,
  taskAbortError,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { projectImportedAssetPayload } from './import-product.js';
import { normaliseForPack } from './import-runner.js';
import { producePluginAsset } from './plugin-asset-output.js';
import { type RuntimePackCacheStore, RuntimePackPersistentCache } from './runtime-pack-cache.js';
import {
  runtimeGeneratorDefinition as generatorDefinition,
  parseRuntimePackContent,
  parseRuntimePackInstance,
  parseRuntimePackSnapshot,
} from './runtime-pack-content.js';
import {
  collectRuntimePackDependencies,
  matchesRuntimePackPin as matchesPinnedPublication,
  type RuntimePackPinnedAsset,
  type RuntimePackRecipe,
  type RuntimePackSavedRecipe,
  savedRecipeOutputs,
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

export type { RuntimePackCacheStore } from './runtime-pack-cache.js';
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
  readonly schemaVersion: 'runtime-pack-source/2' | 'runtime-pack-source/3';
  readonly binary?: PackBinary;
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

class RuntimePackCommitInterrupted extends Error {}

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
  /** Executes portable generators in the realm's existing Task Worker pool. */
  readonly tasks?: TaskExecutor;
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
  /** The consumer may need to refresh its private preparation after a Catalog change. */
  readonly isPreparationCurrent?: (publication: RuntimePackPublicationState) => boolean;
  /** The realm owner updates its existing program projection before Catalog notification. */
  readonly onCommit?: (publication: RuntimePackPublicationState) => void;
  readonly cache?: Map<string, RuntimePackCacheEntry> | RuntimePackCacheStore;
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
      child instanceof Uint8Array ? encodeBase64(child) : child,
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
interface RuntimePackAcceptedPublication {
  readonly state: RuntimePackPublicationState;
  readonly bodies: ReadonlyMap<string, RuntimeBody>;
}

interface RuntimePackCandidate extends RuntimePackAcceptedPublication {
  readonly decoded: ReadonlyMap<string, Asset | (() => Promise<Asset>)>;
}

interface RuntimePackCommittedOutput {
  readonly owner: string;
  readonly row: CatalogEntry;
  pin?: RuntimePackPinnedAsset;
}

interface RuntimePackAdmittedSource {
  readonly content: RuntimePackContent;
  readonly digest: string;
  readonly dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
}

interface RuntimePackRebuild {
  readonly candidate: RuntimePackCandidate;
  readonly outputs: ReadonlyMap<string, RuntimePackPinnedAsset>;
}

type RuntimePackFixedRecipe = Extract<RuntimePackRecipe, { fixed: FixedPackPublication }>;

interface RuntimePackRestoreSource {
  content: RuntimePackContent;
  dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
  identity: string;
  admitted?: RuntimePackAdmittedSource;
}

interface RuntimePackRestoreBuild {
  source: RuntimePackRestoreSource;
  instance?: PackInstanceJson | undefined;
  outputs?: readonly AssetPublicationOutput[] | undefined;
  candidate?: RuntimePackCandidate | undefined;
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
function externalReferenceRoots(assets: readonly Pick<AssetPublicationOutput, 'guid' | 'refs'>[]) {
  const own = new Set(assets.map((asset) => asset.guid));
  return new Set(assets.flatMap((asset) => asset.refs).filter((guid) => !own.has(guid)));
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

function stageRuntimeArtifactBody(
  artifact: ImportedArtifactBody,
  adoptMeshBody: boolean,
): Uint8Array<ArrayBuffer> {
  const body = artifact.bytes;
  const backing = body.buffer;
  // The built-in Mesh encoder creates a private body from the isolated output.
  return adoptMeshBody &&
    artifact.assetCodec?.name === 'mesh-binary' &&
    backing instanceof ArrayBuffer
    ? new Uint8Array(backing, body.byteOffset, body.byteLength)
    : new Uint8Array(body);
}

/** Assemble an already produced output using the caller's byte ownership and hash policy. */
export async function stageRuntimePackOutput(
  asset: Pick<DirectPackJson['assets'][string], 'kind' | 'payload' | 'refs'> & {
    readonly guid: string;
    readonly artifacts?: Readonly<Record<string, ImportedArtifactBody>>;
  },
  blobs: Record<string, PackBlob>,
  adoptMeshBody = false,
  hash: (bytes: Uint8Array<ArrayBuffer>) => string | Promise<string> = bytesDigest,
): Promise<DirectPackJson['assets'][string]> {
  const artifacts: Record<string, Record<string, unknown>> = {};
  for (const [key, artifact] of Object.entries(asset.artifacts ?? {})) {
    const path = `${asset.guid}/${key}`;
    const bytes = stageRuntimeArtifactBody(artifact, adoptMeshBody);
    const digest = hash(bytes);
    blobs[path] = bytes;
    artifacts[key] = {
      path,
      mediaType: artifact.mediaType,
      byteLength: bytes.byteLength,
      contentEncoding: 'identity',
      integrity: {
        algorithm: 'sha256',
        digest: typeof digest === 'string' ? digest : await digest,
      },
      ...(artifact.assetCodec ? { assetCodec: artifact.assetCodec } : {}),
    };
  }
  return {
    kind: asset.kind,
    payload: asset.payload,
    ...(asset.refs === undefined ? {} : { refs: asset.refs }),
    artifacts,
  };
}

export function assembleRuntimePackContent(
  packageId: string,
  assets: DirectPackJson['assets'],
  blobs: Record<string, PackBlob>,
  options: Pick<RuntimePackContent, 'programs' | 'dependencies'> = {},
): RuntimePackContent {
  const source = { schemaVersion: '3.0.0' as const, packageId, assets };
  parsePackSourceJson(source).unwrap();
  return { source, blobs, ...options };
}

function usesRuntimeMeshBody(asset: unknown): asset is MeshAsset {
  return (
    asset !== null &&
    typeof asset === 'object' &&
    'kind' in asset &&
    asset.kind === 'mesh' &&
    isStandaloneStaticMesh(asset as MeshAsset)
  );
}

async function contentFromOutputs(
  packageId: string,
  submitted: PackOutputMap,
  programs?: RuntimePackContent['programs'],
  sceneComponents?: readonly ScriptablePackSceneComponentInput[],
  cookStaticMeshes = false,
): Promise<RuntimePackContent> {
  // Take the entire output graph before the first producer can yield.
  const owned = cookStaticMeshes
    ? copyPackOutputData(submitted, usesRuntimeMeshBody)
    : (copyPackData(submitted) as PackOutputMap);
  const producers = runtimeOutputProducers(programs, sceneComponents, cookStaticMeshes);
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
    assets[sourceKey] = await stageRuntimePackOutput(
      {
        guid,
        kind: asset.kind,
        payload:
          asset.kind === 'plugin' && 'module' in asset
            ? (asset as unknown as Record<string, unknown>)
            : projectImportedAssetPayload({ ...product, kind: asset.kind, guid }),
        ...(asset.kind === 'plugin' ? {} : { refs: product.refs.map((ref) => ref.guid) }),
        artifacts: product.artifacts,
      },
      blobs,
      cookStaticMeshes && asset.kind === 'mesh',
    );
  }
  return assembleRuntimePackContent(packageId, assets, blobs, programs ? { programs } : {});
}

const RUNTIME_PACK_BUILD_TASK = 'runtime-pack.build';

interface RuntimePackBuildSource {
  readonly packageId: string;
  readonly source: RuntimeScriptablePackSource;
  readonly values: NonNullable<Parameters<typeof executePackBuild>[1]['values']>;
  readonly programs: NonNullable<RuntimePackContent['programs']>;
}

interface RuntimePackBuildInput extends RuntimePackBuildSource {
  readonly imports?: RuntimePackProducerOptions['imports'];
  readonly moduleUrl?: string;
  readonly dependencies: ReadonlyMap<string, Asset>;
}

function runtimeBuildPlacement(
  runtime: ScriptablePackRuntime | undefined,
  tasks: TaskExecutor | undefined,
) {
  const authored = runtime?.outputs !== undefined;
  const required = runtime?.execution === 'task-worker';
  const available = tasks !== undefined && (!('mode' in tasks) || tasks.mode !== 'inline');
  return {
    workerBuild: required || (authored && available),
    cookStaticMeshes: required || authored,
  };
}

function runtimeGeneratorValues(
  metadata: ReturnType<typeof generatorDefinition>,
  values: PackInstanceJson['values'],
): RuntimePackBuildSource['values'] {
  if ('parameters' in metadata) return resolvePackParameterValues(metadata, values).unwrap();
  if (metadata.runtime?.outputs !== undefined && Object.keys(values).length === 0) return {};
  throw new TypeError(
    'instances require parameter capability or declared runtime outputs without values',
  );
}

async function buildRuntimeContent(
  input: RuntimePackBuildSource,
  build: unknown,
  readPinned: (guid: string) => Promise<Asset | undefined>,
  task?: TaskContext,
): Promise<RuntimePackContent> {
  let dependencyFault: AssetError | undefined;
  const definition = generatorDefinition(input.source, build);
  const built = await executePackBuild(
    definition,
    {
      packageId: definePackageId(input.packageId),
      ...('parameters' in definition ? { values: input.values } : {}),
      ...(task === undefined ? {} : { task }),
      async readByGuid<TAsset = Asset>(guid: import('@forgeax/engine-types').AssetGuid) {
        const asset = await readPinned(AssetGuid.format(guid));
        if (asset !== undefined) return ok(structuredClone(asset) as TAsset);
        dependencyFault = new AssetError({
          code: 'asset-not-found',
          expected: 'an explicitly declared, pinned dependency',
          hint: 'add every parameter branch dependency to runtime.dependencies before admission',
        });
        return err(dependencyFault);
      },
    },
    'runtime',
  );
  if (task?.aborted) throw taskAbortError();
  if (!built || typeof built.ok !== 'boolean')
    throw new TypeError('Pack build must return a Result');
  if (!built.ok) throw built.error;
  if (dependencyFault !== undefined) throw dependencyFault;
  return contentFromOutputs(
    input.packageId,
    built.value,
    input.programs,
    input.source.sceneComponents,
    task !== undefined || input.source.runtime?.outputs !== undefined,
  );
}

/** Collect buffers only from the privately captured, validated Pack output graph. */
function outputTransfers(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const visit = (part: unknown): void => {
    if (typeof part !== 'object' || part === null || seen.has(part)) return;
    seen.add(part);
    if (ArrayBuffer.isView(part)) {
      if (part.buffer instanceof ArrayBuffer) buffers.add(part.buffer);
      return;
    }
    for (const child of Object.values(part)) visit(child);
  };
  visit(value);
  return [...buffers];
}

const runtimePackBuildTask: TaskModule<RuntimePackBuildInput, RuntimePackContent> = {
  async run(input, context) {
    const program = input.programs[input.source.program]?.artifact;
    if (program === undefined) throw new TypeError('missing generator program');
    // A native URL is issued by the host for the verified closure. Import that
    // URL here so evaluating the generator never runs its top level in Engine.
    const build =
      input.moduleUrl === undefined
        ? (await loadPackProgram(program, input.imports)).unwrap()
        : (await import(/* @vite-ignore */ input.moduleUrl))[program.export];
    if (context.aborted) throw taskAbortError();
    const content = await buildRuntimeContent(
      input,
      build,
      async (guid) => input.dependencies.get(guid),
      context,
    );
    if (context.aborted) throw taskAbortError();
    return { value: content, transfer: outputTransfers(content) };
  },
};

/** App composes this registration into both ends of the existing Task Worker pool. */
export const runtimePackTaskKinds = {
  [RUNTIME_PACK_BUILD_TASK]: {
    load: () => runtimePackBuildTask,
    workerOnly: true,
    maxInFlight: 1,
  },
};

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
  cookStaticMeshes = false,
) {
  const outputs = createAssetOutputProducerRegistry(
    projectScriptablePackSceneComponents(sceneComponents),
  );
  outputs.register(
    cookStaticMeshes
      ? {
          kind: 'mesh',
          version: `${meshAssetOutputProducer.version}+${meshAssetDataProducer.version}`,
          produce(input) {
            const producer = usesRuntimeMeshBody(input.asset)
              ? meshAssetOutputProducer
              : meshAssetDataProducer;
            return producer.produce(input);
          },
        }
      : meshAssetDataProducer,
  );
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
      return producePluginAsset(input, () => ({ program }));
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
  private readonly packs = new Map<string, RuntimePackAdmittedSource>();
  private readonly published = new Map<string, RuntimePackAcceptedPublication>();
  private readonly executions = new Map<string, RuntimePackExecution>();
  private readonly listeners = new Set<(delta: CatalogDelta) => void>();
  private readonly packageUrls = new Map<string, RuntimePackAcceptedPublication>();
  private readonly programs = new Map<string, RuntimePackProgram>();
  private readonly loadedPrograms = new Map<string, ReturnType<typeof loadPackProgram>>();
  private readonly workerBuilds = new Map<string, TaskHandle<RuntimePackContent>>();
  private readonly committedOutputs = new Map<string, RuntimePackCommittedOutput>();
  private readonly admissions = new Map<string, AbortController>();
  private readonly memoryCache?: Map<string, RuntimePackCacheEntry>;
  private readonly persistentCache?: RuntimePackPersistentCache;
  private closed = false;
  private mutationRevision = 0;
  private request = 0;
  private readonly catalogRoot = PackageId.format(PackageId.random());
  private catalogRevision = 0;
  readonly catalog;
  readonly fetch: PackageFetcher = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    let body: RuntimeBody | undefined;
    for (const { bodies } of this.packageUrls.values()) {
      body = bodies.get(input);
      if (body !== undefined) break;
    }
    return body === undefined
      ? createPackageResponse(new Uint8Array(), { status: 404 })
      : createPackageResponse(await bodyBytes(body), {
          mediaType: body.mediaType,
        });
  };
  constructor(private readonly options: RuntimePackProducerOptions) {
    if (!options.scopeId)
      throw new TypeError('Runtime Pack producer requires the active scope identity');
    if (options.cache instanceof Map) this.memoryCache = options.cache;
    else if (options.cache) this.persistentCache = new RuntimePackPersistentCache(options.cache);
    this.catalog = {
      expectedScope: { scopeId: this.options.scopeId, generation: 0 },
      openPackage: (packageUrl: string): PackageFetcher | undefined => {
        const bodies = this.packageUrls.get(packageUrl)?.bodies;
        return bodies === undefined ? undefined : bodyFetcher(bodies);
      },
      retainArtifact: (packageUrl: string, path: string): PackageFetcher | undefined => {
        const url = new URL(path, packageUrl).href;
        const body = this.packageUrls.get(packageUrl)?.bodies?.get(url);
        return body === undefined ? undefined : bodyFetcher(new Map([[url, body]]));
      },
      enumerate: async (): Promise<
        Result<readonly CatalogEntry[], AssetError> & {
          readonly revisions: readonly CatalogRevisionPoint[];
        }
      > =>
        Object.assign(ok(this.rows()), {
          revisions: [{ rootId: this.catalogRoot, revision: this.catalogRevision }],
        }),
      subscribe: (listener: (delta: CatalogDelta) => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
    };
  }
  rows(): readonly CatalogEntry[] {
    // Keep each Pack's shared publication table shared in the detached snapshot.
    return structuredClone([...this.published.values()].flatMap(({ state }) => state.rows));
  }
  /** Read only the matching committed row, detached from producer-owned state. */
  catalogRow(guid: string): CatalogEntry | undefined {
    const row = this.committedOutputs.get(guid.toLowerCase())?.row;
    return row === undefined ? undefined : structuredClone(row);
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
    return encodePackData(
      saveRuntimePackSnapshot(
        [...this.packs.values()],
        [...this.executions.values()].flatMap((value) =>
          value.status !== 'withdrawn' && value.lastKnownGood
            ? [{ ...value.instance, values: value.lastKnownGood.values }]
            : [],
        ),
        [
          ...new Set(
            [...this.committedOutputs.values()].flatMap(({ pin }) =>
              pin?.recipe && ('fixed' in pin.recipe || pin.recipe.instance !== undefined)
                ? [pin.recipe]
                : [],
            ),
          ),
        ],
      ),
    );
  }
  private currentPublication(id: string): RuntimePackPublicationReceipt {
    const state = this.published.get(id)?.state;
    if (!state) throw new TypeError(`admitted Pack has no publication ${id}`);
    return publicationReceipt(state);
  }
  private currentRow(guid: string): CatalogEntry | undefined {
    return (
      this.committedOutputs.get(guid.toLowerCase())?.row ??
      this.options.assetSource?.currentRow?.(guid)
    );
  }
  async exportSource(versions: ReadonlyMap<string, string>): Promise<RuntimePackSnapshot> {
    const recipes = new Set<RuntimePackRecipe>();
    for (const [guid, digest] of versions) {
      const pin = this.committedOutputs.get(guid.toLowerCase())?.pin;
      if (pin?.digest !== digest || !pin.recipe)
        throw new TypeError(`source version unavailable ${guid}@${digest}`);
      recipes.add(pin.recipe);
    }
    return encodePackData(saveRuntimePackSnapshot([], [], [...recipes]));
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
      let pin = this.committedOutputs.get(guid.toLowerCase())?.pin;
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
      for (const output of savedRecipeOutputs(saved.closure?.recipes[root])) {
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
  ): Promise<RuntimePackRebuild> {
    signal?.throwIfAborted();
    const { onCommit: _commit, cache: _cache, assetSource: _source, ...options } = this.options;
    let current = new Map<string, CatalogEntry>();
    const privateProducer = new RuntimePackProducer({
      ...options,
      assetSource: { currentRow: (guid) => current.get(guid) },
      validate: (state, fetcher, pins) => {
        current = new Map([...pins].map(([guid, pin]) => [guid, pin.row]));
        return options.validate(state, fetcher, pins);
      },
    });
    try {
      (await privateProducer.admitContent(content, { dependencies }, undefined, signal)).unwrap();
      signal?.throwIfAborted();
      if (instance) (await privateProducer.generate(instance, signal)).unwrap();
      signal?.throwIfAborted();
      const accepted = privateProducer.published.get(
        instance?.packageId ?? content.source.packageId,
      );
      if (!accepted) throw new TypeError('private rebuild did not produce a candidate');
      const outputs = new Map<string, RuntimePackPinnedAsset>();
      for (const { pin } of privateProducer.committedOutputs.values())
        if (pin !== undefined) outputs.set(pin.row.guid, pin);
      const decoded = outputs.values().next().value?.recipe?.assets ?? new Map();
      return { candidate: { ...accepted, decoded }, outputs };
    } finally {
      privateProducer.dispose();
    }
  }

  private async candidate(
    content: RuntimePackContent,
    revision: string,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset> = new Map(),
    hash = createScriptablePackFingerprinter(),
  ): Promise<RuntimePackCandidate> {
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
          () => ({ program }),
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
        bytes: values instanceof Uint8Array ? values : decodePackBlob(values),
        mediaType: 'application/octet-stream',
      });
    }
    const pins = collectRuntimePackDependencies(
      dependencies,
      externalReferenceRoots(projected.assets),
    );
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
    return this.validateCandidate(
      { packageId, status: 'admitted', content, publication, rows },
      bodies,
      pins,
      async (input) => {
        const body = bodies.get(input);
        return body
          ? createPackageResponse(await bodyBytes(body), { mediaType: body.mediaType })
          : this.fetch(input);
      },
    );
  }

  private async validateCandidate(
    state: RuntimePackPublicationState,
    bodies: ReadonlyMap<string, RuntimeBody>,
    pins: ReadonlyMap<string, RuntimePackPinnedAsset>,
    fetcher = bodyFetcher(bodies),
  ) {
    const validated = await this.options.validate(
      state,
      fetcher,
      new Map([...pins].map(([guid, { row, asset }]) => [guid, { row, asset }])),
    );
    if (!validated.ok) throw validated.error;
    return { state, bodies, decoded: validated.value };
  }
  private refreshPreparation(
    candidate: RuntimePackCandidate,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
  ): RuntimePackCandidate | Promise<RuntimePackCandidate> {
    const { state, bodies } = candidate;
    const publication = state.publication?.publication;
    if (!publication || this.options.isPreparationCurrent?.(state) !== false) return candidate;
    // Authored sources declare root pins. Publication evidence also contains their
    // transitive references, which must be resolved through the retained recipes.
    const roots =
      'source' in state.content
        ? externalReferenceRoots(publication.outputs)
        : fixedPublicationDependencies(publication).keys();
    const pins = collectRuntimePackDependencies(dependencies, roots);
    return this.validateCandidate(state, bodies, pins);
  }

  private async fixedCandidate(
    fixed: FixedPackPublication,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
  ): Promise<RuntimePackCandidate> {
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
    const roots = fixedPublicationDependencies(original);
    const pins = collectRuntimePackDependencies(dependencies, roots.keys());
    for (const [guid, evidence] of roots) {
      const pin = pins.get(guid);
      if (!pin || !matchesFixedDependency(evidence, pin))
        throw new TypeError(`fixed dependency version differs ${guid}`);
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
    return this.validateCandidate(
      {
        ...(packageId ? { packageId } : {}),
        status: 'admitted',
        content: fixed,
        rows,
        publication: { pack, publication },
      },
      bodies,
      pins,
    );
  }
  private async rebuildFixed(
    fixed: FixedPackPublication,
    dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
    signal?: AbortSignal,
  ): Promise<RuntimePackRebuild> {
    signal?.throwIfAborted();
    const candidate = await this.fixedCandidate(fixed, dependencies);
    signal?.throwIfAborted();
    const recipe: RuntimePackRecipe = {
      fixed,
      dependencies,
      outputs: candidate.state.publication?.publication.outputs ?? [],
      assets: candidate.decoded,
    };
    const outputs = new Map(
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
    return { candidate, outputs };
  }
  private indexCommittedOutputs(
    key: string,
    { state, decoded }: RuntimePackCandidate,
    recipe?: RuntimePackRecipe,
  ): ReadonlyMap<string, RuntimePackCommittedOutput> {
    const next = new Map<string, RuntimePackCommittedOutput>();
    for (const row of state.rows) {
      const guid = row.guid.toLowerCase();
      const prior = this.committedOutputs.get(guid);
      if (prior !== undefined && prior.owner !== key)
        throw new TypeError(`GUID collision ${row.guid}`);
      next.set(guid, { owner: key, row });
    }
    if (decoded.size === 0) return next;
    const publication = state.publication;
    const digests = new Map(
      publication?.publication.outputs.map(({ guid, digest }) => [guid, digest]),
    );
    for (const [guid, asset] of decoded) {
      const entry = next.get(guid.toLowerCase());
      const digest = digests.get(guid);
      if (!publication || entry?.row.guid !== guid || digest === undefined)
        throw new TypeError(`missing output evidence ${guid}`);
      entry.pin = {
        asset: recipe?.assets.get(guid) ?? asset,
        digest,
        generation: publication.pack.generation,
        row: entry.row,
        ...(recipe === undefined ? {} : { recipe }),
      };
    }
    return next;
  }

  private commit(
    candidate: RuntimePackCandidate,
    install?: () => void,
    recipe?: RuntimePackRecipe,
  ): void {
    const { state, bodies } = candidate;
    if (this.closed && state.status !== 'withdrawn')
      throw new TypeError('runtime Pack producer is disposed');
    const key = publicationKey(state.content);
    const before = this.published.get(key)?.state;
    const validateCommitDependencyEvidence = () => {
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
          (evidence.generation !== undefined &&
            row?.publication?.generation !== evidence.generation)
        )
          throw new TypeError(`referenced dependency is not consumer-current ${evidence.guid}`);
      }
    };
    validateCommitDependencyEvidence();
    // Prepare all potentially failing clones and evidence before the first public mutation.
    const next = this.indexCommittedOutputs(key, candidate, recipe);
    const mutationRevision = this.mutationRevision;
    this.options.onCommit?.(state);
    // A synchronous realm callback may withdraw or dispose this prepared candidate.
    if (this.mutationRevision !== mutationRevision) {
      if (state.status === 'withdrawn') return;
      throw new RuntimePackCommitInterrupted('publication withdrawn or disposed during commit');
    }
    this.mutationRevision++;
    const oldUrl = before?.rows[0]?.packageUrl;
    if (oldUrl !== undefined) this.packageUrls.delete(oldUrl);
    if (state.status === 'withdrawn') this.published.delete(key);
    else {
      const accepted = { state, bodies };
      this.published.set(key, accepted);
      const url = state.rows[0]?.packageUrl;
      if (url !== undefined) this.packageUrls.set(url, accepted);
    }
    for (const row of before?.rows ?? []) this.committedOutputs.delete(row.guid.toLowerCase());
    for (const [guid, entry] of next) this.committedOutputs.set(guid, entry);
    install?.();
    const baselineRevision = this.catalogRevision++;
    const oldGuids = new Set(before?.rows.map((row) => row.guid));
    const newGuids = new Set(state.rows.map((row) => row.guid));
    const delta: CatalogDelta = {
      scopeId: this.options.scopeId,
      generation: 0,
      revisions: {
        baseline: [{ rootId: this.catalogRoot, revision: baselineRevision }],
        current: [{ rootId: this.catalogRoot, revision: this.catalogRevision }],
      },
      added: state.rows.filter((row) => !oldGuids.has(row.guid)),
      changed: state.rows.filter((row) => oldGuids.has(row.guid)),
      removed: [...oldGuids].filter((guid) => !newGuids.has(guid)),
    };
    for (const listener of this.listeners) {
      try {
        // Each listener owns its copy. Shared publication evidence is cloned once per delta.
        listener(structuredClone(delta));
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
  /** Atomically replace direct data after checking the caller's accepted publication. */
  async replace(
    input: RuntimePackContent,
    expected: Pick<AssetPublicationEnvelope, 'generation' | 'digest'>,
    signal?: AbortSignal,
  ): Promise<Result<RuntimePackPublicationReceipt, RuntimePackError>> {
    return this.admitContent(input, undefined, undefined, signal, expected);
  }
  private async admitContent(
    input: RuntimePackContent,
    recovery?: Pick<RuntimePackRestoreSource, 'dependencies' | 'admitted'>,
    prepared?: RuntimePackCandidate,
    signal?: AbortSignal,
    replacement?: Pick<AssetPublicationEnvelope, 'generation' | 'digest'>,
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
      const previousPublication = this.published.get(id)?.state.publication?.publication;
      if (
        replacement &&
        (!previous ||
          isGenerator(content.source) ||
          isGenerator(previous.content.source) ||
          previousPublication?.generation !== replacement.generation ||
          previousPublication.digest !== replacement.digest)
      )
        return err(
          failure(
            'runtime-pack-conflict',
            id,
            'replacement requires the exact current direct-data publication generation and digest',
          ),
        );
      if (previous && !recovery && !replacement)
        return previous.digest === digest
          ? ok(this.currentPublication(id))
          : err(failure('runtime-pack-conflict', id, 'same identity has different content'));
      if (this.executions.has(id))
        return err(failure('runtime-pack-conflict', id, 'identity belongs to an instance'));
      const validateAdmissionPrograms = () => {
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
            throw new TypeError(
              'generator requires runtime capability and a local program artifact',
            );
          const declared = [...source.runtime.dependencies].sort();
          if (
            JSON.stringify(declared) !==
            JSON.stringify(Object.keys(content.dependencies ?? {}).sort())
          )
            throw new TypeError('complete runtime dependency versions are required');
        }

        return undefined;
      };
      const validateAdmissionProgramsFailure = validateAdmissionPrograms();
      if (validateAdmissionProgramsFailure !== undefined) return validateAdmissionProgramsFailure;

      const dependencies =
        recovery?.dependencies ??
        (await this.readDependencies(content.dependencies ?? {}, undefined, signal));
      const matches = (value: RuntimePackAdmittedSource) =>
        value.digest === digest &&
        (!recovery ||
          fingerprint(saveRuntimePackSnapshot([value], [])) ===
            fingerprint(saveRuntimePackSnapshot([{ content, dependencies }], [])));
      const checkAdmission = (committing: boolean) => {
        if (this.closed || lifetime.signal.aborted || signal?.aborted)
          return err(
            failure(
              'runtime-pack-cancelled',
              id,
              committing
                ? 'admission withdrawn, disposed or cancelled'
                : 'admission cancelled during dependency recovery',
            ),
          );
        if (committing && this.executions.has(id))
          return err(failure('runtime-pack-conflict', id, 'concurrent instance claimed identity'));
        const admitted = this.packs.get(id);
        if (replacement && admitted !== previous)
          return err(
            failure(
              'runtime-pack-conflict',
              id,
              committing
                ? 'publication changed during replacement validation'
                : 'publication changed during replacement preparation',
            ),
          );
        if (!admitted || replacement) return undefined;
        if (matches(admitted)) {
          if (recovery) recovery.admitted = admitted;
          return ok(this.currentPublication(id));
        }
        return err(
          failure(
            'runtime-pack-conflict',
            id,
            committing
              ? 'concurrent admission differs'
              : 'saved source bindings conflict with admitted content',
          ),
        );
      };
      const preparedAdmission = checkAdmission(false);
      if (preparedAdmission !== undefined) return preparedAdmission;
      const candidate = prepared
        ? await this.refreshPreparation(prepared, dependencies)
        : await this.candidate(content, digest, dependencies, hash);
      const validateCandidateReferences = () => {
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
      };
      validateCandidateReferences();

      const committingAdmission = checkAdmission(true);
      if (committingAdmission !== undefined) return committingAdmission;
      for (const [name, program] of Object.entries(content.programs ?? {})) {
        const installed = this.programs.get(name);
        if (installed && fingerprint(installed) !== fingerprint(program))
          return err(failure('runtime-pack-conflict', id, `concurrent program ${name}`));
      }

      const reply = publicationReceipt(candidate.state);
      const admitted = { content, digest, dependencies };
      this.commit(
        candidate,
        () => {
          this.packs.set(id, admitted);
          if (recovery) recovery.admitted = admitted;
          for (const [name, program] of Object.entries(content.programs ?? {}))
            this.programs.set(name, program);
        },
        this.recipe(content, dependencies, candidate),
      );
      return ok(reply);
    } catch (cause) {
      return err(
        failure(
          signal?.aborted || cause instanceof RuntimePackCommitInterrupted
            ? 'runtime-pack-cancelled'
            : 'runtime-pack-invalid',
          id,
          cause,
        ),
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
    prepared?: { candidate: RuntimePackCandidate; owner: RuntimePackAdmittedSource },
  ): Promise<Result<RuntimePackPublicationReceipt, RuntimePackError>> {
    let id = '';
    const request = ++this.request;
    let instance: PackInstanceJson;
    let old: RuntimePackExecution | undefined;
    let requestCancelled: (() => boolean) | undefined;
    try {
      instance = parseRuntimePackInstance(input);
      id = instance.packageId;
      old = this.executions.get(id);
      if (this.packs.has(id))
        return err(failure('runtime-pack-conflict', id, 'identity belongs to an admitted Pack'));
      const owner = this.packs.get(instance.parent);
      if (!owner || !isGenerator(owner.content.source))
        throw new TypeError('parent must be an admitted ScriptablePack anchor');
      const beginInstanceGeneration = () => {
        if (prepared && prepared.owner !== owner)
          return err(
            failure('runtime-pack-conflict', id, 'instance parent changed during restore'),
          );
        if (old && old.instance.parent !== instance.parent)
          return err(failure('runtime-pack-conflict', id, 'instance parent cannot change'));
        this.workerBuilds.get(id)?.cancel();
        this.executions.set(id, {
          instance,
          request,
          status: 'pending',
          ...(old?.lastKnownGood === undefined ? {} : { lastKnownGood: old.lastKnownGood }),
        });

        return undefined;
      };
      const beginInstanceGenerationFailure = beginInstanceGeneration();
      if (beginInstanceGenerationFailure !== undefined) return beginInstanceGenerationFailure;

      const cancelled = () =>
        this.closed ||
        this.packs.get(instance.parent) !== owner ||
        signal?.aborted === true ||
        this.executions.get(id)?.request !== request;
      requestCancelled = cancelled;
      if (cancelled()) return this.cancelled(id, request, 'generation cancelled');
      const source = owner.content.source;
      const metadata = generatorDefinition(source, () => ok({}));
      const values = runtimeGeneratorValues(metadata, instance.values);
      const program = owner.content.programs?.[source.program]?.artifact;
      if (!program) throw new TypeError(`missing admitted generator program ${source.program}`);
      const { workerBuild, cookStaticMeshes } = runtimeBuildPlacement(
        metadata.runtime,
        this.options.tasks,
      );
      const outputs = runtimeOutputProducers(
        owner.content.programs,
        source.sceneComponents,
        cookStaticMeshes,
      );
      const key = fingerprint({
        sourceRevision: owner.digest,
        packageId: id,
        program: program.digest,
        values,
        dependencies: owner.content.dependencies ?? {},
        producers: outputs.versions(),
      });
      const declared = prepared === undefined ? source.runtime?.outputs : undefined;
      const cached =
        prepared === undefined
          ? await this.cachedGeneration(key, id, owner, declared, signal)
          : undefined;
      let candidate = prepared
        ? await this.refreshPreparation(prepared.candidate, owner.dependencies)
        : cached?.candidate;
      if (cancelled()) return this.cancelled(id, request, 'late cache lookup');
      let content = prepared
        ? (candidate?.state.content as RuntimePackContent | undefined)
        : cached?.content;
      if (!content) {
        const programs = owner.content.programs ?? {};
        const buildInput = { packageId: id, source, values, programs };
        const readPinned = async (guid: string): Promise<Asset | undefined> => {
          const asset = owner.dependencies.get(guid)?.asset;
          return typeof asset === 'function' ? await asset() : asset;
        };
        const assertCurrent = () => {
          if (cancelled()) throw taskAbortError('generation request is no longer current');
        };
        content = workerBuild
          ? await this.runWorkerBuild(buildInput, program, readPinned, assertCurrent, signal)
          : await this.runLocalBuild(buildInput, program, readPinned, assertCurrent);
        content = { ...content, dependencies: owner.content.dependencies ?? {} };
      }
      if (content.source.packageId !== id || isGenerator(content.source))
        throw new TypeError('cache does not belong to this instance');
      candidate ??= await this.candidate(content, key, owner.dependencies);
      if (cancelled()) return this.cancelled(id, request, 'late generation result');
      const accepted = candidate;
      const publication = accepted.state.publication;
      if (!publication) throw new TypeError(`missing generated publication ${id}`);
      const cachedContent =
        this.memoryCache && cached === undefined
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
      if (cachedContent) this.memoryCache?.set(key, cachedContent);
      if (!cached && declared) this.persistentCache?.write(key, content);
      return ok(reply);
    } catch (cause) {
      if (signal?.aborted || requestCancelled?.() || cause instanceof RuntimePackCommitInterrupted)
        return this.cancelled(
          id,
          request,
          cause instanceof Error ? cause.message : 'generation cancelled',
        );
      const error = failure('runtime-pack-execution-failed', id, cause);
      const current = this.executions.get(id);
      if (current?.request === request && current.status !== 'withdrawn')
        this.executions.set(id, { ...current, status: 'failed', error });
      return err(error);
    }
  }
  private async cachedGeneration(
    key: string,
    packageId: string,
    owner: {
      content: RuntimePackContent;
      dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>;
    },
    declared:
      | NonNullable<NonNullable<RuntimeScriptablePackSource['runtime']>['outputs']>
      | undefined,
    signal?: AbortSignal,
  ) {
    try {
      const entry = this.memoryCache?.get(key);
      let content: RuntimePackContent | undefined;
      if (entry) {
        content = parseRuntimePackContent(entry.content);
        if (
          entry.inputFingerprint !== key ||
          entry.digest !== (await fingerprintAsync(content)) ||
          content.source.packageId !== packageId ||
          fingerprint(content.programs ?? {}) !== fingerprint(owner.content.programs ?? {}) ||
          isGenerator(content.source)
        )
          throw new TypeError('invalid cache envelope');
      } else if (declared) {
        content = await this.persistentCache?.read(key, packageId, declared, owner.content, signal);
      }
      if (content && !signal?.aborted) {
        const candidate = await this.candidate(content, key, owner.dependencies);
        return { content, candidate };
      }
    } catch {
      this.memoryCache?.delete(key);
    }
    return undefined;
  }
  private async runLocalBuild(
    input: RuntimePackBuildSource,
    program: PackProgram,
    readPinned: (guid: string) => Promise<Asset | undefined>,
    assertCurrent: () => void,
  ): Promise<RuntimePackContent> {
    const moduleKey = `${packProgramModuleIdentity(program, this.options.imports).unwrap()}/${program.entry}#${program.export}`;
    let loading = this.loadedPrograms.get(moduleKey);
    if (!loading) {
      loading = loadPackProgram(program, this.options.imports, this.options.programHost);
      this.loadedPrograms.set(moduleKey, loading);
    }
    const loaded = await loading;
    if (!loaded.ok) this.loadedPrograms.delete(moduleKey);
    if (!loaded.ok) throw loaded.error;
    assertCurrent();
    return buildRuntimeContent(input, loaded.value, readPinned);
  }

  private async runWorkerBuild(
    input: RuntimePackBuildSource,
    program: PackProgram,
    readPinned: (guid: string) => Promise<Asset | undefined>,
    assertCurrent: () => void,
    signal?: AbortSignal,
  ): Promise<RuntimePackContent> {
    const { tasks, imports, programHost } = this.options;
    if (tasks === undefined) throw new Error('Runtime Pack generation requires a Task Worker');
    packProgramModuleIdentity(program, imports).unwrap();
    // Publication must not evaluate the program in this realm. Native package
    // hosts can supply a Worker-loadable locator separately from local loading.
    const moduleUrl = programHost?.publishForTask
      ? await programHost.publishForTask(program, imports ?? {})
      : programHost && !programHost.importModule
        ? await programHost.publish(program, imports ?? {})
        : undefined;
    const dependencies = new Map<string, Asset>();
    for (const guid of input.source.runtime?.dependencies ?? []) {
      assertCurrent();
      const asset = await readPinned(guid);
      if (asset === undefined) throw new TypeError(`missing pinned dependency ${guid}`);
      dependencies.set(guid, asset);
    }
    assertCurrent();
    const id = input.packageId;
    const build = tasks.submit<RuntimePackBuildInput, RuntimePackContent>(
      RUNTIME_PACK_BUILD_TASK,
      { ...input, imports, ...(moduleUrl === undefined ? {} : { moduleUrl }), dependencies },
      { priority: 'background', ...(signal === undefined ? {} : { signal }), debugName: id },
    );
    this.workerBuilds.set(id, build);
    try {
      return await build.result;
    } finally {
      if (this.workerBuilds.get(id) === build) this.workerBuilds.delete(id);
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
    candidate: RuntimePackCandidate,
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
    this.mutationRevision++;
    this.admissions.get(packageId)?.abort();
    this.admissions.delete(packageId);
    this.workerBuilds.get(packageId)?.cancel();
    this.workerBuilds.delete(packageId);
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
    const previous = this.published.get(packageId)?.state;
    if (!previous) return;
    const { publication: _publication, ...rest } = previous;
    this.commit({
      state: { ...rest, status: 'withdrawn', rows: [] },
      bodies: new Map(),
      decoded: new Map(),
    });
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
  private async restoreDependencyResolver(snapshot: RuntimePackSnapshot, signal?: AbortSignal) {
    const completed = new Map<string, Promise<ReadonlyMap<string, RuntimePackPinnedAsset>>>();
    const rootIds = new Set(snapshot.recipeRoots);
    // Only explicit publication roots carry full candidates out of graph recovery.
    const preparedRoots = new WeakMap<RuntimePackRecipe, RuntimePackCandidate>();
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
        if (
          !recipe ||
          savedRecipeOutputs(recipe).find((output) => output.guid === guid)?.digest !== digest
        )
          throw new TypeError(`saved dependency binding unavailable ${guid}@${digest}`);
      }
    };
    const versions = (recipe: RuntimePackSavedRecipe): Readonly<Record<string, string>> => {
      if ('content' in recipe) {
        const content = contents.get(recipe.content);
        if (!content) throw new TypeError('saved recipe content unavailable');
        return content.dependencies ?? {};
      }
      const publication = recipe.fixed.rows[0]?.publication;
      if (!publication) throw new TypeError('fixed publication missing');
      const refs = fixedPublicationDependencies(publication);
      if (refs.size !== Object.keys(recipe.dependencies).length)
        throw new TypeError('fixed dependency bindings differ from retained references');
      return Object.fromEntries(
        [...refs].map(([guid, evidence]) => {
          const target = recipes.get(recipe.dependencies[guid] ?? '');
          const output = savedRecipeOutputs(target).find((output) => output.guid === guid);
          if (!output || (evidence?.digest !== undefined && evidence.digest !== output.digest))
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
      if (
        !selected ||
        savedRecipeOutputs(selected).find((output) => output.guid === guid)?.digest !== digest
      )
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
          const recipe = result.outputs.get(guid)?.recipe;
          assertOutputSet(recipe?.outputs ?? [], savedRecipeOutputs(selected));
          if (recipe && rootIds.has(recipeId)) preparedRoots.set(recipe, result.candidate);
          return result.outputs;
        })();
        completed.set(recipeId, pending);
      }
      const value = (await pending).get(guid);
      signal?.throwIfAborted();
      if (!value || value.digest !== digest)
        throw new TypeError(`restored dependency unavailable ${guid}`);
      return value;
    };
    return {
      prepared: (recipe: RuntimePackRecipe) => preparedRoots.get(recipe),
      dependency: async (content: RuntimePackContent, guid: string, digest: string) =>
        resolve(
          guid,
          digest,
          snapshot.closure?.bindings[await fingerprintAsync(content)]?.[guid] ?? '',
        ),
      root: async (id: string): Promise<ReadonlyMap<string, RuntimePackPinnedAsset>> => {
        signal?.throwIfAborted();
        const first = savedRecipeOutputs(recipes.get(id))[0];
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
    const plans = new Map<string, RuntimePackRestoreSource>();
    const pending = new Map<string, RuntimePackRestoreBuild>();
    const fixedPlans = new Map<string, RuntimePackFixedRecipe>();
    const includeRecipe = (recipe: RuntimePackRecipe): void => {
      if ('fixed' in recipe) {
        const key = fingerprint(recipe.fixed);
        if (fixedPlans.has(key)) return;
        this.fixedRestoreExists(recipe);
        fixedPlans.set(key, recipe);
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
      } else {
        const plan = include(recipe.content, recipe.dependencies, recipe.instance, recipe.outputs);
        plan.candidate ??= recovery.prepared(recipe);
      }
    };
    const include = (
      content: RuntimePackContent,
      dependencies: ReadonlyMap<string, RuntimePackPinnedAsset>,
      instance?: PackInstanceJson,
      outputs?: readonly AssetPublicationOutput[],
    ) => {
      const id = content.source.packageId;
      const identity = fingerprint(saveRuntimePackSnapshot([{ content, dependencies }], []));
      const admitted = this.packs.get(id);
      if (admitted && fingerprint(saveRuntimePackSnapshot([admitted], [])) !== identity)
        throw new TypeError(`restore source bindings conflict with admitted content ${id}`);
      const prior = plans.get(id);
      if (pending.get(id)?.instance)
        throw new TypeError('restore instance overlaps an admitted Pack identity');
      if (prior && prior.identity !== identity)
        throw new TypeError(`restore requires conflicting source versions ${id}`);
      const source = prior ?? { content, dependencies, identity };
      if (!prior) plans.set(id, source);
      const outputId = instance?.packageId ?? id;
      const scheduled = pending.get(outputId);
      if (!scheduled) {
        const plan: RuntimePackRestoreBuild = { source, instance, outputs };
        pending.set(outputId, plan);
        return plan;
      }
      if (
        scheduled.source !== source ||
        fingerprint(scheduled.instance ?? null) !== fingerprint(instance ?? null)
      )
        throw new TypeError('restore requires conflicting publications');
      if (outputs) {
        if (scheduled.outputs) assertOutputSet(outputs, scheduled.outputs);
        scheduled.outputs = outputs;
      }
      return scheduled;
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
    // Follow only references in the produced assets. Historical inputs remain private.
    for (const [id, plan] of pending) {
      if (plan.instance && plans.has(id))
        throw new TypeError('restore instance overlaps an admitted Pack identity');
      const { content, dependencies } = plan.source;
      plan.candidate ??= (
        await this.rebuildRecipe(content, dependencies, plan.instance, signal)
      ).candidate;
      const outputs = plan.candidate.state.publication?.publication.outputs ?? [];
      if (plan.outputs) assertOutputSet(outputs, plan.outputs);
      plan.outputs = outputs;
      const roots = externalReferenceRoots(outputs);
      for (const [guid, pin] of collectRuntimePackDependencies(dependencies, roots)) {
        const current = this.currentRow(guid);
        if (current && !matchesPinnedPublication(current, pin))
          throw new TypeError(`restore reference conflicts with current version ${guid}`);
        if (!current && pin.recipe) includeRecipe(pin.recipe);
      }
    }
    return this.publishRestore(plans, pending, fixedPlans.values(), recovery.prepared, signal);
  }

  private fixedRestoreExists(recipe: RuntimePackFixedRecipe): boolean {
    let present = 0;
    for (const output of recipe.outputs) {
      const current = this.currentRow(output.guid);
      if (!current) continue;
      const row = recipe.fixed.rows.find((entry) => entry.guid === output.guid);
      if (
        !row ||
        !matchesPinnedPublication(current, {
          row,
          digest: output.digest,
          generation: recipe.fixed.pack.generation,
        })
      )
        throw new TypeError(`fixed restore version changed ${output.guid}`);
      present++;
    }
    if (present > 0 && present !== recipe.outputs.length)
      throw new TypeError('partial fixed publication already exists');
    return present > 0;
  }

  private async publishRestore(
    plans: ReadonlyMap<string, RuntimePackRestoreSource>,
    pending: Map<string, RuntimePackRestoreBuild>,
    fixedPlans: Iterable<RuntimePackFixedRecipe>,
    prepared: (recipe: RuntimePackRecipe) => RuntimePackCandidate | undefined,
    signal?: AbortSignal,
  ): Promise<Result<void, RuntimePackError>> {
    type Step = () => Promise<Result<unknown, RuntimePackError> | undefined>;
    const steps: Step[] = [
      ...[...fixedPlans].map((recipe) => async () => {
        try {
          if (this.fixedRestoreExists(recipe)) return ok(undefined);
          const previous = prepared(recipe);
          const candidate = previous
            ? await this.refreshPreparation(previous, recipe.dependencies)
            : await this.fixedCandidate(recipe.fixed, recipe.dependencies);
          signal?.throwIfAborted();
          this.commit(candidate, undefined, recipe);
          return ok(undefined);
        } catch (cause) {
          return err(
            failure(
              signal?.aborted ? 'runtime-pack-cancelled' : 'runtime-pack-dependency-unavailable',
              '',
              cause,
            ),
          );
        }
      }),
      ...[...plans.values()].map(
        (plan) => () =>
          this.admitContent(
            plan.content,
            plan,
            pending.get(plan.content.source.packageId)?.candidate,
            signal,
          ),
      ),
      ...[...pending.values()]
        .filter(({ instance }) => instance !== undefined)
        .map(({ instance, candidate }) => async () => {
          if (!instance || !candidate) throw new TypeError('missing prepared instance');
          const owner = plans.get(instance.parent)?.admitted;
          return owner === undefined
            ? undefined
            : this.generateInstance(instance, signal, { candidate, owner });
        }),
    ];
    const worklist = new Set(steps);
    while (worklist.size > 0) {
      const remaining = worklist.size;
      let last: RuntimePackError | undefined;
      for (const step of worklist) {
        if (signal?.aborted) return err(failure('runtime-pack-cancelled', '', 'request cancelled'));
        const result = await step();
        if (result?.ok) worklist.delete(step);
        else if (result?.error.code === 'runtime-pack-cancelled') return result;
        else if (result !== undefined) last = result.error;
      }
      if (worklist.size === remaining)
        return err(last ?? failure('runtime-pack-invalid', '', 'restore made no progress'));
    }
    return ok(undefined);
  }
  dispose(): void {
    if (this.closed) return;
    this.mutationRevision++;
    this.closed = true;
    this.persistentCache?.dispose();
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
    this.packageUrls.clear();
    this.published.clear();
    this.committedOutputs.clear();
    this.packs.clear();
    this.programs.clear();
    this.loadedPrograms.clear();
    this.admissions.clear();
    if (failures.length)
      throw new AggregateError(failures, 'Runtime Pack publication cleanup failed');
  }
}
