import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { defineAssetKind } from '@forgeax/engine-assets-runtime';

import {
  type AssetSnapshot,
  runtimeAssetReference,
  runtimeAssetSource,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import type { EntityHandle, ScheduleToken, SystemToken, World } from '@forgeax/engine-ecs';

import type { StateProjection } from '@forgeax/engine-ecs/projection';

import {
  type Asset,
  type AssetHandle,
  canonicalJson,
  sha256,
  sha256Bytes,
  type WaterBodyAsset,
  type WaterZoneAsset,
} from '@forgeax/engine-types';

import {
  type WaterBodySnapshot,
  type WaterDependencySnapshot,
  type WaterFluidError,
  type WaterSnapshotLease,
  waterBodyQueryPrismParts,
} from '@forgeax/engine-water';

type WaterMatrix4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

type WaterVector3 = readonly [number, number, number];

export type WaterSceneCollisionFailure = {
  readonly entity: number;
  readonly bodyGuid: string;
  readonly stage: 'cook' | 'prepare' | 'admit' | 'retire';
  readonly reason: string;
  readonly code?: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: unknown;
};

export type WaterSceneGeometryMeshFailure = Readonly<{
  guid: string;
  code: string;
  expected: string;
  hint: string;
  detail?: unknown;
}>;

export type WaterSceneDependencyFailure = Readonly<{
  guid: string;
  kind: string;
  code: string;
  expected: string;
  hint: string;
  detail?: unknown;
}>;

export type WaterSceneGeometryRecookRequired = Readonly<{
  entity: number;
  bodyGuid: string;
  code: 'requires-recook';
  expected: string;
  hint: string;
}>;

export type WaterSceneStatus = {
  duplicateZoneAssetGuids: readonly string[];
  invalidBodyTransforms: readonly string[];
  invalidZoneTransforms: readonly string[];
  invalidExclusionTransforms: readonly string[];
  invalidExclusionBodyEntities: readonly string[];
  unsupportedCustomParticipation: readonly string[];
  waterGeometryRecookRequired: readonly WaterSceneGeometryRecookRequired[];
  waterGeometryMeshFailures: readonly WaterSceneGeometryMeshFailure[];
  waterDependencyFailures: readonly WaterSceneDependencyFailure[];
  waterCollisionFailures: readonly WaterSceneCollisionFailure[];
  waterFluidFailures?: readonly WaterFluidError[];
};

export interface WaterSceneAssetAccess {
  sourceGuid(handle: number): string | undefined;
  version(handle: number): number | undefined;
  read(handle: number): Asset | undefined;
  publication?(handle: number): WaterBodySnapshot['sourcePublication'];
  dependency?(guid: string, kind: string): WaterDependencySnapshot | undefined;
  dependencyParents?(guid: string, kind: string): readonly string[];
  syncWaterGeometryMeshes?(guids: readonly string[]): void;
  disposeWaterGeometryMeshes?(): void;
  syncBodyDependencies?(
    dependencies: readonly Pick<WaterDependencySnapshot, 'guid' | 'kind'>[],
  ): void;
  disposeBodyDependencies?(): void;
}

export type RegistryVersionedWaterDependency = WaterDependencySnapshot & {
  readonly version?: string;
};

export type WaterSceneAssetSnapshot = Readonly<{
  handle: AssetHandle;
  sourceGuid: string;
  version: number;
  kind: string;
  payload: Asset;
  sourcePublication?: WaterBodySnapshot['sourcePublication'];
}>;

export const versionedRegistryAccesses = new WeakSet<object>();

export const waterSceneCurrentAssetMetadata = Symbol('water-scene/current-asset-metadata');

type WaterSceneCurrentAssetMetadata = Readonly<{
  sourceGuid: string;
  version: number;
  kind: string;
}>;

export type RegistryWaterSceneAssetAccess = WaterSceneAssetAccess & {
  readonly [waterSceneCurrentAssetMetadata]?: (
    handle: AssetHandle,
  ) => WaterSceneCurrentAssetMetadata | undefined;
};

function cloneDeepFreezePlain(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => cloneDeepFreezePlain(item)));
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
  for (const [key, child] of Object.entries(value)) copy[key] = cloneDeepFreezePlain(child);
  return Object.freeze(copy);
}

export function waterSceneAssetSnapshot(
  state: Lifecycle,
  assets: WaterSceneAssetAccess,
  handle: AssetHandle,
  sourceGuid: string,
  version: number,
  kind: string,
  persist = true,
): WaterSceneAssetSnapshot | undefined {
  const identity = Number(handle);
  const cacheable =
    state.geometryMeshOwner === assets && versionedRegistryAccesses.has(assets as object);
  const cached = state.assetSnapshots.get(identity);
  if (
    cacheable &&
    cached?.handle === handle &&
    cached.sourceGuid === sourceGuid &&
    cached.version === version &&
    cached.kind === kind
  )
    return cached;
  const payload = assets.read(handle);
  if (payload?.kind !== kind) return undefined;
  const sourcePublication = kind === 'water-body' ? assets.publication?.(handle) : undefined;
  const snapshot = Object.freeze({
    handle,
    sourceGuid,
    version,
    kind,
    payload:
      cacheable && kind === 'water-zone' ? (cloneDeepFreezePlain(payload) as Asset) : payload,
    ...(sourcePublication === undefined ? {} : { sourcePublication }),
  });
  if (cacheable && persist) state.assetSnapshots.set(identity, snapshot);
  return snapshot;
}

function bodyDependencyKey(kind: string, guid: string): string {
  return `${kind.toLowerCase()}\u0000${guid.toLowerCase()}`;
}

/** Resolve against the plugin's retained references before borrowing the registry's reverse index. */
export function resolveWaterSceneDependencyHandle(
  kind: string,
  guid: string,
  geometryMeshes: ReadonlyMap<string, AssetHandle>,
  bodyDependencies: ReadonlyMap<string, AssetHandle>,
  borrowed: AssetHandle | undefined,
): AssetHandle | undefined {
  return (
    (kind === 'mesh'
      ? geometryMeshes.get(guid.toLowerCase())
      : bodyDependencies.get(bodyDependencyKey(kind, guid))) ?? borrowed
  );
}

type LiveZone = {
  readonly handle: AssetHandle<'water-zone'>;
  readonly generation: number;
  readonly version: number;
  readonly worldMatrixM: readonly number[];
};

export type BodyMount = {
  readonly entity: number;
  readonly handle: AssetHandle<'water-body'>;
  readonly sourceAssetGuid: string;
  readonly version: number;
  readonly dependencies: readonly WaterDependencySnapshot[];
  readonly ownedRigidBodyEpoch?: number;
  readonly retiring?: true;
};

export type Lifecycle = {
  systems?: readonly (readonly [ScheduleToken, SystemToken])[];
  readonly bodies: Map<string, BodyMount>;
  readonly queryPrismParts: Map<
    string,
    { readonly parts: readonly Float32Array[]; readonly digest: string }
  >;
  readonly geometryConsumerOutputs: Map<
    string,
    { readonly inputKey: string; readonly generation: number; readonly digest: string }
  >;
  geometryConsumerGeneration: number;
  queryConsumerGeneration: number;
  readonly zones: Map<string, LiveZone>;
  readonly zoneEntities: Map<
    string,
    {
      readonly handle: AssetHandle<'water-zone'>;
      readonly guid: string;
      readonly version: number;
      readonly generation: number;
      readonly worldMatrixM: readonly number[];
      readonly asset?: WaterZoneAsset;
    }
  >;
  readonly zoneVersions: Map<
    string,
    {
      handle: AssetHandle<'water-zone'>;
      version: number;
      generation: number;
      worldMatrixM: readonly number[];
    }
  >;
  readonly assetSnapshots: Map<number, WaterSceneAssetSnapshot>;
  readonly terrainProviderProjection: StateProjection;
  readonly terrainProviderHandles: Map<
    number,
    { readonly entity: EntityHandle; readonly handle: AssetHandle }
  >;
  readonly terrainProviderHandleCounts: Map<number, number>;
  readonly leases: Map<string, WaterSnapshotLease>;
  readonly riverBakeNormalAssets: Map<string, RiverBakeNormalAssetLeases>;
  assetRegistry?: AssetRegistry;
  readonly geometryMeshOwner?: WaterSceneAssetAccess;
  disposing?: boolean;
  disposal?: Promise<void>;
};

export type RiverBakeNormalAssetLease = Readonly<{
  readonly key: string;
  readonly handle: AssetHandle<'texture'>;
  readonly guid: string;
  readonly revision: number;
  readonly snapshot: AssetSnapshot;
}>;

type RiverBakeNormalAssetLeases = {
  accepted?: RiverBakeNormalAssetLease;
  candidate?: RiverBakeNormalAssetLease;
};

export const states = new WeakMap<World, Lifecycle>();

export function registryAccess(
  assets: AssetRegistry,
  status: Pick<WaterSceneStatus, 'waterGeometryMeshFailures' | 'waterDependencyFailures'>,
): WaterSceneAssetAccess {
  const geometryMeshHandles = new Map<string, AssetHandle<'mesh'>>();
  const geometryMeshLoads = new Map<string, Promise<void>>();
  const geometryMeshFailures = new Map<
    string,
    {
      readonly failure: WaterSceneGeometryMeshFailure;
      readonly publication: string;
      readonly retryFrame: number;
    }
  >();
  let activeGeometryMeshes = new Set<string>();
  let geometryMeshFrame = 0;
  const bodyDependencyHandles = new Map<string, AssetHandle>();
  const bodyDependencyLoads = new Map<string, Promise<void>>();
  const bodyDependencyFailures = new Map<
    string,
    {
      readonly failure: WaterSceneDependencyFailure;
      readonly publication: string;
      readonly retryFrame: number;
    }
  >();
  let activeBodyDependencies = new Map<string, { readonly guid: string; readonly kind: string }>();
  const dependencyFacts = new Map<
    string,
    {
      readonly handle: AssetHandle;
      readonly revision: number;
      readonly projection: ReturnType<AssetRegistry['getMaterialProjectionForPayload']>;
      readonly snapshot: RegistryVersionedWaterDependency;
    }
  >();
  const pruneDependencyFacts = () => {
    for (const [key, { snapshot }] of dependencyFacts) {
      if (activeBodyDependencies.has(key)) continue;
      if (snapshot.kind === 'mesh' && activeGeometryMeshes.has(snapshot.guid.toLowerCase()))
        continue;
      dependencyFacts.delete(key);
    }
  };
  let bodyDependencyFrame = 0;
  let bodyDependenciesDisposed = false;
  let disposed = false;
  const publishGeometryMeshFailures = () => {
    status.waterGeometryMeshFailures = Object.freeze(
      [...geometryMeshFailures.values()]
        .map(({ failure }) => failure)
        .sort((left, right) => left.guid.localeCompare(right.guid)),
    );
  };
  const publishBodyDependencyFailures = () => {
    status.waterDependencyFailures = Object.freeze(
      [...bodyDependencyFailures.values()]
        .map(({ failure }) => failure)
        .sort((left, right) =>
          `${left.kind}:${left.guid}`.localeCompare(`${right.kind}:${right.guid}`),
        ),
    );
  };
  const structuredAssetLoadFailure = (
    guid: string,
    kind: string,
    cause: unknown,
    fallbackExpected: string,
    fallbackHint: string,
  ) => {
    const value =
      typeof cause === 'object' && cause !== null
        ? (cause as { code?: unknown; expected?: unknown; hint?: unknown; detail?: unknown })
        : undefined;
    return Object.freeze({
      guid,
      kind,
      code: typeof value?.code === 'string' ? value.code : 'asset-load-failed',
      expected: typeof value?.expected === 'string' ? value.expected : fallbackExpected,
      hint: typeof value?.hint === 'string' ? value.hint : fallbackHint,
      ...(value?.detail === undefined ? {} : { detail: value.detail }),
    });
  };
  const releaseGeometryMesh = (handle: AssetHandle<'mesh'>) => {
    const released = assets.release(handle);
    if (!released.ok) return;
  };
  const catalogPublication = (guid: string) => {
    const entry = assets.catalogEntry(guid);
    return entry === undefined
      ? 'missing'
      : canonicalJson({
          kind: entry.kind,
          revision: entry.revision,
          publication: entry.publication,
        });
  };
  const recordGeometryMeshFailure = (guid: string, cause: unknown) => {
    const key = guid.toLowerCase();
    geometryMeshFailures.set(key, {
      failure: structuredAssetLoadFailure(
        guid,
        'mesh',
        cause,
        'the referenced Water geometry MeshAsset loads',
        'repair the WaterBody Pack mesh reference and retry',
      ),
      publication: catalogPublication(guid),
      retryFrame: geometryMeshFrame + 60,
    });
    publishGeometryMeshFailures();
  };
  const syncWaterGeometryMeshes = (guids: readonly string[]) => {
    if (disposed) return;
    geometryMeshFrame += 1;
    const next = new Map<string, string>();
    for (const guid of guids) if (!next.has(guid.toLowerCase())) next.set(guid.toLowerCase(), guid);
    activeGeometryMeshes = new Set(next.keys());
    pruneDependencyFacts();
    for (const [key, handle] of geometryMeshHandles) {
      if (activeGeometryMeshes.has(key)) continue;
      geometryMeshHandles.delete(key);
      releaseGeometryMesh(handle);
    }
    for (const key of geometryMeshFailures.keys()) {
      if (activeGeometryMeshes.has(key)) continue;
      geometryMeshFailures.delete(key);
    }
    publishGeometryMeshFailures();
    for (const [key, guid] of next) {
      if (geometryMeshHandles.has(key) || geometryMeshLoads.has(key)) continue;
      const failure = geometryMeshFailures.get(key);
      const publication = catalogPublication(guid);
      if (failure && failure.publication === publication && geometryMeshFrame < failure.retryFrame)
        continue;
      geometryMeshFailures.delete(key);
      const request = assets
        .load(guid, 'mesh')
        .then((result) => {
          geometryMeshLoads.delete(key);
          if (!result.ok) {
            if (!disposed && activeGeometryMeshes.has(key))
              recordGeometryMeshFailure(guid, result.error);
            return;
          }
          geometryMeshFailures.delete(key);
          if (disposed || !activeGeometryMeshes.has(key)) releaseGeometryMesh(result.value);
          else geometryMeshHandles.set(key, result.value);
          publishGeometryMeshFailures();
        })
        .catch((cause: unknown) => {
          geometryMeshLoads.delete(key);
          if (!disposed && activeGeometryMeshes.has(key)) recordGeometryMeshFailure(guid, cause);
        });
      geometryMeshLoads.set(key, request);
    }
  };
  const disposeWaterGeometryMeshes = () => {
    if (disposed) return;
    disposed = true;
    activeGeometryMeshes.clear();
    pruneDependencyFacts();
    for (const handle of geometryMeshHandles.values()) releaseGeometryMesh(handle);
    geometryMeshHandles.clear();
    geometryMeshFailures.clear();
    publishGeometryMeshFailures();
  };
  const syncBodyDependencies = (
    dependencies: readonly Pick<WaterDependencySnapshot, 'guid' | 'kind'>[],
  ) => {
    if (bodyDependenciesDisposed) return;
    bodyDependencyFrame += 1;
    const next = new Map<string, { readonly guid: string; readonly kind: string }>();
    for (const dependency of dependencies) {
      const key = bodyDependencyKey(dependency.kind, dependency.guid);
      if (!next.has(key)) next.set(key, dependency);
    }
    activeBodyDependencies = next;
    pruneDependencyFacts();
    for (const [key, handle] of bodyDependencyHandles) {
      if (activeBodyDependencies.has(key)) continue;
      bodyDependencyHandles.delete(key);
      assets.release(handle);
    }
    for (const key of bodyDependencyFailures.keys())
      if (!activeBodyDependencies.has(key)) bodyDependencyFailures.delete(key);
    publishBodyDependencyFailures();
    for (const [key, dependency] of next) {
      if (bodyDependencyHandles.has(key) || bodyDependencyLoads.has(key)) continue;
      const publication = catalogPublication(dependency.guid);
      const failure = bodyDependencyFailures.get(key);
      if (
        failure &&
        failure.publication === publication &&
        bodyDependencyFrame < failure.retryFrame
      )
        continue;
      bodyDependencyFailures.delete(key);
      publishBodyDependencyFailures();
      const request = assets
        .load(dependency.guid, defineAssetKind(dependency.kind))
        .then((result) => {
          bodyDependencyLoads.delete(key);
          if (!result.ok) {
            if (!bodyDependenciesDisposed && activeBodyDependencies.has(key))
              bodyDependencyFailures.set(key, {
                failure: structuredAssetLoadFailure(
                  dependency.guid,
                  dependency.kind,
                  result.error,
                  `the Body ${dependency.kind} dependency ${dependency.guid} loads`,
                  `repair the Body reference to ${dependency.guid} and retry`,
                ),
                publication,
                retryFrame: bodyDependencyFrame + 60,
              });
            publishBodyDependencyFailures();
            return;
          }
          bodyDependencyFailures.delete(key);
          publishBodyDependencyFailures();
          if (bodyDependenciesDisposed || !activeBodyDependencies.has(key))
            assets.release(result.value);
          else bodyDependencyHandles.set(key, result.value);
        })
        .catch((cause: unknown) => {
          bodyDependencyLoads.delete(key);
          if (!bodyDependenciesDisposed && activeBodyDependencies.has(key)) {
            bodyDependencyFailures.set(key, {
              failure: structuredAssetLoadFailure(
                dependency.guid,
                dependency.kind,
                cause,
                `the Body ${dependency.kind} dependency ${dependency.guid} loads`,
                `repair the Body reference to ${dependency.guid} and retry`,
              ),
              publication,
              retryFrame: bodyDependencyFrame + 60,
            });
            publishBodyDependencyFailures();
          }
        });
      bodyDependencyLoads.set(key, request);
    }
  };
  const disposeBodyDependencies = () => {
    if (bodyDependenciesDisposed) return;
    bodyDependenciesDisposed = true;
    activeBodyDependencies.clear();
    pruneDependencyFacts();
    for (const handle of bodyDependencyHandles.values()) assets.release(handle);
    bodyDependencyHandles.clear();
    bodyDependencyFailures.clear();
    publishBodyDependencyFailures();
  };
  const access: RegistryWaterSceneAssetAccess = {
    [waterSceneCurrentAssetMetadata]: (handle) => {
      try {
        const records = runtimeAssets(assets);
        const version = records.version(handle);
        const current = records.borrow<Asset>(handle);
        const sourceGuid = runtimeAssetSource(assets, handle);
        if (!version.ok || !current.ok || sourceGuid === undefined) return undefined;
        return { sourceGuid, version: version.value, kind: current.value.kind };
      } catch {
        return undefined;
      }
    },
    sourceGuid: (handle) => runtimeAssetSource(assets, handle),
    version: (handle) => {
      try {
        const result = runtimeAssets(assets).version(handle as AssetHandle);
        return result.ok ? result.value : undefined;
      } catch {
        return undefined;
      }
    },
    read: (handle) => {
      try {
        const result = assets.read(handle as AssetHandle);
        return result.ok ? (result.value as Asset) : undefined;
      } catch {
        return undefined;
      }
    },
    publication: (handle) => {
      try {
        const result = assets.source(handle as AssetHandle);
        const publication = result.ok ? result.value?.publication : undefined;
        return publication
          ? {
              sourceRevision: publication.sourceRevision,
              generation: publication.generation,
              digest: publication.digest,
              outputSetDigest: publication.outputSetDigest,
            }
          : undefined;
      } catch {
        return undefined;
      }
    },
    dependency: (guid, kind) => {
      const factKey = bodyDependencyKey(kind, guid);
      const catalogKind = assets.catalogEntry(guid)?.kind;
      if (catalogKind !== undefined && catalogKind !== kind) {
        dependencyFacts.delete(factKey);
        return { guid, kind, status: 'invalid-kind', actualKind: catalogKind };
      }
      const handle = resolveWaterSceneDependencyHandle(
        kind,
        guid,
        geometryMeshHandles,
        bodyDependencyHandles,
        runtimeAssetReference(assets, guid),
      );
      if (handle === undefined) {
        dependencyFacts.delete(factKey);
        const key = kind === 'mesh' ? guid.toLowerCase() : bodyDependencyKey(kind, guid);
        const loads = kind === 'mesh' ? geometryMeshLoads : bodyDependencyLoads;
        const failures = kind === 'mesh' ? geometryMeshFailures : bodyDependencyFailures;
        if (loads.has(key)) return { guid, kind, status: 'pending' };
        const failed = failures.get(key);
        if (failed !== undefined) return { guid, kind, status: 'failed', failure: failed.failure };
        return { guid, kind, status: 'unavailable' };
      }
      try {
        const records = runtimeAssets(assets);
        const version = records.version(handle);
        const current = records.borrow<Asset>(handle);
        if (!version.ok || !current.ok) {
          dependencyFacts.delete(factKey);
          return { guid, kind, status: 'unavailable' };
        }
        if (current.value.kind !== kind) {
          dependencyFacts.delete(factKey);
          return { guid, kind, status: 'invalid-kind', actualKind: current.value.kind };
        }
        const completeWaterDependencySnapshot: () => NonNullable<
          ReturnType<NonNullable<WaterSceneAssetAccess['dependency']>>
        > = () => {
          const projection =
            current.value.kind === 'material'
              ? assets.getMaterialProjectionForPayload(current.value)
              : undefined;
          const previous = dependencyFacts.get(factKey);
          if (
            previous?.handle === handle &&
            previous.revision === version.value &&
            previous.projection === projection
          ) {
            return previous.snapshot.guid === guid && previous.snapshot.kind === kind
              ? previous.snapshot
              : { ...previous.snapshot, guid, kind };
          }
          // Registry borrows can be mutated in place; only retain a detached read.
          const payload = assets.read(handle as AssetHandle);
          if (!payload.ok) {
            dependencyFacts.delete(factKey);
            return { guid, kind, status: 'unavailable' };
          }
          const asset = payload.value as Asset;
          const readMaterialBakedSourceRequirement = () => {
            const materialRequiresBakedSource = projection?.passes.some((pass) =>
              pass.programs.some(
                (program) =>
                  program.abi?.systemInputs?.water === 'water-frame/3' &&
                  program.abi.entryPoints?.some((point) =>
                    point.bindings.some((read) => read.group === 2 && read.binding === 24),
                  ),
              ),
            );
            return materialRequiresBakedSource;
          };
          const materialRequiresBakedSource = readMaterialBakedSourceRequirement();
          const snapshot: RegistryVersionedWaterDependency = {
            guid,
            kind,
            status: 'valid',
            version: String(version.value),
            payload: asset,
            ...(materialRequiresBakedSource === undefined ? {} : { materialRequiresBakedSource }),
          };
          dependencyFacts.set(factKey, { handle, revision: version.value, projection, snapshot });
          return snapshot;
        };
        return completeWaterDependencySnapshot();
      } catch {
        dependencyFacts.delete(factKey);
        return { guid, kind, status: 'unavailable' };
      }
    },
    dependencyParents: (guid, kind) =>
      kind === 'material'
        ? (assets
            .catalogEntry(guid)
            ?.refs?.filter((reference) => assets.catalogEntry(reference)?.kind === 'material') ??
          [])
        : [],
    syncWaterGeometryMeshes,
    disposeWaterGeometryMeshes,
    syncBodyDependencies,
    disposeBodyDependencies,
  };
  versionedRegistryAccesses.add(access);
  return access;
}

export function transformedXZBounds(
  matrix: readonly number[],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): { minM: [number, number]; maxM: [number, number] } | undefined {
  if (
    !validMatrix(matrix) ||
    ![minX, minZ, maxX, maxZ].every(Number.isFinite) ||
    minX > maxX ||
    minZ > maxZ
  )
    return undefined;
  const corners: readonly (readonly [number, number])[] = [
    [minX, minZ],
    [minX, maxZ],
    [maxX, minZ],
    [maxX, maxZ],
  ];
  const points = corners.map(
    ([x, z]) =>
      [
        matrix[0] * x + matrix[8] * z + matrix[12],
        matrix[2] * x + matrix[10] * z + matrix[14],
      ] as const,
  );
  if (points.some((point) => !point.every(Number.isFinite))) return undefined;
  return {
    minM: [
      Math.min(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
    ],
    maxM: [
      Math.max(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[1])),
    ],
  };
}

export type SceneWaterBodyTarget = {
  readonly sourceAssetGuid: string;
  readonly version: number;
  readonly payload: WaterBodyAsset;
  readonly worldMatrixM: readonly number[];
  queryParts?: readonly Float32Array[] | null;
};

export function cacheWaterQueryPrismParts(
  world: World,
  target: SceneWaterBodyTarget,
): readonly Float32Array[] | null {
  const state = states.get(world);
  if (!state) return null;
  if (target.queryParts !== undefined) return target.queryParts;
  const cacheKey = `${target.sourceAssetGuid}:${target.version}`;
  const cached = state.queryPrismParts.get(cacheKey);
  if (cached) {
    target.queryParts = cached.parts;
    return cached.parts;
  }
  const query = waterBodyQueryPrismParts(target.payload);
  target.queryParts = query.ok ? query.value : null;
  if (!query.ok) return null;
  state.queryPrismParts.set(cacheKey, {
    parts: query.value,
    digest: sha256(
      canonicalJson({
        consumer: 'water-query-prism/1',
        footprint: target.payload.geometrySnapshot?.queryFootprint.digest,
        volume: target.payload.geometrySnapshot?.queryVolume.digest,
        parts: query.value.map((part) =>
          sha256Bytes(new Uint8Array(part.buffer, part.byteOffset, part.byteLength)),
        ),
      }),
    ),
  });
  return query.value;
}

export function waterExclusionIntersectsQueryPrismParts(
  queryParts: readonly Float32Array[],
  bodyWorldMatrixM: readonly number[],
  centerM: readonly number[],
  halfExtentsM: readonly number[],
  exclusionWorldMatrixM: readonly number[],
): boolean {
  if (
    !validMatrix(bodyWorldMatrixM) ||
    !validMatrix(exclusionWorldMatrixM) ||
    centerM.length !== 3 ||
    halfExtentsM.length !== 3
  )
    return false;
  const centerX = centerM[0],
    centerY = centerM[1],
    centerZ = centerM[2],
    halfX = halfExtentsM[0],
    halfY = halfExtentsM[1],
    halfZ = halfExtentsM[2];
  if (
    centerX === undefined ||
    centerY === undefined ||
    centerZ === undefined ||
    halfX === undefined ||
    halfY === undefined ||
    halfZ === undefined
  )
    return false;
  const exclusion: [number, number][] = [];
  for (const x of [centerX - halfX, centerX + halfX])
    for (const y of [centerY - halfY, centerY + halfY])
      for (const z of [centerZ - halfZ, centerZ + halfZ]) {
        const world = transformPoint(exclusionWorldMatrixM, [x, y, z]);
        exclusion.push([world[0], world[2]]);
      }
  const convexHull = (points: readonly (readonly [number, number])[]): [number, number][] => {
    const sorted = [
      ...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values(),
    ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (
      o: readonly [number, number],
      a: readonly [number, number],
      b: readonly [number, number],
    ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: (readonly [number, number])[] = [],
      upper: (readonly [number, number])[] = [];
    for (const point of sorted) {
      while (lower.length >= 2) {
        const previous = lower.at(-2),
          last = lower.at(-1);
        if (previous === undefined || last === undefined || cross(previous, last, point) > 0) break;
        lower.pop();
      }
      lower.push(point);
    }
    for (const point of [...sorted].reverse()) {
      while (upper.length >= 2) {
        const previous = upper.at(-2),
          last = upper.at(-1);
        if (previous === undefined || last === undefined || cross(previous, last, point) > 0) break;
        upper.pop();
      }
      upper.push(point);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)] as [number, number][];
  };
  const intersectsProjected = (bodyPoints: readonly (readonly [number, number, number])[]) => {
    const footprint = convexHull(bodyPoints.map((point) => [point[0], point[2]] as const));
    if (footprint.length < 3) return false;
    const axes: [number, number][] = [];
    for (const polygon of [footprint, exclusion])
      for (let index = 0; index < polygon.length; index++) {
        const a = polygon[index],
          b = polygon[(index + 1) % polygon.length];
        if (a === undefined || b === undefined) return false;
        const axis: [number, number] = [-(b[1] - a[1]), b[0] - a[0]];
        const magnitude = Math.hypot(...axis);
        if (magnitude > 1e-9) axes.push([axis[0] / magnitude, axis[1] / magnitude]);
      }
    return axes.every(([x, z]) => {
      const a = footprint.map((point) => point[0] * x + point[1] * z),
        b = exclusion.map((point) => point[0] * x + point[1] * z);
      return Math.min(...a) <= Math.max(...b) + 1e-8 && Math.max(...a) + 1e-8 >= Math.min(...b);
    });
  };
  const exclusionHull = convexHull(exclusion);
  if (exclusionHull.length < 3) return false;
  exclusion.splice(0, exclusion.length, ...exclusionHull);
  return queryParts.some((vertices) => {
    if (vertices.length % 3 !== 0) return false;
    const worldPoints: Array<[number, number, number]> = [];
    for (let index = 0; index < vertices.length / 3; index++) {
      const x = vertices[index * 3],
        y = vertices[index * 3 + 1],
        z = vertices[index * 3 + 2];
      if (x === undefined || y === undefined || z === undefined) return false;
      worldPoints.push(transformPoint(bodyWorldMatrixM, [x, y, z]));
    }
    return intersectsProjected(worldPoints);
  });
}

function transformPoint(matrix: WaterMatrix4, point: WaterVector3): [number, number, number] {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

export function sameSplineMetric(left: readonly number[], right: readonly number[]): boolean {
  if (!isMatrix4(left) || !isMatrix4(right)) return false;
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) {
      let leftDot = 0;
      let rightDot = 0;
      let leftAbsProducts = 0;
      let rightAbsProducts = 0;
      for (let row = 0; row < 3; row++) {
        const leftA = left[a * 4 + row],
          leftB = left[b * 4 + row],
          rightA = right[a * 4 + row],
          rightB = right[b * 4 + row];
        if (
          leftA === undefined ||
          leftB === undefined ||
          rightA === undefined ||
          rightB === undefined
        )
          return false;
        const leftProduct = leftA * leftB;
        const rightProduct = rightA * rightB;
        leftDot += leftProduct;
        rightDot += rightProduct;
        leftAbsProducts += Math.abs(leftProduct);
        rightAbsProducts += Math.abs(rightProduct);
      }
      const tolerance = 4 * 2 ** -23 * Math.max(1, leftAbsProducts, rightAbsProducts);
      if (Math.abs(leftDot - rightDot) > tolerance) return false;
    }
  return true;
}

export function isMatrix4(value: readonly number[]): value is WaterMatrix4 {
  return value.length === 16;
}

export function validMatrix(value: readonly number[]): value is WaterMatrix4 {
  return isMatrix4(value) && value.every(Number.isFinite);
}
