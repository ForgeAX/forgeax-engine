import { createHash } from 'node:crypto';
import { availableParallelism, freemem } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import {
  type CatalogBuildResult,
  createRuntimePackPublication,
  finalizePackageTransportSource,
  metaPathForGuid,
  projectPackageCatalog,
} from '@forgeax/engine-pack/build';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import {
  type LegacyPackInventoryDocument,
  resolvePackSourceSubjects,
  type ScriptablePackSourceDeclaration,
} from '@forgeax/engine-pack/scanner';
import { PackageId, projectDirectPackJson } from '@forgeax/engine-pack/source';
import {
  createLazyScriptablePackDefinition,
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import type {
  AssetPublicationEnvelope,
  AssetPublicationOutput,
  CookReceipt,
  Importer,
  PackIndexEntry,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import type { ImportRunnerFs } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';
import { projectMaterialPackTransport } from './material-pack-transport.js';
import { packBuildConcurrency } from './pack-build-concurrency.js';
import { projectImportProductForBuild } from './pack-projection.js';
import type { ScriptablePackBuildProduct } from './scriptable-pack-build.js';
import {
  canonicalScriptableSourcePath,
  createDeclaredPackAssetSnapshotSource,
  type PreparedScriptablePack,
  prepareDirectPackTransport,
  prepareLegacyPackTransport,
  produceScriptablePackProducts,
  type ScriptablePackInput,
  type ScriptablePackProductionOptions,
} from './scriptable-pack-host.js';
import {
  finalizeSourcePackage,
  produceSourcePackage,
  sourcePackageAssetsByGuid,
} from './source-package.js';
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

export interface BuildProductionOptions {
  readonly inventory: CatalogBuildResult;
  readonly cwd: string;
  readonly basePrefix: string;
  readonly generation: number;
  readonly cookers: readonly NativeCooker[];
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly cookedCurrentProjection: Record<string, unknown>;
  readonly directCurrentProjection: Record<string, unknown>;
  readonly authoredCookedCurrentProjection: Record<string, unknown>;
  readonly runtimeBinding?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
  readonly sourceSnapshot?: ScriptablePackSourceSnapshot;
  /** Reuse producer-verified immutable products; publication remains current-generation work. */
  readonly buildCacheRoot?: string;
  readonly sink: BuildProductionSink;
  readonly fail: (failure: BuildProductionFailure) => Error;
}

function runtimePublicationFor(
  context: BuildProductionOptions,
  input: {
    readonly pack: Parameters<typeof createRuntimePackPublication>[0]['pack'];
    readonly sourcePath: string;
    readonly sourceRevision: string;
    readonly packageUrl: string;
    readonly digest?: string;
    readonly inputFingerprint?: string;
    /** Preserve producer-declared semantic keys on generic publication output rows. */
    readonly sourceKeys?: ReadonlyMap<string, string>;
    readonly outputs?: readonly AssetPublicationOutput[];
    readonly externalEvidence?: readonly import('@forgeax/engine-types').AssetPublicationExternalEvidence[];
  },
) {
  const publicationInput = {
    pack: input.pack,
    scopeId: context.runtimeBinding?.scopeId ?? 'asset-runtime',
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    packageUrl: input.packageUrl,
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    ...(input.inputFingerprint === undefined ? {} : { inputFingerprint: input.inputFingerprint }),
    ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
    ...(input.sourceKeys === undefined ? {} : { sourceKeys: input.sourceKeys }),
    ...(input.externalEvidence === undefined ? {} : { externalEvidence: input.externalEvidence }),
    generation: context.runtimeBinding?.generation ?? context.generation,
  };
  return createRuntimePackPublication(publicationInput);
}

function sourceKeysFor(
  declarations: readonly { readonly guid: string; readonly sourceKey?: string }[],
): ReadonlyMap<string, string> {
  return new Map(
    declarations.flatMap((declaration) =>
      declaration.sourceKey === undefined
        ? []
        : [[declaration.guid.toLowerCase(), declaration.sourceKey] as const],
    ),
  );
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

function packCatalogSourcePath(context: BuildProductionOptions, sourcePath: string): string {
  const projected = context.fsForImport.sourceIdentityFor?.(sourcePath);
  const logical =
    projected === undefined || isAbsolute(projected)
      ? relative(context.cwd, sourcePath)
      : projected;
  return canonicalScriptableSourcePath(logical).replaceAll('\\', '/');
}

/** Build ScriptablePack roots and Pack JSON instances before normal emission. */
async function buildPackSources(context: BuildProductionOptions): Promise<PackBuildBundle[]> {
  const subjects = await resolvePackSourceSubjects(context.inventory.sourceDeclarations);
  if (!subjects.ok) dynamicFailure(context, subjects.error);
  const maxConcurrency = packBuildConcurrency(
    {
      parallelism: availableParallelism(),
      freeBytes: Math.min(freemem(), process.availableMemory?.() ?? Infinity),
      heapHeadroomBytes: getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed,
      concurrentCookers:
        context.cookers?.every((cooker) => cooker.concurrency === 'parallel') ?? true,
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
  const definitionFor = (source: ScriptablePackSourceDeclaration) =>
    createLazyScriptablePackDefinition({
      sourcePath: source.sourcePath,
      definition: source.definition,
      sourceClosure: source.sourceClosure,
      sourceSnapshot,
      executors,
    });
  try {
    const policy = (packageId: PackageId) => (product: ScriptablePackBuildProduct) => {
      const paths = new Map(
        product.product.assets.flatMap((asset) =>
          Object.entries(asset.artifacts).map(
            ([key, artifact]) =>
              [
                `${asset.guid.toLowerCase()}/${key}`,
                `shared/${createHash('sha256').update(artifact.bytes).digest('hex')}.bin`,
              ] as const,
          ),
        ),
      );
      return {
        base: context.basePrefix === '' ? '/' : context.basePrefix,
        packagePath: `assets/${PackageId.format(packageId)}.pack.json`,
        artifactPath: (guid: string, key: string) => {
          const path = paths.get(`${guid.toLowerCase()}/${key}`);
          if (path === undefined) throw new Error(`missing produced artifact: ${guid}/${key}`);
          return path;
        },
      };
    };
    const inputs: ScriptablePackInput[] = [];
    for (const source of subjects.value.sources) {
      inputs.push({
        sourcePath: source.sourcePath,
        displaySourcePath: packCatalogSourcePath(context, source.sourcePath),
        definition: definitionFor(source),
        sourceClosure: source.sourceClosure,
        publicationGeneration: context.generation,
        policy: policy(source.definition.packageId),
      });
    }
    for (const instance of subjects.value.instances) {
      inputs.push({
        sourcePath: instance.sourcePath,
        displaySourcePath: packCatalogSourcePath(context, instance.sourcePath),
        definition: definitionFor(instance.root),
        sourceClosure: instance.root.sourceClosure,
        subjectPackageId: instance.packageId,
        values: instance.values,
        publicationGeneration: context.generation,
        policy: policy(instance.packageId),
      });
    }
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
    const built = await produceScriptablePackProducts({
      sources: inputs,
      assetSource,
      cookers: context.cookers,
      maxConcurrency,
      availableGuids,
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
      ...(context.buildCacheRoot === undefined ? {} : { buildCacheRoot: context.buildCacheRoot }),
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
      const packageId = PackageId.format(input.subjectPackageId ?? input.definition.packageId);
      const stagedByGuid = new Map(
        prepared.product.stagedOutputs.map((output) => [
          AssetGuid.format(output.guid).toLowerCase(),
          output,
        ]),
      );
      const entries = projectPackageCatalog(
        prepared.product.product.assets.map((asset, sourceIndex) => {
          const staged = stagedByGuid.get(asset.guid.toLowerCase());
          return {
            guid: asset.guid,
            kind: asset.kind,
            sourcePath: input.displaySourcePath,
            sourceIndex,
            ...(staged?.sourceKey === undefined ? {} : { sourceKey: staged.sourceKey }),
            refs: asset.refs.map((reference) => reference.guid),
            execution: 'cooked' as const,
            packageId,
            provenance: { provider: 'pack-ts', version: '2.0.0' },
          };
        }),
        `${context.basePrefix === '/' ? '' : context.basePrefix}/${input.displaySourcePath}`,
      );
      bundles.push({ input, prepared, entries });
    }
    return bundles;
  } finally {
    await executors.dispose();
  }
}

function updateImportedEntries(
  entries: PackIndexEntry[],
  guids: readonly string[],
  packageUrl: string,
  projection: Record<string, unknown> = {},
  refsByGuid?: ReadonlyMap<string, readonly string[]>,
  publication?: AssetPublicationEnvelope,
  sourcePath?: string,
  receiptUrls?: ReadonlyMap<string, string>,
  revision?: PackIndexEntry['revision'],
): void {
  const selected = new Set(guids.map((guid) => guid.toLowerCase()));
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || !selected.has(entry.guid.toLowerCase())) continue;
    const refs = refsByGuid?.get(entry.guid.toLowerCase());
    const cookReceiptUrl = receiptUrls?.get(entry.guid.toLowerCase());
    entries[index] = {
      ...entry,
      packageUrl,
      ...projection,
      ...(sourcePath === undefined ? {} : { sourcePath }),
      ...(publication === undefined ? {} : { publication }),
      ...(refs === undefined ? {} : { refs }),
      ...(cookReceiptUrl === undefined ? {} : { cookReceiptUrl }),
      ...(revision === undefined ? {} : { revision }),
    };
  }
}

interface BuildEmissionWork {
  readonly importedEntries: PackIndexEntry[];
  readonly context: BuildProductionOptions;
  readonly sharedMaterialPrograms: Set<string>;
}

interface PackEmissionOptions {
  readonly pack: unknown;
  readonly artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly packageName: string;
  readonly originalFileName: string;
  readonly guids: readonly string[];
  readonly projection?: Record<string, unknown>;
  readonly refsByGuid?: ReadonlyMap<string, readonly string[]>;
  readonly receipts?: readonly CookReceipt[];
  readonly receiptOutputDigest?: string;
  readonly publication?: AssetPublicationEnvelope;
  readonly sourcePath?: string;
  readonly revision?: PackIndexEntry['revision'];
}

async function emitPackDocument(
  work: BuildEmissionWork,
  options: PackEmissionOptions,
): Promise<string> {
  for (const artifact of options.artifacts) {
    const shared = /^shared\/materials\/programs\/([a-f0-9]{64})\.wgsl$/.exec(artifact.path);
    if (shared !== null) {
      const actual = createHash('sha256').update(artifact.bytes).digest('hex');
      if (actual !== shared[1]) {
        throw work.context.fail({
          code: 'producer-artifact-invalid',
          expected: 'the shared material program path to match its content digest',
          hint: 'repair the material cooker artifact before Pack emission',
          detail: { path: artifact.path, actual },
        });
      }
      if (work.sharedMaterialPrograms.has(artifact.path)) continue;
      work.sharedMaterialPrograms.add(artifact.path);
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
  updateImportedEntries(
    work.importedEntries,
    options.guids,
    packageUrl,
    options.projection,
    options.refsByGuid,
    options.publication,
    options.sourcePath,
    receiptUrls,
    options.revision,
  );
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
  if (declaration.value.schemaVersion === '3.0.0') {
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
        base: work.context.basePrefix === '' ? '/' : work.context.basePrefix,
        packagePath: `assets/${projected.packageId}.pack.json`,
        artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
      },
    });
    if (!prepared.ok) dynamicFailure(work.context, prepared.error);
    const { product, finalized, facts, revision } = prepared.value;
    const publication = runtimePublicationFor(work.context, {
      pack: finalized.pack,
      sourcePath: entry.sourcePath,
      sourceRevision: product.inputFingerprint,
      packageUrl: finalized.packageUrl,
      digest: finalized.digest,
      inputFingerprint: product.inputFingerprint,
      outputs: facts.outputs,
      externalEvidence: product.externalEvidence,
    });
    await emitPackDocument(work, {
      pack: publication.pack,
      artifacts: finalized.artifacts,
      packageName: `${prepared.value.projected.packageId}.pack.json`,
      originalFileName: packPath,
      guids: product.product.assets.map((asset) => asset.guid),
      projection: work.context.authoredCookedCurrentProjection,
      refsByGuid: facts.refs,
      receipts: product.product.receipts,
      receiptOutputDigest: finalized.digest,
      publication: publication.publication,
      sourcePath: entry.sourcePath,
      revision,
    });
    for (const asset of product.product.assets) guidSeen.add(asset.guid.toLowerCase());
    return;
  }
  // Legacy array-shaped documents are runtime Pack transport, not an
  // authoring input anymore. Preserve the explicit v2 native-cooker seam for
  // cooked transport while keeping source evaluation out of this path.
  const legacy = declaration.value as LegacyPackInventoryDocument;
  const prepared = await prepareLegacyPackTransport(
    legacy,
    work.context.cookers,
    (guid) => ({
      base: work.context.basePrefix === '' ? '/' : work.context.basePrefix,
      packagePath: `assets/${guid}.pack.json`,
      artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
    }),
    packPath,
  );
  const outputGuid = prepared.firstGuid ?? entry.guid;
  const authoredPack = prepared.finalized?.pack ?? {
    schemaVersion: '2.0.0' as const,
    kind: 'internal-text-package' as const,
    assets: legacy.assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      payload: asset.payload,
      refs: asset.refs,
      artifacts: asset.artifacts ?? {},
    })),
  };
  const runtimePublication = runtimePublicationFor(work.context, {
    pack: authoredPack,
    sourceKeys: sourceKeysFor(legacy.assets),
    sourcePath: entry.sourcePath,
    sourceRevision: declaration.sourceRevision,
    packageUrl:
      prepared.finalized?.packageUrl ??
      `${work.context.basePrefix === '/' ? '' : work.context.basePrefix}/assets/${outputGuid}.pack.json`,
    ...(prepared.finalized?.digest === undefined ? {} : { digest: prepared.finalized.digest }),
  });
  await emitPackDocument(work, {
    pack: runtimePublication.pack,
    artifacts: prepared.finalized?.artifacts ?? [],
    packageName: `${outputGuid}.pack.json`,
    originalFileName: packPath,
    guids: authoredPack.assets.map((asset) => asset.guid),
    projection:
      prepared.finalized === undefined
        ? work.context.directCurrentProjection
        : work.context.authoredCookedCurrentProjection,
    refsByGuid: new Map(authoredPack.assets.map((asset) => [asset.guid.toLowerCase(), asset.refs])),
    ...(prepared.finalized?.receipts === undefined
      ? {}
      : {
          receipts: prepared.finalized.receipts,
          receiptOutputDigest: prepared.finalized.digest,
        }),
    publication: runtimePublication.publication,
    sourcePath: entry.sourcePath,
  });
  for (const guid of authoredPack.assets.map((asset) => asset.guid)) {
    guidSeen.add(guid.toLowerCase());
  }
}

async function emitScriptablePack(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  bundle: PackBuildBundle,
): Promise<void> {
  const { input, prepared } = bundle;
  const packageId = PackageId.format(input.subjectPackageId ?? input.definition.packageId);
  const runtimePublication = createRuntimePackPublication({
    pack: { assets: prepared.finalized.pack.assets },
    scopeId: work.context.runtimeBinding?.scopeId ?? 'asset-runtime',
    sourcePath: input.displaySourcePath,
    sourceRevision: prepared.product.inputFingerprint,
    packageUrl: prepared.finalized.packageUrl,
    inputFingerprint: prepared.product.inputFingerprint,
    digest: prepared.finalized.digest,
    generation: work.context.runtimeBinding?.generation ?? prepared.publication.generation,
    outputs: prepared.facts.outputs,
    externalEvidence: prepared.product.externalEvidence,
  });
  await emitPackDocument(work, {
    pack: runtimePublication.pack,
    artifacts: prepared.finalized.artifacts,
    packageName: `${packageId}.pack.json`,
    originalFileName: input.sourcePath,
    guids: prepared.product.product.assets.map((asset) => asset.guid),
    projection: work.context.authoredCookedCurrentProjection,
    refsByGuid: prepared.facts.refs,
    receipts: prepared.product.product.receipts,
    receiptOutputDigest: prepared.finalized.digest,
    publication: runtimePublication.publication,
    sourcePath: input.displaySourcePath,
    revision: prepared.revision,
  });
  for (const asset of prepared.product.product.assets) guidSeen.add(asset.guid.toLowerCase());
}

async function emitFinalizedOwner(
  work: BuildEmissionWork,
  metaPath: string,
  sourcePath: string,
  subAssets: readonly { readonly guid: string }[],
  sourcePackage: Extract<
    Awaited<ReturnType<typeof produceSourcePackage>>,
    { readonly ok: true }
  >['value'],
  ownerFinalizer: NonNullable<Importer['finalize']>,
): Promise<void> {
  const ownerGuid = subAssets[0]?.guid;
  if (ownerGuid === undefined) return;
  const artifactPaths = new Map<string, string>();
  const sourceAsset = sourcePackage.product.assets[0];
  for (const [path, artifact] of Object.entries(sourceAsset?.artifacts ?? {})) {
    const ref = work.context.sink.emitFile({
      type: 'asset',
      name: path,
      originalFileName: path,
      source: artifact.bytes,
    });
    artifactPaths.set(path, work.context.sink.getFileName(ref));
  }
  const ownerProduct = await finalizeSourcePackage(
    sourcePackage.product,
    ownerFinalizer,
    (artifact) => work.context.sink.fileUrl(artifactPaths.get(artifact.path) ?? artifact.path),
  );
  if (!ownerProduct.ok) throw work.context.fail(ownerProduct.error);
  const ownerPackage = await finalizePackageTransportSource(
    projectImportProductForBuild(ownerProduct.value),
    {
      base: work.context.basePrefix,
      packagePath: `assets/${ownerGuid}.pack.json`,
      artifactPath: (_guid, key) => {
        const emittedPath = artifactPaths.get(key);
        if (emittedPath === undefined) {
          throw work.context.fail({
            code: 'producer-artifact-missing',
            expected: `producer artifact ${key} to be emitted before Pack finalization`,
            hint: 'repair the importer finalizer artifact closure and rebuild',
            detail: { stage: 'finalize', metaPath, artifact: key },
          });
        }
        return emittedPath.replace(/^assets\//, '');
      },
    },
  );
  const runtimePublication = runtimePublicationFor(work.context, {
    pack: { assets: ownerPackage.pack.assets },
    // The Catalog entry identifies the imported source, while metaPath is the
    // sidecar declaration that drove the import. Keep publication fences on
    // the Catalog identity in production just as the dev importer does.
    sourcePath,
    sourceRevision: ownerPackage.sourceRevision,
    packageUrl: ownerPackage.packageUrl,
    digest: ownerPackage.digest,
  });
  await emitPackDocument(work, {
    pack: runtimePublication.pack,
    artifacts: ownerPackage.artifacts,
    packageName: `${ownerGuid}.pack.json`,
    originalFileName: metaPath,
    guids: subAssets.map((sub) => sub.guid),
    projection: work.context.cookedCurrentProjection,
    refsByGuid: new Map(
      ownerProduct.value.assets.map((asset) => [
        asset.guid.toLowerCase(),
        asset.refs.map((ref) => ref.guid),
      ]),
    ),
    publication: runtimePublication.publication,
    sourcePath,
  });
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
  const runMeta = { ...declaration, buildPack: false };
  const subAssets = runMeta.subAssets;
  for (const sub of subAssets) guidSeen.add(sub.guid.toLowerCase());
  const sourcePackage = await produceSourcePackage({
    meta: runMeta,
    registry: work.context.importerRegistry,
    fs: work.context.fsForImport,
    cookers: work.context.cookers,
  });
  if (!sourcePackage.ok) throw work.context.fail(sourcePackage.error);
  const ownerFinalizer = work.context.importerRegistry.get(runMeta.importer)?.finalize;
  if (ownerFinalizer !== undefined) {
    await emitFinalizedOwner(
      work,
      metaPath,
      canonicalScriptableSourcePath(entry.sourcePath),
      subAssets,
      sourcePackage.value,
      ownerFinalizer,
    );
    return;
  }
  const finalized = await finalizePackageTransportSource(
    projectImportProductForBuild(sourcePackage.value.product),
    {
      base: work.context.basePrefix,
      packagePath: `assets/${subAssets[0]?.guid ?? 'pack'}.pack.json`,
      artifactPath: (assetGuid, key) => `${assetGuid}-${key}.bin`,
    },
  );
  const productByGuid = sourcePackageAssetsByGuid(sourcePackage.value);
  const canonicalSourcePath = canonicalScriptableSourcePath(entry.sourcePath);
  const runtimePublication = runtimePublicationFor(work.context, {
    pack: { assets: finalized.pack.assets },
    // See emitFinalizedOwner: the sidecar path is an import driver, not the
    // stable source identity carried by the Catalog row.
    sourcePath: canonicalSourcePath,
    sourceRevision: finalized.sourceRevision,
    packageUrl: finalized.packageUrl,
    digest: finalized.digest,
    sourceKeys: sourceKeysFor(subAssets),
  });
  await emitPackDocument(work, {
    pack: runtimePublication.pack,
    artifacts: finalized.artifacts,
    packageName: `${subAssets[0]?.guid ?? 'pack'}.pack.json`,
    originalFileName: metaPath,
    guids: subAssets.map((sub) => sub.guid),
    projection: work.context.cookedCurrentProjection,
    refsByGuid: new Map(
      [...productByGuid].map(([guid, asset]) => [guid, asset.refs.map((ref) => ref.guid)]),
    ),
    publication: runtimePublication.publication,
    sourcePath: canonicalSourcePath,
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
  const availableGuids = new Set(entries.map((entry) => entry.guid.toLowerCase()));
  const importedEntries = [...entries];
  const guidSeen = new Set<string>();
  const work: BuildEmissionWork = { importedEntries, context, sharedMaterialPrograms: new Set() };
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
