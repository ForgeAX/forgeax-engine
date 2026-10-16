import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AcceptedPublicationStore,
  ScriptablePackPublicationSnapshot,
} from '@forgeax/engine-ddc';
import { createAcceptedPublication } from '@forgeax/engine-ddc';
import type { ImporterRegistry, ImportRunnerFs } from '@forgeax/engine-import';
import {
  canonicalScriptableSourcePath,
  createDeclaredPackAssetSnapshotSource,
  materializePreparedScriptablePack,
  prepareDirectPackTransport,
  prepareLegacyPackTransport,
  produceScriptablePackProducts,
  projectImportProductForBuild,
  projectMaterialPackTransport,
  type ScriptablePackInput,
} from '@forgeax/engine-import';
import {
  createRuntimePackPublication,
  packageTransportRevision,
  projectPackageCatalog,
} from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import {
  resolvePackSourceSubjects,
  type ScanSourceDeclaration,
  type ScriptablePackSourceDeclaration,
} from '@forgeax/engine-pack/scanner';
import {
  type PackBuildContextWithoutParameters,
  projectDirectPackJson,
} from '@forgeax/engine-pack/source';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
  type ScriptablePackModuleExecutorPool,
} from '@forgeax/engine-pack/source-node';
import type { AssetPublicationEnvelope, PackIndexEntry } from '@forgeax/engine-types';
import type { PluginPackInternalOptions } from '../plugin-contract.js';
import { structuredPluginError } from '../structured-plugin-error.js';
import type { PluginServerState } from './plugin-server.js';
import { sourceDeclarationForCatalogPath } from './source-path.js';

export interface AuthoredPackPublicationContext {
  readonly opts: PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  readonly metaPackBodies: PluginServerState['metaPackBodies'];
  readonly devArtifactBodies: Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >;
  readonly publicationCandidates: Map<string, AssetPublicationEnvelope>;
  readonly importedGuids: Set<string>;
  readonly publicationStore: AcceptedPublicationStore;
  /** Accepted rows, used to retire removed dynamic outputs on a new generation. */
  readonly previousCatalogEntries?: readonly PackIndexEntry[];
  readonly scopeId?: string;
  readonly signal?: AbortSignal;
  readonly sourceDeclarations: ReadonlyMap<string, ScanSourceDeclaration>;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly currentProjection: Record<string, unknown>;
  readonly directProjection: Record<string, unknown>;
  readonly authoredCookedProjection: Record<string, unknown>;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

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

function packCatalogSourcePath(
  sourcePath: string,
  sourceIdentityFor: ((sourcePath: string) => string) | undefined,
): string {
  const projected = sourceIdentityFor?.(sourcePath);
  const logical =
    projected === undefined || isAbsolute(projected)
      ? relative(process.cwd(), sourcePath)
      : projected;
  return canonicalScriptableSourcePath(logical).replaceAll('\\', '/');
}

async function packDevInputs(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  generationFor: (displaySourcePath: string) => number,
  sourceIdentityFor: ((sourcePath: string) => string) | undefined,
  executors: ScriptablePackModuleExecutorPool,
): Promise<
  | {
      readonly ok: true;
      readonly value: { readonly inputs: readonly ScriptablePackInput[] };
    }
  | { readonly ok: false; readonly error: unknown }
> {
  const subjects = await resolvePackSourceSubjects(declarations);
  if (!subjects.ok) return subjects;

  // Inventory is metadata only. Acquire a fresh module lease when the worklist
  // actually builds it, then return the worker through loadScriptablePack's
  // existing completion/failure fence. Retries and instances each get a lease.
  const definitionFor = (subject: ScriptablePackSourceDeclaration) => ({
    ...subject.definition,
    async build(context: PackBuildContextWithoutParameters) {
      const waitingAt = performance.now();
      const executor = await executors.acquire();
      publicationTiming('worker-acquire', waitingAt, subject.sourcePath);
      const loadingAt = performance.now();
      const loaded = await loadScriptablePack(subject.sourcePath, { executor });
      publicationTiming('module-load', loadingAt, subject.sourcePath);
      if (!loaded.ok) throw loaded.error;
      if (
        PackageId.format(loaded.value.packageId) !== PackageId.format(subject.definition.packageId)
      ) {
        await executor.dispose?.('failure');
        throw {
          code: 'pack-source-revision-conflict',
          expected: 'the ScriptablePack packageId to remain fixed during publication',
          hint: 'retry after source writes settle and rebuild the current generation',
          detail: {
            sourcePath: subject.sourcePath,
            scannedPackageId: PackageId.format(subject.definition.packageId),
            loadedPackageId: PackageId.format(loaded.value.packageId),
          },
        };
      }
      const buildingAt = performance.now();
      try {
        return await loaded.value.build(context as never);
      } finally {
        publicationTiming('source-build', buildingAt, subject.sourcePath);
      }
    },
  });

  const policy =
    (packageId: PackageId): ScriptablePackInput['policy'] =>
    (product) => {
      const transportRevision = `${product.inputFingerprint}:${packageTransportRevision(
        projectImportProductForBuild(product.product),
      )}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      return {
        base: '/',
        packagePath:
          `${DEV_PACK_PREFIX}${PackageId.format(packageId)}.${transportRevision}.pack.json`.replace(
            /^\/+/,
            '',
          ),
        artifactPath: (guid, key) =>
          `${guid.toLowerCase()}/${transportRevision}/${key.includes('.') ? key : `${key}.bin`}`,
      };
    };
  const inputs: ScriptablePackInput[] = [];
  for (const source of subjects.value.sources) {
    const displaySourcePath = packCatalogSourcePath(source.sourcePath, sourceIdentityFor);
    inputs.push({
      sourcePath: source.sourcePath,
      displaySourcePath,
      definition: definitionFor(source),
      sourceClosure: source.sourceClosure,
      publicationGeneration: generationFor(displaySourcePath),
      policy: policy(source.definition.packageId),
    });
  }
  for (const instance of subjects.value.instances) {
    const displaySourcePath = packCatalogSourcePath(instance.sourcePath, sourceIdentityFor);
    inputs.push({
      sourcePath: instance.sourcePath,
      displaySourcePath,
      definition: definitionFor(instance.root),
      sourceClosure: instance.root.sourceClosure,
      subjectPackageId: instance.packageId,
      values: instance.values,
      publicationGeneration: generationFor(displaySourcePath),
      policy: policy(instance.packageId),
    });
  }

  return { ok: true, value: { inputs } };
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
  snapshot: ScriptablePackPublicationSnapshot,
): AssetPublicationEnvelope {
  const accepted = snapshot.current;
  if (
    accepted === undefined ||
    accepted.sourcePath !== publication.sourcePath ||
    accepted.sourceRevision !== publication.sourceRevision ||
    accepted.digest !== publication.digest ||
    accepted.outputSetDigest !== publication.outputSetDigest ||
    accepted.generation === publication.generation
  ) {
    return publication;
  }
  return {
    ...publication,
    generation: accepted.generation,
    ...(publication.current === undefined
      ? {}
      : { current: { ...publication.current, generation: accepted.generation } }),
  };
}

function hasSameAuthoredPublicationIdentity(
  accepted: AssetPublicationEnvelope | undefined,
  candidate: AssetPublicationEnvelope | undefined,
): boolean {
  if (
    accepted === undefined ||
    candidate === undefined ||
    accepted.sourcePath !== candidate.sourcePath ||
    accepted.sourceRevision !== candidate.sourceRevision ||
    accepted.outputSetDigest !== candidate.outputSetDigest ||
    accepted.digest !== candidate.digest
  ) {
    return false;
  }
  return true;
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
  const cookers = context.opts.cookers?.map((cooker) => {
    const discover = cooker.discover;
    const cacheIdentity = cooker.cacheIdentity;
    return {
      key: cooker.key,
      ...(cacheIdentity === undefined ? {} : { cacheIdentity: () => cacheIdentity.call(cooker) }),
      ...(discover === undefined
        ? {}
        : {
            discover(input: unknown) {
              assertPublicationOpen(context.signal);
              return discover.call(cooker, input);
            },
          }),
      cook(input: unknown) {
        // Drain an accepted cook, but do not start another output after close.
        assertPublicationOpen(context.signal);
        return cooker.cook(input);
      },
    };
  });
  const published = new Map<string, string>();
  const stagedPackBodies = new Map<string, string>();
  const stagedArtifactBodies = new Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >();
  const cookedRefs = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const cookReceiptUrls = new Map<string, ReadonlyMap<string, string>>();
  const authoredRevisions = new Map<string, PackIndexEntry['revision']>();
  const authoredPublications = new Map<string, AssetPublicationEnvelope>();
  const dynamicPackEntries: PackIndexEntry[] = [];
  const requiredGuids = raw.map((entry) => {
    const parsed = AssetGuid.parse(entry.guid);
    if (!parsed.ok) throw structuredPluginError(parsed.error);
    return parsed.value;
  });
  // Catalog-declared Meta outputs prove identity for direct Pack refs, but
  // they are not all content dependencies of a ScriptablePack build. Keep
  // that availability set separate from required content reads so an
  // unrelated procedural stub is not imported merely because it is scanned.
  const availableGuids = new Set([
    ...requiredGuids.map((guid) => AssetGuid.format(guid).toLowerCase()),
    ...[...context.sourceDeclarations.values()].flatMap((declaration) =>
      declaration.format === 'meta.json'
        ? declaration.value.subAssets.map((asset) => asset.guid.toLowerCase())
        : [],
    ),
  ]);
  // ScriptablePack sources and v3 instances have no static output rows for the
  // scanner to publish. Build every current subject in one fixed-point pass,
  // then add the resulting rows to this generation's Catalog candidate. The
  // route still serves the ordinary Pack v2 transport produced by the shared
  // importer host.
  // First cook every subject at its accepted generation (or generation one for
  // a new subject). The complete candidate tuple can then be compared before
  // advancing only the subjects whose source or outputs changed.
  const probeInputsResult = await packDevInputs(
    context.sourceDeclarations,
    (displaySourcePath) =>
      context.publicationStore.observe(displaySourcePath).current?.generation ?? 1,
    context.opts.sourceIdentityFor,
    executors,
  );
  if (!probeInputsResult.ok) throw dynamicPluginError(probeInputsResult.error);
  let packInputs = probeInputsResult.value.inputs;
  if (packInputs.length > 0) {
    const dynamicSourcePaths = new Set(packInputs.map((input) => input.displaySourcePath));
    for (const entry of context.previousCatalogEntries ?? []) {
      if (
        dynamicSourcePaths.has(entry.sourcePath) &&
        entry.provenance?.provider === 'pack-ts' &&
        entry.execution === 'cooked'
      ) {
        context.importedGuids.delete(entry.guid.toLowerCase());
        context.metaPackBodies.delete(entry.packageUrl);
      }
    }
    const assetSource = createDeclaredPackAssetSnapshotSource(
      context.sourceDeclarations,
      cookers ?? [],
      requiredGuids,
      {
        importerRegistry: context.importerRegistry,
        fsForImport: context.fsForImport,
      },
    );
    const produce = async (sources: readonly ScriptablePackInput[]) => {
      const producingAt = performance.now();
      const prepared = await produceScriptablePackProducts({
        sources,
        ...(context.opts.ddc?.buildCacheRoot === undefined
          ? {}
          : { buildCacheRoot: context.opts.ddc.buildCacheRoot }),
        ...(cookers === undefined ? {} : { cookers }),
        assetSource,
        availableGuids,
      });
      publicationTiming('produce-and-cook', producingAt);
      if (!prepared.ok) throw dynamicPluginError(prepared.error);
      return prepared.value;
    };
    let preparedScriptablePacks = await produce(packInputs);
    const generationFor = (displaySourcePath: string): number => {
      const accepted = context.publicationStore.observe(displaySourcePath).current;
      const probe = preparedScriptablePacks.get(displaySourcePath)?.publication;
      return selectAuthoredPublicationGeneration(accepted, probe);
    };
    if (
      packInputs.some(
        (input) => generationFor(input.displaySourcePath) !== input.publicationGeneration,
      )
    ) {
      const finalInputsResult = await packDevInputs(
        context.sourceDeclarations,
        generationFor,
        context.opts.sourceIdentityFor,
        executors,
      );
      if (!finalInputsResult.ok) throw dynamicPluginError(finalInputsResult.error);
      packInputs = finalInputsResult.value.inputs;
      preparedScriptablePacks = await produce(packInputs);
    }
    for (const input of packInputs) {
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
        prepared.publication,
        context.publicationStore.observe(input.displaySourcePath),
      );
      const { product, finalized, facts, revision } = prepared;
      const transportRevision = `${product.inputFingerprint}:${finalized.sourceRevision}`.replace(
        /[^a-zA-Z0-9._-]/g,
        '-',
      );
      const receiptUrls = await materializePreparedScriptablePack(
        prepared,
        {
          packagePath: finalized.packageUrl,
          artifactPath: (path) => `${DEV_PACK_PREFIX}${path}`,
          receiptPath: (guid) =>
            `${DEV_PACK_PREFIX}${guid.toLowerCase()}.${transportRevision}.receipt.json`,
        },
        {
          writePackage: (path, body) => {
            stagedPackBodies.set(path, body);
          },
          writeArtifact: (path, bytes, mimeType) => {
            stagedArtifactBodies.set(path, { bytes, mimeType });
          },
          writeReceipt: (path, body) => {
            stagedArtifactBodies.set(path, {
              bytes: new TextEncoder().encode(body),
              mimeType: 'application/json',
            });
          },
        },
      );
      const runtimePublication = createRuntimePackPublication({
        pack: { assets: finalized.pack.assets },
        scopeId: context.scopeId ?? 'asset-runtime',
        sourcePath: publication.sourcePath,
        sourceRevision: publication.sourceRevision,
        packageUrl: finalized.packageUrl,
        inputFingerprint: publication.receipt.inputFingerprint,
        digest: finalized.digest,
        generation: publication.generation,
        outputs: facts.outputs,
        externalEvidence: publication.externalEvidence,
      });
      stagedPackBodies.set(
        finalized.packageUrl,
        JSON.stringify(projectMaterialPackTransport(runtimePublication.pack)),
      );
      const accepted = context.publicationStore.stage(input.displaySourcePath, {
        envelope: publication,
      });
      assertPublicationOpen(context.signal);
      if (!accepted.ok) {
        throw structuredPluginError({
          code: accepted.error.code,
          expected: 'DDC to accept the dynamic Pack publication tuple',
          hint: accepted.error.reason,
          detail: { stage: accepted.error.stage, sourcePath: input.displaySourcePath },
        });
      }
      context.publicationCandidates.set(input.displaySourcePath, publication);
      const stagedByGuid = new Map(
        product.stagedOutputs.map((output) => [
          AssetGuid.format(output.guid).toLowerCase(),
          output,
        ]),
      );
      const projected = projectPackageCatalog(
        product.product.assets.map((asset, sourceIndex) => {
          const staged = stagedByGuid.get(asset.guid.toLowerCase());
          return {
            guid: asset.guid,
            kind: asset.kind,
            sourcePath: input.displaySourcePath,
            sourceIndex,
            ...(staged?.sourceKey === undefined ? {} : { sourceKey: staged.sourceKey }),
            refs: asset.refs.map((reference) => reference.guid),
            execution: 'cooked' as const,
            packageId: PackageId.format(input.subjectPackageId ?? input.definition.packageId),
            provenance: { provider: 'pack-ts', version: '2.0.0' },
          };
        }),
        finalized.packageUrl,
      ).map((entry) => {
        const cookReceiptUrl = receiptUrls.get(entry.guid.toLowerCase());
        return {
          ...entry,
          ...(cookReceiptUrl === undefined ? {} : { cookReceiptUrl }),
          revision,
          publication: runtimePublication.publication,
          ...context.currentProjection,
          refs: facts.refs.get(entry.guid.toLowerCase()) ?? [],
        };
      });
      dynamicPackEntries.push(...projected);
    }
  }
  for (const entry of raw) {
    assertPublicationOpen(context.signal);
    if (
      !entry.packageUrl.endsWith('.pack.json') ||
      entry.packageUrl.includes(DEV_PACK_PREFIX) ||
      published.has(entry.packageUrl)
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
    if (declaration.value.schemaVersion === '3.0.0') {
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
        ]),
        ...(context.opts.cookers === undefined ? {} : { cookers: context.opts.cookers }),
        policy: {
          base: '/',
          packagePath: `__forgeax-ddc/${projected.packageId}.pack.json`,
          artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
          sink: () => {},
        },
      });
      publicationTiming('direct-pack', preparingAt, sourcePath);
      if (!prepared.ok) throw dynamicPluginError(prepared.error);
      const { product, finalized, facts, revision } = prepared.value;
      const transportRevision = `${product.inputFingerprint}:${packageTransportRevision(
        projectImportProductForBuild(product.product),
      )}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      const generation =
        (context.publicationStore.observe(entry.sourcePath).current?.generation ?? 0) + 1;
      const candidate = createAcceptedPublication({
        sourcePath: entry.sourcePath,
        sourceRevision: product.inputFingerprint,
        generation,
        digest: finalized.digest,
        packageUrl: finalized.packageUrl,
        inputFingerprint: product.inputFingerprint,
        outputs: facts.outputs,
        externalEvidence: product.externalEvidence,
      });
      const publication = preserveAcceptedPublicationGeneration(
        candidate,
        context.publicationStore.observe(entry.sourcePath),
      );
      const accepted = context.publicationStore.stage(entry.sourcePath, {
        envelope: publication,
      });
      assertPublicationOpen(context.signal);
      if (!accepted.ok) {
        throw structuredPluginError({
          code: accepted.error.code,
          expected: 'DDC to accept the direct Pack publication tuple',
          hint: accepted.error.reason,
          detail: { stage: accepted.error.stage, sourcePath: entry.sourcePath },
        });
      }
      context.publicationCandidates.set(entry.sourcePath, publication);
      const runtimePublication = createRuntimePackPublication({
        pack: { assets: finalized.pack.assets },
        scopeId: context.scopeId ?? 'asset-runtime',
        sourcePath: publication.sourcePath,
        sourceRevision: publication.sourceRevision,
        packageUrl: finalized.packageUrl,
        inputFingerprint: publication.receipt.inputFingerprint,
        digest: finalized.digest,
        generation: publication.generation,
        outputs: facts.outputs,
        externalEvidence: publication.externalEvidence,
      });
      published.set(entry.packageUrl, finalized.packageUrl);
      authoredPublications.set(entry.packageUrl, runtimePublication.publication);
      authoredRevisions.set(entry.packageUrl, revision);
      stagedPackBodies.set(
        finalized.packageUrl,
        JSON.stringify(projectMaterialPackTransport(runtimePublication.pack)),
      );
      for (const artifact of finalized.artifacts) {
        stagedArtifactBodies.set(`${DEV_PACK_PREFIX}${artifact.path}`, {
          bytes: artifact.bytes,
          mimeType: artifact.mediaType,
        });
      }
      const receipts = new Map<string, string>();
      for (const receipt of product.product.receipts) {
        const guid = receipt.guid.toLowerCase();
        const receiptUrl = `${DEV_PACK_PREFIX}${guid}.${transportRevision}.receipt.json`;
        stagedArtifactBodies.set(receiptUrl, {
          bytes: new TextEncoder().encode(
            JSON.stringify({ ...receipt, outputDigest: finalized.digest }),
          ),
          mimeType: 'application/json',
        });
        receipts.set(guid, receiptUrl);
      }
      cookReceiptUrls.set(entry.packageUrl, receipts);
      cookedRefs.set(entry.packageUrl, facts.refs);
      continue;
    }
    const preparingAt = performance.now();
    const prepared = await prepareLegacyPackTransport(
      declaration.value,
      context.opts.cookers,
      (guid) => ({
        base: '/',
        packagePath: `${DEV_PACK_PREFIX}${guid}.pack.json`.replace(/^\/+/, ''),
        artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
      }),
      sourcePath,
    );
    publicationTiming('legacy-pack', preparingAt, sourcePath);
    const firstGuid = prepared.firstGuid;
    if (firstGuid === undefined) continue;
    assertPublicationOpen(context.signal);
    const packageUrl = `${DEV_PACK_PREFIX}${firstGuid}.pack.json`;
    published.set(entry.packageUrl, packageUrl);
    const authoredPack = prepared.finalized?.pack ?? {
      schemaVersion: '2.0.0' as const,
      kind: 'internal-text-package' as const,
      assets: declaration.value.assets.map((asset) => ({
        guid: asset.guid,
        kind: asset.kind,
        ...(asset.name === undefined ? {} : { name: asset.name }),
        payload: asset.payload,
        refs: asset.refs,
        artifacts: asset.artifacts ?? {},
      })),
    };
    const runtimePublication = createRuntimePackPublication({
      pack: { assets: authoredPack.assets },
      sourceKeys: new Map(
        declaration.value.assets.flatMap((asset) =>
          asset.sourceKey === undefined ? [] : [[asset.guid.toLowerCase(), asset.sourceKey]],
        ),
      ),
      scopeId: context.scopeId ?? 'asset-runtime',
      sourcePath: entry.sourcePath,
      sourceRevision: declaration.sourceRevision,
      packageUrl,
      ...(prepared.finalized?.digest === undefined ? {} : { digest: prepared.finalized.digest }),
    });
    authoredPublications.set(entry.packageUrl, runtimePublication.publication);
    const finalPackageUrl = prepared.finalized?.packageUrl ?? packageUrl;
    stagedPackBodies.set(
      finalPackageUrl,
      JSON.stringify(projectMaterialPackTransport(runtimePublication.pack)),
    );
    if (prepared.finalized !== undefined) {
      for (const artifact of prepared.finalized.artifacts) {
        stagedArtifactBodies.set(`${DEV_PACK_PREFIX}${artifact.path}`, {
          bytes: artifact.bytes,
          mimeType: artifact.mediaType,
        });
      }
    }
    published.set(entry.packageUrl, finalPackageUrl);
    cookedRefs.set(entry.packageUrl, prepared.cooked?.refsByGuid ?? new Map());
  }
  const projected = [...raw, ...dynamicPackEntries].map((entry) => {
    const packageUrl = published.get(entry.packageUrl);
    if (packageUrl === undefined) return entry;
    const refs = cookedRefs.get(entry.packageUrl)?.get(entry.guid.toLowerCase());
    if (refs !== undefined) {
      const publication = authoredPublications.get(entry.packageUrl);
      const cookReceiptUrl = cookReceiptUrls.get(entry.packageUrl)?.get(entry.guid.toLowerCase());
      const revision = authoredRevisions.get(entry.packageUrl);
      return {
        ...entry,
        packageUrl,
        ...context.authoredCookedProjection,
        ...(publication === undefined ? {} : { publication }),
        refs,
        ...(cookReceiptUrl === undefined ? {} : { cookReceiptUrl }),
        ...(revision === undefined ? {} : { revision }),
      };
    }
    const publication = authoredPublications.get(entry.packageUrl);
    return publication === undefined
      ? { ...entry, packageUrl, ...context.directProjection }
      : { ...entry, packageUrl, publication, ...context.directProjection };
  });
  for (const [url, body] of stagedPackBodies) context.metaPackBodies.set(url, body);
  assertPublicationOpen(context.signal);
  for (const [url, body] of stagedArtifactBodies) context.devArtifactBodies.set(url, body);
  for (const entry of projected) {
    if (entry.packageUrl.startsWith(DEV_PACK_PREFIX)) {
      context.importedGuids.add(entry.guid.toLowerCase());
    }
  }
  return projected;
}
