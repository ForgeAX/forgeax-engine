import { stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { normalizeMeshPayload } from '@forgeax/engine-geometry';
import {
  finalizePackageTransportSource,
  type PackageFinalizePolicy,
  packageTransportRevision,
  type RuntimePackPublication,
  resolveAssetSource,
} from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId, type PackageId as PackageIdType } from '@forgeax/engine-pack/guid';
import {
  type NativeCookDraft,
  type NativeCooker,
  NativeCookerRegistry,
} from '@forgeax/engine-pack/native-cooker';
import {
  declaredSourceGuids,
  type PackInstanceResolution,
  type ScanSourceDeclaration,
  type ScriptablePackSourceDeclaration,
} from '@forgeax/engine-pack/scanner';
import {
  type AnyScriptablePackDefinition,
  type DirectPackAssetProjection,
  isScriptablePackAssetKind,
  projectDirectPackJson,
  projectScriptablePackSceneComponents,
  type ScriptablePackSourceClosureEntry,
} from '@forgeax/engine-pack/source';
import {
  createLazyScriptablePackDefinition,
  type ScriptablePackModuleExecutorPool,
  type ScriptablePackSourceSnapshot,
} from '@forgeax/engine-pack/source-node';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  AssetPublicationOutput,
  AssetRef,
  ImportedAsset,
  ResourceRevision,
  Result,
} from '@forgeax/engine-types';
import { AssetError, createAssetPublication, err, ok } from '@forgeax/engine-types';
import type { ImportRunnerFs, RunImportMeta } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';
import { projectMaterialPackTransport } from './material-pack-transport.js';
import { orderedPackProduction } from './ordered-pack-preparation.js';
import { projectImportProductForBuild } from './pack-projection.js';
import type {
  ScriptablePackAssetSnapshotSource,
  ScriptablePackDomainError,
  ScriptablePackStagedOutput,
} from './scriptable-pack.js';
import {
  buildScriptablePackWorklist,
  createStandardAssetOutputProducerRegistry,
  type ScriptablePackBuildProduct,
  type ScriptablePackBuildWorkItem,
  type ScriptablePackBuildWorklistOptions,
  waterPackReferenceKindFailure,
} from './scriptable-pack-build.js';
import {
  type PackOutputPlan,
  planPackOutputMap,
  sealPackOutputPlan,
} from './scriptable-pack-build-core.js';
import { scriptablePackFingerprintAsync } from './scriptable-pack-fingerprint.js';
import { createPreExternalizedSceneAssetOutputProducer } from './scriptable-pack-output-producers.js';
import {
  bindScriptablePackMaterialGeneration,
  createScriptablePackProductCache,
} from './scriptable-pack-product-cache.js';
import {
  createScriptablePackStagedAssetSnapshotSource,
  sourceWithPreparedPackOutputs,
} from './scriptable-pack-staged-snapshot.js';
import { createScriptablePackTransportCache } from './scriptable-pack-transport-cache.js';
import { produceSourcePackage } from './source-package.js';

type FinalizedPackageTransport = Awaited<ReturnType<typeof finalizePackageTransportSource>>;

export interface ScriptablePackInput {
  readonly sourcePath: string;
  readonly displaySourcePath: string;
  readonly definition: AnyScriptablePackDefinition;
  readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
  readonly publicationGeneration: number;
  readonly policy:
    | PackageFinalizePolicy
    | ((product: ScriptablePackBuildProduct) => PackageFinalizePolicy);
  /** Opt in only for a pure, sink-free policy. Change this identity whenever its URL mapping changes. */
  readonly transportIdentity?: string;
  readonly subjectPackageId?: PackageIdType;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly inheritedValues?: Readonly<
    Record<string, import('@forgeax/engine-pack/source').PackParameterValue>
  >;
}

export function planScriptablePackInputs(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  instances: ReadonlyMap<string, PackInstanceResolution>,
  options: {
    readonly sourceSnapshot: ScriptablePackSourceSnapshot;
    readonly executors: ScriptablePackModuleExecutorPool;
    readonly enginePackageRoot?: string | undefined;
    readonly displayPath: (sourcePath: string) => string;
    readonly generationFor: (displayPath: string) => number;
    readonly policy: (packageId: PackageIdType) => ScriptablePackInput['policy'];
    readonly transportIdentity: (packageId: PackageIdType) => string;
    readonly executionBudget?: (displayPath: string) => 'production' | 'interactive';
  },
): ScriptablePackInput[] {
  const inputFor = (
    root: ScriptablePackSourceDeclaration,
    sourcePath: string,
    packageId: PackageIdType,
  ): ScriptablePackInput => {
    const displaySourcePath = options.displayPath(sourcePath);
    const executionBudget = options.executionBudget?.(displaySourcePath);
    return {
      sourcePath,
      displaySourcePath,
      definition: createLazyScriptablePackDefinition({
        sourcePath: root.sourcePath,
        definition: root.definition,
        sourceClosure: root.sourceClosure,
        sourceSnapshot: options.sourceSnapshot,
        executors: options.executors,
        ...(options.enginePackageRoot === undefined
          ? {}
          : { packageBinding: { name: '@forgeax/engine', root: options.enginePackageRoot } }),
        ...(executionBudget === undefined ? {} : { executionBudget }),
      }),
      sourceClosure: root.sourceClosure,
      publicationGeneration: options.generationFor(displaySourcePath),
      policy: options.policy(packageId),
      transportIdentity: options.transportIdentity(packageId),
    };
  };
  const roots = [...declarations.values()].filter((source) => source.format === 'pack.ts');
  roots.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return [
    ...roots.map((root) => inputFor(root, root.sourcePath, root.definition.packageId)),
    ...[...instances]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourcePath, instance]) => ({
        ...inputFor(instance.root, sourcePath, instance.packageId),
        subjectPackageId: instance.packageId,
        values: instance.values,
      })),
  ];
}

export interface PreparedScriptablePack {
  readonly product: ScriptablePackBuildProduct;
  readonly finalized: FinalizedPackageTransport;
  readonly revision: ResourceRevision;
  readonly publication: AssetPublicationEnvelope;
}

export interface ScriptablePackProductionOptions {
  readonly sources: readonly ScriptablePackInput[];
  /** Optional immutable Pack-product DDC root, independent of runtime publication scope. */
  readonly buildCacheRoot?: string;
  /** Project root that Pack-product cache keys spell source paths relative to. */
  readonly cacheIdentityRoot?: string;
  readonly declaredExternalOutputs?: readonly ScriptablePackStagedOutput[];
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  /** Build-time producers used for custom or otherwise uncooked asset rows. */
  readonly cookers?: readonly NativeCooker[];
  readonly availableGuids?: ReadonlySet<string>;
  readonly availableKinds?: ReadonlyMap<string, string>;
  readonly incomingRefs?: ReadonlyMap<string, readonly string[]>;
  readonly maxPasses?: number;
  readonly maxConcurrency?: number;
  readonly onProgress?: ScriptablePackBuildWorklistOptions['onProgress'];
}

export interface ScriptablePackTransportPaths {
  readonly packagePath: string;
  readonly artifactPath: (path: string) => string;
  readonly receiptPath: (guid: string) => string;
}

export interface ScriptablePackTransportSink {
  writePackage(path: string, body: string): void | Promise<void>;
  writeArtifact(path: string, bytes: Uint8Array, mimeType: string): void | Promise<void>;
  writeReceipt(path: string, body: string): void | Promise<void>;
}

/** Build-time capabilities required to expose ordinary Meta products to a Pack. */
export interface ScriptablePackExternalImportOptions {
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
}

export function canonicalScriptableSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll('\\', '/');
  if (!isAbsolute(normalized) && !win32.isAbsolute(normalized)) return normalized;
  const marker = '/assets/';
  const markerIndex = normalized.indexOf(marker);
  return markerIndex < 0 ? normalized : normalized.slice(markerIndex + 1);
}

/** Stage materialized outputs owned by Meta or an already-cooked Pack v2 document. */
export async function declaredPackExternalOutputs(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  cookers: readonly NativeCooker[] = [],
  requiredGuids: readonly AssetGuidType[] = [],
  externalImport?: ScriptablePackExternalImportOptions,
): Promise<readonly ScriptablePackStagedOutput[]> {
  if (requiredGuids.length === 0) return [];
  const required = new Set(requiredGuids.map((guid) => AssetGuid.format(guid).toLowerCase()));
  const available = new Set(required);
  for (const declaration of declarations.values()) {
    if (declaration.format !== 'meta.json') continue;
    for (const asset of declaration.value.subAssets) {
      const parsed = AssetGuid.parse(asset.guid);
      if (!parsed.ok) throw parsed.error;
      available.add(AssetGuid.format(parsed.value).toLowerCase());
    }
  }
  const outputs: ScriptablePackStagedOutput[] = [];
  for (const declaration of declarations.values()) {
    if (declaration.format === 'meta.json') {
      if (externalImport === undefined) continue;
      if (!declaration.value.subAssets.some((asset) => required.has(asset.guid.toLowerCase()))) {
        continue;
      }
      const resolved = resolveAssetSource(declaration.sourcePath, declaration.value.source);
      const meta: RunImportMeta = {
        importer: declaration.value.importer,
        source: resolved,
        sourceRevision: declaration.sourceRevision,
        ...(declaration.value.packageId === undefined
          ? {}
          : { packageId: declaration.value.packageId }),
        ...(declaration.value.provenance === undefined
          ? {}
          : { provenance: declaration.value.provenance }),
        ...(declaration.value.revision === undefined
          ? {}
          : { revision: declaration.value.revision }),
        ...(declaration.value.diagnostics === undefined
          ? {}
          : { diagnostics: declaration.value.diagnostics }),
        importSettings: declaration.value.importSettings,
        ...(declaration.value.sourceOverrides === undefined
          ? {}
          : { sourceOverrides: declaration.value.sourceOverrides }),
        subAssets: declaration.value.subAssets.map(({ guid, sourceIndex, sourceKey, kind }) => ({
          guid,
          sourceIndex,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          kind,
        })),
      };
      const sourcePackage = await produceSourcePackage({
        meta,
        registry: externalImport.importerRegistry,
        fs: externalImport.fsForImport,
      });
      if (!sourcePackage.ok) throw sourcePackage.error;
      for (const asset of sourcePackage.value.product.assets) {
        if (!required.has(asset.guid.toLowerCase())) continue;
        const parsed = AssetGuid.parse(asset.guid);
        if (!parsed.ok) throw parsed.error;
        const declared = declaration.value.subAssets.find(
          (candidate) => candidate.guid.toLowerCase() === asset.guid.toLowerCase(),
        );
        outputs.push({
          guid: parsed.value,
          sourceKey: declared?.sourceKey ?? asset.guid,
          asset: { ...(asset.payload as Record<string, unknown>), kind: asset.kind } as Asset,
        });
      }
      continue;
    }
    if (declaration.format !== 'pack.json') continue;
    const parsed = declaration.value;
    if (parsed.format !== 'direct') continue;
    const full = projectDirectPackJson(parsed);
    const projected = {
      ...full,
      assets: full.assets.filter((asset) => required.has(asset.guid.toLowerCase())),
    };
    if (projected.assets.length === 0) continue;
    const prepared = await produceDirectPackProduct({
      projected,
      sourcePath: declaration.sourcePath,
      sourceRevision: declaration.sourceRevision,
      availableGuids: available,
      // These are staged content inputs. Both hosts validate the direct Pack
      // again against the complete generation before publishing it.
      deferReferenceValidation: true,
      ...(cookers.length === 0 ? {} : { cookers }),
    });
    if (!prepared.ok) throw prepared.error;
    // Content reads receive the producer payload; the finalized transport payload
    // omits data that its artifacts carry.
    const cookedByGuid = new Map(
      prepared.value.product.assets.map((asset) => [asset.guid.toLowerCase(), asset]),
    );
    for (const asset of projected.assets) {
      if (!required.has(asset.guid.toLowerCase())) continue;
      const parsedGuid = AssetGuid.parse(asset.guid);
      if (!parsedGuid.ok) throw parsedGuid.error;
      const cooked = cookedByGuid.get(asset.guid.toLowerCase());
      if (cooked === undefined) {
        throw new AssetError({
          code: 'asset-not-imported',
          expected: 'the direct Pack producer to retain every declared output',
          hint: 'repair the direct Pack output and rerun the Pack build',
          detail: { sourcePath: declaration.sourcePath },
        });
      }
      outputs.push({
        guid: parsedGuid.value,
        sourceKey: asset.sourceKey,
        asset: { kind: cooked.kind, ...(cooked.payload as Record<string, unknown>) } as Asset,
      });
    }
  }
  return outputs;
}

/** Current-inventory content reads; identity-only references never invoke a producer. */
export function createDeclaredPackAssetSnapshotSource(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  cookers: readonly NativeCooker[] = [],
  availableGuids: readonly AssetGuidType[] = [],
  externalImport?: ScriptablePackExternalImportOptions,
): ScriptablePackAssetSnapshotSource {
  const available = new Set(availableGuids.map((guid) => AssetGuid.format(guid).toLowerCase()));
  const owners = [...declarations.values()].flatMap((declaration) => {
    if (declaration.format === 'meta.json' && externalImport === undefined) return [];
    const owned = declaredSourceGuids(declaration)
      .filter((guid) => available.has(guid.toLowerCase()))
      .map(directGuid);
    if (owned.length === 0) return [];
    // Direct entries have independent producers. Meta sources retain
    // whole-source ownership because their importers may produce a shared closure.
    const direct = declaration.format === 'pack.json' && declaration.value.format === 'direct';
    const groups = direct ? owned.map((guid) => [guid]) : [owned];
    return groups.map((guids) => ({
      id: direct
        ? `${declaration.sourcePath}#${guids.map(AssetGuid.format).join(',')}`
        : declaration.sourcePath,
      guids,
      async build() {
        try {
          const outputs = await declaredPackExternalOutputs(
            new Map([[declaration.sourcePath, declaration]]),
            cookers,
            guids,
            externalImport,
          );
          // Retain the existing external snapshot identity and normalized payload.
          // The staged owner supplies concurrency, retry, and private result clones.
          return ok(
            await Promise.all(
              outputs.map(async (output) => ({
                ...output,
                digest: output.digest ?? (await scriptablePackFingerprintAsync(output.asset)),
              })),
            ),
          );
        } catch (error) {
          if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            'expected' in error &&
            typeof error.expected === 'string' &&
            'hint' in error &&
            typeof error.hint === 'string'
          )
            return err(error as ScriptablePackDomainError);
          throw error;
        }
      },
    }));
  });
  const known = new Set(
    owners.flatMap((owner) => owner.guids.map((guid) => AssetGuid.format(guid).toLowerCase())),
  );
  const staged = createScriptablePackStagedAssetSnapshotSource({ generation: 1, owners });
  return {
    readByGuid(guid) {
      const key = AssetGuid.format(guid).toLowerCase();
      // A forward read of another dynamic subject must reach the existing worklist.
      if (!known.has(key))
        return Promise.resolve(
          err(
            new AssetError({
              code: 'asset-not-found',
              expected: `an available Asset snapshot for ${key}`,
              hint: 'publish the referenced Pack or repair the content dependency',
            }),
          ),
        );
      return staged.readByGuid(guid);
    },
  };
}

export interface DirectPackTransport extends Omit<PreparedScriptablePack, 'publication'> {
  readonly outputs: readonly AssetPublicationOutput[];
  readonly projected: {
    readonly packageId: string;
    readonly assets: readonly DirectPackAssetProjection[];
  };
}

export interface DirectPackTransportInput {
  readonly projected: DirectPackTransport['projected'];
  readonly sourcePath: string;
  readonly displaySourcePath?: string;
  readonly sourceRevision: string;
  readonly policy: PackageFinalizePolicy;
  readonly availableGuids?: ReadonlySet<string>;
  readonly availableKinds?: ReadonlyMap<string, string>;
  /** Staging only: validate references when the complete generation is materialized. */
  readonly deferReferenceValidation?: boolean;
  readonly cookers?: readonly NativeCooker[];
}

function directReference(guid: string): AssetRef {
  return { guid, sourceField: { fieldName: 'refs' } };
}

function mergeDirectReferences(
  produced: readonly AssetRef[],
  declared: readonly string[],
): readonly AssetRef[] {
  const merged = [...produced];
  const seen = new Set(produced.map((reference) => reference.guid.toLowerCase()));
  for (const guid of declared) {
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw parsed.error;
    const normalized = AssetGuid.format(parsed.value);
    if (seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    merged.push(directReference(normalized));
  }
  return merged;
}

function validateDirectReferences(
  input: DirectPackProductionInput,
  assets: readonly ImportedAsset<unknown>[],
  known: ReadonlySet<string>,
): Result<void, unknown> {
  if (input.deferReferenceValidation) return ok(undefined);
  const missing = new Set<string>();
  for (const asset of assets) {
    for (const reference of asset.refs) {
      if (!known.has(reference.guid.toLowerCase())) missing.add(reference.guid.toLowerCase());
    }
  }
  return missing.size === 0
    ? ok(undefined)
    : err({
        code: 'pack-output-reference-missing',
        expected: 'every direct Pack reference to resolve to a local or published AssetGuid',
        hint: 'publish the referenced Pack or repair the direct refs before rebuilding the Pack',
        detail: { sourcePath: input.sourcePath, guids: [...missing].sort() },
      });
}

function directInputFingerprint(
  sourceRevision: string,
  nativeFingerprints: ReadonlyMap<string, string>,
): string {
  if (nativeFingerprints.size === 0) return sourceRevision;
  return `sha256:${packageTransportRevision({
    sourceRevision,
    nativeCookers: [...nativeFingerprints.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  })}`;
}

function directStagedOutputs(assets: readonly DirectPackAssetProjection[]) {
  return assets.map((asset) => ({
    guid: directGuid(asset.guid),
    sourceKey: asset.sourceKey,
    asset: directAssetForProducer(asset),
    digest: `sha256:${packageTransportRevision({ kind: asset.kind, payload: asset.payload })}`,
  }));
}

function planRawDirectPack(
  input: DirectPackProductionInput,
): Omit<PackOutputPlan, 'stagedOutputs'> {
  const inputFingerprint = `sha256:${packageTransportRevision({
    packageId: input.projected.packageId,
    sourceRevision: input.sourceRevision,
    assets: input.projected.assets,
  })}`;
  const imported = input.projected.assets.map((asset) => ({
    guid: asset.guid,
    kind: asset.kind,
    ...(asset.name === undefined ? {} : { name: asset.name }),
    payload: directRuntimePayload(asset),
    refs: asset.refs.map(directReference),
    artifacts: {},
  }));
  return {
    imported,
    externalEvidence: [],
    inputFingerprint,
    sourceDependencies: [input.sourcePath],
  };
}

function directGuid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function nativeRefs(refs: readonly string[]): AssetRef[] {
  return refs.map((guid) => {
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw parsed.error;
    return { guid: AssetGuid.format(parsed.value) };
  });
}

function nativeCookSource(asset: { readonly kind: string; readonly payload: unknown }): unknown {
  if (
    asset.kind !== 'material' ||
    asset.payload === null ||
    typeof asset.payload !== 'object' ||
    Array.isArray(asset.payload)
  ) {
    return asset.payload;
  }
  return { ...(asset.payload as Record<string, unknown>), kind: asset.kind };
}

/** Shared native cooker input for an output from a direct v3 declaration. */
export function directPackCookInput(asset: DirectPackAssetProjection, sourcePath: string) {
  return {
    guid: asset.guid,
    source: nativeCookSource(asset),
    sourceKey: asset.sourceKey,
    sourcePath,
    refs: asset.refs,
  };
}

function directRuntimePayload(asset: DirectPackAssetProjection): unknown {
  if (
    asset.kind !== 'ui' ||
    asset.payload === null ||
    typeof asset.payload !== 'object' ||
    Array.isArray(asset.payload)
  ) {
    return asset.payload;
  }
  return { ...(asset.payload as Record<string, unknown>), guid: asset.guid };
}

function directAssetForProducer(asset: DirectPackAssetProjection): Asset {
  const payload = {
    ...(directRuntimePayload(asset) as Record<string, unknown>),
    kind: asset.kind,
  };
  if (asset.kind !== 'mesh') return payload as Asset;
  return (normalizeMeshPayload(payload, asset.refs) ?? payload) as Asset;
}

/** Cook only opted-in siblings together; drain each bounded batch before returning a failure. */
async function cookDirectPackDrafts(
  input: DirectPackProductionInput,
  registry: NativeCookerRegistry,
): Promise<Result<ReadonlyMap<string, NativeCookDraft>, unknown>> {
  const assets = input.projected.assets.filter(
    (asset) => isScriptablePackAssetKind(asset.kind) && registry.get(asset.kind) !== undefined,
  );
  const materialTable = Object.fromEntries(
    assets
      .filter((asset) => asset.kind === 'material')
      .map((asset) => [asset.guid, nativeCookSource(asset)]),
  );
  const drafts = new Map<string, NativeCookDraft>();
  const parallel = (asset: DirectPackAssetProjection) =>
    registry.get(asset.kind)?.concurrency === 'parallel';
  const cook = async (asset: DirectPackAssetProjection) => {
    const draft = await registry.runDraft(asset.kind, {
      ...directPackCookInput(asset, input.sourcePath),
      ...(asset.kind === 'material' ? { publication: 'templates', table: materialTable } : {}),
    });
    if (!draft.ok) return draft;
    const guid = asset.guid.toLowerCase();
    if (draft.value.guid.toLowerCase() !== guid)
      return err({
        code: 'pack-parameter-invalid',
        expected: 'a direct Pack cooker to preserve the derived AssetGuid',
        hint: 'repair the native cooker output GUID and rebuild the direct Pack',
        detail: {
          sourcePath: input.sourcePath,
          sourceKey: asset.sourceKey,
          expectedGuid: asset.guid,
          actualGuid: draft.value.guid,
        },
      });
    return ok({ guid, draft: draft.value });
  };
  for await (const result of orderedPackProduction(
    assets,
    parallel,
    cook,
    (result) => !result.ok,
  )) {
    if (result.status === 'rejected') throw result.reason;
    if (!result.value.ok) return result.value;
    drafts.set(result.value.value.guid, result.value.value.draft);
  }
  return ok(drafts);
}

/** Cook one direct v3 Pack through the same producer/finalizer seam as pack.ts. */
export async function prepareDirectPackTransport(
  input: DirectPackTransportInput,
): Promise<Result<DirectPackTransport, unknown>> {
  const product = await produceDirectPackProduct(input);
  if (!product.ok) return product;
  const finalized = await finalizePackageTransportSource(
    projectImportProductForBuild(product.value.product),
    input.policy,
  );
  const transport = await projectPackProductTransport(
    product.value,
    finalized,
    input.displaySourcePath ?? input.sourcePath,
    [{ path: input.sourcePath, digest: input.sourceRevision }],
  );
  return transport.ok ? ok({ ...transport.value, projected: input.projected }) : transport;
}

type DirectPackProductionInput = Omit<DirectPackTransportInput, 'policy' | 'displaySourcePath'>;

async function produceDirectPackProduct(
  input: DirectPackProductionInput,
): Promise<Result<ScriptablePackBuildProduct, unknown>> {
  const localGuids = new Set(input.projected.assets.map((asset) => asset.guid.toLowerCase()));
  const availableGuids = new Set(
    [...(input.availableGuids ?? [])].filter((guid) => !localGuids.has(guid.toLowerCase())),
  );
  const directArtifacts = input.projected.assets.find(
    (asset) => asset.artifacts !== undefined && Object.keys(asset.artifacts).length > 0,
  );
  if (directArtifacts !== undefined) {
    return err({
      code: 'pack-parameter-invalid',
      expected: 'direct v3 authoring entries to leave artifacts empty for the producer',
      hint: 'remove authored artifact data and let the registered Asset producer create it',
      detail: { sourcePath: input.sourcePath, sourceKey: directArtifacts.sourceKey },
    });
  }
  const packageId = PackageId.parse(input.projected.packageId);
  if (!packageId.ok) return err(packageId.error);
  const cookerRegistry = new NativeCookerRegistry();
  for (const cooker of input.cookers ?? []) cookerRegistry.register(cooker);
  const cookedDrafts = await cookDirectPackDrafts(input, cookerRegistry);
  if (!cookedDrafts.ok) return cookedDrafts;
  const nativeDrafts = cookedDrafts.value;
  const unsupported = input.projected.assets.filter(
    (asset) => !isScriptablePackAssetKind(asset.kind),
  );
  if (unsupported.length > 0 && unsupported.length !== input.projected.assets.length) {
    return err({
      code: 'pack-parameter-invalid',
      expected: 'a direct Pack to contain only producer-backed Engine Assets or only direct PODs',
      hint: 'split custom direct PODs from producer-backed Assets into separate Packs',
      detail: {
        sourcePath: input.sourcePath,
        unsupportedKinds: [...new Set(unsupported.map((asset) => asset.kind))].sort(),
      },
    });
  }
  const known = new Set([...availableGuids, ...localGuids]);
  const plan =
    unsupported.length === input.projected.assets.length
      ? ok(planRawDirectPack(input))
      : await planDirectPack(input, packageId.value, nativeDrafts, availableGuids);
  if (!plan.ok) return plan;
  const references = validateDirectReferences(input, plan.value.imported, known);
  if (!references.ok) return references;
  return sealPackOutputPlan(input.sourcePath, {
    ...plan.value,
    stagedOutputs: directStagedOutputs(input.projected.assets),
  });
}

async function planDirectPack(
  input: DirectPackProductionInput,
  packageId: PackageIdType,
  nativeDrafts: ReadonlyMap<string, NativeCookDraft>,
  availableGuids: ReadonlySet<string>,
): Promise<Result<Omit<PackOutputPlan, 'stagedOutputs'>, unknown>> {
  const source = Object.fromEntries(
    input.projected.assets.map((asset) => [
      asset.sourceKey,
      {
        ...((nativeDrafts.get(asset.guid.toLowerCase())?.payload as
          | Record<string, unknown>
          | undefined) ?? directAssetForProducer(asset)),
        kind: asset.kind,
      } as Asset,
    ]),
  );
  const outputs = createStandardAssetOutputProducerRegistry();
  outputs.register(createPreExternalizedSceneAssetOutputProducer());
  const built = await planPackOutputMap(
    {
      sourcePath: input.sourcePath,
      outputs,
      sourceClosure: [{ path: input.sourcePath, digest: input.sourceRevision }],
      availableGuids,
      deferReferenceValidation: true,
    },
    packageId,
    source,
    input.projected.assets.some((asset) => asset.kind === 'plugin') ? true : undefined,
  );
  if (!built.ok) return built;
  const declared = new Map(
    input.projected.assets.map((asset) => [asset.guid.toLowerCase(), asset.refs]),
  );
  const assets = built.value.imported.map((asset) => {
    const guid = asset.guid.toLowerCase();
    const draft = nativeDrafts.get(guid);
    return {
      ...asset,
      ...(draft === undefined ? {} : { payload: draft.payload, artifacts: draft.artifacts }),
      refs: mergeDirectReferences(
        draft === undefined ? asset.refs : nativeRefs(draft.refs),
        declared.get(guid) ?? [],
      ),
    };
  });
  const knownKinds = new Map(
    [...(input.availableKinds ?? [])].map(([guid, kind]) => [guid.toLowerCase(), kind]),
  );
  for (const asset of input.projected.assets) knownKinds.set(asset.guid.toLowerCase(), asset.kind);
  for (const asset of input.projected.assets) {
    const kindFailure = waterPackReferenceKindFailure(
      input.sourcePath,
      asset.sourceKey,
      { ...(asset.payload as Record<string, unknown>), kind: asset.kind } as Asset,
      knownKinds,
    );
    if (kindFailure !== undefined) return err(kindFailure);
  }
  const fingerprints = new Map<string, string>();
  for (const asset of input.projected.assets) {
    const draft = nativeDrafts.get(asset.guid.toLowerCase());
    if (draft !== undefined) fingerprints.set(asset.sourceKey, draft.inputFingerprint);
  }
  return ok({
    imported: assets,
    externalEvidence: built.value.externalEvidence,
    inputFingerprint: directInputFingerprint(built.value.inputFingerprint, fingerprints),
    sourceDependencies: built.value.sourceDependencies,
  });
}

/** Materialize a dynamic Pack product through the same dev transport seam. */
export async function materializePreparedScriptablePack(
  prepared: Pick<PreparedScriptablePack, 'product' | 'finalized'>,
  paths: ScriptablePackTransportPaths,
  sink: ScriptablePackTransportSink,
  pack: FinalizedPackageTransport['pack'] | RuntimePackPublication['pack'] = prepared.finalized
    .pack,
  delivery: 'scriptable' | 'direct' = 'scriptable',
): Promise<ReadonlyMap<string, string>> {
  const { product, finalized } = prepared;
  await sink.writePackage(paths.packagePath, JSON.stringify(projectMaterialPackTransport(pack)));
  for (const artifact of finalized.artifacts) {
    await sink.writeArtifact(
      paths.artifactPath(artifact.path),
      artifact.bytes,
      delivery === 'scriptable' && artifact.path.endsWith('.json')
        ? 'application/json'
        : artifact.mediaType,
    );
  }
  const receipts = new Map<string, string>();
  const rows =
    delivery === 'direct'
      ? product.product.receipts
      : product.product.assets.map(({ guid }) => ({
          guid,
          origin: 'sourceMeta',
          status: 'succeeded',
          inputFingerprint: product.inputFingerprint,
        }));
  for (const receipt of rows) {
    const guid = receipt.guid.toLowerCase();
    const path = paths.receiptPath(delivery === 'direct' ? guid : receipt.guid);
    await sink.writeReceipt(path, JSON.stringify({ ...receipt, outputDigest: finalized.digest }));
    receipts.set(guid, path);
  }
  return receipts;
}

function projectScriptablePackPublication(
  product: ScriptablePackBuildProduct,
): Result<readonly AssetPublicationOutput[], ScriptablePackDomainError> {
  const assets = new Map(product.product.assets.map((asset) => [asset.guid.toLowerCase(), asset]));
  const outputs: AssetPublicationOutput[] = [];
  for (const staged of product.stagedOutputs) {
    const guid = AssetGuid.format(staged.guid).toLowerCase();
    const asset = assets.get(guid);
    if (asset === undefined || staged.digest === undefined || staged.sourceKey === undefined) {
      return err({
        code: 'pack-source-output-invalid',
        expected: `ScriptablePack publication output ${guid} to include a product, sourceKey, and digest`,
        hint: 'repair the dynamic Pack output and rebuild the current generation',
        detail: { stage: 'publication', guid },
      });
    }
    outputs.push({
      guid,
      sourceKey: staged.sourceKey,
      kind: asset.kind,
      digest: staged.digest,
      refs: asset.refs.map((reference) => reference.guid),
    });
  }
  return ok(outputs);
}

async function createProductionCaches(
  options: ScriptablePackProductionOptions,
  outputVersions: Readonly<Record<string, string>>,
) {
  if (options.buildCacheRoot === undefined) return { product: undefined, transport: undefined };
  const identity =
    options.cacheIdentityRoot === undefined ? {} : { identityRoot: options.cacheIdentityRoot };
  const product = await createScriptablePackProductCache({
    root: options.buildCacheRoot,
    ...identity,
    outputVersions,
    cookers: options.cookers ?? [],
  });
  const transport = await createScriptablePackTransportCache({
    root: options.buildCacheRoot,
    ...identity,
    canReuse: product.canReuse,
  });
  return { product, transport };
}

/**
 * Build ScriptablePack sources in one generation and hand their terminal
 * products to the ordinary Pack v2 finalizer. The worklist is deliberately
 * below publication: it only decides which current-generation products exist.
 */
export async function produceScriptablePackProducts(
  options: ScriptablePackProductionOptions,
): Promise<Result<ReadonlyMap<string, PreparedScriptablePack>, unknown>> {
  if (options.sources.length === 0) return ok(new Map());
  const external = options.declaredExternalOutputs ?? [];
  const assetSource = sourceWithPreparedPackOutputs(external, options.assetSource);
  const availableGuids = new Set([
    ...(options.availableGuids ?? []),
    ...external.map((output) => AssetGuid.format(output.guid).toLowerCase()),
  ]);
  const availableKinds = new Map(
    [...(options.availableKinds ?? [])].map(([guid, kind]) => [guid.toLowerCase(), kind]),
  );
  for (const output of external)
    availableKinds.set(AssetGuid.format(output.guid).toLowerCase(), String(output.asset.kind));
  const workItems: ScriptablePackBuildWorkItem[] = options.sources.map((source) => ({
    definition: source.definition,
    sourcePath: source.sourcePath,
    ...(source.subjectPackageId === undefined ? {} : { subjectPackageId: source.subjectPackageId }),
    ...(source.values === undefined ? {} : { values: source.values }),
    ...(source.inheritedValues === undefined ? {} : { inheritedValues: source.inheritedValues }),
    sourceClosure: source.sourceClosure,
    publicationGeneration: source.publicationGeneration,
  }));
  const outputs = createStandardAssetOutputProducerRegistry(
    options.sources.flatMap((source) =>
      projectScriptablePackSceneComponents(source.definition.sceneComponents),
    ),
  );
  const { product: cache, transport: transportCache } = await createProductionCaches(
    options,
    outputs.versions(),
  );
  const worklist = await buildScriptablePackWorklist({
    subjects: workItems,
    outputs,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(cache === undefined ? {} : { cache }),
    ...(options.cookers === undefined ? {} : { cookers: options.cookers }),
    ...(assetSource === undefined ? {} : { assetSource }),
    availableGuids,
    availableKinds,
    ...(options.incomingRefs === undefined ? {} : { incomingRefs: options.incomingRefs }),
    ...(options.maxPasses === undefined ? {} : { maxPasses: options.maxPasses }),
    ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
  });
  if (!worklist.ok) return worklist;

  const productsBySource = new Map(
    worklist.value.buildProducts
      .filter((product) => product.product.sourceKey !== undefined)
      .map((product) => [product.product.sourceKey as string, product]),
  );
  const prepared = new Map<string, PreparedScriptablePack>();
  for (const source of options.sources) {
    const product = productsBySource.get(source.sourcePath);
    if (product === undefined) {
      return err({
        code: 'pack-source-output-invalid',
        expected: 'one terminal dynamic Pack product for every source subject',
        hint: 'rerun the bounded generation worklist and inspect its subject map',
        detail: { sourcePath: source.sourcePath },
      });
    }
    const result = await finalizeScriptablePackProduct(source, product, transportCache);
    if (!result.ok) return result;
    prepared.set(source.displaySourcePath, result.value);
  }
  return ok(prepared);
}

/** Project the immutable module closure into the Catalog revision contract. */
async function scriptablePackResourceRevision(
  displaySourcePath: string,
  digest: string,
  sourceClosure: readonly ScriptablePackSourceClosureEntry[],
): Promise<ResourceRevision> {
  const mtimes = await Promise.all(
    sourceClosure.map(async (entry) => {
      try {
        return (await stat(entry.path)).mtimeMs;
      } catch (error) {
        // Direct Pack declarations may be supplied with a logical source path
        // and sourceText rather than a file-backed module. The digest remains
        // the authoritative revision in that case; preserve filesystem errors
        // other than a missing path so real source failures stay visible.
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        ) {
          return 0;
        }
        throw error;
      }
    }),
  );
  const observedAt = mtimes.length === 0 ? 0 : Math.trunc(Math.max(...mtimes));
  return { digest, observedAt, rootId: displaySourcePath };
}

async function finalizeScriptablePackProduct(
  source: ScriptablePackInput,
  product: ScriptablePackBuildProduct,
  cache?: Awaited<ReturnType<typeof createScriptablePackTransportCache>>,
): Promise<Result<PreparedScriptablePack, unknown>> {
  let finalized = await cache?.read(source, product);
  if (finalized === undefined) {
    const policy = typeof source.policy === 'function' ? source.policy(product) : source.policy;
    finalized = await finalizePackageTransportSource(
      projectImportProductForBuild(product.product),
      policy,
    );
    if (policy.sink === undefined) await cache?.write(source, product, finalized);
  }
  const transport = await projectPackProductTransport(
    product,
    finalized,
    source.displaySourcePath,
    source.sourceClosure,
  );
  if (!transport.ok) return transport;
  const { revision, outputs } = transport.value;
  return ok({
    product,
    finalized,
    revision,
    publication: projectPreparedPackPublication(
      { product, finalized, outputs },
      source.displaySourcePath,
      source.publicationGeneration,
    ),
  });
}

/**
 * The worklist exposes authored staged outputs to its readers. A metadata-only
 * material cooker changes neither those outputs nor their dependency evidence.
 */
export async function rebindPreparedScriptablePack(
  source: ScriptablePackInput,
  prepared: PreparedScriptablePack,
): Promise<Result<PreparedScriptablePack, unknown>> {
  const product = bindScriptablePackMaterialGeneration(
    prepared.product,
    source.publicationGeneration,
  );
  if (!product) return err(new TypeError('invalid cooked material publication generation'));
  if (product !== prepared.product) return finalizeScriptablePackProduct(source, product);
  return ok({
    ...prepared,
    publication: projectPreparedPackPublication(
      prepared,
      source.displaySourcePath,
      source.publicationGeneration,
    ),
  });
}

export function projectPreparedPackPublication(
  prepared: Pick<DirectPackTransport, 'product' | 'finalized' | 'outputs'> | PreparedScriptablePack,
  sourcePath: string,
  generation: number,
): AssetPublicationEnvelope {
  const { product, finalized } = prepared;
  return createAssetPublication({
    sourcePath,
    sourceRevision: product.inputFingerprint,
    generation,
    digest: finalized.digest,
    packageUrl: finalized.packageUrl,
    inputFingerprint: product.inputFingerprint,
    outputs: 'publication' in prepared ? prepared.publication.outputs : prepared.outputs,
    externalEvidence: product.externalEvidence,
  });
}

async function projectPackProductTransport(
  product: ScriptablePackBuildProduct,
  finalized: FinalizedPackageTransport,
  displaySourcePath: string,
  closure: readonly ScriptablePackSourceClosureEntry[],
): Promise<Result<Omit<DirectPackTransport, 'projected'>, ScriptablePackDomainError>> {
  const outputs = projectScriptablePackPublication(product);
  if (!outputs.ok) return outputs;
  const revision = await scriptablePackResourceRevision(
    displaySourcePath,
    product.inputFingerprint,
    closure,
  );
  return ok({ product, finalized, outputs: outputs.value, revision });
}
