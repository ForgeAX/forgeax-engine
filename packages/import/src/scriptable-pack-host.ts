import { stat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { normalizeMeshPayload } from '@forgeax/engine-geometry';
import {
  finalizePackageTransportSource,
  type PackageFinalizePolicy,
  type PackageProductAsset,
  packageTransportRevision,
  resolveAssetSource,
} from '@forgeax/engine-pack/build';
import { BUILTIN_MESH_ASSETS } from '@forgeax/engine-pack/builtin';
import { AssetGuid, PackageId, type PackageId as PackageIdType } from '@forgeax/engine-pack/guid';
import {
  type NativeCookDraft,
  type NativeCooker,
  NativeCookerRegistry,
} from '@forgeax/engine-pack/native-cooker';
import {
  declaredSourceGuids,
  type LegacyPackInventoryDocument,
  type ScanSourceDeclaration,
} from '@forgeax/engine-pack/scanner';
import {
  type AnyScriptablePackDefinition,
  type DirectPackAssetProjection,
  isScriptablePackAssetKind,
  projectDirectPackJson,
  projectScriptablePackSceneComponents,
  type ScriptablePackSourceClosureEntry,
} from '@forgeax/engine-pack/source';
import { isEngineMaterial } from '@forgeax/engine-shader';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  AssetPublicationOutput,
  AssetRef,
  ImportedArtifactBody,
  ImportedAsset,
  MaterialAsset,
  ResourceRevision,
  Result,
} from '@forgeax/engine-types';
import { AssetError, createAssetPublication, err, ok } from '@forgeax/engine-types';
import type { DdcPack, ImportRunnerFs, RunImportMeta } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';
import { projectImportProductForBuild } from './pack-projection.js';
import type {
  ScriptablePackAssetSnapshotSource,
  ScriptablePackDomainError,
  ScriptablePackStagedOutput,
} from './scriptable-pack.js';
import {
  buildScriptablePack,
  buildScriptablePackWorklist,
  type ScriptablePackBuildProduct,
  type ScriptablePackBuildWorkItem,
  type ScriptablePackBuildWorklistOptions,
} from './scriptable-pack-build.js';
import { createPreExternalizedSceneAssetOutputProducer } from './scriptable-pack-output-producers.js';
import { createScriptablePackProductCache } from './scriptable-pack-product-cache.js';
import { createScriptablePackStagedAssetSnapshotSource } from './scriptable-pack-staged-snapshot.js';
import { produceSourcePackage } from './source-package.js';
import { createStandardAssetOutputProducerRegistry } from './standard-output-producers.js';

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
  readonly subjectPackageId?: PackageIdType;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly inheritedValues?: Readonly<
    Record<string, import('@forgeax/engine-pack/source').PackParameterValue>
  >;
}

export interface PreparedScriptablePack {
  readonly product: ScriptablePackBuildProduct;
  readonly finalized: FinalizedPackageTransport;
  readonly facts: ScriptablePackPublicationFacts;
  readonly revision: ResourceRevision;
  readonly publication: AssetPublicationEnvelope;
}

export interface ScriptablePackProductionOptions {
  readonly sources: readonly ScriptablePackInput[];
  /** Optional immutable Pack-product DDC root, independent of runtime publication scope. */
  readonly buildCacheRoot?: string;
  readonly declaredExternalOutputs?: readonly ScriptablePackStagedOutput[];
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  /** Build-time producers used for custom or otherwise uncooked asset rows. */
  readonly cookers?: readonly NativeCooker[];
  readonly availableGuids?: ReadonlySet<string>;
  readonly incomingRefs?: ReadonlyMap<string, readonly string[]>;
  readonly maxPasses?: number;
  readonly maxConcurrency?: number;
  readonly onProgress?: ScriptablePackBuildWorklistOptions['onProgress'];
}

export interface ScriptablePackPublicationFacts {
  readonly outputs: readonly AssetPublicationOutput[];
  readonly refs: ReadonlyMap<string, readonly string[]>;
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
        buildPack: false,
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
    if (declaration.value.schemaVersion === '3.0.0') {
      const parsed = declaration.value;
      if (parsed.format !== 'direct') continue;
      const full = projectDirectPackJson(parsed);
      const projected = {
        ...full,
        assets: full.assets.filter((asset) => required.has(asset.guid.toLowerCase())),
      };
      if (projected.assets.length === 0) continue;
      const prepared = await prepareDirectPackTransport({
        projected,
        sourcePath: declaration.sourcePath,
        sourceRevision: declaration.sourceRevision,
        availableGuids: available,
        // These are staged content inputs. Both hosts validate the direct Pack
        // again against the complete generation before publishing it.
        deferReferenceValidation: true,
        ...(cookers.length === 0 ? {} : { cookers }),
        policy: {
          base: '/',
          packagePath: `assets/${projected.packageId}.pack.json`,
          artifactPath: (assetGuid, key) => `${assetGuid}/${key}.bin`,
        },
      });
      if (!prepared.ok) throw prepared.error;
      const cookedByGuid = new Map(
        prepared.value.finalized.pack.assets.map((asset) => [asset.guid.toLowerCase(), asset]),
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
          asset: { kind: cooked.kind, ...cooked.payload } as Asset,
        });
      }
      continue;
    }
    const cooked = await readCookedAuthoredPack(declaration.value, cookers, declaration.sourcePath);
    for (const asset of cooked?.logicalPackage.assets ?? declaration.value.assets) {
      if (!required.has(asset.guid.toLowerCase())) continue;
      const parsedGuid = AssetGuid.parse(asset.guid);
      if (!parsedGuid.ok) throw parsedGuid.error;
      outputs.push({
        guid: parsedGuid.value,
        sourceKey: asset.sourceKey ?? asset.guid,
        asset: { ...asset.payload, kind: asset.kind } as Asset,
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
    // Direct entries have independent producers. Meta and legacy sources retain
    // whole-source ownership because their importers may produce a shared closure.
    const direct =
      declaration.format === 'pack.json' &&
      declaration.value.schemaVersion === '3.0.0' &&
      declaration.value.format === 'direct';
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
            outputs.map((output) => ({ ...output, digest: output.digest ?? 'sha256:staged' })),
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

/** Cook the explicit legacy Pack v2 transport without exposing v1 authoring APIs. */
export async function readCookedAuthoredPack(
  authoredPack: LegacyPackInventoryDocument,
  cookers: readonly NativeCooker[] = [],
  sourcePath?: string,
): Promise<
  | {
      readonly logicalPackage: Pick<DdcPack, 'assets'>;
      readonly refsByGuid: ReadonlyMap<string, readonly string[]>;
    }
  | undefined
> {
  if (authoredPack.schemaVersion !== '2.0.0') return undefined;
  const registry = new NativeCookerRegistry();
  for (const cooker of cookers) registry.register(cooker);
  const assets: PackageProductAsset[] = [];
  const refsByGuid = new Map<string, readonly string[]>();
  let hasCookedAsset = false;
  for (const asset of authoredPack.assets) {
    if (asset.execution !== 'cooked') {
      assets.push({
        guid: asset.guid,
        kind: asset.kind,
        ...(asset.name === undefined ? {} : { name: asset.name }),
        payload: asset.payload,
        refs: asset.refs,
        artifacts: {},
      });
      continue;
    }
    if (isEngineOwnedMaterial(asset)) {
      // Engine-owned material payloads are already cooked, but a legacy Pack
      // source still needs to be projected into the runtime transport route.
      // Mark the package as cooked so prepareLegacyPackTransport stages a
      // published body instead of falling back to the source URL, which the
      // dev route intentionally rejects for cooked v2 inputs.
      hasCookedAsset = true;
      refsByGuid.set(asset.guid.toLowerCase(), [...asset.refs]);
      assets.push({
        guid: asset.guid,
        kind: asset.kind,
        ...(asset.name === undefined ? {} : { name: asset.name }),
        payload: asset.payload,
        refs: asset.refs,
        artifacts: {},
      });
      continue;
    }
    hasCookedAsset = true;
    const result = await registry.runDraft(asset.kind, {
      guid: asset.guid,
      // Pack v2 stores the asset kind beside payload. Native producer APIs
      // consume the runtime Asset shape, so reconstruct that one boundary
      // field before invoking the cooker.
      source: nativeCookSource(asset),
      ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      refs: asset.refs,
    });
    if (!result.ok) throw result.error;
    const draft = result.value;
    refsByGuid.set(asset.guid.toLowerCase(), [...draft.refs]);
    assets.push({
      guid: draft.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      payload: draft.payload as Record<string, unknown>,
      refs: [...draft.refs],
      artifacts: draft.artifacts,
    });
  }
  return hasCookedAsset
    ? {
        logicalPackage: { assets },
        refsByGuid,
      }
    : undefined;
}

export interface LegacyPackTransport {
  readonly pack: LegacyPackInventoryDocument;
  readonly firstGuid?: string;
  readonly cooked?: Awaited<ReturnType<typeof readCookedAuthoredPack>>;
  readonly finalized?: FinalizedPackageTransport;
}

export interface DirectPackTransport {
  readonly projected: {
    readonly packageId: string;
    readonly assets: readonly DirectPackAssetProjection[];
  };
  readonly product: ScriptablePackBuildProduct;
  readonly finalized: FinalizedPackageTransport;
  readonly facts: ScriptablePackPublicationFacts;
  readonly revision: ResourceRevision;
}

export interface DirectPackTransportInput {
  readonly projected: DirectPackTransport['projected'];
  readonly sourcePath: string;
  readonly displaySourcePath?: string;
  readonly sourceRevision: string;
  readonly policy: PackageFinalizePolicy;
  readonly availableGuids?: ReadonlySet<string>;
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

function directReferenceFailure(
  sourcePath: string,
  guids: readonly string[],
): {
  readonly code: 'pack-output-reference-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly sourcePath: string; readonly guids: readonly string[] };
} {
  return {
    code: 'pack-output-reference-missing',
    expected: 'every direct Pack reference to resolve to a local or published AssetGuid',
    hint: 'publish the referenced Pack or repair the direct refs before rebuilding the Pack',
    detail: { sourcePath, guids: [...guids].sort() },
  };
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

function importedAssetArtifacts(
  assets: readonly ImportedAsset<unknown>[],
): Readonly<Record<string, ImportedArtifactBody>> {
  return Object.fromEntries(
    assets.flatMap((asset) =>
      Object.entries(asset.artifacts).map(([key, artifact]) => [`${asset.guid}/${key}`, artifact]),
    ),
  );
}

function rawDirectProduct(input: DirectPackTransportInput): ScriptablePackBuildProduct {
  const inputFingerprint = `sha256:${packageTransportRevision({
    packageId: input.projected.packageId,
    sourceRevision: input.sourceRevision,
    assets: input.projected.assets,
  })}`;
  const assets: ImportedAsset<unknown>[] = input.projected.assets.map((asset) => ({
    guid: asset.guid,
    kind: asset.kind,
    ...(asset.name === undefined ? {} : { name: asset.name }),
    payload: directRuntimePayload(asset),
    refs: asset.refs.map(directReference),
    artifacts: {},
  }));
  return {
    product: {
      assets,
      sourceDependencies: [input.sourcePath],
      refs: assets.flatMap((asset) => asset.refs),
      artifacts: importedAssetArtifacts(assets),
      receipts: assets.map((asset) => ({
        guid: asset.guid,
        origin: 'authoredPack' as const,
        status: 'succeeded' as const,
        inputFingerprint,
      })),
      diagnostics: [],
      sourceRevision: inputFingerprint,
      sourceKey: input.sourcePath,
    },
    stagedOutputs: input.projected.assets.map((asset) => ({
      guid: directGuid(asset.guid),
      sourceKey: asset.sourceKey,
      asset: {
        ...(directRuntimePayload(asset) as Record<string, unknown>),
        kind: asset.kind,
      } as Asset,
      digest: `sha256:${packageTransportRevision({ kind: asset.kind, payload: asset.payload })}`,
    })),
    externalEvidence: [],
    inputFingerprint,
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

function isEngineOwnedMaterial(asset: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  if (
    asset.kind !== 'material' ||
    asset.payload === null ||
    typeof asset.payload !== 'object' ||
    Array.isArray(asset.payload)
  ) {
    return false;
  }
  return isEngineMaterial(asset.payload as Pick<MaterialAsset, 'passes'>);
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

/** Cook one direct v3 Pack through the same producer/finalizer seam as pack.ts. */
export async function prepareDirectPackTransport(
  input: DirectPackTransportInput,
): Promise<Result<DirectPackTransport, unknown>> {
  const localGuids = new Set(input.projected.assets.map((asset) => asset.guid.toLowerCase()));
  const availableGuids = new Set(
    [...(input.availableGuids ?? []), ...BUILTIN_MESH_ASSETS.map((asset) => asset.guid)].filter(
      (guid) => !localGuids.has(guid.toLowerCase()),
    ),
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
  const nativeDrafts = new Map<string, NativeCookDraft>();
  const nativeFingerprints = new Map<string, string>();
  for (const asset of input.projected.assets) {
    if (!isScriptablePackAssetKind(asset.kind)) continue;
    if (cookerRegistry.get(asset.kind) === undefined) continue;
    const draft = await cookerRegistry.runDraft(asset.kind, {
      guid: asset.guid,
      // Direct v3 entries keep `kind` at the entry boundary. Reattach it for
      // producer contracts such as MaterialAsset, whose payload is otherwise
      // intentionally allowed to omit the discriminant.
      source: nativeCookSource(asset),
      sourceKey: asset.sourceKey,
      sourcePath: input.sourcePath,
      refs: asset.refs,
    });
    if (!draft.ok) return err(draft.error);
    if (draft.value.guid.toLowerCase() !== asset.guid.toLowerCase()) {
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
    }
    nativeDrafts.set(asset.guid.toLowerCase(), draft.value);
    nativeFingerprints.set(asset.sourceKey, draft.value.inputFingerprint);
  }
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
  if (unsupported.length === input.projected.assets.length) {
    const raw = rawDirectProduct(input);
    const known = new Set([...availableGuids, ...localGuids]);
    const missing = new Set<string>();
    for (const asset of raw.product.assets) {
      for (const reference of asset.refs) {
        if (!known.has(reference.guid.toLowerCase())) missing.add(reference.guid.toLowerCase());
      }
    }
    if (missing.size > 0 && !input.deferReferenceValidation)
      return err(directReferenceFailure(input.sourcePath, [...missing]));
    const finalized = await finalizePackageTransportSource(
      projectImportProductForBuild(raw.product),
      input.policy,
    );
    const facts = projectScriptablePackPublication(raw);
    if (!facts.ok) return facts;
    const displaySourcePath = input.displaySourcePath ?? input.sourcePath;
    const revision = await scriptablePackResourceRevision(displaySourcePath, raw.inputFingerprint, [
      { path: input.sourcePath, digest: input.sourceRevision },
    ]);
    return ok({
      projected: input.projected,
      product: raw,
      finalized,
      facts: facts.value,
      revision,
    });
  }
  const definition = {
    schemaVersion: '2.0.0' as const,
    packageId: packageId.value,
    ...(input.projected.assets.some((asset) => asset.kind === 'plugin')
      ? { plugins: true as const }
      : {}),
    build: () =>
      ok(
        Object.fromEntries(
          input.projected.assets.map((asset) => [
            asset.sourceKey,
            {
              ...((nativeDrafts.get(asset.guid.toLowerCase())?.payload as
                | Record<string, unknown>
                | undefined) ?? directAssetForProducer(asset)),
              kind: asset.kind,
            } as Asset,
          ]),
        ),
      ),
  } as AnyScriptablePackDefinition;
  const outputs = createStandardAssetOutputProducerRegistry();
  outputs.register(createPreExternalizedSceneAssetOutputProducer());
  const built = await buildScriptablePack({
    definition,
    sourcePath: input.sourcePath,
    outputs,
    sourceClosure: [{ path: input.sourcePath, digest: input.sourceRevision }],
    availableGuids,
    deferReferenceValidation: true,
  });
  if (!built.ok) return built;
  const declaredByGuid = new Map(
    input.projected.assets.map((asset) => [asset.guid.toLowerCase(), asset.refs]),
  );
  const assets = built.value.product.assets.map((asset) => ({
    ...asset,
    ...(nativeDrafts.has(asset.guid.toLowerCase())
      ? {
          payload: nativeDrafts.get(asset.guid.toLowerCase())?.payload as Record<string, unknown>,
          refs: mergeDirectReferences(
            nativeRefs(nativeDrafts.get(asset.guid.toLowerCase())?.refs ?? []),
            declaredByGuid.get(asset.guid.toLowerCase()) ?? [],
          ),
          artifacts: nativeDrafts.get(asset.guid.toLowerCase())?.artifacts ?? {},
        }
      : {
          refs: mergeDirectReferences(
            asset.refs,
            declaredByGuid.get(asset.guid.toLowerCase()) ?? [],
          ),
        }),
  }));
  const missing = new Set<string>();
  const known = new Set([...availableGuids, ...localGuids]);
  for (const asset of assets) {
    for (const reference of asset.refs) {
      if (!known.has(reference.guid.toLowerCase())) missing.add(reference.guid.toLowerCase());
    }
  }
  if (missing.size > 0 && !input.deferReferenceValidation)
    return err(directReferenceFailure(input.sourcePath, [...missing]));
  const inputFingerprint = directInputFingerprint(built.value.inputFingerprint, nativeFingerprints);
  const stagedOutputs = input.projected.assets.map((asset) => ({
    guid: directGuid(asset.guid),
    sourceKey: asset.sourceKey,
    asset: directAssetForProducer(asset),
    digest: `sha256:${packageTransportRevision({ kind: asset.kind, payload: asset.payload })}`,
  }));
  const product: ScriptablePackBuildProduct = {
    ...built.value,
    inputFingerprint,
    stagedOutputs,
    product: {
      ...built.value.product,
      assets,
      refs: assets.flatMap((asset) => asset.refs),
      artifacts: importedAssetArtifacts(assets),
      receipts: built.value.product.receipts.map((receipt) => ({
        ...receipt,
        inputFingerprint,
      })),
      sourceRevision: inputFingerprint,
    },
  };
  const finalized = await finalizePackageTransportSource(
    projectImportProductForBuild(product.product),
    input.policy,
  );
  const facts = projectScriptablePackPublication(product);
  if (!facts.ok) return facts;
  const displaySourcePath = input.displaySourcePath ?? input.sourcePath;
  const revision = await scriptablePackResourceRevision(
    displaySourcePath,
    product.inputFingerprint,
    [{ path: input.sourcePath, digest: input.sourceRevision }],
  );
  return ok({
    projected: input.projected,
    product,
    finalized,
    facts: facts.value,
    revision,
  });
}

/** Normalize one explicit Pack v2 transport and invoke its registered cookers once. */
export async function prepareLegacyPackTransport(
  authoredPack: LegacyPackInventoryDocument,
  cookers: readonly NativeCooker[] | undefined,
  policyFor: (guid: string) => PackageFinalizePolicy,
  sourcePath?: string,
): Promise<LegacyPackTransport> {
  const firstGuid = authoredPack.assets[0]?.guid?.toLowerCase();
  if (authoredPack.schemaVersion !== '2.0.0' || firstGuid === undefined) {
    return { pack: authoredPack, ...(firstGuid === undefined ? {} : { firstGuid }) };
  }
  const cooked = await readCookedAuthoredPack(authoredPack, cookers, sourcePath);
  if (cooked === undefined) return { pack: authoredPack, firstGuid };
  return {
    pack: authoredPack,
    firstGuid,
    cooked,
    finalized: await finalizePackageTransportSource(cooked.logicalPackage, policyFor(firstGuid)),
  };
}

/** Materialize a dynamic Pack product through the same dev transport seam. */
export async function materializePreparedScriptablePack(
  prepared: PreparedScriptablePack,
  paths: ScriptablePackTransportPaths,
  sink: ScriptablePackTransportSink,
): Promise<ReadonlyMap<string, string>> {
  const { product, finalized } = prepared;
  await sink.writePackage(paths.packagePath, JSON.stringify(finalized.pack));
  for (const artifact of finalized.artifacts) {
    await sink.writeArtifact(
      paths.artifactPath(artifact.path),
      artifact.bytes,
      artifact.path.endsWith('.json') ? 'application/json' : artifact.mediaType,
    );
  }
  const receipts = new Map<string, string>();
  for (const asset of product.product.assets) {
    const path = paths.receiptPath(asset.guid);
    await sink.writeReceipt(
      path,
      JSON.stringify({
        guid: asset.guid,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: product.inputFingerprint,
        outputDigest: finalized.digest,
      }),
    );
    receipts.set(asset.guid.toLowerCase(), path);
  }
  return receipts;
}

function projectScriptablePackPublication(
  product: ScriptablePackBuildProduct,
): Result<ScriptablePackPublicationFacts, ScriptablePackDomainError> {
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
  return ok({
    outputs,
    refs: new Map(
      product.product.assets.map((asset) => [
        asset.guid.toLowerCase(),
        asset.refs.map((reference) => reference.guid),
      ]),
    ),
  });
}

function snapshotSourceForStagedOutputs(
  outputs: readonly ScriptablePackStagedOutput[],
): import('./scriptable-pack.js').ScriptablePackAssetSnapshotSource | undefined {
  if (outputs.length === 0) return undefined;
  const byGuid = new Map(
    outputs.map((output) => [AssetGuid.format(output.guid).toLowerCase(), output]),
  );
  return {
    async readByGuid(guid) {
      const key = AssetGuid.format(guid).toLowerCase();
      const output = byGuid.get(key);
      if (output === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `an available Asset snapshot for ${key}`,
            hint: 'publish the referenced Pack or repair the content dependency',
          }),
        );
      }
      return ok({
        asset: structuredClone(output.asset),
        generation: 1,
        digest: output.digest ?? 'sha256:staged',
      });
    },
  };
}

function composeScriptablePackAssetSource(
  staged: import('./scriptable-pack.js').ScriptablePackAssetSnapshotSource | undefined,
  published: import('./scriptable-pack.js').ScriptablePackAssetSnapshotSource | undefined,
): import('./scriptable-pack.js').ScriptablePackAssetSnapshotSource | undefined {
  if (staged === undefined) return published;
  if (published === undefined) return staged;
  return {
    async readByGuid(guid) {
      const local = await staged.readByGuid(guid);
      if (local.ok || local.error.code !== 'asset-not-found') return local;
      return published.readByGuid(guid);
    },
  };
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
  const assetSource = composeScriptablePackAssetSource(
    snapshotSourceForStagedOutputs(external),
    options.assetSource,
  );
  const availableGuids = new Set([
    ...(options.availableGuids ?? []),
    ...external.map((output) => AssetGuid.format(output.guid).toLowerCase()),
  ]);
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
  const cache =
    options.buildCacheRoot === undefined
      ? undefined
      : await createScriptablePackProductCache({
          root: options.buildCacheRoot,
          outputVersions: outputs.versions(),
          cookers: options.cookers ?? [],
        });
  const worklist = await buildScriptablePackWorklist({
    subjects: workItems,
    outputs,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(cache === undefined ? {} : { cache }),
    ...(options.cookers === undefined ? {} : { cookers: options.cookers }),
    ...(assetSource === undefined ? {} : { assetSource }),
    availableGuids,
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
    const result = await finalizeScriptablePackProduct(source, product);
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
): Promise<Result<PreparedScriptablePack, unknown>> {
  const policy = typeof source.policy === 'function' ? source.policy(product) : source.policy;
  const finalized = await finalizePackageTransportSource(
    projectImportProductForBuild(product.product),
    policy,
  );
  const facts = projectScriptablePackPublication(product);
  if (!facts.ok) return facts;
  const revision = await scriptablePackResourceRevision(
    source.displaySourcePath,
    product.inputFingerprint,
    source.sourceClosure,
  );
  const publication = createAssetPublication({
    sourcePath: source.displaySourcePath,
    sourceRevision: product.inputFingerprint,
    generation: source.publicationGeneration,
    digest: finalized.digest,
    packageUrl: finalized.packageUrl,
    inputFingerprint: product.inputFingerprint,
    outputs: facts.value.outputs,
    externalEvidence: product.externalEvidence,
  });
  return ok({ product, finalized, facts: facts.value, revision, publication });
}

/** One producer context for discovery and final Cook. Known output keys come from source declarations. */
export function createScriptablePackProduction(options: {
  readonly sources: readonly (ScriptablePackInput & { readonly sourceKeys: readonly string[] })[];
  readonly declaredExternalOutputs?: readonly ScriptablePackStagedOutput[];
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  readonly cookers?: readonly NativeCooker[];
  readonly projectRoot?: string;
  readonly authoringContractVersion?: string;
}) {
  const inputs = new Map(options.sources.map((source) => [source.displaySourcePath, source]));
  if (inputs.size !== options.sources.length)
    throw new TypeError('duplicate source in a production generation');
  const generation = options.sources[0]?.publicationGeneration ?? 1;
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    options.sources.some((source) => source.publicationGeneration !== generation)
  )
    throw new TypeError('one production generation requires one positive publication generation');
  const localGuids = new Set(
    options.sources.flatMap((source) =>
      source.sourceKeys.map((key) =>
        AssetGuid.format(
          AssetGuid.derive(source.subjectPackageId ?? source.definition.packageId, key),
        ).toLowerCase(),
      ),
    ),
  );
  for (const output of options.declaredExternalOutputs ?? [])
    localGuids.add(AssetGuid.format(output.guid).toLowerCase());
  const products = new Map<string, ScriptablePackBuildProduct>();
  const finalized = new Map<string, Promise<Result<PreparedScriptablePack, unknown>>>();
  const staged = createScriptablePackStagedAssetSnapshotSource({
    generation,
    ...(options.declaredExternalOutputs === undefined
      ? {}
      : { declaredExternalOutputs: options.declaredExternalOutputs }),
    owners: options.sources.map((source) => ({
      id: source.displaySourcePath,
      guids: source.sourceKeys.map((key) =>
        AssetGuid.derive(source.subjectPackageId ?? source.definition.packageId, key),
      ),
      async build(local) {
        const produced = await buildScriptablePack({
          definition: source.definition,
          sourcePath: source.displaySourcePath,
          sourceClosure: source.sourceClosure,
          publicationGeneration: generation,
          ...(source.subjectPackageId === undefined
            ? {}
            : { subjectPackageId: source.subjectPackageId }),
          ...(source.values === undefined ? {} : { values: source.values }),
          ...(source.inheritedValues === undefined
            ? {}
            : { inheritedValues: source.inheritedValues }),
          ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
          ...(options.authoringContractVersion === undefined
            ? {}
            : { authoringContractVersion: options.authoringContractVersion }),
          ...(options.cookers === undefined ? {} : { cookers: options.cookers }),
          assetSource: {
            readByGuid: (guid) =>
              options.assetSource !== undefined &&
              !localGuids.has(AssetGuid.format(guid).toLowerCase())
                ? options.assetSource.readByGuid(guid)
                : local.readByGuid(guid),
          },
          outputs: createStandardAssetOutputProducerRegistry(
            projectScriptablePackSceneComponents(source.definition.sceneComponents),
          ),
          deferReferenceValidation: true,
        });
        if (!produced.ok) return produced;
        const actual = produced.value.stagedOutputs.map((output) => output.sourceKey).sort();
        const expected = [...source.sourceKeys].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          return err({
            code: 'pack-source-output-invalid',
            expected: 'the current output set to match its source declaration',
            hint: 'refresh source discovery before producing this generation',
            detail: { sourcePath: source.displaySourcePath, actual, expected },
          });
        products.set(source.displaySourcePath, produced.value);
        return ok(produced.value.stagedOutputs);
      },
    })),
  });
  const inspect = async (
    sourcePath: string,
  ): Promise<Result<ScriptablePackBuildProduct, unknown>> => {
    const source = inputs.get(sourcePath);
    if (source === undefined)
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: 'a source in this production generation',
          hint: 'discover the source before requesting production',
          detail: { sourcePath },
        }),
      );
    for (const key of source.sourceKeys) {
      const read = await staged.prepareByGuid(
        AssetGuid.derive(source.subjectPackageId ?? source.definition.packageId, key),
      );
      if (!read.ok) return read;
    }
    const product = products.get(sourcePath);
    if (product === undefined)
      return err({
        code: 'pack-source-output-invalid',
        expected: 'at least one declared output',
        hint: 'refresh the source output discovery',
        detail: { sourcePath },
      });
    return ok(product);
  };
  return {
    inspect,
    async produce(sourcePath: string): Promise<Result<PreparedScriptablePack, unknown>> {
      let pending = finalized.get(sourcePath);
      if (pending === undefined) {
        pending = (async () => {
          const built = await inspect(sourcePath);
          if (!built.ok) return built;
          const source = inputs.get(sourcePath);
          if (source === undefined) throw new Error('production source disappeared');
          return finalizeScriptablePackProduct(source, built.value);
        })();
        finalized.set(sourcePath, pending);
      }
      return pending;
    },
  };
}
