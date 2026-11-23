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
  projectScriptablePackRuntimeOutputs,
  resolvePackParameterValues,
} from '@forgeax/engine-pack/source';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  AssetPublicationExternalEvidence,
  ImportedAsset,
  MaterialAsset,
  MaterialTable,
  Result,
} from '@forgeax/engine-types';
import { AssetError, err, ImportError, materialGuidText, ok } from '@forgeax/engine-types';
import {
  createImportProduct,
  type ImportAssetProduct,
  type TerminalImportProduct,
} from './import-product.js';
import { orderedPackPreparation, orderedPackProduction } from './ordered-pack-preparation.js';
import type {
  AssetOutputProducer,
  AssetOutputProducerRegistry,
  AssetOutputProduct,
  PackBuildProduct,
  ScriptablePackAssetSnapshotSource,
  ScriptablePackDomainError,
  ScriptablePackSourceClosureEntry,
  ScriptablePackStagedOutput,
} from './scriptable-pack.js';
import { scriptablePackFingerprintAsync as digest } from './scriptable-pack-fingerprint.js';
import {
  materialAssetOutputProducer,
  projectNativeMaterial,
} from './scriptable-pack-output-producers.js';

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
  /** Catalog kind facts for reference validation without forcing soft-reference content reads. */
  readonly availableKinds?: ReadonlyMap<string, string>;
  /** Worklist mode defers reference closure until every subject is materialized. */
  readonly deferReferenceValidation?: boolean;
  readonly publication?: AssetPublicationEnvelope;
  /** Producer-owned generation shared with every cooked output receipt. */
  readonly publicationGeneration?: number;
}

type PackOutputPlanOptions = Omit<
  ScriptablePackBuildOptions,
  'definition' | 'values' | 'inheritedValues' | 'subjectPackageId' | 'assetSource'
>;

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

function localWaterReferenceError(
  sourcePath: string,
  sourceKey: string,
  guid: string,
  field: string,
  expectedKind: string,
  actualKind: string,
): PackAuthoringError {
  return {
    code: 'pack-output-reference-kind-invalid',
    expected: `${field} to reference a ${expectedKind} output in the available published or staged closure`,
    hint: 'repair the Water source reference kind before publishing this Pack',
    detail: { sourcePath, sourceKey, guid, field, expectedKind, actualKind },
  };
}

function waterReferenceExpectations(
  asset: PackOutput,
): readonly (readonly [string, string, string])[] {
  if (!record(asset)) return [];
  const value = asset as Record<string, unknown>;
  const references: (readonly [string, string, string])[] = [];
  const add = (guid: unknown, expectedKind: string, field: string) => {
    if (typeof guid === 'string') references.push([guid, expectedKind, field]);
  };
  if (value.kind === 'water-body') {
    const appendWaterBodyReferences = (value: Record<string, unknown>) => {
      add(value.surfaceMaterialGuid, 'material', 'surfaceMaterialGuid');
      add(value.zoneGuid, 'water-zone', 'zoneGuid');
      add(value.waveSetGuid, 'water-wave-set', 'waveSetGuid');
      add(value.customMeshOverrideGuid, 'mesh', 'customMeshOverrideGuid');
      add(
        record(value.collision) ? value.collision.meshGuid : undefined,
        'mesh',
        'collision.meshGuid',
      );
      for (const field of [
        'visibleMeshGuid',
        'waterInfoMeshGuid',
        'dilatedWaterInfoMeshGuid',
        'brushShapeMeshGuid',
        'collisionMeshGuid',
      ])
        add(value[field], 'mesh', field);
      if (Array.isArray(value.riverSegmentMeshGuids))
        for (const guid of value.riverSegmentMeshGuids) add(guid, 'mesh', 'riverSegmentMeshGuids');
      for (const field of [
        'riverToLakeTransitionMaterialGuid',
        'riverToOceanTransitionMaterialGuid',
        'waterInfoMaterialGuid',
        'lodMaterialGuid',
        'underwaterPostProcessMaterialGuid',
      ])
        add(value[field], 'material', field);
    };
    appendWaterBodyReferences(value);
  } else if (value.kind === 'water-zone') {
    add(value.farMaterialGuid, 'material', 'farMaterialGuid');
  } else if (value.kind === 'water-brush-recipe') {
    add(value.baseTerrainGuid, 'terrain', 'baseTerrainGuid');
    if (Array.isArray(value.sourceBodyGuids))
      for (const guid of value.sourceBodyGuids) add(guid, 'water-body', 'sourceBodyGuids');
    if (Array.isArray(value.curves))
      for (const guid of value.curves) add(guid, 'texture', 'curves');
    if (Array.isArray(value.textures))
      for (const guid of value.textures) add(guid, 'texture', 'textures');
  } else if (value.kind === 'water-simulation-recipe') {
    const appendSimulationReferences = (value: Record<string, unknown>) => {
      if (Array.isArray(value.materialGuids))
        for (const guid of value.materialGuids) add(guid, 'material', 'materialGuids');
      if (Array.isArray(value.textureGuids))
        for (const guid of value.textureGuids) add(guid, 'texture', 'textureGuids');
      if (record(value.shallowStageConfig) && Array.isArray(value.shallowStageConfig.materialGuids))
        for (const guid of value.shallowStageConfig.materialGuids)
          add(guid, 'material', 'shallowStageConfig.materialGuids');
      if (record(value.riverBakeConfig))
        add(value.riverBakeConfig.sourceBodyGuid, 'water-body', 'riverBakeConfig.sourceBodyGuid');
      if (record(value.oceanPatchConfig))
        add(
          value.oceanPatchConfig.noiseTextureGuid,
          'texture',
          'oceanPatchConfig.noiseTextureGuid',
        );
    };
    appendSimulationReferences(value);
  }
  return references;
}

export function waterPackReferenceKindFailure(
  sourcePath: string,
  sourceKey: string,
  asset: PackOutput,
  knownKinds: ReadonlyMap<string, string>,
): PackAuthoringError | undefined {
  for (const [reference, expectedKind, field] of waterReferenceExpectations(asset)) {
    const normalized = reference.toLowerCase();
    const actualKind = knownKinds.get(normalized);
    if (actualKind !== undefined && actualKind !== expectedKind)
      return localWaterReferenceError(
        sourcePath,
        sourceKey,
        normalized,
        field,
        expectedKind,
        actualKind,
      );
  }
  return undefined;
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
  readonly sourceDependencies?: readonly string[];
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
  options: PackOutputPlanOptions,
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
  options: PackOutputPlanOptions,
  sourceKey: string,
  guid: string,
  asset: PackCookSource,
  materialTable: MaterialTable,
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
  const cookedAsset = cooked.value.payload;
  const produced = isAsset(cookedAsset)
    ? await produceOrdinaryOutput(options, sourceKey, guid, cookedAsset, materialTable)
    : undefined;
  if (produced !== undefined && !produced.ok) return produced;
  const ordinary = produced?.ok === true ? produced.value : undefined;
  const kind = ordinary?.imported.kind ?? asset.kind;
  const refs = cooked.value.refs.map((guid) => ({ guid }));
  const product =
    ordinary === undefined
      ? { payload: cookedAsset, refs, artifacts: cooked.value.artifacts }
      : {
          payload: ordinary.imported.payload,
          refs: [
            ...ordinary.imported.refs,
            ...refs.filter(
              (ref) =>
                !ordinary.imported.refs.some(
                  (own) => own.guid.toLowerCase() === ref.guid.toLowerCase(),
                ),
            ),
          ],
          artifacts: { ...cooked.value.artifacts, ...ordinary.imported.artifacts },
        };
  const invalid = productError(options.sourcePath, sourceKey, { kind }, product);
  if (invalid !== undefined) return err(invalid);
  return ok({
    imported: { guid, kind, ...product },
    nativeFingerprint:
      ordinary?.nativeFingerprint === undefined
        ? cooked.value.inputFingerprint
        : `${cooked.value.inputFingerprint}+${ordinary.nativeFingerprint}`,
  });
}

async function invokeOutputProducer(
  options: PackOutputPlanOptions,
  sourceKey: string,
  guid: string,
  asset: Asset | PluginAssetSource | ParticleEffectAssetSource,
  producer: AssetOutputProducer,
): Promise<Result<AssetOutputProduct, ScriptablePackBuildFailure>> {
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
  return ok(produced.value as AssetOutputProduct);
}

async function cookAuthoredMaterial(
  options: PackOutputPlanOptions,
  sourceKey: string,
  guid: string,
  asset: Asset | PluginAssetSource | ParticleEffectAssetSource,
  product: ImportAssetProduct<unknown>,
  cookerRegistry: Pick<NativeCookerRegistry, 'get' | 'runDraft'>,
  materialTable: MaterialTable,
): Promise<Result<ProducedOutput, ScriptablePackBuildFailure>> {
  const cooked = await cookerRegistry.runDraft('material', {
    guid,
    source: asset,
    table: materialTable,
    sourceKey,
    sourcePath: options.sourcePath,
    refs: product.refs.map((reference) => reference.guid),
    publication: 'templates',
    ...(options.publicationGeneration === undefined
      ? {}
      : { cookGeneration: options.publicationGeneration }),
  });
  if (!cooked.ok) return err(cooked.error);
  const projected = await projectNativeMaterial(guid, sourceKey, cooked.value);
  if (!projected.ok) {
    if ('code' in projected.error) return err(projected.error);
    return err({
      code: 'pack-source-output-invalid',
      expected: projected.error.expected,
      hint: 'repair the native material cooker output and rebuild the Pack',
      detail: { sourcePath: options.sourcePath, sourceKey, expectedGuid: guid, ...projected.error },
    });
  }
  const projectedInvalid = productError(
    options.sourcePath,
    sourceKey,
    materialAssetOutputProducer,
    projected.value,
  );
  if (projectedInvalid !== undefined) return err(projectedInvalid);
  return ok({
    imported: {
      guid,
      kind: asset.kind,
      payload: projected.value.payload,
      refs: projected.value.refs,
      artifacts: {
        ...product.artifacts,
        ...cooked.value.artifacts,
        ...projected.value.artifacts,
      },
    },
    nativeFingerprint: cooked.value.inputFingerprint,
    ...(cooked.value.sourceDependencies === undefined
      ? {}
      : { sourceDependencies: cooked.value.sourceDependencies }),
  });
}

async function produceOrdinaryOutput(
  options: PackOutputPlanOptions,
  sourceKey: string,
  guid: string,
  asset: PackOutput,
  materialTable: MaterialTable,
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
  if (asset.kind === 'material' && cookerRegistry?.get('material') !== undefined) {
    return cookAuthoredMaterial(
      options,
      sourceKey,
      guid,
      asset,
      product.value,
      cookerRegistry,
      materialTable,
    );
  }
  const { payload, refs, artifacts } = product.value;
  return ok({
    imported: { guid, kind: asset.kind, payload, refs, artifacts },
    nativeFingerprint: product.value.inputFingerprint,
    ...(product.value.sourceDependencies === undefined
      ? {}
      : { sourceDependencies: product.value.sourceDependencies }),
  });
}

async function collectMaterialCookTable(
  options: PackOutputPlanOptions,
  packageId: PackageId,
  outputs: PackOutputMap,
  reader: ReturnType<typeof observedReader>['reader'],
): Promise<Result<MaterialTable, ScriptablePackBuildFailure>> {
  const table: Record<string, MaterialAsset> = {};
  if (options.cookers?.get('material') === undefined) return ok(table);
  for (const [sourceKey, asset] of Object.entries(outputs)) {
    if (isAsset(asset) && asset.kind === 'material')
      table[AssetGuid.format(AssetGuid.derive(packageId, sourceKey))] = asset;
  }
  const pending = Object.values(table);
  for (let index = 0; index < pending.length; index++) {
    const parent = pending[index]?.parent;
    if (parent === undefined) continue;
    const key = materialGuidText(parent);
    if (table[key] !== undefined) continue;
    const parsed = AssetGuid.parse(key);
    if (!parsed.ok) return err(parsed.error);
    const canonical = AssetGuid.format(parsed.value);
    const local = table[canonical];
    if (local !== undefined) {
      table[key] = local;
      continue;
    }
    const read = await reader.readByGuid(parsed.value);
    if (!read.ok) return err(thrownBuildFailure(read.error, options.sourcePath));
    if (!isAsset(read.value) || read.value.kind !== 'material')
      return err(outputValueError(options.sourcePath, key, 'a MaterialAsset parent', read.value));
    table[key] = read.value;
    table[canonical] = read.value;
    pending.push(read.value);
  }
  return ok(table);
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
  options: PackOutputPlanOptions,
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
  const evidence: AssetPublicationExternalEvidence[] = [...reads.values()].map(
    (read): AssetPublicationExternalEvidence => ({
      guid: read.guid,
      usage: referenced.has(read.guid) ? 'both' : 'content',
      generation: read.generation,
      digest: read.digest,
    }),
  );
  for (const guid of referenced) {
    if (!reads.has(guid)) evidence.push({ guid, usage: 'reference' });
  }
  return evidence.sort((left, right) => left.guid.localeCompare(right.guid));
}

async function packInputFingerprint(
  options: PackOutputPlanOptions,
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
  sourcePath: string,
  imported: ImportedAsset<unknown>[],
  inputFingerprint: string,
  sourceDependencies: readonly string[],
) {
  const refs = imported.flatMap((asset) => asset.refs);
  const artifacts = Object.fromEntries(
    imported.flatMap((asset) =>
      Object.entries(asset.artifacts).map(([key, artifact]) => [`${asset.guid}/${key}`, artifact]),
    ),
  );
  return createImportProduct({
    assets: imported,
    sourceDependencies: [...new Set(sourceDependencies)].sort(),
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
    sourceKey: sourcePath,
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
  const observed = observedReader(options.assetSource);
  const values = effectiveParameterValues(options);
  if (!values.ok) return values;
  const effectiveValues = values.value;

  const built = await runPackBuild(options, subjectPackageId, effectiveValues, observed.reader);
  if (!built.ok) return built;

  const plan = await planPackOutputMap(
    options,
    subjectPackageId,
    built.value,
    options.definition.plugins,
    observed,
    effectiveValues,
  );
  return plan.ok ? sealPackOutputPlan(options.sourcePath, plan.value, options.publication) : plan;
}

export interface PackOutputPlan
  extends Omit<ScriptablePackBuildProduct, 'product' | 'publication'> {
  readonly imported: ImportedAsset<unknown>[];
  readonly sourceDependencies: readonly string[];
}

export function sealPackOutputPlan(
  sourcePath: string,
  plan: PackOutputPlan,
  publication?: AssetPublicationEnvelope,
): ScriptablePackBuildResult {
  const { imported, sourceDependencies, ...facts } = plan;
  const product = packImportProduct(
    sourcePath,
    imported,
    facts.inputFingerprint,
    sourceDependencies,
  );
  return product.ok
    ? ok({
        ...facts,
        product: product.value,
        ...(publication === undefined ? {} : { publication }),
      })
    : err(product.error);
}

/** Collect producer facts before sealing receipts and the immutable ImportProduct. */
export async function planPackOutputMap(
  options: PackOutputPlanOptions,
  subjectPackageId: PackageId,
  built: PackOutputMap,
  plugins?: true,
  observed = observedReader(undefined),
  effectiveValues?: Readonly<Record<string, PackParameterValue>>,
): Promise<Result<PackOutputPlan, ScriptablePackBuildFailure>> {
  const availableGuids = normalizedGuidSet(options.availableGuids);
  const imported: ImportedAsset<unknown>[] = [];
  const stagedOutputs: ScriptablePackStagedOutput[] = [];
  const ownedOutputs = clone(built);
  const localGuids = new Set<string>();
  const nativeFingerprints = new Map<string, string>();
  const sourceDependencies = new Set<string>();
  const sourceKeys = Object.keys(built).sort();
  const materialTable = await collectMaterialCookTable(
    options,
    subjectPackageId,
    ownedOutputs,
    observed.reader,
  );
  if (!materialTable.ok) return materialTable;
  const parallel = (sourceKey: string): boolean => {
    const asset = ownedOutputs[sourceKey];
    return (
      asset !== undefined &&
      (declaresCookedExecution(asset) ||
        (isAsset(asset) &&
          asset.kind === 'material' &&
          options.cookers?.get(asset.kind)?.concurrency === 'parallel'))
    );
  };
  const produce = async (sourceKey: string) => {
    const asset = ownedOutputs[sourceKey];
    const raw: unknown = asset;
    // Without the plugin capability, keep ordinary outputs and omit plugin siblings.
    if (record(raw) && raw.kind === 'plugin' && plugins !== true) return ok(undefined);
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
      ? await cookCustomOutput(options, sourceKey, guid, asset, materialTable.value)
      : await produceOrdinaryOutput(options, sourceKey, guid, asset, materialTable.value);
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
  const acceptProducedOutput = (
    settled: PromiseSettledResult<Awaited<ReturnType<typeof produce>>>,
  ) => {
    if (settled.status === 'rejected') throw settled.reason;
    const result = settled.value;
    if (!result.ok) return result;
    if (result.value === undefined) return undefined;
    const { sourceKey, produced, staged } = result.value;
    imported.push(produced.imported);
    for (const path of produced.sourceDependencies ?? []) sourceDependencies.add(path);
    if (produced.nativeFingerprint !== undefined)
      nativeFingerprints.set(sourceKey, produced.nativeFingerprint);
    stagedOutputs.push(staged);
    return undefined;
  };
  // Preserve serial barriers and canonical acceptance. Parallel outputs refill
  // idle lanes through the same bounded owner as source-package preparation;
  // failures stop admission and drain every accepted sibling before returning.
  for await (const settled of orderedPackProduction(
    sourceKeys,
    parallel,
    produce,
    (result) => !result.ok,
  )) {
    const failure = acceptProducedOutput(settled);
    if (failure !== undefined) return failure;
  }

  const referenced = externalReferences(imported, localGuids);
  const knownKinds = new Map(
    [...(options.availableKinds ?? [])].map(([guid, kind]) => [guid.toLowerCase(), kind]),
  );
  for (const output of stagedOutputs)
    knownKinds.set(
      AssetGuid.format(output.guid).toLowerCase(),
      String((output.asset as { kind?: unknown }).kind ?? 'unknown'),
    );
  for (const output of stagedOutputs) {
    const kindFailure = waterPackReferenceKindFailure(
      options.sourcePath,
      output.sourceKey,
      output.asset,
      knownKinds,
    );
    if (kindFailure !== undefined) return err(kindFailure);
  }
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
  return ok({
    imported,
    stagedOutputs,
    externalEvidence,
    inputFingerprint,
    sourceDependencies: [
      ...(options.sourceClosure ?? []).map((entry) => entry.path),
      ...sourceDependencies,
    ],
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

/** Identity and captured files shared by every Pack producer's existing DDC. */
export interface PackBuildCacheSubject extends Omit<ScriptablePackBuildWorkItem, 'definition'> {
  readonly definition: Pick<AnyScriptablePackDefinition, 'packageId'>;
  /** Before producer execution, only these files are available for discovery. */
  readonly discoverySourceClosure?: readonly ScriptablePackSourceClosureEntry[];
}

export interface ScriptablePackBuildWorklistOptions {
  readonly subjects: readonly ScriptablePackBuildWorkItem[];
  readonly outputs: AssetOutputProducerRegistry;
  readonly cache?: ScriptablePackBuildProductCache;
  /** Optional build-time cookers forwarded to each authored Pack subject. */
  readonly cookers?: Pick<NativeCookerRegistry, 'get' | 'runDraft'>;
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  readonly availableGuids?: ReadonlySet<string>;
  readonly availableKinds?: ReadonlyMap<string, string>;
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

/** Current content digest of a dependency GUID, or undefined while it is unavailable. */
export type ScriptablePackDependencyResolver = (guid: string) => Promise<string | undefined>;

/** Optional producer cache; the worklist still owns current-generation reference validation. */
export interface ScriptablePackBuildProductCache {
  /** Advisory prior topology only; current production and reference validation remain authoritative. */
  dependencies?(subject: PackBuildCacheSubject): Promise<
    | {
        readonly outputs: readonly string[];
        readonly reads: readonly string[];
      }
    | undefined
  >;
  read(
    subject: PackBuildCacheSubject,
    resolve?: ScriptablePackDependencyResolver,
  ): Promise<ScriptablePackBuildProduct | undefined>;
  write(subject: PackBuildCacheSubject, product: ScriptablePackBuildProduct): Promise<void>;
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

async function orderSubjectsByCachedDependencies(
  subjects: readonly ScriptablePackBuildWorkItem[],
  cache: ScriptablePackBuildProductCache | undefined,
  contentReads: Map<ScriptablePackBuildWorkItem, readonly string[]>,
): Promise<ScriptablePackBuildWorkItem[]> {
  let orderedSubjects = [...subjects].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
  const cachedDependencies = cache?.dependencies?.bind(cache);
  if (cachedDependencies !== undefined) {
    const metadata = await Promise.all(
      orderedSubjects.map(async (subject) => {
        try {
          return await cachedDependencies(subject);
        } catch {
          return undefined;
        }
      }),
    );
    const owners = new Map<string, number>();
    const ambiguous = new Set<string>();
    for (const [index, row] of metadata.entries()) {
      const subject = orderedSubjects[index];
      if (subject !== undefined && row !== undefined) {
        const ownOutputs = new Set(row.outputs.map((guid) => guid.toLowerCase()));
        contentReads.set(
          subject,
          row.reads.map((guid) => guid.toLowerCase()).filter((guid) => !ownOutputs.has(guid)),
        );
      }
      for (const guid of row?.outputs ?? []) {
        if (owners.has(guid)) ambiguous.add(guid);
        else owners.set(guid, index);
      }
    }
    for (const guid of ambiguous) owners.delete(guid);
    const remaining = new Set(orderedSubjects.map((_, index) => index));
    const order: number[] = [];
    while (remaining.size) {
      const ready = [...remaining].filter((index) =>
        (metadata[index]?.reads ?? []).every((guid) => {
          const owner = owners.get(guid);
          return owner === undefined || owner === index || !remaining.has(owner);
        }),
      );
      // Stale or cyclic hints never block the ordinary bounded dependency worklist.
      if (!ready.length) {
        order.push(...remaining);
        break;
      }
      for (const index of ready) {
        remaining.delete(index);
        order.push(index);
      }
    }
    orderedSubjects = order.flatMap((index) => {
      const subject = orderedSubjects[index];
      return subject === undefined ? [] : [subject];
    });
  }
  return orderedSubjects;
}

function admitPublishedContentReaders(
  pending: ReadonlyMap<string, ScriptablePackBuildWorkItem>,
  contentReads: ReadonlyMap<ScriptablePackBuildWorkItem, readonly string[]>,
  staged: ReadonlyMap<string, ScriptablePackStagedOutput>,
): [string, ScriptablePackBuildWorkItem][] {
  const remaining = [...pending];
  // Preparation can refill before the consumer publishes a preceding result.
  // Admit content readers only after that publication, including producers
  // whose older discovery row does not yet identify its output GUIDs.
  const ready =
    pending.size === 1
      ? remaining
      : remaining.filter(([, subject]) =>
          (contentReads.get(subject) ?? []).every((guid) => staged.has(guid)),
        );
  // Discovery is advisory: missing, external or cyclic hints must retain the
  // ordinary bounded cook/retry path rather than deadlock preparation lanes.
  return ready.length === 0 ? remaining : ready;
}

async function* preparePublishedContentReaders<R>(
  pending: ReadonlyMap<string, ScriptablePackBuildWorkItem>,
  ready: readonly [string, ScriptablePackBuildWorkItem][],
  concurrency: number,
  prepare: (input: [string, ScriptablePackBuildWorkItem]) => Promise<R>,
  fatal: (value: R) => boolean,
  madeProgress: () => boolean,
): AsyncGenerator<PromiseSettledResult<R>> {
  yield* orderedPackPreparation(ready, concurrency, prepare, fatal);
  // Hints can select a nonempty subset whose actual reads are not ready.
  // Only after that subset stalls, try the subjects it excluded in this same
  // bounded pass. Never retry an already attempted subject within the pass.
  if (madeProgress()) return;
  const attempted = new Set(ready.map(([key]) => key));
  const remaining = [...pending].filter(([key]) => !attempted.has(key));
  yield* orderedPackPreparation(remaining, concurrency, prepare, fatal);
}

function missingContentGuid(error: unknown): string | undefined {
  const detail = record(error) && record(error.detail) ? error.detail : undefined;
  return detail !== undefined && typeof detail.guid === 'string' ? detail.guid : undefined;
}

function collectDeclaredRuntimeKinds(
  subjects: readonly ScriptablePackBuildWorkItem[],
  builtGuids: ReadonlySet<string>,
): Result<ReadonlyMap<string, string>, PackAuthoringError> {
  const kinds = new Map<string, string>();
  for (const subject of subjects) {
    // The source declaration reserves its own GUIDs. Build-time instances
    // have separate identities and do not acquire implicit runtime outputs.
    if (subject.subjectPackageId !== undefined) continue;
    for (const { guid, sourceKey, kind } of projectScriptablePackRuntimeOutputs(
      subject.definition,
    )) {
      if (builtGuids.has(guid) || kinds.has(guid)) {
        return err({
          code: 'pack-guid-collision',
          expected: 'globally distinct built and runtime declared GUIDs',
          hint: 'give the colliding asset source its own packageId or source key',
          detail: { sourcePath: subject.sourcePath, sourceKey, guid },
        });
      }
      kinds.set(guid, kind);
    }
  }
  return ok(kinds);
}

function removedWorklistReferenceFailure(
  incoming: ScriptablePackBuildWorklistOptions['incomingRefs'],
  staged: ReadonlyMap<string, ScriptablePackStagedOutput>,
  runtime: ReadonlyMap<string, string>,
): Result<never, PackAuthoringError> | undefined {
  if (incoming === undefined) return undefined;
  const referencedRemoved = [...incoming].flatMap(([guid, references]) => {
    const normalized = guid.toLowerCase();
    return references.length > 0 && !staged.has(normalized) && !runtime.has(normalized)
      ? [guid]
      : [];
  });
  return referencedRemoved.length === 0
    ? undefined
    : err(referenceError('pack-output-reference-conflict', 'worklist', referencedRemoved));
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
  const contentReads = new Map<ScriptablePackBuildWorkItem, readonly string[]>();
  const orderedSubjects = await orderSubjectsByCachedDependencies(
    options.subjects,
    options.cache,
    contentReads,
  );
  const maxConcurrency = options.maxConcurrency ?? 1;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4)
    throw new RangeError('Pack build concurrency must be an integer between 1 and 4');
  const pending = new Map(
    orderedSubjects.map((subject, index) => [`${index}:${subject.sourcePath}`, subject]),
  );
  const staged = new Map<string, ScriptablePackStagedOutput>();
  const results = new Map<string, ScriptablePackBuildProduct>();
  const resultSourcePaths = new Map<string, string>();
  const builtGuids = new Set(normalizedGuidSet(options.availableGuids) ?? []);
  const runtimeKinds = collectDeclaredRuntimeKinds(options.subjects, builtGuids);
  if (!runtimeKinds.ok) return runtimeKinds;
  const availableGuids = new Set([...builtGuids, ...runtimeKinds.value.keys()]);
  const availableKinds = new Map([
    ...[...(options.availableKinds ?? [])].map(
      ([guid, kind]) => [guid.toLowerCase(), kind] as const,
    ),
    ...runtimeKinds.value,
  ]);
  const maxPasses = options.maxPasses ?? Math.max(1, options.subjects.length + 1);
  let iterations = 0;
  for (; iterations < maxPasses && pending.size > 0; iterations += 1) {
    let progress = false;
    const waiting = new Set<string>();
    const pass = admitPublishedContentReaders(pending, contentReads, staged);
    const prepare = async ([key, subject]: [string, ScriptablePackBuildWorkItem]) => {
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
      let cached = await options.cache?.read(subject, async (guid) => {
        const parsed = AssetGuid.parse(guid);
        if (!parsed.ok) return undefined;
        const local = visible.get(AssetGuid.format(parsed.value).toLowerCase());
        if (local !== undefined) return local.digest ?? (await digest(local.asset));
        if (pending.size > 1) return undefined;
        const read = await options.assetSource?.readByGuid(parsed.value);
        return read?.ok ? read.value.digest : undefined;
      });
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
              availableKinds: new Map([
                ...availableKinds,
                ...[...visible].map(([guid, output]) => [guid, String(output.asset.kind)] as const),
              ]),
              deferReferenceValidation: true,
            })
          : ok(cached);
      return { key, subject, cached, result, report, visible };
    };
    const fatal = ({ result }: Awaited<ReturnType<typeof prepare>>) =>
      !result.ok && errorCode(result.error) !== 'asset-not-found';
    const prepared =
      pass.length < pending.size
        ? preparePublishedContentReaders(
            pending,
            pass,
            maxConcurrency,
            prepare,
            fatal,
            () => progress,
          )
        : orderedPackPreparation(pass, maxConcurrency, prepare, fatal);
    for await (const outcome of prepared) {
      if (outcome.status === 'rejected') throw outcome.reason;
      const { key, subject, cached, result, report, visible } = outcome.value;
      if (result.ok) {
        // Retry speculative content reads replaced by an earlier producer.
        const captureStaleReads = () => {
          const staleReads = result.value.externalEvidence.filter(({ guid }) => {
            const key = guid.toLowerCase();
            return staged.has(key) && staged.get(key) !== visible.get(key);
          });
          if (staleReads.length > 0) {
            for (const { guid } of staleReads) waiting.add(guid.toLowerCase());
            return true;
          }

          return false;
        };
        if (captureStaleReads()) continue;
        if (cached === undefined && options.cache !== undefined) {
          report('persist', 'miss');
          await options.cache.write(subject, result.value);
        }
        results.set(key, result.value);
        resultSourcePaths.set(key, subject.sourcePath);
        report('ready', cached === undefined ? 'miss' : 'hit');
        for (const output of result.value.stagedOutputs)
          staged.set(AssetGuid.format(output.guid).toLowerCase(), output);
        pending.delete(key);
        progress = true;
        continue;
      }
      if (errorCode(result.error) === 'asset-not-found') {
        const guid = missingContentGuid(result.error);
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
  const validateCompletedReferences = () => {
    const knownKinds = new Map(availableKinds);
    for (const output of staged.values())
      knownKinds.set(
        AssetGuid.format(output.guid).toLowerCase(),
        String((output.asset as { kind?: unknown }).kind ?? 'unknown'),
      );
    for (const [key, product] of results) {
      const sourcePath = resultSourcePaths.get(key);
      if (sourcePath === undefined) throw new Error('Completed Pack product has no source path');
      for (const output of product.stagedOutputs) {
        const guid = AssetGuid.format(output.guid).toLowerCase();
        if (runtimeKinds.value.has(guid)) {
          return err({
            code: 'pack-guid-collision',
            expected: 'built output GUIDs distinct from declared runtime outputs',
            hint: 'give the colliding asset source its own packageId or source key',
            detail: { sourcePath, guid, sourceKey: output.sourceKey },
          });
        }
        const kindFailure = waterPackReferenceKindFailure(
          sourcePath,
          output.sourceKey,
          output.asset,
          knownKinds,
        );
        if (kindFailure !== undefined) return err(kindFailure);
      }
    }
    const knownGuids = new Set([...availableGuids, ...staged.keys()]);
    const missingReferences = new Set<string>();
    for (const product of results.values()) {
      for (const read of product.externalEvidence) {
        const guid = read.guid.toLowerCase();
        if (read.usage === 'reference' && !knownGuids.has(guid)) missingReferences.add(guid);
      }
      const contentReads = new Set(
        product.externalEvidence
          .filter((read) => read.usage !== 'reference')
          .map((read) => read.guid.toLowerCase()),
      );
      for (const output of product.stagedOutputs) {
        for (const [reference] of waterReferenceExpectations(output.asset)) {
          const guid = reference.toLowerCase();
          if (!knownGuids.has(guid) && !contentReads.has(guid)) missingReferences.add(guid);
        }
      }
    }
    if (missingReferences.size > 0) {
      return err(
        referenceError('pack-output-reference-missing', 'worklist', [...missingReferences].sort()),
      );
    }
    return removedWorklistReferenceFailure(options.incomingRefs, staged, runtimeKinds.value);
  };
  const referenceFailure = validateCompletedReferences();
  if (referenceFailure !== undefined) return referenceFailure;
  return ok({
    products: [...results.values()].map((result) => result.product),
    buildProducts: [...results.values()],
    stagedOutputs: [...staged.values()],
    iterations: pending.size === 0 && options.subjects.length > 0 ? iterations + 1 : iterations,
  });
}
