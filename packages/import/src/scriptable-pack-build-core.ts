import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import {
  type AnyScriptablePackDefinition,
  AssetGuid,
  isScriptablePackAssetKind,
  isValidPackSourceKey,
  type PackAuthoringError,
  PackageId,
  type PackBuildContextWithoutParameters,
  type PackBuildContextWithParameters,
  type PackOutput,
  type PackOutputMap,
  type PackParameterDefinition,
  type PackParameterValue,
  type PluginAssetSource,
  resolvePackParameterValues,
} from '@forgeax/engine-pack/source';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
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
  ScriptablePackExternalEvidence,
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

function isAsset(value: unknown): value is Asset | PluginAssetSource {
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
  return {
    code: 'pack-source-key-invalid',
    expected: 'a sourceKey matching the Pack source-key grammar',
    hint: 'return stable lower-case semantic keys instead of paths or output indexes',
    detail: { sourcePath, sourceKey },
  };
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
  let effectiveValues: Readonly<Record<string, PackParameterValue>> | undefined;
  if ('parameters' in options.definition) {
    const resolved = resolvePackParameterValues(
      options.definition,
      options.values ?? {},
      options.inheritedValues,
    );
    if (!resolved.ok) return resolved;
    effectiveValues = resolved.value;
  } else if (options.values !== undefined && Object.keys(options.values).length > 0) {
    return err(
      outputValueError(
        options.sourcePath,
        '$.values',
        'zero-parameter Packs to omit values and instance capabilities',
        options.values,
      ),
    );
  } else if (
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

  let built: Result<PackOutputMap, unknown> | Promise<Result<PackOutputMap, unknown>>;
  try {
    const context = buildContext(subjectPackageId, effectiveValues, observed.reader);
    built = options.definition.build(context as never);
    built = await built;
  } catch (cause) {
    if (record(cause)) {
      let fields: PropertyDescriptorMap | undefined;
      try {
        fields = Object.getOwnPropertyDescriptors(cause);
      } catch {
        // Opaque author objects retain the ordinary unknown-throw fallback.
      }
      if (
        typeof fields?.code?.value === 'string' &&
        typeof fields?.expected?.value === 'string' &&
        typeof fields?.hint?.value === 'string' &&
        (fields?.detail === undefined || 'value' in fields.detail)
      ) {
        return err(cause as unknown as ScriptablePackDomainError);
      }
    }
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: 'Pack build to return a structured Result without throwing',
        hint: 'repair the authoring function and return err(...) for expected failures',
        detail: {
          reason: `${options.sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      }),
    );
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

  const imported: ImportedAsset<unknown>[] = [];
  const stagedOutputs: ScriptablePackStagedOutput[] = [];
  const ownedOutputs = clone(built.value);
  const localGuids = new Set<string>();
  const cookerRegistry = options.cookers;
  const nativeFingerprints = new Map<string, string>();
  for (const sourceKey of Object.keys(built.value).sort()) {
    if (!isValidPackSourceKey(sourceKey))
      return err(sourceKeyFailure(options.sourcePath, sourceKey));
    const asset = ownedOutputs[sourceKey];
    const customSource = record(asset) && 'execution' in asset && asset.execution === 'cooked';
    if (
      customSource &&
      (typeof asset.kind !== 'string' ||
        asset.kind.trim().length === 0 ||
        isScriptablePackAssetKind(asset.kind) ||
        !('source' in asset) ||
        Object.keys(asset).some((key) => !['kind', 'execution', 'source'].includes(key)))
    ) {
      return err(
        outputValueError(
          options.sourcePath,
          sourceKey,
          'a custom kind with only execution: cooked and source; ordinary Assets use their standard producers',
          asset,
        ),
      );
    }
    if (!customSource && !isAsset(asset)) {
      return err(
        outputValueError(
          options.sourcePath,
          sourceKey,
          'a concrete Asset with a supported kind',
          asset,
        ),
      );
    }
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
    if (customSource) {
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
        source: (asset as Record<string, unknown>).source,
        refs: [],
      });
      if (!cooked.ok) return err(cooked.error);
      if (cooked.value.guid.toLowerCase() !== normalizedGuid)
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
      imported.push({ guid, kind: asset.kind, ...product });
      nativeFingerprints.set(sourceKey, cooked.value.inputFingerprint);
      stagedOutputs.push({
        guid: AssetGuid.derive(subjectPackageId, sourceKey),
        sourceKey,
        asset,
        digest: await digest(asset),
      });
      continue;
    }
    // A custom source has been handled above; ordinary producers retain the closed Asset union.
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
    let produced: unknown;
    try {
      produced = await producer.produce({
        guid,
        sourceKey,
        asset,
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
    const product = produced.value as ImportAssetProduct<unknown>;
    let payload = product.payload;
    let artifacts = product.artifacts;
    let refs = product.refs;
    if (
      asset.kind === 'material' &&
      Array.isArray(asset.passes) &&
      cookerRegistry?.get('material') !== undefined
    ) {
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
      if (cooked.value.guid.toLowerCase() !== normalizedGuid) {
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
      payload = projected.value.payload;
      artifacts = {
        ...product.artifacts,
        ...cooked.value.artifacts,
        ...projected.value.artifacts,
      };
      const mergedRefs: AssetRef[] = [...projected.value.refs];
      const seenRefs = new Set(mergedRefs.map((reference) => reference.guid.toLowerCase()));
      for (const cookerRef of cooked.value.refs) {
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
      refs = mergedRefs;
      nativeFingerprints.set(sourceKey, cooked.value.inputFingerprint);
    }
    imported.push({
      guid,
      kind: asset.kind,
      payload,
      refs,
      artifacts,
    });
    stagedOutputs.push({
      guid: AssetGuid.derive(subjectPackageId, sourceKey),
      sourceKey,
      asset,
      digest: await digest(asset),
    });
  }

  const referenced = new Set<string>();
  for (const asset of imported) {
    for (const ref of asset.refs) {
      const guid = ref.guid.toLowerCase();
      if (!localGuids.has(guid)) referenced.add(guid);
    }
  }
  if (options.deferReferenceValidation !== true) {
    const missing = [...referenced].filter(
      (guid) => availableGuids !== undefined && !availableGuids.has(guid),
    );
    if (missing.length > 0)
      return err(referenceError('pack-output-reference-missing', options.sourcePath, missing));
  }

  const externalEvidence: ScriptablePackExternalEvidence[] = [...observed.reads.values()]
    .sort((left, right) => left.guid.localeCompare(right.guid))
    .map(
      (read): ScriptablePackExternalEvidence => ({
        guid: read.guid,
        usage: referenced.has(read.guid) ? 'both' : 'content',
        generation: read.generation,
        digest: read.digest,
      }),
    );
  const authoredInputFingerprint = await digest({
    packageId: PackageId.format(subjectPackageId),
    sourcePath: options.sourcePath,
    sourceClosure: options.sourceClosure ?? [],
    values: effectiveValues,
    externalEvidence: externalEvidence.map(({ guid, usage, digest: evidenceDigest }) => ({
      guid,
      usage,
      digest: evidenceDigest,
    })),
    authoringContractVersion: options.authoringContractVersion ?? 'scriptable-pack/1',
    producerVersions: options.outputs.versions(),
  });
  const inputFingerprint =
    nativeFingerprints.size === 0
      ? authoredInputFingerprint
      : await digest({
          sourceRevision: authoredInputFingerprint,
          nativeCookers: [...nativeFingerprints.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        });
  const refs = imported.flatMap((asset) => asset.refs);
  const artifacts = Object.fromEntries(
    imported.flatMap((asset) =>
      Object.entries(asset.artifacts).map(([key, artifact]) => [`${asset.guid}/${key}`, artifact]),
    ),
  );
  const product = createImportProduct({
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
  if (!product.ok) return err(product.error);
  return ok({
    product: product.value,
    stagedOutputs,
    externalEvidence,
    inputFingerprint,
    ...(options.publication === undefined ? {} : { publication: options.publication }),
  });
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
  const availableGuids = new Set([
    ...(normalizedGuidSet(options.availableGuids) ?? []),
    ...BUILTIN_MESH_ASSETS.map((asset) => asset.guid.toLowerCase()),
  ]);
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
        const cached = await options.cache?.read(subject);
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
