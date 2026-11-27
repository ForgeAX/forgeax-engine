import { createHash } from 'node:crypto';
import { availableParallelism, freemem } from 'node:os';
import { resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import {
  bindRuntimePackPublication,
  type CatalogBuildResult,
  catalogSourcePathFor,
  metaPathForGuid,
  type PackageFinalizePolicy,
  RUNTIME_PACK_SUFFIX,
} from '@forgeax/engine-pack/build';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { declaredRuntimePackGuids } from '@forgeax/engine-pack/scanner';
import { PackageId, projectDirectPackJson } from '@forgeax/engine-pack/source';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import type { CookReceipt, PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { ImportRunnerFs } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';
import { projectMaterialPackTransport } from './material-pack-transport.js';
import { packBuildConcurrency } from './pack-build-concurrency.js';
import {
  importSourceKeys,
  type PublishedImportRows,
  projectPackBuildCatalog,
  publishImportedCatalogRows,
} from './pack-projection.js';
import type { ScriptablePackBuildProduct } from './scriptable-pack-build.js';
import {
  canonicalScriptableSourcePath,
  createDeclaredPackAssetSnapshotSource,
  type DirectPackTransport,
  type PreparedScriptablePack,
  planScriptablePackInputs,
  prepareDirectPackTransport,
  produceScriptablePackProducts,
  projectPreparedPackPublication,
  type ScriptablePackInput,
  type ScriptablePackProductionOptions,
} from './scriptable-pack-host.js';
import { prepareImportedPackPublication, produceSourcePackage } from './source-package.js';
import {
  createSourcePackageBuildDdc,
  type SourcePackageBuildDdc,
} from './source-package-build-product.js';
import { sourceDeclarationForCatalogPath } from './source-path.js';

export interface BuildProductionFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly cause?: unknown;
}

export interface BuildProductionFile {
  readonly type: 'asset';
  readonly fileName?: string;
  readonly name?: string;
  readonly originalFileName?: string;
  readonly source: string | Uint8Array;
}

export interface BuildProductionSink {
  emitFile(file: BuildProductionFile): string;
  getFileName(referenceId: string): string;
  fileUrl(fileName: string): string;
}

export interface BuildProductionOptions
  extends Pick<PackageFinalizePolicy, 'materialProgramTransport'> {
  readonly inventory: CatalogBuildResult;
  readonly cwd: string;
  readonly basePrefix: string;
  readonly generation: number;
  readonly cookers: readonly NativeCooker[];
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly cookedCurrentProjection: Record<string, unknown>;
  readonly authoredCookedCurrentProjection: Record<string, unknown>;
  readonly runtimeBinding?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
  readonly sourceSnapshot?: ScriptablePackSourceSnapshot;
  readonly enginePackageRoot?: string;
  /** Reuse producer-verified immutable products; publication remains current-generation work. */
  readonly buildCacheRoot?: string;
  readonly buildCacheSeedRoot?: string;
  readonly producerIdentity?: string;
  readonly sink: BuildProductionSink;
  readonly fail: (failure: BuildProductionFailure) => Error;
}

function materialProgramTransport(
  context: Pick<BuildProductionOptions, 'materialProgramTransport'>,
): Pick<PackageFinalizePolicy, 'materialProgramTransport'> {
  const { materialProgramTransport } = context;
  return materialProgramTransport === undefined ? {} : { materialProgramTransport };
}

interface PackBuildBundle {
  readonly input: ScriptablePackInput;
  readonly prepared: PreparedScriptablePack;
  readonly entries: readonly PackIndexEntry[];
}

function dynamicFailure(context: BuildProductionOptions, value: unknown): never {
  const candidate = value !== null && typeof value === 'object' ? value : {};
  const error = candidate as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  throw context.fail({
    code: typeof error.code === 'string' ? error.code : 'pack-build-failed',
    expected:
      typeof error.expected === 'string'
        ? error.expected
        : 'the Pack source generation to produce a valid terminal result',
    hint:
      typeof error.hint === 'string'
        ? error.hint
        : 'inspect the Pack source subject and rebuild the current generation',
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

/** Build ScriptablePack roots and Pack JSON instances before normal emission. */
async function buildPackSources(context: BuildProductionOptions): Promise<PackBuildBundle[]> {
  // NativeCookerRegistry serializes calls to each serial cooker across Packs.
  // Independent Pack preparation can still use the host's available lanes.
  const maxConcurrency = packBuildConcurrency(
    {
      parallelism: availableParallelism(),
      freeBytes: process.availableMemory?.() ?? freemem(),
      heapHeadroomBytes: getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed,
    },
    process.env.FORGEAX_BUILD_CONCURRENCY,
  );
  if (process.env.FORGEAX_BUILD_PROGRESS === '1')
    process.stderr.write(`[forgeax.pack-build-budget] ${JSON.stringify({ maxConcurrency })}\n`);
  const executors = createScriptablePackModuleExecutorPool({
    maxWorkers: maxConcurrency,
    maxTasksPerWorker: 1,
  });
  const sourceSnapshot = context.sourceSnapshot ?? createScriptablePackSourceSnapshot();
  const programTransport = materialProgramTransport(context);
  try {
    const artifactPaths = new WeakMap<Uint8Array, string>();
    const artifactPath = (bytes: Uint8Array): string => {
      let path = artifactPaths.get(bytes);
      if (path === undefined) {
        path = `shared/${createHash('sha256').update(bytes).digest('hex')}.bin`;
        artifactPaths.set(bytes, path);
      }
      return path;
    };
    const policy = (packageId: PackageId) => (product: ScriptablePackBuildProduct) => {
      const paths = new Map(
        product.product.assets.flatMap((asset) =>
          Object.entries(asset.artifacts).map(
            ([key, artifact]) =>
              [`${asset.guid.toLowerCase()}/${key}`, artifactPath(artifact.bytes)] as const,
          ),
        ),
      );
      return {
        ...programTransport,
        base: context.basePrefix === '' ? '/' : context.basePrefix,
        packagePath: `assets/${PackageId.format(packageId)}${RUNTIME_PACK_SUFFIX}`,
        artifactPath: (guid: string, key: string) => {
          const path = paths.get(`${guid.toLowerCase()}/${key}`);
          if (path === undefined) throw new Error(`missing produced artifact: ${guid}/${key}`);
          return path;
        },
      };
    };
    const inputs = planScriptablePackInputs(
      context.inventory.sourceDeclarations,
      context.inventory.packInstances,
      {
        sourceSnapshot,
        executors,
        enginePackageRoot: context.enginePackageRoot,
        displayPath: (sourcePath) =>
          catalogSourcePathFor(context.cwd, sourcePath, context.fsForImport.sourceIdentityFor),
        generationFor: () => context.generation,
        policy,
        transportIdentity: (packageId) =>
          JSON.stringify([
            'shared-binary/1',
            RUNTIME_PACK_SUFFIX,
            context.materialProgramTransport ?? 'bytes',
            context.basePrefix || '/',
            PackageId.format(packageId),
          ]),
      },
    );
    if (inputs.length === 0) return [];

    const requiredGuids = context.inventory.entries.flatMap((entry) => {
      const parsed = AssetGuid.parse(entry.guid);
      if (!parsed.ok) dynamicFailure(context, parsed.error);
      return [parsed.value];
    });
    const assetSource = createDeclaredPackAssetSnapshotSource(
      context.inventory.sourceDeclarations,
      context.cookers,
      requiredGuids,
      {
        importerRegistry: context.importerRegistry,
        fsForImport: context.fsForImport,
      },
    );
    const availableGuids = new Set(
      requiredGuids.map((guid) => AssetGuid.format(guid).toLowerCase()),
    );
    const availableKinds = new Map(
      context.inventory.entries.map((entry) => [entry.guid.toLowerCase(), entry.kind] as const),
    );
    const built = await produceScriptablePackProducts({
      sources: inputs,
      assetSource,
      cookers: context.cookers,
      maxConcurrency,
      availableGuids,
      availableKinds,
      ...(process.env.FORGEAX_BUILD_PROGRESS === '1'
        ? {
            onProgress: (
              event: Parameters<NonNullable<ScriptablePackProductionOptions['onProgress']>>[0],
            ) =>
              process.stderr.write(
                `[forgeax.pack-build] ${JSON.stringify({
                  ...event,
                  ...(event.phase === 'ready'
                    ? {
                        memory: {
                          heapUsedMiB: Math.ceil(process.memoryUsage().heapUsed / 1024 ** 2),
                          rssMiB: Math.ceil(process.memoryUsage().rss / 1024 ** 2),
                          peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
                        },
                      }
                    : {}),
                })}\n`,
              ),
          }
        : {}),
      ...(context.buildCacheRoot === undefined
        ? {}
        : { buildCacheRoot: context.buildCacheRoot, cacheIdentityRoot: context.cwd }),
      ...(context.buildCacheSeedRoot === undefined
        ? {}
        : { buildCacheSeedRoot: context.buildCacheSeedRoot }),
    });
    if (!built.ok) dynamicFailure(context, built.error);

    const bundles: PackBuildBundle[] = [];
    for (const input of inputs) {
      const prepared = built.value.get(input.displaySourcePath);
      if (prepared === undefined) {
        dynamicFailure(context, {
          code: 'pack-build-failed',
          expected: 'the worklist to return one prepared result per source subject',
          hint: 'rerun Pack source generation from a clean inventory',
          detail: { sourcePath: input.sourcePath },
        });
      }
      const entries = projectPackBuildCatalog(
        prepared.product,
        input.displaySourcePath,
        input.subjectPackageId ?? input.definition.packageId,
        `${context.basePrefix === '/' ? '' : context.basePrefix}/${input.displaySourcePath}`,
      );
      bundles.push({ input, prepared, entries });
    }
    return bundles;
  } finally {
    await executors.dispose();
  }
}

interface BuildEmissionWork {
  readonly importedEntries: PackIndexEntry[];
  readonly context: BuildProductionOptions;
  readonly sharedMaterialPrograms: Map<string, Buffer>;
  readonly sourcePackageDdc?: SourcePackageBuildDdc;
}

interface PackEmissionOptions extends PublishedImportRows {
  readonly pack: unknown;
  readonly artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly packageName: string;
  readonly originalFileName: string;
  readonly receipts?: readonly CookReceipt[];
  readonly receiptOutputDigest?: string;
}

const CONTENT_ADDRESSED_PROGRAM = /^materials\/programs\/[a-f0-9]{64}\.wgsl$/;

/**
 * Imported material programs are already named by the digest of their bytes,
 * and many imported files compile to the same handful of programs. Keeping
 * that address under `shared/` lets every Pack in one build output reference a
 * single file instead of writing one copy per material. A changed material
 * compiles to a new digest, so it gets a new file and never overwrites one
 * that other Packs still reference. Other artifacts stay owner-scoped.
 */
function importedArtifactPath(assetGuid: string, key: string): string {
  return CONTENT_ADDRESSED_PROGRAM.test(key) ? `shared/${key}` : `${assetGuid}-${key}.bin`;
}

async function emitPackDocument(
  work: BuildEmissionWork,
  options: PackEmissionOptions,
): Promise<string> {
  for (const artifact of options.artifacts) {
    const shared = /^shared\/materials\/programs\/([a-f0-9]{64})\.wgsl$/.exec(artifact.path);
    if (shared !== null) {
      // Packages share programs; bytes equal to an already verified copy need
      // no second digest.
      const verified = work.sharedMaterialPrograms.get(artifact.path);
      if (verified?.equals(artifact.bytes) === true) continue;
      const actual = createHash('sha256').update(artifact.bytes).digest('hex');
      if (actual !== shared[1]) {
        throw work.context.fail({
          code: 'producer-artifact-invalid',
          expected: 'the shared material program path to match its content digest',
          hint: 'repair the material cooker artifact before Pack emission',
          detail: { path: artifact.path, actual },
        });
      }
      if (verified !== undefined) continue;
      work.sharedMaterialPrograms.set(artifact.path, Buffer.from(artifact.bytes));
    }
    work.context.sink.emitFile({
      type: 'asset',
      fileName: `assets/${artifact.path}`,
      source: artifact.bytes,
    });
  }
  const referenceId = work.context.sink.emitFile({
    type: 'asset',
    fileName: options.packageName.startsWith('assets/')
      ? options.packageName
      : `assets/${options.packageName}`,
    name: options.packageName,
    originalFileName: options.originalFileName,
    source: new TextEncoder().encode(JSON.stringify(projectMaterialPackTransport(options.pack))),
  });
  const packageUrl = work.context.sink.fileUrl(work.context.sink.getFileName(referenceId));
  const receiptUrls = new Map<string, string>();
  for (const receipt of options.receipts ?? []) {
    const guid = receipt.guid.toLowerCase();
    const receiptReferenceId = work.context.sink.emitFile({
      type: 'asset',
      fileName: `assets/${guid}.receipt.json`,
      name: `${guid}.receipt.json`,
      originalFileName: options.originalFileName,
      source: JSON.stringify({
        ...receipt,
        ...(receipt.outputDigest === undefined && options.receiptOutputDigest === undefined
          ? {}
          : { outputDigest: receipt.outputDigest ?? options.receiptOutputDigest }),
      }),
    });
    receiptUrls.set(
      guid,
      work.context.sink.fileUrl(work.context.sink.getFileName(receiptReferenceId)),
    );
  }
  publishImportedCatalogRows(work.importedEntries, { ...options, packageUrl }, receiptUrls);
  return packageUrl;
}

async function emitAuthoredPack(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  entry: PackIndexEntry,
  availableGuids: ReadonlySet<string>,
): Promise<void> {
  const sourceDeclaration = sourceDeclarationForCatalogPath(
    entry.sourcePath,
    work.context.inventory.sourceDeclarations,
    work.context.fsForImport.sourceIdentityFor,
    work.context.cwd,
  );
  const packPath = sourceDeclaration?.sourcePath ?? resolve(work.context.cwd, entry.sourcePath);
  const declaration = sourceDeclaration?.declaration;
  if (declaration?.format !== 'pack.json') {
    throw work.context.fail({
      code: 'catalog-declaration-missing',
      expected: 'the inventory to retain the authored Pack declaration',
      hint: 'rerun Pack inventory before emitting the authored Pack',
      detail: { stage: 'scan', sourcePath: packPath },
    });
  }
  const parsed = declaration.value;
  if (parsed.format !== 'direct') {
    dynamicFailure(work.context, {
      code: 'catalog-declaration-missing',
      expected: 'a direct v3 Pack declaration for an indexed authored output',
      hint: 'instances are built from their ScriptablePack parent and do not have direct Catalog rows',
      detail: { stage: 'scan', sourcePath: packPath },
    });
  }
  const projected = projectDirectPackJson(parsed);
  const prepared = await prepareDirectPackTransport({
    projected,
    sourcePath: packPath,
    sourceRevision: declaration.sourceRevision,
    availableGuids,
    cookers: work.context.cookers,
    policy: {
      ...materialProgramTransport(work.context),
      base: work.context.basePrefix === '' ? '/' : work.context.basePrefix,
      packagePath: `assets/${projected.packageId}${RUNTIME_PACK_SUFFIX}`,
      artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
    },
  });
  if (!prepared.ok) dynamicFailure(work.context, prepared.error);
  await emitCookedPack(
    work,
    guidSeen,
    prepared.value,
    prepared.value.projected.packageId,
    packPath,
    entry.sourcePath,
    work.context.generation,
  );
}

async function emitScriptablePack(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  bundle: PackBuildBundle,
): Promise<void> {
  const { input, prepared } = bundle;
  const packageId = PackageId.format(input.subjectPackageId ?? input.definition.packageId);
  await emitCookedPack(
    work,
    guidSeen,
    prepared,
    packageId,
    input.sourcePath,
    input.displaySourcePath,
    prepared.publication.generation,
  );
}

async function emitCookedPack(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  prepared: PreparedScriptablePack | DirectPackTransport,
  packageId: string,
  originalFileName: string,
  sourcePath: string,
  generation: number,
): Promise<void> {
  const { product, finalized, revision } = prepared;
  const deliveryGeneration = work.context.runtimeBinding?.generation ?? generation;
  const publication =
    'publication' in prepared && prepared.publication.generation === deliveryGeneration
      ? prepared.publication
      : projectPreparedPackPublication(prepared, sourcePath, deliveryGeneration);
  const guids = product.product.assets.map((asset) => asset.guid);
  await emitPackDocument(work, {
    pack: bindRuntimePackPublication(
      finalized.pack,
      work.context.runtimeBinding?.scopeId ?? 'asset-runtime',
      publication,
    ),
    artifacts: finalized.artifacts,
    packageName: `${packageId}${RUNTIME_PACK_SUFFIX}`,
    originalFileName,
    guids,
    projection: work.context.authoredCookedCurrentProjection,
    receipts: product.product.receipts,
    receiptOutputDigest: finalized.digest,
    publication,
    sourcePath,
    revision,
  });
  for (const guid of guids) guidSeen.add(guid.toLowerCase());
}

function emitOwnerArtifactPaths(
  work: BuildEmissionWork,
  metaPath: string,
  guid: string,
  product: Extract<
    Awaited<ReturnType<typeof produceSourcePackage>>,
    { readonly ok: true }
  >['value']['product'],
) {
  const artifactPaths = new Map<string, string>();
  const sourceAsset = product.assets[0];
  for (const [path, artifact] of Object.entries(sourceAsset?.artifacts ?? {})) {
    const ref = work.context.sink.emitFile({
      type: 'asset',
      name: path,
      originalFileName: path,
      source: artifact.bytes,
    });
    artifactPaths.set(path, work.context.sink.getFileName(ref));
  }
  return {
    artifactUrl: ({ path }: { readonly path: string }) =>
      work.context.sink.fileUrl(artifactPaths.get(path) ?? path),
    policy: {
      base: work.context.basePrefix,
      packagePath: `assets/${guid}${RUNTIME_PACK_SUFFIX}`,
      artifactPath: (_guid, key) => {
        const emittedPath = artifactPaths.get(key);
        if (emittedPath === undefined)
          throw work.context.fail({
            code: 'producer-artifact-missing',
            expected: `producer artifact ${key} to be emitted before Pack finalization`,
            hint: 'repair the importer finalizer artifact closure and rebuild',
            detail: { stage: 'finalize', metaPath, artifact: key },
          });
        return emittedPath.replace(/^assets\//, '');
      },
    } satisfies PackageFinalizePolicy,
  };
}

async function emitBuildEntry(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  entry: PackIndexEntry,
  availableGuids: ReadonlySet<string>,
): Promise<void> {
  const guid = entry.guid.toLowerCase();
  const metaPath = metaPathForGuid(work.context.inventory.declarations, guid);
  if (metaPath === undefined) {
    if (entry.sourcePath.endsWith('.pack.json'))
      await emitAuthoredPack(work, guidSeen, entry, availableGuids);
    else guidSeen.add(guid);
    return;
  }
  const declaration = work.context.inventory.declarations.get(metaPath);
  if (declaration === undefined) {
    throw work.context.fail({
      code: 'catalog-declaration-missing',
      expected: 'every indexed Meta path to have one validated producer declaration',
      hint: 'rerun the inventory and repair the Catalog declaration index',
      detail: { metaPath },
    });
  }
  const runMeta = declaration;
  const subAssets = runMeta.subAssets;
  for (const sub of subAssets) guidSeen.add(sub.guid.toLowerCase());
  const sourcePackage = await produceSourcePackage({
    meta: runMeta,
    registry: work.context.importerRegistry,
    fs: work.context.fsForImport,
    cookers: work.context.cookers,
    ...(work.sourcePackageDdc === undefined ? {} : { ddc: work.sourcePackageDdc }),
  });
  if (!sourcePackage.ok) throw work.context.fail(sourcePackage.error);
  const ownerFinalizer = work.context.importerRegistry.get(runMeta.importer)?.finalize;
  const ownerGuid = subAssets[0]?.guid;
  if (ownerFinalizer !== undefined && ownerGuid === undefined) return;
  const packageName = `${ownerGuid ?? 'pack'}${RUNTIME_PACK_SUFFIX}`;
  const product = sourcePackage.value.product;
  const owner =
    ownerFinalizer && ownerGuid
      ? emitOwnerArtifactPaths(work, metaPath, ownerGuid, product)
      : undefined;
  const sourcePath = canonicalScriptableSourcePath(entry.sourcePath);
  const prepared = await prepareImportedPackPublication(
    product,
    owner?.policy ?? {
      ...materialProgramTransport(work.context),
      base: work.context.basePrefix,
      packagePath: `assets/${packageName}`,
      artifactPath: importedArtifactPath,
    },
    () => ({
      scopeId: work.context.runtimeBinding?.scopeId ?? 'asset-runtime',
      generation: work.context.runtimeBinding?.generation ?? work.context.generation,
      sourcePath,
      ...(ownerFinalizer === undefined ? { sourceKeys: importSourceKeys(subAssets) } : {}),
    }),
    owner && ownerFinalizer
      ? { finalize: ownerFinalizer, artifactUrl: owner.artifactUrl }
      : undefined,
  );
  if (!prepared.ok) throw work.context.fail(prepared.error);
  await emitPackDocument(work, {
    ...prepared.value,
    packageName,
    originalFileName: metaPath,
    guids: subAssets.map((sub) => sub.guid),
    projection: work.context.cookedCurrentProjection,
    sourcePath,
  });
}

export async function produceBuildAssets(
  context: BuildProductionOptions,
): Promise<PackIndexEntry[]> {
  const dynamicBundles = await buildPackSources(context);
  const entries = [
    ...context.inventory.entries,
    ...dynamicBundles.flatMap((bundle) => bundle.entries),
  ];
  const availableGuids = new Set([
    ...entries.map((entry) => entry.guid.toLowerCase()),
    ...declaredRuntimePackGuids(context.inventory.sourceDeclarations.values()),
  ]);
  const importedEntries = [...entries];
  const guidSeen = new Set<string>();
  const sourcePackageDdc = await createSourcePackageBuildDdc({
    root: context.buildCacheRoot,
    identityRoot: context.cwd,
    producerIdentity: context.producerIdentity,
    cookers: context.cookers,
  });
  const work: BuildEmissionWork = {
    importedEntries,
    context,
    sharedMaterialPrograms: new Map(),
    ...(sourcePackageDdc === undefined ? {} : { sourcePackageDdc }),
  };
  // Emission owns the remaining queue. Published payloads no longer need to
  // survive while subsequent Packs are cooked; Catalog rows live in entries.
  for (let bundle = dynamicBundles.shift(); bundle !== undefined; bundle = dynamicBundles.shift()) {
    await emitScriptablePack(work, guidSeen, bundle);
  }
  for (const entry of importedEntries) {
    if (!guidSeen.has(entry.guid.toLowerCase()))
      await emitBuildEntry(work, guidSeen, entry, availableGuids);
  }
  return importedEntries;
}
