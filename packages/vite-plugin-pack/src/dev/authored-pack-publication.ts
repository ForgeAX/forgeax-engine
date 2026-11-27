import { resolve } from 'node:path';
import type { ImporterRegistry, ImportRunnerFs } from '@forgeax/engine-import';
import {
  createDeclaredPackAssetSnapshotSource,
  materializePreparedScriptablePack,
  type PreparedScriptablePack,
  planScriptablePackInputs,
  prepareDirectPackTransport,
  produceScriptablePackProducts,
  projectImportProductForBuild,
  projectPackBuildCatalog,
  projectPreparedPackPublication,
  rebindPreparedScriptablePack,
  type ScriptablePackInput,
  sourceDeclarationForCatalogPath,
} from '@forgeax/engine-import';
import {
  bindRuntimePackPublication,
  catalogSourcePathFor,
  packageTransportRevision,
  RUNTIME_PACK_SUFFIX,
} from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import {
  declaredRuntimePackGuids,
  type PackInstanceResolution,
  type ScanSourceDeclaration,
} from '@forgeax/engine-pack/scanner';
import { projectDirectPackJson } from '@forgeax/engine-pack/source';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  type ScriptablePackModuleExecutorPool,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import {
  type AssetPublicationEnvelope,
  assetPublicationOutputSetDigest,
  assetPublicationReceiptMatches,
  canonicalJson,
  type PackIndexEntry,
} from '@forgeax/engine-types';
import type { PluginPackInternalOptions } from '../plugin-contract.js';
import { structuredPluginError } from '../structured-plugin-error.js';
import {
  createAuthoredPackProgressTiming,
  timeAuthoredPackRecipe,
} from './authored-pack-timing.js';
import type { PluginServerProjectionState } from './plugin-server.js';

interface AuthoredPackPublicationContext {
  readonly onProgress?: (event: import('../plugin-contract.js').PluginPackSourceProgress) => void;
  readonly opts: PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  readonly draft: PluginServerProjectionState;
  /** Accepted rows, used to retire removed dynamic outputs on a new generation. */
  readonly previousCatalogEntries?: readonly PackIndexEntry[];
  readonly scopeId?: string;
  readonly signal?: AbortSignal;
  readonly sourceDeclarations: ReadonlyMap<string, ScanSourceDeclaration>;
  readonly packInstances: ReadonlyMap<string, PackInstanceResolution>;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly currentProjection: Record<string, unknown>;
  readonly directProjection: Record<string, unknown>;
  readonly authoredCookedProjection: Record<string, unknown>;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';
// The policy below is sink-free and depends only on the current product tuple.
const DEV_PACK_TRANSPORT_IDENTITY = `vite-authored-pack/1:${DEV_PACK_PREFIX}:${RUNTIME_PACK_SUFFIX}`;

function publicationTiming(stage: string, startedAt: number, sourcePath?: string): void {
  if (process.env.FORGEAX_WORKSPACE_TIMING !== '1') return;
  console.error(
    '[forgeax.authored-pack.timing]',
    JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - startedAt), sourcePath }),
  );
}

function dynamicPluginError(value: unknown): Error {
  const candidate = value !== null && typeof value === 'object' ? value : {};
  const failure = candidate as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  return structuredPluginError({
    code: typeof failure.code === 'string' ? failure.code : 'pack-build-failed',
    expected:
      typeof failure.expected === 'string'
        ? failure.expected
        : 'the Pack source generation to produce a valid terminal result',
    hint:
      typeof failure.hint === 'string'
        ? failure.hint
        : 'inspect the Pack source subject and rebuild the current generation',
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  });
}

function packDevInputs(
  context: AuthoredPackPublicationContext,
  generationFor: (displaySourcePath: string) => number,
  sourceIdentityFor: ((sourcePath: string) => string) | undefined,
  executors: ScriptablePackModuleExecutorPool,
  enginePackageRoot: string | undefined,
  sourceSnapshot: ScriptablePackSourceSnapshot,
): readonly ScriptablePackInput[] {
  const policy =
    (packageId: PackageId): ScriptablePackInput['policy'] =>
    (product) => {
      const transportRevision = `${product.inputFingerprint}:${packageTransportRevision(
        projectImportProductForBuild(product.product),
      )}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      return {
        base: '/',
        packagePath:
          `${DEV_PACK_PREFIX}${PackageId.format(packageId)}.${transportRevision}${RUNTIME_PACK_SUFFIX}`.replace(
            /^\/+/,
            '',
          ),
        artifactPath: (guid, key) =>
          `${guid.toLowerCase()}/${transportRevision}/${key.includes('.') ? key : `${key}.bin`}`,
      };
    };
  return planScriptablePackInputs(context.sourceDeclarations, context.packInstances, {
    sourceSnapshot,
    executors,
    enginePackageRoot,
    displayPath: (sourcePath) => catalogSourcePathFor(process.cwd(), sourcePath, sourceIdentityFor),
    generationFor,
    policy,
    transportIdentity: () => DEV_PACK_TRANSPORT_IDENTITY,
    executionBudget: (displayPath) =>
      !context.draft.authoredPublications.has(displayPath) ? 'production' : 'interactive',
  });
}

/**
 * Keep a deterministic republish on the accepted generation.
 *
 * The production session generation is an attempt fence, while the
 * publication generation is the durable identity carried by authored scene
 * mounts. Watcher noise can schedule several attempts for the same source
 * bytes; minting a new publication generation for each one makes an
 * unchanged saved mount fail its own publication fence. Reuse the accepted
 * generation only when the complete source/output tuple is unchanged.
 */
export function preserveAcceptedPublicationGeneration(
  publication: AssetPublicationEnvelope,
  accepted: AssetPublicationEnvelope | undefined,
): AssetPublicationEnvelope {
  if (!accepted || !hasSameAuthoredPublicationIdentity(accepted, publication)) return publication;
  return withAuthoredPublicationGeneration(publication, accepted.generation);
}

function withAuthoredPublicationGeneration(
  publication: AssetPublicationEnvelope,
  generation: number,
): AssetPublicationEnvelope {
  if (generation === publication.generation) return publication;
  return {
    ...publication,
    generation,
    ...(publication.current === undefined
      ? {}
      : { current: { ...publication.current, generation } }),
  };
}

function hasSameAuthoredPublicationIdentity(
  accepted: AssetPublicationEnvelope | undefined,
  candidate: AssetPublicationEnvelope | undefined,
): boolean {
  return (
    accepted !== undefined &&
    candidate !== undefined &&
    accepted.sourcePath === candidate.sourcePath &&
    accepted.sourceRevision === candidate.sourceRevision &&
    accepted.outputSetDigest === candidate.outputSetDigest &&
    accepted.digest === candidate.digest
  );
}

export function validateAuthoredPublication(
  publication: AssetPublicationEnvelope,
  accepted: AssetPublicationEnvelope | undefined,
): void {
  const fail = (code: string, stage: 'receipt' | 'output' | 'cancelled', hint: string): never => {
    throw structuredPluginError({
      code,
      expected: 'a complete authored Pack publication for the current generation',
      hint,
      detail: { stage, sourcePath: publication.sourcePath },
    });
  };
  if (publication.schemaVersion !== 'asset-publication/1')
    fail('asset-publication-schema-invalid', 'receipt', 'publish a supported envelope');
  if (!Number.isSafeInteger(publication.generation) || publication.generation < 1)
    fail('asset-publication-generation-invalid', 'receipt', 'publish a positive generation');
  const { outputs, outputSetDigest, receipt } = publication;
  const guids = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const output of outputs) {
    const guid = output.guid.toLowerCase();
    if (guids.has(guid) || sourceKeys.has(output.sourceKey))
      fail(
        'asset-publication-output-duplicate',
        'output',
        'use unique output GUIDs and sourceKeys',
      );
    guids.add(guid);
    sourceKeys.add(output.sourceKey);
  }
  if (outputs.length === 0 || assetPublicationOutputSetDigest(outputs) !== outputSetDigest)
    fail('asset-publication-output-set-mismatch', 'receipt', 'publish the complete output tuple');
  if (
    !assetPublicationReceiptMatches(publication) ||
    canonicalJson(receipt.externalEvidence) !== canonicalJson(publication.externalEvidence)
  )
    fail('asset-publication-receipt-mismatch', 'receipt', 'publish a receipt for the output tuple');
  if (
    accepted &&
    publication.generation <= accepted.generation &&
    (publication.generation !== accepted.generation ||
      !hasSameAuthoredPublicationIdentity(accepted, publication))
  )
    fail('asset-publication-stale', 'cancelled', 'retry against the current publication');
}

export function selectAuthoredPublicationGeneration(
  accepted: AssetPublicationEnvelope | undefined,
  candidate: AssetPublicationEnvelope | undefined,
): number {
  if (accepted === undefined) return 1;
  return hasSameAuthoredPublicationIdentity(accepted, candidate)
    ? accepted.generation
    : accepted.generation + 1;
}

async function stageDevPack(
  context: AuthoredPackPublicationContext,
  prepared: Pick<PreparedScriptablePack, 'product' | 'finalized'>,
  publication: AssetPublicationEnvelope,
  delivery?: 'direct',
) {
  const { draft } = context;
  const { finalized, product } = prepared;
  const transportRevision = `${product.inputFingerprint}:${finalized.sourceRevision}`.replace(
    /[^a-zA-Z0-9._-]/g,
    '-',
  );
  const pack = bindRuntimePackPublication(
    finalized.pack,
    context.scopeId ?? 'asset-runtime',
    publication,
  );
  const receipts = await materializePreparedScriptablePack(
    prepared,
    {
      packagePath: finalized.packageUrl,
      artifactPath: (path) => `${DEV_PACK_PREFIX}${path}`,
      receiptPath: (guid) =>
        `${DEV_PACK_PREFIX}${guid.toLowerCase()}.${transportRevision}.receipt.json`,
    },
    {
      writePackage: (path, body) => {
        draft.metaPackBodies.set(path, body);
      },
      writeArtifact: (path, bytes, mimeType) => {
        draft.devArtifactBodies.set(path, { bytes, mimeType });
      },
      writeReceipt: (path, body) => {
        draft.devArtifactBodies.set(path, {
          bytes: new TextEncoder().encode(body),
          mimeType: 'application/json',
        });
      },
    },
    pack,
    delivery,
  );
  return receipts;
}

function assertPublicationOpen(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw structuredPluginError({
    code: 'cleanup-failed',
    expected: 'the active production generation to remain open while publishing authored Packs',
    hint: 'discard the aborted candidate and retry the next generation',
    detail: { stage: 'cleanup', subject: 'authored-pack-publication' },
  });
}

export async function publishAuthoredDevPacks(
  raw: readonly PackIndexEntry[],
  context: AuthoredPackPublicationContext,
): Promise<PackIndexEntry[]> {
  const executors = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 1 });
  try {
    return await publishWithExecutors(raw, context, executors);
  } finally {
    await executors.dispose();
  }
}

async function publishWithExecutors(
  raw: readonly PackIndexEntry[],
  context: AuthoredPackPublicationContext,
  executors: ScriptablePackModuleExecutorPool,
): Promise<PackIndexEntry[]> {
  assertPublicationOpen(context.signal);
  const { draft } = context;
  // The candidate is replaced atomically with its routes and Catalog. Retain
  // generation fences for authored paths that disappear and later return.
  const publications = new Map(draft.authoredPublications);
  const accept = (publication: AssetPublicationEnvelope) => {
    validateAuthoredPublication(
      publication,
      draft.authoredPublications.get(publication.sourcePath),
    );
    publications.set(publication.sourcePath, publication);
  };
  const cookers = context.opts.cookers?.map((cooker) => {
    const discover = cooker.discover;
    const cacheIdentity = cooker.cacheIdentity;
    return {
      key: cooker.key,
      ...(cooker.concurrency === undefined ? {} : { concurrency: cooker.concurrency }),
      ...(cacheIdentity === undefined ? {} : { cacheIdentity: () => cacheIdentity.call(cooker) }),
      ...(discover === undefined
        ? {}
        : {
            discover(input: unknown) {
              assertPublicationOpen(context.signal);
              if (process.env.FORGEAX_WORKSPACE_TIMING === '1')
                return timeAuthoredPackRecipe('native-discover', cooker.key, input, () =>
                  discover.call(cooker, input),
                );
              return discover.call(cooker, input);
            },
          }),
      cook(input: unknown) {
        // Drain an accepted cook, but do not start another output after close.
        assertPublicationOpen(context.signal);
        if (process.env.FORGEAX_WORKSPACE_TIMING === '1')
          return timeAuthoredPackRecipe('native-cook', cooker.key, input, () => cooker.cook(input));
        return cooker.cook(input);
      },
    };
  });
  const packages = new Map<
    string,
    {
      readonly publication: AssetPublicationEnvelope;
      readonly refs: ReadonlyMap<string, readonly string[]>;
      readonly receipts: ReadonlyMap<string, string>;
      readonly revision: PackIndexEntry['revision'];
      readonly projection: Record<string, unknown>;
    }
  >();
  const stage = async (
    url: string,
    prepared: Pick<PreparedScriptablePack, 'product' | 'finalized' | 'revision'>,
    publication: AssetPublicationEnvelope,
    delivery?: 'direct',
  ) => {
    accept(publication);
    packages.set(url, {
      publication,
      revision: prepared.revision,
      refs: new Map(publication.outputs.map(({ guid, refs }) => [guid.toLowerCase(), refs])),
      receipts: await stageDevPack(context, prepared, publication, delivery),
      projection:
        delivery === 'direct' ? context.authoredCookedProjection : context.currentProjection,
    });
  };
  const dynamicPackEntries: PackIndexEntry[] = [];
  // Register every declared identity for lazy content reads. Snapshot owners
  // invoke their producer only when readByGuid requests one of their outputs.
  const declaredGuids = [
    ...raw.map((entry) => entry.guid),
    ...[...context.sourceDeclarations.values()].flatMap((declaration) =>
      declaration.format === 'meta.json'
        ? declaration.value.subAssets.map((asset) => asset.guid)
        : [],
    ),
  ].map((guid) => {
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw structuredPluginError(parsed.error);
    return parsed.value;
  });
  const availableGuids = new Set(declaredGuids.map((guid) => AssetGuid.format(guid).toLowerCase()));
  // ScriptablePack sources and v3 instances have no static output rows for the
  // scanner to publish. Build every current subject in one fixed-point pass,
  // then add the resulting rows to this generation's Catalog candidate. The
  // route still serves the ordinary Pack v2 transport produced by the shared
  // importer host.
  // First cook every subject at its accepted generation (or generation one for
  // a new subject). The complete candidate tuple can then be compared before
  // advancing only the subjects whose source or outputs changed.
  const sourceSnapshot = createScriptablePackSourceSnapshot();
  const packInputs = packDevInputs(
    context,
    (displaySourcePath) => draft.authoredPublications.get(displaySourcePath)?.generation ?? 1,
    context.opts.sourceIdentityFor,
    executors,
    context.opts.enginePackageRoot,
    sourceSnapshot,
  );
  if (packInputs.length > 0) {
    const dynamicSourcePaths = new Set(packInputs.map((input) => input.displaySourcePath));
    for (const entry of context.previousCatalogEntries ?? []) {
      if (
        dynamicSourcePaths.has(entry.sourcePath) &&
        entry.provenance?.provider === 'pack-ts' &&
        entry.execution === 'cooked'
      ) {
        draft.metaPackBodies.delete(entry.packageUrl);
      }
    }
    const assetSource = createDeclaredPackAssetSnapshotSource(
      context.sourceDeclarations,
      cookers ?? [],
      declaredGuids,
      {
        importerRegistry: context.importerRegistry,
        fsForImport: context.fsForImport,
      },
    );
    const produce = async (sources: readonly ScriptablePackInput[]) => {
      const producingAt = performance.now();
      const timing =
        process.env.FORGEAX_WORKSPACE_TIMING === '1'
          ? createAuthoredPackProgressTiming()
          : undefined;
      try {
        const prepared = await produceScriptablePackProducts({
          sources,
          ...(context.opts.ddc?.buildCacheRoot === undefined
            ? {}
            : { buildCacheRoot: context.opts.ddc.buildCacheRoot }),
          ...(context.opts.ddc?.buildCacheSeedRoot === undefined
            ? {}
            : { buildCacheSeedRoot: context.opts.ddc.buildCacheSeedRoot }),
          ...(context.opts.ddc?.identityRoot === undefined
            ? {}
            : { cacheIdentityRoot: context.opts.ddc.identityRoot }),
          ...(cookers === undefined ? {} : { cookers }),
          assetSource,
          availableGuids,
          onProgress: (event) => {
            timing?.onProgress(event);
            context.onProgress?.(event);
          },
        });
        if (!prepared.ok) throw dynamicPluginError(prepared.error);
        if (timing === undefined) publicationTiming('produce-and-cook', producingAt);
        timing?.finish();
        return prepared.value;
      } catch (failure) {
        timing?.finish(failure);
        throw failure;
      }
    };
    const preparePublications = async () => {
      let prepared = await produce(packInputs);
      const inputs = packInputs.map((input) => {
        const accepted = draft.authoredPublications.get(input.displaySourcePath);
        const probe = prepared.get(input.displaySourcePath)?.publication;
        const publicationGeneration = selectAuthoredPublicationGeneration(accepted, probe);
        return publicationGeneration === input.publicationGeneration
          ? input
          : { ...input, publicationGeneration };
      });
      const materialCooker = context.opts.cookers?.find(({ key }) => key === 'material');
      const changedMaterials =
        materialCooker === undefined
          ? []
          : inputs.filter(
              (input, index) =>
                input !== packInputs[index] &&
                prepared
                  .get(input.displaySourcePath)
                  ?.publication.outputs.some(({ kind }) => kind === 'material'),
            );
      const customCook =
        changedMaterials.length > 0 && materialCooker?.publicationGeneration !== 'metadata-only';
      if (customCook) prepared = await produce(inputs);
      else if (changedMaterials.length > 0) {
        const rebound = new Map(prepared);
        for (const input of changedMaterials) {
          const candidate = prepared.get(input.displaySourcePath);
          if (!candidate) throw new TypeError('missing prepared material Pack');
          const result = await rebindPreparedScriptablePack(input, candidate);
          if (!result.ok) throw dynamicPluginError(result.error);
          rebound.set(input.displaySourcePath, result.value);
        }
        prepared = rebound;
      }
      if (inputs.some((input, index) => input !== packInputs[index])) {
        const current = await sourceSnapshot.verify();
        if (!current.ok) throw dynamicPluginError(current.error);
      }
      return { prepared, inputs };
    };
    const { prepared: preparedScriptablePacks, inputs: finalInputs } = await preparePublications();
    for (const input of finalInputs) {
      assertPublicationOpen(context.signal);
      const prepared = preparedScriptablePacks.get(input.displaySourcePath);
      if (prepared === undefined) {
        throw structuredPluginError({
          code: 'catalog-declaration-missing',
          expected: 'the dynamic Pack generation to retain every current source subject',
          hint: 'rerun the source inventory and rebuild the accepted generation',
          detail: { stage: 'scan', sourcePath: input.sourcePath },
        });
      }
      const publication = preserveAcceptedPublicationGeneration(
        withAuthoredPublicationGeneration(prepared.publication, input.publicationGeneration),
        draft.authoredPublications.get(input.displaySourcePath),
      );
      const { product, finalized } = prepared;
      await stage(finalized.packageUrl, prepared, publication);
      dynamicPackEntries.push(
        ...projectPackBuildCatalog(
          product,
          input.displaySourcePath,
          input.subjectPackageId ?? input.definition.packageId,
          finalized.packageUrl,
        ),
      );
    }
  }
  for (const entry of raw) {
    assertPublicationOpen(context.signal);
    if (
      !entry.packageUrl.endsWith('.pack.json') ||
      entry.packageUrl.includes(DEV_PACK_PREFIX) ||
      packages.has(entry.packageUrl)
    ) {
      continue;
    }
    const sourceDeclaration = sourceDeclarationForCatalogPath(
      entry.sourcePath,
      context.sourceDeclarations,
      context.opts.sourceIdentityFor,
    );
    const sourcePath = sourceDeclaration?.sourcePath ?? resolve(process.cwd(), entry.sourcePath);
    const declaration = sourceDeclaration?.declaration;
    if (declaration?.format !== 'pack.json') {
      throw structuredPluginError({
        code: 'catalog-declaration-missing',
        expected: 'the scanner inventory to contain the authored Pack declaration',
        hint: 'rerun Pack inventory and publish only the accepted declaration set',
        detail: { stage: 'scan', sourcePath },
      });
    }
    const parsed = declaration.value;
    if (parsed.format !== 'direct') continue;
    const projected = projectDirectPackJson(parsed);
    const preparingAt = performance.now();
    const prepared = await prepareDirectPackTransport({
      projected,
      sourcePath,
      displaySourcePath: entry.sourcePath,
      sourceRevision: declaration.sourceRevision,
      availableGuids: new Set([
        ...availableGuids,
        ...dynamicPackEntries.map((candidate) => candidate.guid),
        ...declaredRuntimePackGuids(context.sourceDeclarations.values()),
      ]),
      ...(context.opts.cookers === undefined ? {} : { cookers: context.opts.cookers }),
      policy: {
        base: '/',
        packagePath: `__forgeax-ddc/${projected.packageId}${RUNTIME_PACK_SUFFIX}`,
        artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
        sink: () => {},
      },
    });
    publicationTiming('direct-pack', preparingAt, sourcePath);
    if (!prepared.ok) throw dynamicPluginError(prepared.error);
    const generation = (draft.authoredPublications.get(entry.sourcePath)?.generation ?? 0) + 1;
    const publication = preserveAcceptedPublicationGeneration(
      projectPreparedPackPublication(prepared.value, entry.sourcePath, generation),
      draft.authoredPublications.get(entry.sourcePath),
    );
    await stage(entry.packageUrl, prepared.value, publication, 'direct');
  }
  assertPublicationOpen(context.signal);
  const projected = [...raw, ...dynamicPackEntries].map((entry) => {
    const pkg = packages.get(entry.packageUrl);
    if (pkg === undefined) return entry;
    const { publication, receipts, revision, projection } = pkg;
    const packageUrl = publication.current?.packageUrl ?? entry.packageUrl;
    const guid = entry.guid.toLowerCase();
    const refs = pkg.refs.get(guid);
    if (refs === undefined)
      return { ...entry, packageUrl, publication, ...context.directProjection };
    const cookReceiptUrl = receipts.get(guid);
    return {
      ...entry,
      packageUrl,
      ...projection,
      publication,
      refs,
      ...(cookReceiptUrl === undefined ? {} : { cookReceiptUrl }),
      ...(revision === undefined ? {} : { revision }),
    };
  });
  draft.authoredPublications = publications;
  return projected;
}
