import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import {
  type AnyScriptablePackDefinition,
  AssetGuid,
  executePackBuild,
  isScriptablePackAssetKind,
  isValidPackSourceKey,
  type PackAuthoringError,
  PackageId,
  type PackBuildContextWithoutParameters,
  type PackBuildContextWithParameters,
  type PackCookSource,
  type PackOutput,
  type PackOutputMap,
  type PackParameterDefinition,
  type PackParameterValue,
  type ParticleEffectAssetSource,
  type PluginAssetSource,
  packSourceKeyFailure,
  resolvePackParameterValues,
} from '@forgeax/engine-pack/source';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  AssetRef,
  ImportedAsset,
  Result,
} from '@forgeax/engine-types';
import { AssetError, err, ImportError, ok } from '@forgeax/engine-types';
import {
  createImportProduct,
  type ImportAssetProduct,
  type TerminalImportProduct,
} from './import-product.js';
import { orderedPackPreparation } from './ordered-pack-preparation.js';
import type {
  AssetOutputProducer,
  AssetOutputProducerRegistry,
  PackBuildProduct,
  ScriptablePackAssetSnapshotSource,
  ScriptablePackDomainError,
  ScriptablePackSourceClosureEntry,
  ScriptablePackStagedOutput,
} from './scriptable-pack.js';
import { scriptablePackFingerprintAsync as digest } from './scriptable-pack-fingerprint.js';
import { materialAssetOutputProducer } from './scriptable-pack-output-producers.js';

export interface ScriptablePackBuildOptions {
  readonly definition: AnyScriptablePackDefinition;
  readonly sourcePath: string;
  readonly projectRoot?: string;
  /** Instance identity. Omitted for a root source and defaults to definition.packageId. */
  readonly subjectPackageId?: PackageId;
  /** Sparse instance values; defaults are applied before build. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Effective parent values supplied by the inheritance resolver. */
  readonly inheritedValues?: Readonly<Record<string, PackParameterValue>>;
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  readonly outputs: AssetOutputProducerRegistry;
  /** Optional build-time cookers for authored producer outputs that need artifacts. */
  readonly cookers?: Pick<NativeCookerRegistry, 'get' | 'runDraft'>;
  readonly sourceClosure?: readonly ScriptablePackSourceClosureEntry[];
  readonly authoringContractVersion?: string;
  /** Known published GUIDs used for the optional global reference gate. */
  readonly availableGuids?: ReadonlySet<string>;
  /** Worklist mode defers reference closure until every subject is materialized. */
  readonly deferReferenceValidation?: boolean;
  readonly publication?: AssetPublicationEnvelope;
  /** Producer-owned generation shared with every cooked output receipt. */
  readonly publicationGeneration?: number;
}

export interface ScriptablePackBuildProduct extends PackBuildProduct {
  readonly publication?: AssetPublicationEnvelope;
}

export type ScriptablePackBuildResult = Result<
  ScriptablePackBuildProduct,
  | PackAuthoringError
  | ScriptablePackDomainError
  | AssetError
  | ImportError
  | {
      readonly code: string;
      readonly expected: string;
      readonly hint: string;
      readonly detail?: unknown;
    }
>;

interface ObservedRead {
  readonly guid: string;
  readonly asset: PackOutput;
  readonly generation: number;
  readonly digest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAsset(value: unknown): value is Asset | PluginAssetSource | ParticleEffectAssetSource {
  return record(value) && typeof value.kind === 'string' && isScriptablePackAssetKind(value.kind);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function observedReader(source: ScriptablePackAssetSnapshotSource | undefined): {
  readonly reader: {
    readByGuid<TAsset extends PackOutput = Asset>(
      guid: AssetGuidType,
    ): Promise<Result<TAsset, unknown>>;
  };
  readonly reads: ReadonlyMap<string, ObservedRead>;
} {
  const reads = new Map<string, ObservedRead>();
  const reader = {
    async readByGuid<TAsset extends PackOutput = Asset>(
      guid: AssetGuidType,
    ): Promise<Result<TAsset, unknown>> {
      const key = AssetGuid.format(guid).toLowerCase();
      const cached = reads.get(key);
      if (cached !== undefined) return ok(clone(cached.asset) as TAsset);
      if (source === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `a published Asset snapshot for content dependency ${key}`,
            hint: 'publish the dependency or remove the content read from the Pack build',
            detail: { sourcePath: key },
          }),
        );
      }
      const result = await source.readByGuid(guid);
      if (!result.ok) return result;
      const asset = clone(result.value.asset);
      reads.set(key, {
        guid: key,
        asset,
        generation: result.value.generation,
        digest: result.value.digest,
      });
      return ok(clone(asset) as TAsset);
    },
  };
  return { reader, reads };
}

function buildContext(
  packageId: PackageId,
  values: Readonly<Record<string, PackParameterValue>> | undefined,
  reader: ReturnType<typeof observedReader>['reader'],
):
  | PackBuildContextWithParameters<readonly [PackParameterDefinition, ...PackParameterDefinition[]]>
  | PackBuildContextWithoutParameters {
  if (values === undefined) return { packageId, readByGuid: reader.readByGuid };
  return { packageId, values, readByGuid: reader.readByGuid } as PackBuildContextWithParameters<
    readonly [PackParameterDefinition, ...PackParameterDefinition[]]
  >;
}

function sourceKeyFailure(sourcePath: string, sourceKey: unknown): PackAuthoringError {
  return packSourceKeyFailure(sourceKey, { sourcePath });
}

function outputValueError(
  sourcePath: string,
  sourceKey: string,
  expected: string,
  actual: unknown,
): PackAuthoringError {
  return {
    code: 'pack-parameter-invalid',
    expected,
    hint: 'repair the build output and rebuild the Pack from a fresh generation',
    detail: { sourcePath, sourceKey, actual: typeof actual === 'string' ? actual : typeof actual },
  };
}

function referenceError(
  code: 'pack-output-reference-missing' | 'pack-output-reference-conflict',
  sourcePath: string,
  guids: readonly string[],
): PackAuthoringError {
  return {
    code,
    expected:
      code === 'pack-output-reference-missing'
        ? 'every output reference to resolve to a local or published AssetGuid'
        : 'removed output GUIDs to have no incoming references',
    hint:
      code === 'pack-output-reference-missing'
        ? 'build or publish the referenced Pack before verifying this output'
        : 'migrate incoming references before publishing the topology change',
    detail: { sourcePath, guids: [...guids].sort() },
  };
}

function productError(
  sourcePath: string,
  sourceKey: string,
  producer: Pick<AssetOutputProducer, 'kind'>,
  product: unknown,
): PackAuthoringError | undefined {
  if (!record(product)) {
    return outputValueError(
      sourcePath,
      sourceKey,
      `producer ${producer.kind} to return an asset product object`,
      product,
    );
  }
  if (!Array.isArray(product.refs)) {
    return outputValueError(
      sourcePath,
      sourceKey,
      `producer ${producer.kind} to return a refs array`,
      product.refs,
    );
  }
  if (!record(product.artifacts)) {
    return outputValueError(
      sourcePath,
      sourceKey,
      `producer ${producer.kind} to return an artifacts object`,
      product.artifacts,
    );
  }
  const payload = product.payload;
  if (!record(payload) || payload.kind !== producer.kind) {
    return outputValueError(
      sourcePath,
      sourceKey,
      `producer ${producer.kind} to return a matching payload kind`,
      payload,
    );
  }
  for (const ref of product.refs) {
    if (!record(ref) || typeof ref.guid !== 'string' || !AssetGuid.parse(ref.guid).ok) {
      return outputValueError(
        sourcePath,
        sourceKey,
        'producer refs to contain valid AssetGuid values',
        ref,
      );
    }
  }
  for (const [key, artifact] of Object.entries(product.artifacts)) {
    if (
      key.length === 0 ||
      key.startsWith('/') ||
      key.includes('..') ||
      key.includes('\\') ||
      !record(artifact) ||
      typeof artifact.mediaType !== 'string' ||
      !(artifact.bytes instanceof Uint8Array)
    ) {
      return outputValueError(
        sourcePath,
        sourceKey,
        'asset-local artifacts with safe keys and bytes',
        key,
      );
    }
  }
  return undefined;
}

function errorCode(value: unknown): string | undefined {
  return record(value) && typeof value.code === 'string' ? value.code : undefined;
}

function normalizedGuidSet(value: ReadonlySet<string> | undefined): Set<string> | undefined {
  return value === undefined ? undefined : new Set([...value].map((guid) => guid.toLowerCase()));
}
type ScriptablePackBuildFailure = Extract<
  ScriptablePackBuildResult,
  { readonly ok: false }
>['error'];

/** One authored output projected to its imported form and optional native cook fingerprint. */
interface ProducedOutput {
  readonly imported: ImportedAsset<unknown>;
  readonly nativeFingerprint: string | undefined;
}

function effectiveParameterValues(
  options: ScriptablePackBuildOptions,
): Result<Readonly<Record<string, PackParameterValue>> | undefined, ScriptablePackBuildFailure> {
  if ('parameters' in options.definition) {
    const resolved = resolvePackParameterValues(
      options.definition,
      options.values ?? {},
      options.inheritedValues,
    );
    if (!resolved.ok) return resolved;
    return ok(resolved.value);
  }
  if (options.values !== undefined && Object.keys(options.values).length > 0) {
    return err(
      outputValueError(
        options.sourcePath,
        '$.values',
        'zero-parameter Packs to omit values and instance capabilities',
        options.values,
      ),
    );
  }
  if (
    options.subjectPackageId !== undefined &&
    PackageId.format(options.subjectPackageId).toLowerCase() !==
      PackageId.format(options.definition.packageId).toLowerCase()
  ) {
    return err({
      code: 'pack-parent-has-no-parameters',
      expected: 'a ScriptablePack source with parameters for an independent instance packageId',
      hint: 'use clone for a zero-parameter Pack instead of building it as an instance',
      detail: {
        sourcePath: options.sourcePath,
        rootPackageId: PackageId.format(options.definition.packageId),
        subjectPackageId: PackageId.format(options.subjectPackageId),
      },
    });
  }
  return ok(undefined);
}

/** Whether an author throw already carries the structured error fields as own data properties. */
function structuredThrow(cause: Record<string, unknown>): PropertyDescriptorMap | undefined {
  let fields: PropertyDescriptorMap | undefined;
  try {
    fields = Object.getOwnPropertyDescriptors(cause);
  } catch {
    // Opaque author objects retain the ordinary unknown-throw fallback.
  }
  return typeof fields?.code?.value === 'string' &&
    typeof fields?.expected?.value === 'string' &&
    typeof fields?.hint?.value === 'string' &&
    (fields?.detail === undefined || 'value' in fields.detail)
    ? fields
    : undefined;
}

function thrownBuildFailure(cause: unknown, sourcePath: string): ScriptablePackBuildFailure {
  const fields = record(cause) ? structuredThrow(cause) : undefined;
  if (fields !== undefined) {
    if (fields.code?.value === 'pack-source-key-invalid') {
      const value: unknown = fields.detail?.value;
      const detail = record(value) ? value : {};
      return packSourceKeyFailure(detail.sourceKey, { ...detail, sourcePath });
    }
    return cause as unknown as ScriptablePackDomainError;
  }
  return new ImportError({
    code: 'import-internal-error',
    expected: 'Pack build to return a structured Result without throwing',
    hint: 'repair the authoring function and return err(...) for expected failures',
    detail: {
      reason: `${sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    },
  });
}

async function runPackBuild(
  options: ScriptablePackBuildOptions,
  subjectPackageId: PackageId,
  effectiveValues: Readonly<Record<string, PackParameterValue>> | undefined,
  reader: ReturnType<typeof observedReader>['reader'],
): Promise<Result<PackOutputMap, ScriptablePackBuildFailure>> {
  let built: Result<PackOutputMap, unknown>;
  try {
    const context = buildContext(subjectPackageId, effectiveValues, reader);
    built = await executePackBuild(options.definition, context);
  } catch (cause) {
    return err(thrownBuildFailure(cause, options.sourcePath));
  }
  if (!record(built) || typeof built.ok !== 'boolean') {
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: 'Pack build to return a Result object',
        hint: 'return ok(sourceKeyToAsset) or err(structuredError) from the authoring function',
        detail: { reason: `${options.sourcePath}: malformed build result` },
      }),
    );
  }
  if (!built.ok) {
    if (errorCode(built.error) !== undefined) return err(built.error as never);
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: 'a structured Pack build error',
        hint: 'return an error carrying code, expected, hint and detail',
        detail: { reason: `${options.sourcePath}: ${String(built.error)}` },
      }),
    );
  }
  if (!record(built.value)) {
    return err(
      outputValueError(
        options.sourcePath,
        '$',
        'build to return a sourceKey-to-Asset object',
        built.value,
      ),
    );
  }
  return ok(built.value);
}

function declaresCookedExecution(asset: PackOutput): asset is PackCookSource {
  return record(asset) && 'execution' in asset && asset.execution === 'cooked';
}

/** Reject outputs whose shape no producer path can own, before any identity is derived. */
function outputShapeFailure(
  options: ScriptablePackBuildOptions,
  sourceKey: string,
  asset: PackOutput,
): PackAuthoringError | undefined {
  const customSource = declaresCookedExecution(asset);
  if (
    customSource &&
    (typeof asset.kind !== 'string' ||
      asset.kind.trim().length === 0 ||
      isScriptablePackAssetKind(asset.kind) ||
      !('source' in asset) ||
      Object.keys(asset).some((key) => !['kind', 'execution', 'source'].includes(key)))
  ) {
    return outputValueError(
      options.sourcePath,
      sourceKey,
      'a custom kind with only execution: cooked and source; ordinary Assets use their standard producers',
      asset,
    );
  }
  if (!customSource && !isAsset(asset)) {
    return outputValueError(
      options.sourcePath,
      sourceKey,
      'a concrete Asset with a supported kind',
      asset,
    );
  }
  return undefined;
}

async function cookCustomOutput(
  options: ScriptablePackBuildOptions,
  sourceKey: string,
  guid: string,
  asset: PackCookSource,
): Promise<Result<ProducedOutput, ScriptablePackBuildFailure>> {
  const cookerRegistry = options.cookers;
  if (cookerRegistry === undefined)
    return err(
      outputValueError(
        options.sourcePath,
        sourceKey,
        'a producer-prepared Asset; runtime execution cannot cook source',
        asset,
      ),
    );
  const cooked = await cookerRegistry.runDraft(asset.kind, {
    guid,
    sourceKey,
    sourcePath: options.sourcePath,
    source: asset.source,
    refs: [],
  });
  if (!cooked.ok) return err(cooked.error);
  if (cooked.value.guid.toLowerCase() !== guid.toLowerCase())
    return err({
      code: 'pack-source-output-invalid',
      expected: 'the custom cooker to preserve the derived AssetGuid',
      hint: 'remove cooker-owned identity generation and retain the host GUID',
      detail: {
        sourcePath: options.sourcePath,
        sourceKey,
        expectedGuid: guid,
        actualGuid: cooked.value.guid,
      },
    });
  const product = {
    payload: cooked.value.payload,
    refs: cooked.value.refs.map((guid) => ({ guid })),
    artifacts: cooked.value.artifacts,
  };
  const invalid = productError(options.sourcePath, sourceKey, { kind: asset.kind }, product);
  if (invalid !== undefined) return err(invalid);
  return ok({
    imported: { guid, kind: asset.kind, ...product },
    nativeFingerprint: cooked.value.inputFingerprint,
  });
}

async function invokeOutputProducer(
  options: ScriptablePackBuildOptions,
  sourceKey: string,
  guid: string,
  asset: Asset | PluginAssetSource | ParticleEffectAssetSource,
  producer: AssetOutputProducer,
): Promise<Result<ImportAssetProduct<unknown>, ScriptablePackBuildFailure>> {
  const cookerRegistry = options.cookers;
  let produced: unknown;
  try {
    produced = await producer.produce({
      guid,
      sourceKey,
      asset,
      ...(cookerRegistry === undefined ? {} : { cookers: cookerRegistry }),
      sourcePath: options.sourcePath,
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    });
  } catch (cause) {
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: `producer ${producer.kind} to return a structured Result without throwing`,
        hint: 'repair the output producer and return err(...) for expected failures',
        detail: {
          reason: `${options.sourcePath}:${sourceKey}: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      }),
    );
  }
  if (!record(produced) || typeof produced.ok !== 'boolean') {
    return err(
      outputValueError(
        options.sourcePath,
        sourceKey,
        `producer ${producer.kind} to return a Result`,
        produced,
      ),
    );
  }
  if (!produced.ok) {
    if (errorCode(produced.error) !== undefined) return err(produced.error as never);
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: `producer ${producer.kind} to return a structured error`,
        hint: 'return an error carrying code, expected, hint and detail',
        detail: { reason: `${options.sourcePath}:${sourceKey}: ${String(produced.error)}` },
      }),
    );
  }
  const invalidProduct = productError(options.sourcePath, sourceKey, producer, produced.value);
  if (invalidProduct !== undefined) return err(invalidProduct);
  return ok(produced.value as ImportAssetProduct<unknown>);
}

/** Projected refs first, then cooker refs not already present (case-insensitive). */
function mergeCookerRefs(
  options: ScriptablePackBuildOptions,
  sourceKey: string,
  projectedRefs: readonly AssetRef[],
  cookerRefs: readonly string[],
): Result<AssetRef[], ScriptablePackBuildFailure> {
  const mergedRefs: AssetRef[] = [...projectedRefs];
  const seenRefs = new Set(mergedRefs.map((reference) => reference.guid.toLowerCase()));
  for (const cookerRef of cookerRefs) {
    const parsed = AssetGuid.parse(cookerRef);
    if (!parsed.ok) {
      return err({
        code: 'pack-source-output-invalid',
        expected: 'the authored material cooker refs to contain valid AssetGuid values',
        hint: 'repair the native material cooker refs and rebuild the Pack',
        detail: { sourcePath: options.sourcePath, sourceKey, ref: cookerRef },
      });
    }
    const formatted = AssetGuid.format(parsed.value);
    const normalizedRef = formatted.toLowerCase();
    if (seenRefs.has(normalizedRef)) continue;
    seenRefs.add(normalizedRef);
    mergedRefs.push({ guid: formatted });
  }
  return ok(mergedRefs);
}

async function cookAuthoredMaterial(
  options: ScriptablePackBuildOptions,
  sourceKey: string,
  guid: string,
  asset: Asset | PluginAssetSource | ParticleEffectAssetSource,
  product: ImportAssetProduct<unknown>,
  cookerRegistry: Pick<NativeCookerRegistry, 'get' | 'runDraft'>,
): Promise<Result<ProducedOutput, ScriptablePackBuildFailure>> {
  const cooked = await cookerRegistry.runDraft('material', {
    guid,
    source: asset,
    sourceKey,
    sourcePath: options.sourcePath,
    refs: product.refs.map((reference) => reference.guid),
    ...(options.publicationGeneration === undefined
      ? {}
      : { cookGeneration: options.publicationGeneration }),
  });
  if (!cooked.ok) return err(cooked.error);
  if (cooked.value.guid.toLowerCase() !== guid.toLowerCase()) {
    return err({
      code: 'pack-source-output-invalid',
      expected: 'the authored material cooker to preserve the derived AssetGuid',
      hint: 'repair the native material cooker output GUID and rebuild the Pack',
      detail: {
        sourcePath: options.sourcePath,
        sourceKey,
        expectedGuid: guid,
        actualGuid: cooked.value.guid,
      },
    });
  }
  // Native cooking owns shader/program composition, but the Pack output
  // producer owns the serialized wire shape. Re-project the cooked
  // material once so texture/sampler/parent values become refsIndex
  // entries again instead of leaking authored GUID strings into JSON.
  const cookedAsset = cooked.value.payload;
  if (!isAsset(cookedAsset) || cookedAsset.kind !== 'material') {
    return err({
      code: 'pack-source-output-invalid',
      expected: 'the authored material cooker to return a material payload',
      hint: 'repair the native material cooker payload and rebuild the Pack',
      detail: { sourcePath: options.sourcePath, sourceKey },
    });
  }
  const projected = await materialAssetOutputProducer.produce({
    guid,
    sourceKey,
    asset: cookedAsset,
  });
  if (!projected.ok) return err(projected.error);
  const projectedInvalid = productError(
    options.sourcePath,
    sourceKey,
    materialAssetOutputProducer,
    projected.value,
  );
  if (projectedInvalid !== undefined) return err(projectedInvalid);
  const refs = mergeCookerRefs(options, sourceKey, projected.value.refs, cooked.value.refs);
  if (!refs.ok) return refs;
  return ok({
    imported: {
      guid,
      kind: asset.kind,
      payload: projected.value.payload,
      refs: refs.value,
      artifacts: {
        ...product.artifacts,
        ...cooked.value.artifacts,
        ...projected.value.artifacts,
      },
    },
    nativeFingerprint: cooked.value.inputFingerprint,
  });
}

async function produceOrdinaryOutput(
  options: ScriptablePackBuildOptions,
  sourceKey: string,
  guid: string,
  asset: PackOutput,
): Promise<Result<ProducedOutput, ScriptablePackBuildFailure>> {
  // A custom source has been handled by its cooker; ordinary producers retain the closed Asset union.
  if (!isAsset(asset))
    return err(outputValueError(options.sourcePath, sourceKey, 'an ordinary Asset', asset));
  const producer = options.outputs.get(asset.kind);
  if (producer === undefined) {
    return err(
      outputValueError(
        options.sourcePath,
        sourceKey,
        `a registered output producer for ${asset.kind}`,
        asset.kind,
      ),
    );
  }
  const product = await invokeOutputProducer(options, sourceKey, guid, asset, producer);
  if (!product.ok) return product;
  const cookerRegistry = options.cookers;
  if (
    asset.kind === 'material' &&
    Array.isArray(asset.passes) &&
    cookerRegistry?.get('material') !== undefined
  ) {
    return cookAuthoredMaterial(options, sourceKey, guid, asset, product.value, cookerRegistry);
  }
  const { payload, refs, artifacts } = product.value;
  return ok({
    imported: { guid, kind: asset.kind, payload, refs, artifacts },
    nativeFingerprint: undefined,
  });
}

/** Lower-case GUIDs referenced by outputs that this Pack does not itself produce. */
function externalReferences(
  imported: readonly ImportedAsset<unknown>[],
  localGuids: ReadonlySet<string>,
): Set<string> {
  const referenced = new Set<string>();
  for (const asset of imported) {
    for (const ref of asset.refs) {
      const guid = ref.guid.toLowerCase();
      if (!localGuids.has(guid)) referenced.add(guid);
    }
  }
  return referenced;
}

function missingReferenceFailure(
  options: ScriptablePackBuildOptions,
  availableGuids: ReadonlySet<string> | undefined,
  referenced: ReadonlySet<string>,
): PackAuthoringError | undefined {
  if (options.deferReferenceValidation === true) return undefined;
  const missing = [...referenced].filter(
    (guid) => availableGuids !== undefined && !availableGuids.has(guid),
  );
  return missing.length > 0
    ? referenceError('pack-output-reference-missing', options.sourcePath, missing)
    : undefined;
}

function externalEvidenceFor(
  reads: ReadonlyMap<string, ObservedRead>,
  referenced: ReadonlySet<string>,
): AssetPublicationExternalEvidence[] {
  return [...reads.values()]
    .sort((left, right) => left.guid.localeCompare(right.guid))
    .map(
      (read): AssetPublicationExternalEvidence => ({
        guid: read.guid,
        usage: referenced.has(read.guid) ? 'both' : 'content',
        generation: read.generation,
        digest: read.digest,
      }),
    );
}

async function packInputFingerprint(
  options: ScriptablePackBuildOptions,
  subjectPackageId: PackageId,
  effectiveValues: Readonly<Record<string, PackParameterValue>> | undefined,
  externalEvidence: readonly AssetPublicationExternalEvidence[],
  nativeFingerprints: ReadonlyMap<string, string>,
): Promise<string> {
  const authoredInputFingerprint = await digest({
    packageId: PackageId.format(subjectPackageId),
    ...packRelativeIdentity(options.sourcePath, options.sourceClosure ?? []),
    values: effectiveValues,
    externalEvidence: externalEvidence.map(({ guid, usage, digest: evidenceDigest }) => ({
      guid,
      usage,
      digest: evidenceDigest,
    })),
    authoringContractVersion: options.authoringContractVersion ?? 'scriptable-pack/1',
    producerVersions: options.outputs.versions(),
  });
  if (nativeFingerprints.size === 0) return authoredInputFingerprint;
  return digest({
    sourceRevision: authoredInputFingerprint,
    nativeCookers: [...nativeFingerprints.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

function packImportProduct(
  options: ScriptablePackBuildOptions,
  imported: ImportedAsset<unknown>[],
  inputFingerprint: string,
) {
  const refs = imported.flatMap((asset) => asset.refs);
  const artifacts = Object.fromEntries(
    imported.flatMap((asset) =>
      Object.entries(asset.artifacts).map(([key, artifact]) => [`${asset.guid}/${key}`, artifact]),
    ),
  );
  return createImportProduct({
    assets: imported,
    sourceDependencies: (options.sourceClosure ?? []).map((entry) => entry.path),
    refs,
    artifacts,
    receipts: imported.map((asset) => ({
      guid: asset.guid,
      origin: 'authoredPack' as const,
      status: 'succeeded' as const,
      inputFingerprint,
    })),
    diagnostics: [],
    sourceRevision: inputFingerprint,
    sourceKey: options.sourcePath,
  });
}

/**
 * Execute a v2 Pack source and project its dynamic output map through the
 * existing importer producers. No output GUID or output manifest is read.
 */
export async function buildScriptablePack(
  options: ScriptablePackBuildOptions,
): Promise<ScriptablePackBuildResult> {
  const subjectPackageId = options.subjectPackageId ?? options.definition.packageId;
  const availableGuids = normalizedGuidSet(options.availableGuids);
  const observed = observedReader(options.assetSource);
  const values = effectiveParameterValues(options);
  if (!values.ok) return values;
  const effectiveValues = values.value;

  const built = await runPackBuild(options, subjectPackageId, effectiveValues, observed.reader);
  if (!built.ok) return built;

  const imported: ImportedAsset<unknown>[] = [];
  const stagedOutputs: ScriptablePackStagedOutput[] = [];
  const ownedOutputs = clone(built.value);
  const localGuids = new Set<string>();
  const nativeFingerprints = new Map<string, string>();
  const sourceKeys = Object.keys(built.value).sort();
  const parallel = (index: number): boolean => {
    const asset = ownedOutputs[sourceKeys[index] ?? ''];
    return (
      asset !== undefined &&
      (declaresCookedExecution(asset) ||
        (isAsset(asset) && asset.kind === 'material' && Array.isArray(asset.passes))) &&
      options.cookers?.get(asset.kind)?.concurrency === 'parallel'
    );
  };
  const produce = async (sourceKey: string) => {
    const asset = ownedOutputs[sourceKey];
    const raw: unknown = asset;
    // Without the plugin capability, keep ordinary outputs and omit plugin siblings.
    if (record(raw) && raw.kind === 'plugin' && options.definition.plugins !== true)
      return ok(undefined);
    if (!isValidPackSourceKey(sourceKey))
      return err(sourceKeyFailure(options.sourcePath, sourceKey));
    if (asset === undefined)
      return err(
        outputValueError(
          options.sourcePath,
          sourceKey,
          'a concrete Asset with a supported kind',
          asset,
        ),
      );
    const shapeFailure = outputShapeFailure(options, sourceKey, asset);
    if (shapeFailure !== undefined) return err(shapeFailure);
    const guid = AssetGuid.format(AssetGuid.derive(subjectPackageId, sourceKey));
    const normalizedGuid = guid.toLowerCase();
    if (localGuids.has(normalizedGuid) || availableGuids?.has(normalizedGuid)) {
      return err({
        code: 'pack-guid-collision',
        expected: 'derived output GUIDs to be unique in the global source index',
        hint: 'change the colliding packageId or repair the source index before publishing',
        detail: { sourcePath: options.sourcePath, guid },
      });
    }
    localGuids.add(normalizedGuid);
    const produced = declaresCookedExecution(asset)
      ? await cookCustomOutput(options, sourceKey, guid, asset)
      : await produceOrdinaryOutput(options, sourceKey, guid, asset);
    if (!produced.ok) return produced;
    return ok({
      sourceKey,
      produced: produced.value,
      staged: {
        guid: AssetGuid.derive(subjectPackageId, sourceKey),
        sourceKey,
        asset,
        digest: await digest(asset),
      },
    });
  };
  // Only reentrant cooker outputs share admission. Drain each bounded batch
  // before reporting its first authored error or starting any later outputs.
  for (let index = 0; index < sourceKeys.length; ) {
    let end = index + 1;
    if (parallel(index)) {
      while (end < Math.min(index + 4, sourceKeys.length) && parallel(end)) end++;
    }
    const results = await Promise.allSettled(sourceKeys.slice(index, end).map(produce));
    for (const settled of results) {
      if (settled.status === 'rejected') throw settled.reason;
      const result = settled.value;
      if (!result.ok) return result;
      if (result.value === undefined) continue;
      const { sourceKey, produced, staged } = result.value;
      imported.push(produced.imported);
      if (produced.nativeFingerprint !== undefined)
        nativeFingerprints.set(sourceKey, produced.nativeFingerprint);
      stagedOutputs.push(staged);
    }
    index = end;
  }

  const referenced = externalReferences(imported, localGuids);
  const missing = missingReferenceFailure(options, availableGuids, referenced);
  if (missing !== undefined) return err(missing);

  const externalEvidence = externalEvidenceFor(observed.reads, referenced);
  const inputFingerprint = await packInputFingerprint(
    options,
    subjectPackageId,
    effectiveValues,
    externalEvidence,
    nativeFingerprints,
  );
  const product = packImportProduct(options, imported, inputFingerprint);
  if (!product.ok) return err(product.error);
  return ok({
    product: product.value,
    stagedOutputs,
    externalEvidence,
    inputFingerprint,
    ...(options.publication === undefined ? {} : { publication: options.publication }),
  });
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const PATH_SEPARATORS = /[\\/]+/;

/** Pure '/'-spelled relative path; a path on another root stays unchanged. */
function relativePackPath(directory: readonly string[], path: string): string {
  const parts = path.split(PATH_SEPARATORS);
  if (parts[0] !== directory[0]) return path;
  let shared = 0;
  while (shared < directory.length && parts[shared] === directory[shared]) shared++;
  return [...directory.slice(shared).map(() => '..'), ...parts.slice(shared)].join('/');
}

/**
 * Fingerprint paths spelled relative to the Pack's own directory. The digest
 * names the authored layout and bytes rather than where a checkout sits, so
 * equal sources in different worktrees publish one identity. Logical
 * (non-filesystem) source paths keep their spelling.
 */
function packRelativeIdentity(
  sourcePath: string,
  sourceClosure: readonly ScriptablePackSourceClosureEntry[],
): {
  readonly sourcePath: string;
  readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
} {
  if (!ABSOLUTE_PATH.test(sourcePath)) return { sourcePath, sourceClosure };
  const directory = sourcePath.split(PATH_SEPARATORS).slice(0, -1);
  return {
    sourcePath: relativePackPath(directory, sourcePath),
    sourceClosure: sourceClosure.map((entry) =>
      ABSOLUTE_PATH.test(entry.path)
        ? { ...entry, path: relativePackPath(directory, entry.path) }
        : entry,
    ),
  };
}

export interface ScriptablePackBuildWorkItem {
  readonly definition: AnyScriptablePackDefinition;
  readonly sourcePath: string;
  readonly subjectPackageId?: PackageId;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly inheritedValues?: Readonly<Record<string, PackParameterValue>>;
  readonly sourceClosure?: readonly ScriptablePackSourceClosureEntry[];
  readonly publicationGeneration?: number;
}

export interface ScriptablePackBuildWorklistOptions {
  readonly subjects: readonly ScriptablePackBuildWorkItem[];
  readonly outputs: AssetOutputProducerRegistry;
  readonly cache?: ScriptablePackBuildProductCache;
  /** Optional build-time cookers forwarded to each authored Pack subject. */
  readonly cookers?: Pick<NativeCookerRegistry, 'get' | 'runDraft'>;
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  readonly availableGuids?: ReadonlySet<string>;
  readonly incomingRefs?: ReadonlyMap<string, readonly string[]>;
  readonly maxPasses?: number;
  readonly maxConcurrency?: number;
  readonly onProgress?: (event: {
    readonly phase: 'cache' | 'cook' | 'persist' | 'ready';
    readonly sourcePath: string;
    readonly completed: number;
    readonly total: number;
    readonly cache?: 'hit' | 'miss';
  }) => void;
}

/** Optional producer cache; the worklist still owns current-generation reference validation. */
export interface ScriptablePackBuildProductCache {
  read(subject: ScriptablePackBuildWorkItem): Promise<ScriptablePackBuildProduct | undefined>;
  write(subject: ScriptablePackBuildWorkItem, product: ScriptablePackBuildProduct): Promise<void>;
}

export interface ScriptablePackBuildWorklistProduct {
  readonly products: readonly TerminalImportProduct<unknown>[];
  readonly buildProducts: readonly ScriptablePackBuildProduct[];
  readonly stagedOutputs: readonly ScriptablePackStagedOutput[];
  readonly iterations: number;
}

function stagedSource(
  staged: ReadonlyMap<string, ScriptablePackStagedOutput>,
  fallback: ScriptablePackAssetSnapshotSource | undefined,
): ScriptablePackAssetSnapshotSource {
  return {
    async readByGuid(guid) {
      const key = AssetGuid.format(guid).toLowerCase();
      const local = staged.get(key);
      if (local !== undefined) {
        return ok({
          asset: clone(local.asset),
          generation: 1,
          digest: local.digest ?? 'sha256:staged',
        });
      }
      if (fallback === undefined) {
        return err({
          code: 'asset-not-found',
          expected: 'a staged or published content dependency',
          hint: 'wait for the dependency subject to materialize',
          detail: { guid: key },
        });
      }
      return fallback.readByGuid(guid);
    },
  };
}

/** Build subjects in stable passes; content reads may wait for a later subject. */
export async function buildScriptablePackWorklist(
  options: ScriptablePackBuildWorklistOptions,
): Promise<
  Result<
    ScriptablePackBuildWorklistProduct,
    | PackAuthoringError
    | ScriptablePackDomainError
    | AssetError
    | ImportError
    | {
        readonly code: string;
        readonly expected: string;
        readonly hint: string;
        readonly detail?: unknown;
      }
  >
> {
  const orderedSubjects = [...options.subjects].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
  const maxConcurrency = options.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4)
    throw new RangeError('Pack build concurrency must be an integer between 1 and 4');
  const pending = new Map(
    orderedSubjects.map((subject, index) => [`${index}:${subject.sourcePath}`, subject]),
  );
  const staged = new Map<string, ScriptablePackStagedOutput>();
  const results = new Map<string, ScriptablePackBuildProduct>();
  const availableGuids = new Set(normalizedGuidSet(options.availableGuids) ?? []);
  const maxPasses = options.maxPasses ?? Math.max(1, options.subjects.length + 1);
  let iterations = 0;
  for (; iterations < maxPasses && pending.size > 0; iterations += 1) {
    let progress = false;
    const waiting = new Set<string>();
    const pass = [...pending];
    const prepared = orderedPackPreparation(
      pass,
      maxConcurrency,
      async ([key, subject]) => {
        const visible = new Map(staged);
        const report = (phase: 'cache' | 'cook' | 'persist' | 'ready', cache?: 'hit' | 'miss') =>
          options.onProgress?.({
            phase,
            sourcePath: subject.sourcePath,
            completed: results.size,
            total: orderedSubjects.length,
            ...(cache === undefined ? {} : { cache }),
          });
        report('cache');
        let cached = await options.cache?.read(subject);
        const cachedPluginsIgnored =
          cached !== undefined &&
          subject.definition.plugins !== true &&
          cached.product.assets.some((asset) => asset.kind === 'plugin');
        // Rebuild a stale capability hit so its disabled plugin outputs are omitted.
        if (cachedPluginsIgnored) cached = undefined;
        if (cached === undefined) report('cook', 'miss');
        const result =
          cached === undefined
            ? await buildScriptablePack({
                definition: subject.definition,
                sourcePath: subject.sourcePath,
                ...(subject.subjectPackageId === undefined
                  ? {}
                  : { subjectPackageId: subject.subjectPackageId }),
                ...(subject.values === undefined ? {} : { values: subject.values }),
                ...(subject.inheritedValues === undefined
                  ? {}
                  : { inheritedValues: subject.inheritedValues }),
                ...(subject.sourceClosure === undefined
                  ? {}
                  : { sourceClosure: subject.sourceClosure }),
                ...(subject.publicationGeneration === undefined
                  ? {}
                  : { publicationGeneration: subject.publicationGeneration }),
                outputs: options.outputs,
                ...(options.cookers === undefined ? {} : { cookers: options.cookers }),
                assetSource: stagedSource(visible, options.assetSource),
                availableGuids: new Set([...availableGuids, ...visible.keys()]),
                deferReferenceValidation: true,
              })
            : ok(cached);
        return { key, subject, cached, result, report, visible };
      },
      ({ result }) => !result.ok && errorCode(result.error) !== 'asset-not-found',
    );
    for await (const outcome of prepared) {
      if (outcome.status === 'rejected') throw outcome.reason;
      const { key, subject, cached, result, report, visible } = outcome.value;
      if (result.ok) {
        // Retry speculative content reads replaced by an earlier producer.
        const staleReads = result.value.externalEvidence.filter(({ guid }) => {
          const key = guid.toLowerCase();
          return staged.has(key) && staged.get(key) !== visible.get(key);
        });
        if (staleReads.length > 0) {
          for (const { guid } of staleReads) waiting.add(guid.toLowerCase());
          continue;
        }
        if (cached === undefined && options.cache !== undefined) {
          report('persist', 'miss');
          await options.cache.write(subject, result.value);
        }
        results.set(key, result.value);
        report('ready', cached === undefined ? 'miss' : 'hit');
        for (const output of result.value.stagedOutputs)
          staged.set(AssetGuid.format(output.guid).toLowerCase(), output);
        pending.delete(key);
        progress = true;
        continue;
      }
      if (errorCode(result.error) === 'asset-not-found') {
        const detail =
          record(result.error) && record(result.error.detail) ? result.error.detail : undefined;
        const guid =
          detail !== undefined && typeof detail.guid === 'string' ? detail.guid : undefined;
        if (guid !== undefined) waiting.add(guid.toLowerCase());
        continue;
      }
      return result;
    }
    if (pending.size === 0) break;
    if (!progress) {
      return err({
        code: 'pack-content-dependency-stalled',
        expected: 'the content dependency worklist to make progress',
        hint: 'inspect waitingGuids and repair the missing output or content-read cycle, then rebuild',
        detail: {
          waitingGuids: [...waiting].sort(),
          pendingSubjects: [...pending.values()].map((subject) => subject.sourcePath).sort(),
          iterations: iterations + 1,
        },
      });
    }
  }
  if (pending.size > 0) {
    return err({
      code: 'pack-content-dependency-stalled',
      expected: 'the content dependency worklist to finish within its bounded retry budget',
      hint: 'inspect pendingSubjects and waitingGuids, then repair the dependency graph',
      detail: {
        pendingSubjects: [...pending.values()].map((subject) => subject.sourcePath).sort(),
        waitingGuids: [],
        iterations,
      },
    });
  }
  const knownGuids = new Set([...availableGuids, ...staged.keys()]);
  const missingReferences = new Set<string>();
  for (const product of results.values()) {
    const contentReads = new Set(product.externalEvidence.map((read) => read.guid.toLowerCase()));
    for (const asset of product.product.assets) {
      for (const reference of asset.refs) {
        const guid = reference.guid.toLowerCase();
        if (!knownGuids.has(guid) && !contentReads.has(guid)) missingReferences.add(guid);
      }
    }
  }
  if (missingReferences.size > 0) {
    return err(
      referenceError('pack-output-reference-missing', 'worklist', [...missingReferences].sort()),
    );
  }
  const removed = [...(options.incomingRefs?.keys() ?? [])].filter(
    (guid) => !staged.has(guid.toLowerCase()),
  );
  const referencedRemoved = removed.filter(
    (guid) => (options.incomingRefs?.get(guid) ?? []).length > 0,
  );
  if (referencedRemoved.length > 0)
    return err(referenceError('pack-output-reference-conflict', 'worklist', referencedRemoved));
  return ok({
    products: [...results.values()].map((result) => result.product),
    buildProducts: [...results.values()],
    stagedOutputs: [...staged.values()],
    iterations: pending.size === 0 && options.subjects.length > 0 ? iterations + 1 : iterations,
  });
}
