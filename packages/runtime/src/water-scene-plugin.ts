import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

import { runtimeAssetReference } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle } from '@forgeax/engine-ecs';

import {
  beginScheduleWork,
  defineResource,
  defineSystem,
  FixedUpdate,
  fixedStepIsDeferred,
  hasScheduleRunObservers,
  registerScheduleWork,
  Update,
  type World,
} from '@forgeax/engine-ecs';

import { createStateProjection, readEntityComponentEpoch } from '@forgeax/engine-ecs/projection';

import { worldRead } from '@forgeax/engine-ecs/world-read';

import { mat4, quat, vec3 } from '@forgeax/engine-math';

import {
  type BodyMotion,
  Collider,
  type DerivedPhysicsAdmissionState,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCollisionReceipt,
  DerivedPhysicsError,
  PhysicsSimulation,
  PhysicsSync,
  type PhysicsWorld,
  PhysicsWorldResource,
  PhysicsWritebackPhase,
  RigidBody,
  type RigidBodyType,
  RigidBodyTypeValue,
  rigidBodyTypeFromF32,
} from '@forgeax/engine-physics';

import type { Plugin } from '@forgeax/engine-plugin';

import {
  ChildOf,
  GlobalTransform,
  PropagateTransforms,
  Transform,
  WaterBodyInstance,
  WaterExclusionMode,
  WaterExclusionVolume,
  WaterFluidSimulation,
  WaterTerrainProvider,
  WaterZoneInstance,
} from '@forgeax/engine-scene';

import { terrainTranslationValid } from '@forgeax/engine-terrain';

import {
  type Asset,
  type AssetError,
  type AssetHandle,
  canonicalJson,
  err,
  type MeshAsset,
  materialPassLightMode,
  ok,
  type Result,
  sha256,
  sha256Bytes,
  type TerrainAsset,
  type TextureAsset,
  unpackSlot,
  WATER_BODY_DEFAULT_SHAPE_DILATION_M,
  type WaterBodyAsset,
  type WaterZoneAsset,
} from '@forgeax/engine-types';

import {
  buildWaterPhysicsCandidateInput,
  validateWaterRuntimeBody,
  type WaterBakedQueryGrid,
  type WaterBodySnapshot,
  type WaterDependencySnapshot,
  type WaterDirtyKind,
  type WaterError,
  type WaterExclusionVolumeSnapshot,
  type WaterFluidError,
  type WaterFluidInstanceInput,
  type WaterMaterialResolution,
  type WaterMeshViewInput,
  type WaterOperationObserver,
  type WaterQueryBodySnapshot,
  type WaterSurfaceSourceDescriptor,
  WaterSystem,
  type WaterTerrainQuerySample,
  type WaterZoneGroundQuerySnapshot,
  type WaterZoneMeshPublication,
  type WaterZoneTerrainProviderInput,
  waterBodyQueryPrismParts,
} from '@forgeax/engine-water';

import { requireWaterValue } from '@forgeax/engine-water/internal';

import { installWaterBuoyancy } from './water-buoyancy.js';

import { installWaterContactProbes } from './water-contact-probes.js';

import {
  WaterBuoyancy,
  WaterBuoyancyCompletion,
  WaterSceneCollisionReconcile,
  WaterSceneReconcile,
} from './water-system-order.js';

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    assets?: AssetRegistry;
  }
}

import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine-water';

export { WATER_SYSTEM_RESOURCE } from '@forgeax/engine-water';

export const WATER_SCENE_STATUS_RESOURCE = defineResource<WaterSceneStatus>('WaterSceneStatus');

const SYSTEM = 'waterSceneReconcile';

const COLLISION_SYSTEM = 'waterSceneCollisionReconcile';

const WATER_SCENE_PROFILE_WORK = [
  'water/mesh/input-signature-match',
  'water/mesh/publication-signature-match',
  'water/mesh/publication-copy',
  'water/zone/ground-snapshot-copy',
] as const;

const COLLISION_RECEIPT_SYSTEM = 'waterSceneCollisionReceiptCommit';

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

function persistWaterSceneAssetSnapshot(
  state: Lifecycle,
  assets: WaterSceneAssetAccess,
  snapshot: WaterSceneAssetSnapshot,
): void {
  if (state.geometryMeshOwner === assets && versionedRegistryAccesses.has(assets as object))
    state.assetSnapshots.set(Number(snapshot.handle), snapshot);
}

function retireAssetSnapshot(state: Lifecycle, handle: AssetHandle, kind: string): void {
  const identity = Number(handle);
  const snapshot = state.assetSnapshots.get(identity);
  if (snapshot?.handle === handle && snapshot.kind === kind) state.assetSnapshots.delete(identity);
}

function retireTerrainProviderHandle(state: Lifecycle, index: number): void {
  const previous = state.terrainProviderHandles.get(index);
  if (!previous) return;
  state.terrainProviderHandles.delete(index);
  const identity = Number(previous.handle);
  const count = state.terrainProviderHandleCounts.get(identity) ?? 0;
  if (count > 1) {
    state.terrainProviderHandleCounts.set(identity, count - 1);
    return;
  }
  state.terrainProviderHandleCounts.delete(identity);
  retireAssetSnapshot(state, previous.handle, 'terrain');
}

function trackTerrainProviderHandle(
  state: Lifecycle,
  index: number,
  entity: EntityHandle | undefined,
  handle: AssetHandle | undefined,
): void {
  const previous = state.terrainProviderHandles.get(index);
  if (previous && (previous.entity !== entity || previous.handle !== handle))
    retireTerrainProviderHandle(state, index);
  if (entity === undefined || handle === undefined) return;
  if (previous?.entity === entity && previous.handle === handle) return;
  state.terrainProviderHandles.set(index, { entity, handle });
  const identity = Number(handle);
  state.terrainProviderHandleCounts.set(
    identity,
    (state.terrainProviderHandleCounts.get(identity) ?? 0) + 1,
  );
}

function hasOtherLiveBodyAssetOwner(
  state: Lifecycle,
  instanceId: string,
  handle: AssetHandle,
): boolean {
  for (const [owner, body] of state.bodies)
    if (owner !== instanceId && !body.retiring && body.handle === handle) return true;
  return false;
}

function impulseNoiseKind(assets: WaterSceneAssetAccess, guid: string): 'texture' | 'gpu-texture' {
  return assets.referenceKind?.(guid) === 'gpu-texture' ? 'gpu-texture' : 'texture';
}

function waterDependencyVersion(
  dependency: WaterDependencySnapshot | undefined,
): string | undefined {
  const version = (dependency as RegistryVersionedWaterDependency | undefined)?.version;
  return typeof version === 'string' ? version : undefined;
}

function waterDependencyRevision(
  dependency: WaterDependencySnapshot | undefined,
): string | undefined {
  if (dependency === undefined) return undefined;
  const version = waterDependencyVersion(dependency);
  if (version !== undefined) return `version:${version}`;
  if (dependency.payload === undefined) return undefined;
  const payload =
    dependency.kind === 'mesh' ? meshPayloadDigest(dependency.payload as MeshAsset) : undefined;
  return `digest:${payload ?? sha256(canonicalJson(dependency.payload))}`;
}

export interface WaterScenePluginOptions {
  /** Packed Physics membership/filter groups for every camera's underwater trace. */
  readonly underwaterTraceFilterMask?: number;
}

export function waterScenePlugin(options: WaterScenePluginOptions = {}): Plugin {
  return {
    name: 'water-scene',
    inject: ['world', 'assets'],
    apply(ctx) {
      if (!ctx.assets) return;
      const world = ctx.world;
      const status = {
        duplicateZoneAssetGuids: Object.freeze([]) as readonly string[],
        invalidBodyTransforms: Object.freeze([]) as readonly string[],
        invalidZoneTransforms: Object.freeze([]) as readonly string[],
        invalidExclusionTransforms: Object.freeze([]) as readonly string[],
        invalidExclusionBodyEntities: Object.freeze([]) as readonly string[],
        unsupportedCustomParticipation: Object.freeze([]) as readonly string[],
        waterGeometryRecookRequired: Object.freeze(
          [],
        ) as WaterSceneStatus['waterGeometryRecookRequired'],
        waterGeometryMeshFailures: Object.freeze([]) as readonly WaterSceneGeometryMeshFailure[],
        waterDependencyFailures: Object.freeze([]) as readonly WaterSceneDependencyFailure[],
        waterCollisionFailures: Object.freeze([]) as WaterSceneStatus['waterCollisionFailures'],
      };
      const assetAccess = registryAccess(ctx.assets, status);
      const system = createWaterSystem(world, assetAccess);
      const lifecycle = states.get(world);
      if (lifecycle) lifecycle.assetRegistry = ctx.assets;
      if (options.underwaterTraceFilterMask !== undefined)
        system.setUnderwaterTraceFilterMask(options.underwaterTraceFilterMask).unwrap();
      world.insertResource(WATER_SYSTEM_RESOURCE, system);
      world.insertResource(WATER_SCENE_STATUS_RESOURCE, status);
      const releaseBuoyancy = installWaterBuoyancy(world, system, (entity) =>
        waterSceneSnapshot(world, entity),
      );
      ctx.effect(() => () => releaseBuoyancy(), 'water/buoyancy-lifecycle');
      const releaseContactProbes = installWaterContactProbes(world, system, (entity) =>
        waterSceneSnapshot(world, entity),
      );
      ctx.effect(() => () => releaseContactProbes(), 'water/contact-probes-lifecycle');
      const waterSceneCollisionSystem = defineSystem({
        name: COLLISION_SYSTEM,
        sets: [WaterSceneCollisionReconcile],
        after: [PhysicsSync],
        before: [WaterBuoyancy, PhysicsSimulation],
        queries: [],
        fn: () => reconcileWaterSceneCollisions(world, system, status),
      });
      world.addSystem(FixedUpdate, waterSceneCollisionSystem).unwrap();
      const waterSceneCollisionReceiptSystem = defineSystem({
        name: COLLISION_RECEIPT_SYSTEM,
        after: [PhysicsWritebackPhase],
        before: [WaterBuoyancyCompletion],
        queries: [],
        fn: () => commitCompletedWaterCollisionReceipts(world, system, status),
      });
      world.addSystem(FixedUpdate, waterSceneCollisionReceiptSystem).unwrap();
      const waterSceneReconcileSystem = defineSystem({
        name: SYSTEM,
        sets: [WaterSceneReconcile],
        after: [PropagateTransforms],
        queries: [],
        fn: () => {
          if (!states.get(world)?.disposing) {
            reconcileWaterScene(world, assetAccess, system, status);
            system.updateAudioState();
          }
        },
      });
      world.addSystem(Update, waterSceneReconcileSystem).unwrap();
      if (lifecycle)
        lifecycle.systems = [
          [FixedUpdate, waterSceneCollisionSystem],
          [FixedUpdate, waterSceneCollisionReceiptSystem],
          [Update, waterSceneReconcileSystem],
        ];
      const releaseProfileWork = WATER_SCENE_PROFILE_WORK.map((work) =>
        registerScheduleWork(world, work),
      );
      ctx.effect(
        () => () => {
          for (const release of releaseProfileWork) release();
          return beginWaterSceneDisposal(world, system);
        },
        'water/scene-lifecycle',
      );
    },
  };
}

function currentWaterProfileObserver(world: World): WaterOperationObserver | undefined {
  return hasScheduleRunObservers(world)
    ? { begin: (work) => beginScheduleWork(world, work) }
    : undefined;
}

type PendingWaterCollision = {
  readonly bodyGeneration?: number;
  readonly revision: number;
  readonly digest: string;
  readonly pairedBake?: boolean;
  readonly stagedScene?: boolean;
  readonly candidate?: DerivedPhysicsCandidate;
  readonly failed?: true;
  readonly retiring?: true;
  readonly sourceKey?: string;
};

const pendingWaterCollision = new WeakMap<World, Map<number, PendingWaterCollision>>();

function waterCollisionAdmissionIsInFlight(
  world: World,
  water: WaterSystem,
  guid: string,
  entity: number,
): boolean {
  const pending = pendingWaterCollision.get(world)?.get(entity);
  return (
    (pending?.pairedBake === true || pending?.stagedScene === true) &&
    pending.bodyGeneration !== undefined &&
    water.bakedQueryGridCandidatePhase(guid, pending.bodyGeneration, pending.revision) !== undefined
  );
}

function waterNativeSourceAttached(world: World, guid: string, entity: number): boolean {
  const sourceKey = `water:${guid}`;
  try {
    const receipt = world
      .getResource<PhysicsWorld>(PhysicsWorldResource)
      .getDerivedCollisionReceipt?.(entity);
    if (receipt !== undefined)
      return receipt.sourceKey === sourceKey && receipt.sourceTransform !== undefined;
    const pendingCandidate = pendingWaterCollision.get(world)?.get(entity)?.candidate;
    return (
      pendingCandidate?.input.sourceKey === sourceKey &&
      pendingCandidate.input.sourceTransform !== undefined
    );
  } catch {
    return false;
  }
}

function waterNativeCollisionRetired(world: World, guid: string, entity: number): boolean {
  try {
    const receipt = world
      .getResource<PhysicsWorld>(PhysicsWorldResource)
      .getDerivedCollisionReceipt?.(entity);
    return (
      receipt?.sourceKey === `water:${guid}` &&
      receipt.shapes.length === 0 &&
      receipt.sourceTransform === undefined
    );
  } catch {
    return false;
  }
}

function createWaterSystem(world: World, assets: WaterSceneAssetAccess): WaterSystem {
  states.set(world, {
    bodies: new Map(),
    queryPrismParts: new Map(),
    geometryConsumerOutputs: new Map(),
    geometryConsumerGeneration: 0,
    queryConsumerGeneration: 0,
    zones: new Map(),
    zoneEntities: new Map(),
    zoneVersions: new Map(),
    assetSnapshots: new Map(),
    terrainProviderProjection: createStateProjection(world, [WaterTerrainProvider]),
    terrainProviderHandles: new Map(),
    terrainProviderHandleCounts: new Map(),
    leases: new Map(),
    riverBakeNormalAssets: new Map(),
    geometryMeshOwner: assets,
  });
  pendingWaterCollision.set(world, new Map());
  return new WaterSystem(
    (guid) => {
      const state = states.get(world);
      const zone = state?.zones.get(guid);
      const instance =
        zone &&
        [...(state?.zoneEntities.values() ?? [])].find(
          (candidate) =>
            candidate.guid === guid && candidate.generation === zone.generation && candidate.asset,
        );
      return zone ? { ...zone, ...(instance?.asset ? { asset: instance.asset } : {}) } : undefined;
    },
    (asset) => collectWaterDependencies(asset, assets),
    () => {
      const state = states.get(world);
      if (!state) return Object.freeze([]);
      const zones = [...state.zones].flatMap(([guid, zone]) => {
        const instance = [...state.zoneEntities.values()].find(
          (candidate) =>
            candidate.guid === guid && candidate.generation === zone.generation && candidate.asset,
        );
        return instance?.asset
          ? [{ guid, generation: zone.generation, asset: instance.asset }]
          : [];
      });
      return Object.freeze(zones);
    },
    (body, ground, positionM) => sampleWaterTerrainForQuery(body, ground, positionM, world, assets),
  );
}

function sampleWaterTerrainForQuery(
  body: WaterQueryBodySnapshot,
  ground: WaterZoneGroundQuerySnapshot | undefined,
  positionM: readonly [number, number, number],
  world: World,
  assets: WaterSceneAssetAccess,
): WaterTerrainQuerySample | undefined {
  if (
    body.binding.kind !== 'bound' ||
    !ground ||
    ground.zoneGuid !== body.binding.zoneGuid ||
    ground.zoneGeneration !== body.binding.zoneGeneration
  )
    return undefined;
  const state = states.get(world);
  for (const provider of ground.providers) {
    if (
      positionM[0] < provider.boundsXZ.minM[0] ||
      positionM[0] > provider.boundsXZ.maxM[0] ||
      positionM[2] < provider.boundsXZ.minM[1] ||
      positionM[2] > provider.boundsXZ.maxM[1]
    )
      continue;
    const resolveQueryTerrain = () => {
      let terrain: TerrainAsset | undefined;
      if (
        state?.geometryMeshOwner === assets &&
        versionedRegistryAccesses.has(assets as object) &&
        !ground.pending
      ) {
        const providerEntity = provider.entity as EntityHandle;
        const currentProvider = world.get(providerEntity, WaterTerrainProvider);
        const handle = currentProvider.ok ? currentProvider.value.terrain : undefined;
        const tracked = state.terrainProviderHandles.get(unpackSlot(providerEntity));
        const currentAsset =
          handle === undefined
            ? undefined
            : (assets as RegistryWaterSceneAssetAccess)[waterSceneCurrentAssetMetadata]?.(handle);
        if (
          handle !== undefined &&
          tracked?.entity === providerEntity &&
          tracked.handle === handle &&
          currentAsset?.sourceGuid === provider.terrainGuid &&
          currentAsset.version === provider.terrainVersion &&
          currentAsset.kind === 'terrain'
        ) {
          const cached = state.assetSnapshots.get(Number(handle));
          if (
            cached?.handle === handle &&
            cached.sourceGuid === provider.terrainGuid &&
            cached.version === provider.terrainVersion &&
            cached.kind === 'terrain' &&
            cached.payload.kind === 'terrain'
          )
            terrain = cached.payload;
        }
      }
      const resolveTerrainDependencyFallback = () => {
        if (terrain === undefined) {
          const dependency = assets.dependency?.(provider.terrainGuid, 'terrain');
          const payload = dependency?.payload as TerrainAsset | undefined;
          terrain =
            dependency?.status === 'valid' &&
            waterDependencyVersion(dependency) === String(provider.terrainVersion) &&
            payload?.kind === 'terrain'
              ? payload
              : undefined;
        }
      };
      resolveTerrainDependencyFallback();
      return terrain;
    };
    const terrain = resolveQueryTerrain();
    if (
      !terrain ||
      terrain.columns < 2 ||
      terrain.rows < 2 ||
      !(terrain.spacing > 0) ||
      terrain.heights.length !== terrain.columns * terrain.rows
    )
      continue;
    const sampleQueryTerrainProvider = (terrain: TerrainAsset) => {
      const matrix = provider.worldMatrixM;
      if (!validMatrix(matrix)) return undefined;
      const translationX = matrix[12],
        translationY = matrix[13],
        translationZ = matrix[14];
      if (translationX === undefined || translationY === undefined || translationZ === undefined)
        return undefined;
      const localX = positionM[0] - translationX;
      const localZ = positionM[2] - translationZ;
      const maxX = (terrain.columns - 1) * terrain.spacing,
        maxZ = (terrain.rows - 1) * terrain.spacing;
      if (localX < 0 || localZ < 0 || localX > maxX || localZ > maxZ) return undefined;
      const fx = localX / terrain.spacing,
        fz = localZ / terrain.spacing;
      const x0 = Math.min(Math.floor(fx), terrain.columns - 2),
        z0 = Math.min(Math.floor(fz), terrain.rows - 2);
      const tx = fx - x0,
        tz = fz - z0;
      const heightAt = (x: number, z: number) => terrain.heights[z * terrain.columns + x];
      const h00 = heightAt(x0, z0),
        h10 = heightAt(x0 + 1, z0),
        h01 = heightAt(x0, z0 + 1),
        h11 = heightAt(x0 + 1, z0 + 1);
      if (h00 === undefined || h10 === undefined || h01 === undefined || h11 === undefined)
        return undefined;
      const top = h00 * (1 - tx) + h10 * tx;
      const bottom = h01 * (1 - tx) + h11 * tx;
      const heightM = top * (1 - tz) + bottom * tz + translationY;
      if (Number.isFinite(heightM))
        return Object.freeze({
          heightM,
          providerGuid: provider.terrainGuid,
          providerVersion: provider.terrainVersion,
          zoneGeneration: ground.zoneGeneration,
          groundGeneration: ground.generation,
        });
      return undefined;
    };
    const sampled = sampleQueryTerrainProvider(terrain);
    if (sampled !== undefined) return sampled;
  }
  return undefined;
}

function beginWaterSceneDisposal(world: World, water: WaterSystem): Promise<void> | undefined {
  const state = states.get(world);
  if (!state) return;
  if (state.disposal) return state.disposal;
  state.disposing = true;
  water.clearViewStates();
  water.fluid.clear();
  for (const [schedule, system] of state.systems ?? []) world.removeSystem(schedule, system);
  const retirements = new Map<number, string>(
    [...state.bodies.values()].map((body) => [body.entity, `scene-entity:${body.entity}`]),
  );
  for (const snapshot of water.snapshots()) {
    if (!snapshot.guid.startsWith('scene-entity:')) continue;
    const entity = Number(snapshot.guid.slice('scene-entity:'.length));
    if (Number.isSafeInteger(entity) && !retirements.has(entity))
      retirements.set(entity, snapshot.guid);
  }
  let physics: PhysicsWorld | undefined;
  try {
    physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  } catch {
    /* No native source was installed. */
  }
  const pending = pendingWaterCollision.get(world);
  const disposal = (async () => {
    const failures: unknown[] = [];
    for (const [entity, guid] of retirements) {
      const sourceKey = `water:${guid}`;
      const tried = new Set<object>();
      const pendingCollision = pending?.get(entity);
      const pendingCandidate = pendingCollision?.candidate;
      const currentReceipt = physics?.getDerivedCollisionReceipt?.(entity);
      const cancelQueuedWaterSceneBake = () => {
        if (
          (pendingCollision?.pairedBake || pendingCollision?.stagedScene) &&
          pendingCollision.bodyGeneration !== undefined &&
          pendingCandidate?.input.sourceKey === sourceKey &&
          water.bakedQueryGridCandidatePhase(
            guid,
            pendingCollision.bodyGeneration,
            pendingCollision.revision,
          ) === 'queued'
        ) {
          const cancelled = physics
            ? cancelWaterCollisionCandidate(physics, pendingCandidate)
            : err(new Error('PhysicsWorld is unavailable while cancelling a queued River Bake'));
          if (!cancelled.ok) {
            failures.push(cancelled.error);
            return true;
          }
          water.rejectBakedQueryGridCandidate(
            guid,
            pendingCollision.bodyGeneration,
            pendingCollision.revision,
          );
          pending?.delete(entity);
        }

        return false;
      };
      if (cancelQueuedWaterSceneBake()) continue;
      const hasCurrentSource = currentReceipt?.sourceKey === sourceKey;
      const hasPendingSource = pending?.get(entity)?.candidate?.input.sourceKey === sourceKey;
      if ((hasCurrentSource || hasPendingSource) && !physics?.retireDerivedSource) {
        failures.push(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            `Physics must confirm native Water source retirement for ${sourceKey}`,
            'retain the Water Scene until this Physics backend can retire or cancel its owned source',
            { entity, reason: 'source-retirement-unsupported' },
          ),
        );
        continue;
      }
      let retirementFailed = false;
      try {
        while (physics?.retireDerivedSource) {
          const candidate = pending?.get(entity)?.candidate;
          const receipt = physics.getDerivedCollisionReceipt?.(entity);
          const credential =
            candidate?.input.sourceKey === sourceKey && !tried.has(candidate)
              ? candidate
              : receipt?.sourceKey === sourceKey && !tried.has(receipt.publication)
                ? receipt.publication
                : undefined;
          if (!credential) break;
          tried.add(credential);
          const retired = await physics.retireDerivedSource(credential);
          if (retired.ok) continue;
          if (retired.error.code !== 'derived-candidate-stale') {
            failures.push(retired.error);
            retirementFailed = true;
            break;
          }
        }
        if (retirementFailed) continue;
        const releaseRetiredWaterSceneSource = () => {
          if (
            (pendingCollision?.pairedBake || pendingCollision?.stagedScene) &&
            pendingCollision.bodyGeneration !== undefined
          )
            water.rejectBakedQueryGridCandidate(
              guid,
              pendingCollision.bodyGeneration,
              pendingCollision.revision,
            );
          pending?.delete(entity);
          const released = releaseWaterRigidBody(world, guid, physics);
          if (!released.ok) failures.push(released.error);
        };
        releaseRetiredWaterSceneSource();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Water scene source retirement failed');
    finishWaterSceneDisposal(world, water);
  })();
  state.disposal = disposal.catch((cause: unknown) => {
    if (states.get(world) === state) delete state.disposal;
    throw cause;
  });
  return state.disposal;
}

function finishWaterSceneDisposal(world: World, water: WaterSystem): void {
  const state = states.get(world);
  if (!state?.disposing) return;
  const unmountFailures = water.snapshots().flatMap((snapshot) => {
    const unmounted = water.unmountBody(snapshot.guid);
    return unmounted.ok ? [] : [unmounted.error];
  });
  if (unmountFailures.length)
    throw new AggregateError(unmountFailures, 'Water scene snapshots remained in native admission');
  const releaseFailures: unknown[] = [];
  for (const [guid, lease] of state.leases) {
    const released = water.releaseSnapshot(lease);
    if (!released.ok) releaseFailures.push(released.error);
    else state.leases.delete(guid);
  }
  if (releaseFailures.length)
    throw new AggregateError(releaseFailures, 'Water scene snapshot leases could not be released');
  for (const leases of state.riverBakeNormalAssets.values()) {
    leases.accepted?.snapshot.dispose();
    leases.candidate?.snapshot.dispose();
  }
  state.riverBakeNormalAssets.clear();
  water.removeOceanPatch();
  state.assetSnapshots.clear();
  state.terrainProviderHandles.clear();
  state.terrainProviderHandleCounts.clear();
  state.queryPrismParts.clear();
  state.geometryConsumerOutputs.clear();
  state.geometryMeshOwner?.disposeWaterGeometryMeshes?.();
  state.geometryMeshOwner?.disposeBodyDependencies?.();
  for (const [schedule, system] of state.systems ?? []) world.removeSystem(schedule, system);
  world.removeResource(WATER_SYSTEM_RESOURCE);
  world.removeResource(WATER_SCENE_STATUS_RESOURCE);
  states.delete(world);
  pendingWaterCollision.delete(world);
}

function collisionFailureFields(
  reason: unknown,
): Pick<WaterSceneCollisionFailure, 'reason' | 'code' | 'expected' | 'hint' | 'detail'> {
  if (typeof reason !== 'object' || reason === null) return { reason: String(reason) };
  const value = reason as {
    code?: unknown;
    expected?: unknown;
    hint?: unknown;
    detail?: unknown;
    message?: unknown;
  };
  const fields: {
    reason: string;
    code?: string;
    expected?: string;
    hint?: string;
    detail?: unknown;
  } = {
    reason: typeof value.message === 'string' ? value.message : String(reason),
  };
  if (typeof value.code === 'string') fields.code = value.code;
  if (typeof value.expected === 'string') fields.expected = value.expected;
  if (typeof value.hint === 'string') fields.hint = value.hint;
  if (value.detail !== undefined) {
    try {
      const serialized = JSON.stringify(value.detail);
      if (serialized !== undefined) fields.detail = JSON.parse(serialized) as unknown;
    } catch {
      // Non-serializable detail stays available on the original error only.
    }
  }
  return fields;
}

function retireWaterCollision(
  world: World,
  entity: number,
  status?: WaterSceneStatus,
  bodyGuid = '',
): boolean {
  if (!Number.isSafeInteger(entity) || entity < 0) return true;
  let physics: PhysicsWorld | undefined;
  const reportFailure = (reason: unknown) => {
    if (status)
      status.waterCollisionFailures = Object.freeze([
        ...status.waterCollisionFailures.filter((failure) => failure.entity !== entity),
        Object.freeze({
          entity,
          bodyGuid,
          stage: 'retire' as const,
          ...collisionFailureFields(reason),
        }),
      ]);
  };
  const finish = () => {
    const released = releaseWaterRigidBody(world, bodyGuid, physics);
    if (!released.ok) {
      reportFailure(released.error);
      return false;
    }
    if (status)
      status.waterCollisionFailures = Object.freeze(
        status.waterCollisionFailures.filter((failure) => failure.entity !== entity),
      );
    return true;
  };
  try {
    physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  } catch {
    return finish();
  }
  const completeRetiringWaterCollision = () => {
    if (!physics.prepareDerivedShapeCandidate || !physics.admitDerivedShapeCandidate)
      return finish();
    const pending = pendingWaterCollision.get(world) ?? new Map<number, PendingWaterCollision>();
    pendingWaterCollision.set(world, pending);
    const previous = pending.get(entity);
    const current = physics.getDerivedCollisionReceipt?.(entity);
    const expectedSourceKey = `water:${bodyGuid}`;
    const retireMismatchedWaterSource = () => {
      if (current && current.sourceKey !== expectedSourceKey) {
        if (previous?.candidate) {
          const cancelled = cancelWaterCollisionCandidate(physics, previous.candidate);
          if (!cancelled.ok) {
            reportFailure(cancelled.error);
            return false;
          }
        }
        pending.delete(entity);
        return true;
      }
      return undefined;
    };
    const mismatchedSourceResult = retireMismatchedWaterSource();
    if (mismatchedSourceResult !== undefined) return mismatchedSourceResult;
    if (
      previous?.retiring &&
      current?.sourceKey === expectedSourceKey &&
      current.publication.revision >= previous.revision &&
      current.shapes.length === 0
    ) {
      pending.delete(entity);
      return finish();
    }
    if (!current) {
      if (previous?.candidate) {
        const cancelled = cancelWaterCollisionCandidate(physics, previous.candidate);
        if (!cancelled.ok) {
          reportFailure(cancelled.error);
          return false;
        }
      }
      pending.delete(entity);
      return finish();
    }
    const reconcileRetiringWaterCandidate = () => {
      if (previous?.candidate && !previous.retiring) {
        const cancelled = cancelWaterCollisionCandidate(physics, previous.candidate);
        if (!cancelled.ok) {
          reportFailure(cancelled.error);
          return false;
        }
      }
      if (previous?.retiring && previous.candidate && !previous.failed) {
        const failure = physics.getDerivedFailure?.(entity);
        if (failure?.revision === previous.revision) {
          const cancelled = cancelWaterCollisionCandidate(physics, previous.candidate);
          if (!cancelled.ok) {
            reportFailure(cancelled.error);
            return false;
          }
          pending.set(entity, {
            revision: previous.revision,
            digest: previous.digest,
            sourceKey: previous.sourceKey ?? expectedSourceKey,
            retiring: true,
            failed: true,
          });
          reportFailure(failure.error);
        } else return false;
      }
      if (previous?.candidate && previous.failed) {
        const cancelled = cancelWaterCollisionCandidate(physics, previous.candidate);
        if (!cancelled.ok) {
          reportFailure(cancelled.error);
          return false;
        }
      }
      return undefined;
    };
    const retiringCandidateFailure = reconcileRetiringWaterCandidate();
    if (retiringCandidateFailure !== undefined) return retiringCandidateFailure;
    const sourceKey = current?.sourceKey ?? previous?.sourceKey ?? expectedSourceKey;
    const validateRetiringSourceKey = () => {
      if (sourceKey !== expectedSourceKey) {
        pending.delete(entity);
        return true;
      }
      return undefined;
    };
    const sourceKeyResult = validateRetiringSourceKey();
    if (sourceKeyResult !== undefined) return sourceKeyResult;
    const revision = Math.max(current?.publication.revision ?? 0, previous?.revision ?? 0) + 1;
    const digest = `retire:${bodyGuid}:${revision}`;
    const input = { entity, sourceKey, revision, shapes: [] };
    const prepared = physics.prepareDerivedShapeCandidate(input);
    if (!prepared.ok) {
      pending.set(entity, { revision, digest, sourceKey, retiring: true, failed: true });
      reportFailure(prepared.error);
      return false;
    }
    const admitted = physics.admitDerivedShapeCandidate(prepared.value);
    if (!admitted.ok) {
      const reportRetiringCollisionAdmissionFailure = () => {
        reportFailure(admitted.error);
        const cancelled = cancelWaterCollisionCandidate(physics, prepared.value);
        if (!cancelled.ok) {
          pending.set(entity, {
            revision,
            digest,
            sourceKey,
            retiring: true,
            failed: true,
            candidate: prepared.value,
          });
          reportFailure(cancelled.error);
          return false;
        }
        pending.set(entity, { revision, digest, sourceKey, retiring: true, failed: true });
        return false;
      };
      return reportRetiringCollisionAdmissionFailure();
    }

    pending.set(entity, { revision, digest, sourceKey, retiring: true, candidate: admitted.value });
    return false;
  };
  return completeRetiringWaterCollision();
}

function releaseWaterRigidBody(
  world: World,
  bodyGuid: string,
  physics?: PhysicsWorld,
): ReturnType<World['removeComponent']> {
  const mount = states.get(world)?.bodies.get(bodyGuid);
  if (
    mount?.ownedRigidBodyEpoch === undefined ||
    readEntityComponentEpoch(world, mount.entity as EntityHandle, RigidBody) !==
      mount.ownedRigidBodyEpoch ||
    world.hasComponent(mount.entity as EntityHandle, Collider)
  )
    return ok(undefined);
  const constraints = physics?.hasBody(mount.entity)
    ? physics.getBodyConstraintCount?.(mount.entity)
    : undefined;
  if (constraints && (!constraints.ok || constraints.value > 0)) return ok(undefined);
  return world.removeComponent(mount.entity as EntityHandle, RigidBody);
}

/** Match ordinary PhysicsSync's authored rigid frame; Native motion is guarded separately. */
function authoredWaterBodyPose(world: World, entity: EntityHandle, matrix: readonly number[]) {
  if (!world.hasComponent(entity, ChildOf)) {
    const transform = world.get(entity, Transform);
    if (!transform.ok) return undefined;
    return {
      position: [...transform.value.pos] as [number, number, number],
      rotation: [...transform.value.quat] as [number, number, number, number],
    };
  }
  const position = vec3.create();
  const rotation = quat.create();
  const scale = vec3.create();
  mat4.decompose(position, rotation, scale, matrix);
  quat.normalize(rotation, rotation);
  return {
    position: [position[0], position[1], position[2]] as [number, number, number],
    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]] as [
      number,
      number,
      number,
      number,
    ],
  };
}

type BorrowedWaterBody = Readonly<{
  bodyType: RigidBodyType;
  pose: Pick<BodyMotion, 'position' | 'rotation'>;
  motion: BodyMotion;
}>;

function resolveBorrowedWaterBody(
  world: World,
  physics: PhysicsWorld,
  entity: number,
  snapshot: WaterBodySnapshot,
  existing: DerivedPhysicsCollisionReceipt | undefined,
): Result<BorrowedWaterBody | undefined, unknown> {
  if (snapshot.asset.type !== 'river' || existing?.sourceTransform !== undefined)
    return ok(undefined);
  const authored = world.get(entity as EntityHandle, RigidBody);
  if (!authored.ok) return ok(undefined);
  const bodyType = rigidBodyTypeFromF32(authored.value.type);
  if (bodyType === 'static' && !existing?.shapes.length) return ok(undefined);
  const motion = physics.getBodyMotion?.(entity);
  if (!motion?.ok)
    return err(
      motion && !motion.ok
        ? motion.error
        : 'Physics cannot read the authored River Native rigid pose',
    );
  const pose = authoredWaterBodyPose(world, entity as EntityHandle, snapshot.worldMatrixM);
  return pose === undefined
    ? err('Scene cannot read the authored River rigid pose')
    : ok({ bodyType, motion: motion.value, pose });
}

function independentWaterCollision(
  existing: DerivedPhysicsCollisionReceipt | undefined,
  accepted: WaterBodySnapshot['outputReceipts']['collision'],
  pending: PendingWaterCollision | undefined,
): boolean {
  return (
    existing !== undefined &&
    existing.sourceTransform === undefined &&
    existing.shapes.length > 0 &&
    accepted === undefined &&
    pending?.candidate?.candidateId !== existing.publication.candidateId
  );
}

function borrowedWaterNativePoseMatches(
  world: World,
  entity: number,
  borrowed: BorrowedWaterBody | undefined,
  native: DerivedPhysicsAdmissionState,
): boolean {
  if (borrowed === undefined) return true;
  const currentBody = world.get(entity as EntityHandle, RigidBody);
  return (
    currentBody.ok &&
    rigidBodyTypeFromF32(currentBody.value.type) === borrowed.bodyType &&
    sameVectorF32(native.position, borrowed.motion.position) &&
    sameVectorF32(native.rotation, borrowed.motion.rotation)
  );
}

function waterCollisionSourceMatrixMatches(
  source: DerivedPhysicsCandidate['input']['sourceTransform'],
  matrix: readonly number[],
): boolean {
  return source === undefined || sameMatrixF32(source.sceneMatrix, matrix);
}

function acceptedWaterNativeMotion(
  physics: PhysicsWorld,
  entity: number,
  borrowed: BorrowedWaterBody | undefined,
  sourceOwned: boolean,
  existing: DerivedPhysicsCollisionReceipt | undefined,
) {
  if (borrowed !== undefined) return ok(borrowed.motion);
  return sourceOwned && existing ? physics.getBodyMotion?.(entity) : undefined;
}

function waterCollisionRequiresGuard(
  source: DerivedPhysicsCandidate['input']['sourceTransform'],
  borrowed: BorrowedWaterBody | undefined,
): boolean {
  return source !== undefined || borrowed !== undefined;
}

function waterCollisionNativeBodyType(borrowed: BorrowedWaterBody | undefined): RigidBodyType {
  return borrowed?.bodyType ?? 'static';
}

function waterRiverTransformRequiresStaging(
  world: World,
  guid: string,
  entity: EntityHandle,
  snapshot: WaterBodySnapshot,
  mount: BodyMount | undefined,
): boolean {
  if (
    snapshot.outputReceipts.collision !== undefined ||
    waterNativeSourceAttached(world, guid, entity)
  )
    return true;
  return (
    mount?.ownedRigidBodyEpoch !== undefined &&
    mount.ownedRigidBodyEpoch === readEntityComponentEpoch(world, entity, RigidBody) &&
    !world.getResource<PhysicsWorld>(PhysicsWorldResource).getDerivedCollisionReceipt?.(entity)
  );
}

function publishWaterCollision(
  world: World,
  water: WaterSystem,
  guid: string,
  entity: number,
  status?: WaterSceneStatus,
): boolean {
  let physics: PhysicsWorld;
  try {
    physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  } catch {
    return false;
  }
  if (!physics.prepareDerivedShapeCandidate || !physics.admitDerivedShapeCandidate) return false;
  let snapshot = water.sceneCandidateSnapshot(guid) ?? water.snapshot(guid);
  if (!snapshot) return false;
  const readInitialCollisionBake = (snapshot: NonNullable<ReturnType<WaterSystem['snapshot']>>) => {
    let stagedRiverBake = water.bakedQueryGridCandidate(guid, snapshot.sceneGeneration);
    if (snapshot.outputs.collision === 'not-requested') stagedRiverBake = undefined;
    const outputGeneration =
      stagedRiverBake === undefined
        ? snapshot.outputGenerations.collision
        : (water.bakedQueryGridCandidateOutputGeneration(guid, snapshot.sceneGeneration) ??
          snapshot.outputGenerations.collision);

    return { stagedRiverBake, outputGeneration };
  };
  let { stagedRiverBake, outputGeneration } = readInitialCollisionBake(snapshot);
  const reportFailure = (
    stage: WaterSceneStatus['waterCollisionFailures'][number]['stage'],
    reason: unknown,
  ) => {
    if (status)
      status.waterCollisionFailures = Object.freeze([
        ...status.waterCollisionFailures.filter((failure) => failure.entity !== entity),
        Object.freeze({ entity, bodyGuid: guid, stage, ...collisionFailureFields(reason) }),
      ]);
  };
  const clearFailure = () => {
    if (status)
      status.waterCollisionFailures = Object.freeze(
        status.waterCollisionFailures.filter(
          (failure) =>
            failure.entity !== entity ||
            (failure.code === 'invalid-source' &&
              typeof failure.detail === 'object' &&
              failure.detail !== null &&
              'sourceOwnershipExit' in failure.detail),
        ),
      );
  };
  const existing = physics.getDerivedCollisionReceipt?.(entity);
  const accepted = snapshot.outputReceipts.collision;
  if (
    independentWaterCollision(existing, accepted, pendingWaterCollision.get(world)?.get(entity))
  ) {
    // A source key alone cannot transfer an independently accepted ordinary collision.
    clearFailure();
    return false;
  }
  const reuseAcceptedCollision = (snapshot: NonNullable<ReturnType<WaterSystem['snapshot']>>) => {
    if (
      stagedRiverBake === undefined &&
      snapshot.outputs.collision === 'ready' &&
      !snapshot.dirty.has('collision') &&
      accepted?.sourceVersion === snapshot.sourceVersion &&
      accepted.outputGeneration === outputGeneration &&
      existing?.sourceKey === `water:${guid}` &&
      existing.publication.revision === outputGeneration &&
      accepted.consumerGeneration === existing.publication.generation &&
      accepted.digest === existing.publication.inputDigest &&
      (existing.sourceTransform === undefined ||
        sameMatrixF32(existing.sourceTransform.sceneMatrix, snapshot.worldMatrixM)) &&
      physics.hasBody(entity)
    ) {
      if (accepted.sceneGeneration !== snapshot.sceneGeneration) {
        const refreshed = water.acceptOutput(guid, 'collision', outputGeneration, {
          generation: existing.publication.generation,
          digest: existing.publication.inputDigest,
        });
        if (refreshed.ok) {
          clearFailure();
          pendingWaterCollision.get(world)?.delete(entity);
          return true;
        }
      } else {
        clearFailure();
        pendingWaterCollision.get(world)?.delete(entity);
        return false;
      }
    }

    return undefined;
  };
  const reuseAcceptedCollisionFailure = reuseAcceptedCollision(snapshot);
  if (reuseAcceptedCollisionFailure !== undefined) return reuseAcceptedCollisionFailure;

  const pending = pendingWaterCollision.get(world) ?? new Map();
  pendingWaterCollision.set(world, pending);
  const previousBake = pending.get(entity);
  if (
    previousBake?.pairedBake &&
    (previousBake.bodyGeneration !== snapshot.sceneGeneration || stagedRiverBake === undefined)
  ) {
    const cancelSupersededRiverBake = () => {
      if (previousBake.candidate) {
        const cancelled = physics.cancelDerivedShapeCandidate?.(previousBake.candidate);
        if (!cancelled?.ok) {
          reportFailure(
            'admit',
            cancelled?.error ?? 'could not cancel the superseded River Bake candidate',
          );
          return false;
        }
        water.releaseBakedQueryGridCandidate(
          guid,
          previousBake.bodyGeneration,
          previousBake.revision,
        );
      }

      return undefined;
    };
    const cancelSupersededRiverBakeResult = cancelSupersededRiverBake();
    if (cancelSupersededRiverBakeResult !== undefined) return cancelSupersededRiverBakeResult;
    const refreshSupersededRiverSnapshot = () => {
      water.invalidate(guid, ['collision']);
      pending.delete(entity);
      const refreshed = water.snapshot(guid);
      if (!refreshed) {
        pending.delete(entity);
        return false;
      }
      snapshot = refreshed;
      stagedRiverBake =
        snapshot.asset.type === 'river' && snapshot.asset.collision.enabled
          ? water.bakedQueryGridCandidate(guid, snapshot.sceneGeneration)
          : undefined;
      return undefined;
    };
    const refreshSupersededRiverSnapshotResult = refreshSupersededRiverSnapshot();
    if (refreshSupersededRiverSnapshotResult !== undefined)
      return refreshSupersededRiverSnapshotResult;
  }
  outputGeneration =
    stagedRiverBake === undefined
      ? snapshot.outputGenerations.collision
      : (water.bakedQueryGridCandidateOutputGeneration(guid, snapshot.sceneGeneration) ??
        snapshot.outputGenerations.collision);
  const pairedBake = stagedRiverBake !== undefined;
  const stagedScene = water.sceneCandidateSnapshot(guid) !== undefined;
  if (water.sceneCandidateRequiresBakedGrid(guid, snapshot.sceneGeneration)) {
    const failure: WaterError = {
      code: 'query-data-unavailable',
      expected: 'a qualified World-lattice River Bake for the staged Scene transform',
      hint: 'keep the accepted River pose and Bake active until a qualified replacement Bake or an explicit Bake clear is published',
      detail: { guid, bodyGeneration: snapshot.sceneGeneration, outputGeneration },
    };
    reportFailure('cook', failure);
    return false;
  }
  const readCollisionRiverBakeInput = (
    snapshot: NonNullable<ReturnType<WaterSystem['snapshot']>>,
  ) => {
    const acceptedRiverBake =
      stagedRiverBake === undefined &&
      snapshot.asset.type === 'river' &&
      snapshot.asset.collision.enabled
        ? water.bakedQueryGrid(guid, snapshot.sceneGeneration)
        : undefined;
    const bakedRiverGrid =
      stagedRiverBake === null ? undefined : (stagedRiverBake ?? acceptedRiverBake?.grid);
    const bakedRiverSourceGeneration =
      bakedRiverGrid?.lineage?.sourceBodyGeneration ?? snapshot.sceneGeneration;

    return { acceptedRiverBake, bakedRiverGrid, bakedRiverSourceGeneration };
  };
  const { bakedRiverGrid, bakedRiverSourceGeneration } = readCollisionRiverBakeInput(snapshot);
  const borrowed = resolveBorrowedWaterBody(world, physics, entity, snapshot, existing);
  if (!borrowed.ok) {
    reportFailure('prepare', borrowed.error);
    return false;
  }
  const borrowedBody = borrowed.value;
  const constructWaterCollisionInput = (
    snapshot: NonNullable<ReturnType<WaterSystem['snapshot']>>,
  ) => {
    const input = buildWaterPhysicsCandidateInput({
      entity,
      sourceKey: `water:${guid}`,
      revision: outputGeneration,
      body: snapshot.asset,
      bodyWorldMatrixM: snapshot.worldMatrixM,
      exclusionVolumes: snapshot.exclusionVolumes,
      ...(borrowedBody === undefined ? {} : { borrowedBodyPose: borrowedBody.pose }),
      ...(bakedRiverGrid
        ? {
            riverBake: {
              bodyGeneration: bakedRiverSourceGeneration,
              sourceBodyGuid: snapshot.sourceAssetGuid,
              grid: bakedRiverGrid,
            },
          }
        : {}),
    });

    return input;
  };
  const input = constructWaterCollisionInput(snapshot);
  if (!input.ok) {
    const rejectUncookedWaterCollision = (
      snapshot: NonNullable<ReturnType<WaterSystem['snapshot']>>,
    ) => {
      const releaseFailedCollisionCandidate = () => {
        const failedPending = pending.get(entity);
        if (failedPending?.candidate) {
          const cancelled = physics.cancelDerivedShapeCandidate?.(failedPending.candidate);
          if (!cancelled?.ok) {
            reportFailure('cook', input.error);
            return false;
          }
        }
        if (failedPending?.pairedBake || failedPending?.stagedScene)
          water.releaseBakedQueryGridCandidate(
            guid,
            failedPending.bodyGeneration ?? snapshot.sceneGeneration,
            failedPending.revision,
          );
        pending.delete(entity);
        if (stagedRiverBake !== undefined)
          water.rejectBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);

        return undefined;
      };
      const releaseFailedCollisionCandidateFailure = releaseFailedCollisionCandidate();
      if (releaseFailedCollisionCandidateFailure !== undefined)
        return releaseFailedCollisionCandidateFailure;

      reportFailure('cook', input.error);
      return false;
    };
    return rejectUncookedWaterCollision(snapshot);
  }
  const checkWaterCollisionBodyPresence = () => {
    if (input.value.shapes.length === 0 && !existing && !pending.has(entity)) {
      clearFailure();
      return false;
    }
    ensureWaterRigidBody(world, guid, entity, status);
    if (!physics.hasBody(entity)) {
      clearFailure();
      return false;
    }

    return undefined;
  };
  const checkWaterCollisionBodyPresenceResult = checkWaterCollisionBodyPresence();
  if (checkWaterCollisionBodyPresenceResult !== undefined)
    return checkWaterCollisionBodyPresenceResult;
  const publishPreparedWaterCollision = (
    physics: PhysicsWorld &
      Required<Pick<PhysicsWorld, 'prepareDerivedShapeCandidate' | 'admitDerivedShapeCandidate'>>,
    snapshot: NonNullable<ReturnType<WaterSystem['snapshot']>>,
  ) => {
    const matchWaterCollisionReceipt = () => {
      const receiptMatches =
        existing?.sourceKey === input.value.sourceKey &&
        existing.publication.revision === outputGeneration &&
        existing.publication.inputDigest === input.value.inputDigest &&
        existing.publication.shapeIds.length === input.value.shapes.length &&
        existing.publication.shapeIds.every(
          (shapeId, index) => shapeId === input.value.shapes[index]?.id,
        );
      return receiptMatches;
    };
    const receiptMatches = matchWaterCollisionReceipt();
    if (receiptMatches && existing !== undefined) {
      const acceptMatchingCollision = () => {
        const receipt = existing.publication;
        const consumerReceipt = {
          generation: receipt.generation,
          digest: receipt.inputDigest,
        };
        const accepted =
          stagedRiverBake !== undefined
            ? water.acceptBakedQueryGrid(
                guid,
                snapshot.sceneGeneration,
                outputGeneration,
                consumerReceipt,
              )
            : stagedScene
              ? water.acceptRiverSceneCandidate(
                  guid,
                  snapshot.sceneGeneration,
                  outputGeneration,
                  consumerReceipt,
                )
              : snapshot.asset.collision.enabled
                ? water.acceptOutput(guid, 'collision', outputGeneration, consumerReceipt)
                : ok(true);
        if (!accepted.ok) {
          reportFailure('admit', accepted.error);
          return false;
        }
        clearFailure();
        pending.delete(entity);
        return true;
      };
      return acceptMatchingCollision();
    }
    let previous = pending.get(entity);
    const handleRepeatedCollisionCandidate = (currentPrevious: typeof previous) => {
      let previous = currentPrevious;
      if (
        previous?.revision === outputGeneration &&
        previous.digest === input.value.inputDigest &&
        previous.bodyGeneration === snapshot.sceneGeneration &&
        (previous.pairedBake ?? false) === pairedBake &&
        (previous.stagedScene ?? false) === stagedScene
      ) {
        const failure = physics.getDerivedFailure?.(entity);
        if (failure?.revision === outputGeneration) {
          reportFailure('admit', failure.error);
          if (previous.candidate) {
            const cancelled = physics.cancelDerivedShapeCandidate?.(previous.candidate);
            if (!cancelled?.ok) return false;
          }
          if (previous.pairedBake || previous.stagedScene)
            water.releaseBakedQueryGridCandidate(
              guid,
              previous.bodyGeneration ?? snapshot.sceneGeneration,
              previous.revision,
            );
          pending.delete(entity);
          previous = undefined;
        } else if (previous.candidate && !previous.failed) return false;
      }

      return { previous };
    };
    const repeatedCandidate = handleRepeatedCollisionCandidate(previous);
    if (repeatedCandidate === false) return false;
    previous = repeatedCandidate.previous;
    const releasePreviousCollisionCandidate = () => {
      if (previous?.candidate) {
        const cancelled = physics.cancelDerivedShapeCandidate?.(previous.candidate);
        if (!cancelled?.ok) {
          reportFailure(
            'admit',
            cancelled?.error ?? 'could not cancel the superseded Water collision candidate',
          );
          return false;
        }
        if (previous.pairedBake || previous.stagedScene)
          water.releaseBakedQueryGridCandidate(
            guid,
            previous.bodyGeneration ?? snapshot.sceneGeneration,
            previous.revision,
          );
      }

      return undefined;
    };
    const releasePreviousCollisionCandidateFailure = releasePreviousCollisionCandidate();
    if (releasePreviousCollisionCandidateFailure !== undefined)
      return releasePreviousCollisionCandidateFailure;

    const guardedSourceTransform = input.value.sourceTransform !== undefined;
    const guardedCollision = waterCollisionRequiresGuard(input.value.sourceTransform, borrowedBody);
    const expectedNativeBodyType = waterCollisionNativeBodyType(borrowedBody);
    const validateGuardedCollisionCapabilities = () => {
      if (
        guardedCollision &&
        (!physics.admitDerivedShapeCandidatesGuarded ||
          !physics.getDerivedAdmission ||
          (existing !== undefined && !physics.getBodyMotion))
      ) {
        if (stagedRiverBake !== undefined)
          water.rejectBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
        pending.set(entity, {
          bodyGeneration: snapshot.sceneGeneration,
          revision: outputGeneration,
          digest: input.value.inputDigest,
          pairedBake,
          stagedScene,
          failed: true,
        });
        reportFailure('prepare', {
          code: 'derived-candidate-invalid',
          expected:
            'Physics guarded admission and borrowed admission capabilities for a source-owned River pose',
          hint: 'use the Rapier PhysicsWorld candidate lifecycle for source-owned River collision geometry',
        });
        return false;
      }

      return undefined;
    };
    const validateGuardedCollisionCapabilitiesFailure = validateGuardedCollisionCapabilities();
    if (validateGuardedCollisionCapabilitiesFailure !== undefined)
      return validateGuardedCollisionCapabilitiesFailure;

    const acceptedMotion = acceptedWaterNativeMotion(
      physics,
      entity,
      borrowedBody,
      guardedSourceTransform,
      existing,
    );
    const validateAcceptedCollisionMotion = () => {
      if (guardedSourceTransform && existing && !acceptedMotion?.ok) {
        if (stagedRiverBake !== undefined)
          water.rejectBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
        pending.set(entity, {
          bodyGeneration: snapshot.sceneGeneration,
          revision: outputGeneration,
          digest: input.value.inputDigest,
          pairedBake,
          stagedScene,
          failed: true,
        });
        reportFailure(
          'prepare',
          acceptedMotion && !acceptedMotion.ok
            ? acceptedMotion.error
            : 'Physics cannot read the accepted River Native pose',
        );
        return false;
      }

      return undefined;
    };
    const validateAcceptedCollisionMotionFailure = validateAcceptedCollisionMotion();
    if (validateAcceptedCollisionMotionFailure !== undefined)
      return validateAcceptedCollisionMotionFailure;

    const candidateInput = guardedSourceTransform
      ? input.value
      : (({ bodyType: _bodyType, ...ordinaryInput }) => ordinaryInput)(input.value);
    const prepared = physics.prepareDerivedShapeCandidate(candidateInput);
    if (!prepared.ok) {
      const handleCollisionPreparationFailure = () => {
        if (stagedRiverBake !== undefined)
          water.rejectBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
        pending.set(entity, {
          bodyGeneration: snapshot.sceneGeneration,
          revision: outputGeneration,
          digest: input.value.inputDigest,
          pairedBake,
          stagedScene,
          failed: true,
        });
        reportFailure('prepare', prepared.error);
        return false;
      };
      return handleCollisionPreparationFailure();
    }

    const candidateId = prepared.value.candidateId;
    const admissionCallback = (): Result<void, Error> => {
      if (guardedCollision) {
        const admission = physics.getDerivedAdmission?.(entity);
        if (!admission || admission.entity !== entity || admission.revision !== outputGeneration)
          return err(
            new Error(
              'Physics did not expose the matching borrowed source-owned River admission proof',
            ),
          );
      }
      const readWaterAdmissionCallbackInputs = () => {
        const current = water.sceneCandidateSnapshot(guid) ?? water.snapshot(guid);
        const currentBake =
          current?.asset.type === 'river' && current.asset.collision.enabled
            ? water.bakedQueryGridCandidate(guid, current.sceneGeneration)
            : undefined;
        const currentOutputGeneration = current
          ? currentBake === undefined
            ? current.outputGenerations.collision
            : (water.bakedQueryGridCandidateOutputGeneration(guid, current.sceneGeneration) ??
              current.outputGenerations.collision)
          : undefined;
        return { current, currentBake, currentOutputGeneration };
      };
      const { current, currentBake, currentOutputGeneration } = readWaterAdmissionCallbackInputs();
      if (
        !current ||
        current.sceneGeneration !== snapshot.sceneGeneration ||
        currentOutputGeneration !== outputGeneration ||
        (currentBake !== undefined) !== pairedBake ||
        pending.get(entity)?.candidate?.candidateId !== candidateId
      )
        return err(new Error('Water collision candidate changed before native Physics admission'));
      if (pairedBake || stagedScene) {
        const marked = water.markBakedQueryGridCandidateAdmitting(
          guid,
          snapshot.sceneGeneration,
          outputGeneration,
        );
        if (!marked.ok) return err(new Error(marked.error.hint));
      }
      return ok(undefined);
    };
    const admissionGuard: Parameters<
      NonNullable<PhysicsWorld['admitDerivedShapeCandidatesGuarded']>
    >[1] = (states) => {
      const readGuardedWaterCollisionInputs = () => {
        const current = water.sceneCandidateSnapshot(guid) ?? water.snapshot(guid);
        const currentBake =
          current?.asset.type === 'river' && current.asset.collision.enabled
            ? water.bakedQueryGridCandidate(guid, current.sceneGeneration)
            : undefined;
        const currentOutputGeneration = current
          ? currentBake === undefined
            ? current.outputGenerations.collision
            : (water.bakedQueryGridCandidateOutputGeneration(guid, current.sceneGeneration) ??
              current.outputGenerations.collision)
          : undefined;
        return { current, currentBake, currentOutputGeneration };
      };
      const { current, currentBake, currentOutputGeneration } = readGuardedWaterCollisionInputs();
      if (
        !current ||
        current.sceneGeneration !== snapshot.sceneGeneration ||
        currentOutputGeneration !== outputGeneration ||
        !sameMatrixF32(worldMatrixFor(world, entity), snapshot.worldMatrixM) ||
        !waterCollisionSourceMatrixMatches(input.value.sourceTransform, snapshot.worldMatrixM) ||
        states.length !== 1
      )
        return false;
      const native = states[0];
      if (
        native === undefined ||
        native.entity !== entity ||
        native.candidateId !== candidateId ||
        native.bodyType !== expectedNativeBodyType
      )
        return false;
      if (!borrowedWaterNativePoseMatches(world, entity, borrowedBody, native)) return false;
      const validatePreviousNativeSource = () => {
        if (existing) {
          const oldSource = native.source;
          if (
            oldSource === undefined ||
            oldSource.sourceKey !== existing.sourceKey ||
            oldSource.revision !== existing.publication.revision ||
            !acceptedMotion?.ok ||
            !sameVectorF32(native.position, acceptedMotion.value.position) ||
            !sameVectorF32(native.rotation, acceptedMotion.value.rotation)
          )
            return false;
        } else if (native.source !== undefined) {
          return false;
        }

        return undefined;
      };
      const previousSourceFailure = validatePreviousNativeSource();
      if (previousSourceFailure !== undefined) return previousSourceFailure;
      return (
        (currentBake !== undefined) === pairedBake &&
        !water.sceneCandidateRequiresBakedGrid(guid, current.sceneGeneration) &&
        pending.get(entity)?.candidate?.candidateId === candidateId
      );
    };
    const admitted = guardedCollision
      ? (() => {
          const guarded = requireWaterValue(physics.admitDerivedShapeCandidatesGuarded).call(
            physics,
            [prepared.value],
            admissionGuard,
            admissionCallback,
          );
          if (!guarded.ok) return guarded;
          const first = guarded.value[0];
          return first === undefined
            ? err(new Error('Physics returned an empty guarded River admission roster'))
            : ok(first);
        })()
      : physics.admitDerivedShapeCandidate(prepared.value, admissionCallback);
    if (!admitted.ok) {
      const handleCollisionAdmissionFailure = () => {
        const cancelled = physics.cancelDerivedShapeCandidate?.(prepared.value);
        if (!cancelled?.ok) {
          pending.set(entity, {
            bodyGeneration: snapshot.sceneGeneration,
            revision: outputGeneration,
            digest: input.value.inputDigest,
            pairedBake,
            stagedScene,
            candidate: prepared.value,
            failed: true,
          });
          reportFailure('admit', cancelled?.error ?? admitted.error);
          return false;
        }
        if (pairedBake) {
          water.rejectBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
        } else if (stagedScene)
          water.releaseBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
        pending.set(entity, {
          bodyGeneration: snapshot.sceneGeneration,
          revision: outputGeneration,
          digest: input.value.inputDigest,
          pairedBake,
          stagedScene,
          failed: true,
        });
        reportFailure('admit', admitted.error);
        return false;
      };
      return handleCollisionAdmissionFailure();
    }

    const queuePairedCollisionCandidate = () => {
      if (pairedBake || stagedScene) {
        const queued = water.markBakedQueryGridCandidateQueued(
          guid,
          snapshot.sceneGeneration,
          outputGeneration,
        );
        if (!queued.ok) {
          const cancelled = cancelWaterCollisionCandidate(physics, admitted.value);
          if (!cancelled.ok) {
            pending.set(entity, {
              bodyGeneration: snapshot.sceneGeneration,
              revision: outputGeneration,
              digest: input.value.inputDigest,
              pairedBake,
              stagedScene,
              candidate: admitted.value,
              failed: true,
            });
            reportFailure('admit', cancelled.error);
            return false;
          }
          if (pairedBake)
            water.rejectBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
          else if (stagedScene)
            water.releaseBakedQueryGridCandidate(guid, snapshot.sceneGeneration, outputGeneration);
          reportFailure('admit', queued.error);
          return false;
        }
      }

      return undefined;
    };
    const queuePairedCollisionCandidateFailure = queuePairedCollisionCandidate();
    if (queuePairedCollisionCandidateFailure !== undefined)
      return queuePairedCollisionCandidateFailure;

    pending.set(entity, {
      bodyGeneration: snapshot.sceneGeneration,
      revision: outputGeneration,
      digest: input.value.inputDigest,
      pairedBake,
      stagedScene,
      candidate: admitted.value,
    });
    return false;
  };
  return publishPreparedWaterCollision(
    physics as PhysicsWorld &
      Required<Pick<PhysicsWorld, 'prepareDerivedShapeCandidate' | 'admitDerivedShapeCandidate'>>,
    snapshot,
  );
}

function ensureWaterRigidBody(
  world: World,
  guid: string,
  entity: number,
  status?: WaterSceneStatus,
): void {
  if (!world.hasResource(PhysicsWorldResource)) return;
  const bodyEntity = entity as EntityHandle;
  if (!world.hasComponent(bodyEntity, RigidBody) && !world.hasComponent(bodyEntity, Collider)) {
    const added = world.addComponent(bodyEntity, {
      component: RigidBody,
      data: { type: RigidBodyTypeValue.static },
    });
    if (!added.ok) {
      if (status)
        status.waterCollisionFailures = Object.freeze([
          ...status.waterCollisionFailures.filter((failure) => failure.entity !== entity),
          Object.freeze({
            entity,
            bodyGuid: guid,
            stage: 'prepare' as const,
            ...collisionFailureFields(added.error),
          }),
        ]);
      return;
    }
    const state = states.get(world);
    const mount = state?.bodies.get(guid);
    if (mount)
      state?.bodies.set(guid, {
        ...mount,
        ownedRigidBodyEpoch: readEntityComponentEpoch(world, bodyEntity, RigidBody),
      });
  }
}

/** Consume the latest Scene intent at the guaranteed gap between native solves. */
export function reconcileWaterSceneCollisions(
  world: World,
  water: WaterSystem,
  status?: WaterSceneStatus,
): void {
  if (fixedStepIsDeferred(world)) return;
  const state = states.get(world);
  if (!state) return;
  if (state.disposing) {
    return;
  }
  for (const [instanceId, current] of state.bodies) {
    if (current.retiring) {
      if (retireWaterCollision(world, current.entity, status, instanceId)) {
        state.bodies.delete(instanceId);
        state.geometryConsumerOutputs.delete(instanceId);
      }
      continue;
    }
    const before = water.snapshot(instanceId);
    const refreshLease = publishWaterCollision(world, water, instanceId, current.entity, status);
    const after = water.snapshot(instanceId);
    if (
      refreshLease ||
      before?.sceneGeneration !== after?.sceneGeneration ||
      before?.outputs.collision !== after?.outputs.collision
    )
      replaceSceneLease(state, water, instanceId);
  }
  reconcileRiverBakeNormalAssetLeases(world, water);
}

/** Commit the paired Bake query/native collision only after this fixed-step Physics publication. */
export function commitCompletedWaterCollisionReceipts(
  world: World,
  water: WaterSystem,
  status?: WaterSceneStatus,
): void {
  const state = states.get(world);
  const pending = pendingWaterCollision.get(world);
  if (!state || state.disposing || !pending) return;
  let physics: PhysicsWorld;
  try {
    physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
  } catch {
    return;
  }
  if (!physics.getDerivedCollisionReceipt || !physics.hasBody) return;
  const commitWaterCollisionReceiptRoster = (
    physics: PhysicsWorld & Required<Pick<PhysicsWorld, 'getDerivedCollisionReceipt' | 'hasBody'>>,
  ) => {
    for (const [guid, mount] of state.bodies) {
      if (mount.retiring) continue;
      const candidate = pending.get(mount.entity);
      if (!candidate?.candidate) continue;
      const readCompletedWaterCollisionInputs = () => {
        const snapshot = water.sceneCandidateSnapshot(guid) ?? water.snapshot(guid);
        const stagedBake =
          snapshot?.asset.type === 'river' && snapshot.asset.collision.enabled
            ? water.bakedQueryGridCandidate(guid, snapshot.sceneGeneration)
            : undefined;
        const outputGeneration = snapshot
          ? candidate.pairedBake
            ? (water.bakedQueryGridCandidateOutputGeneration(guid, snapshot.sceneGeneration) ??
              snapshot.outputGenerations.collision)
            : snapshot.outputGenerations.collision
          : undefined;
        return { snapshot, stagedBake, outputGeneration };
      };
      const readAdmissibleWaterCollisionReceipt = () => {
        const { snapshot, stagedBake, outputGeneration } = readCompletedWaterCollisionInputs();
        if (
          !snapshot ||
          snapshot.sceneGeneration !== candidate.bodyGeneration ||
          outputGeneration !== candidate.revision ||
          (candidate.stagedScene === true && !water.sceneCandidateSnapshot(guid)) ||
          (candidate.sourceKey !== undefined && candidate.sourceKey !== `water:${guid}`)
        )
          return undefined;
        const receipt = physics.getDerivedCollisionReceipt(mount.entity);
        if (
          !receipt ||
          receipt.sourceKey !== `water:${guid}` ||
          receipt.publication.revision !== candidate.revision ||
          receipt.publication.inputDigest !== candidate.digest ||
          !physics.hasBody(mount.entity)
        )
          return undefined;
        if (
          candidate.stagedScene &&
          !snapshot.asset.collision.enabled &&
          (receipt.shapes.length !== 0 || receipt.sourceTransform !== undefined)
        )
          return undefined;
        if ((candidate.pairedBake ?? false) !== (stagedBake !== undefined)) return undefined;

        return { snapshot, receipt };
      };
      const completedReceipt = readAdmissibleWaterCollisionReceipt();
      if (completedReceipt === undefined) continue;
      const { snapshot, receipt } = completedReceipt;
      const acceptCompletedCollisionOutput = () => {
        const accepted = candidate.pairedBake
          ? water.acceptBakedQueryGrid(guid, snapshot.sceneGeneration, candidate.revision, {
              generation: receipt.publication.generation,
              digest: receipt.publication.inputDigest,
            })
          : candidate.stagedScene
            ? water.acceptRiverSceneCandidate(guid, snapshot.sceneGeneration, candidate.revision, {
                generation: receipt.publication.generation,
                digest: receipt.publication.inputDigest,
              })
            : snapshot.asset.collision.enabled
              ? water.acceptOutput(guid, 'collision', candidate.revision, {
                  generation: receipt.publication.generation,
                  digest: receipt.publication.inputDigest,
                })
              : ok(true);
        return accepted;
      };
      const accepted = acceptCompletedCollisionOutput();
      const publishCompletedCollisionAcceptance = () => {
        if (!accepted.ok) {
          if (status)
            status.waterCollisionFailures = Object.freeze([
              ...status.waterCollisionFailures.filter((failure) => failure.entity !== mount.entity),
              Object.freeze({
                entity: mount.entity,
                bodyGuid: guid,
                stage: 'admit' as const,
                ...collisionFailureFields(accepted.error),
              }),
            ]);
          return true;
        }
        replaceSceneLease(state, water, guid);
        pending.delete(mount.entity);
        if (status)
          status.waterCollisionFailures = Object.freeze(
            status.waterCollisionFailures.filter((failure) => failure.entity !== mount.entity),
          );
        return false;
      };
      if (publishCompletedCollisionAcceptance()) continue;
    }
  };
  commitWaterCollisionReceiptRoster(
    physics as PhysicsWorld &
      Required<Pick<PhysicsWorld, 'getDerivedCollisionReceipt' | 'hasBody'>>,
  );
  reconcileRiverBakeNormalAssetLeases(world, water);
}

function replaceSceneLease(state: Lifecycle, water: WaterSystem, instanceId: string): void {
  const previous = state.leases.get(instanceId);
  if (previous) water.releaseSnapshot(previous);
  const admitted = water.admitSnapshot(instanceId);
  if (admitted.ok) state.leases.set(instanceId, admitted.value);
  else state.leases.delete(instanceId);
}

function riverBakePairKey(grid: WaterBakedQueryGrid | undefined): string | undefined {
  return grid?.lineage?.version === 'water-river-bake/2' ? canonicalJson(grid.lineage) : undefined;
}

function reconcileRiverBakeNormalAssetLeases(world: World, water: WaterSystem): void {
  const state = states.get(world);
  if (!state) return;
  for (const [guid, leases] of state.riverBakeNormalAssets) {
    const body = water.snapshot(guid);
    const accepted = body ? water.bakedQueryGrid(guid, body.sceneGeneration)?.grid : undefined;
    const acceptedKey = riverBakePairKey(accepted);
    const candidate = body ? water.bakedQueryGridCandidate(guid, body.sceneGeneration) : undefined;
    if (leases.candidate && acceptedKey === leases.candidate.key) {
      if (leases.accepted !== leases.candidate) leases.accepted?.snapshot.dispose();
      leases.accepted = leases.candidate;
      delete leases.candidate;
    } else if (leases.candidate) {
      if (riverBakePairKey(candidate ?? undefined) !== leases.candidate.key) {
        leases.candidate.snapshot.dispose();
        delete leases.candidate;
      }
    }
    if (leases.accepted && acceptedKey !== leases.accepted.key && candidate === undefined) {
      leases.accepted.snapshot.dispose();
      delete leases.accepted;
    }
    if (!state.bodies.has(guid) && body === undefined) {
      leases.accepted?.snapshot.dispose();
      leases.candidate?.snapshot.dispose();
      state.riverBakeNormalAssets.delete(guid);
    } else if (!leases.accepted && !leases.candidate) {
      state.riverBakeNormalAssets.delete(guid);
    }
  }
}

/** Publish a decoded /2 pair while Runtime holds its exact normal Asset version through admission. */
export function publishWaterRiverBake(
  world: World,
  guid: string,
  bodyGeneration: number,
  grid: WaterBakedQueryGrid,
  normalTextureHandle: AssetHandle<'texture'>,
): Result<void, AssetError | WaterError> {
  const state = states.get(world);
  const assets = state?.assetRegistry;
  if (!state || state.disposing || !assets)
    return err({
      code: 'missing-dependency',
      expected: 'the active Water Scene Runtime with its AssetRegistry owner',
      hint: 'install waterScenePlugin and publish the paired River Bake through this Runtime boundary',
      detail: { guid, bodyGeneration },
    });
  const lineage = grid.lineage;
  if (lineage?.version !== 'water-river-bake/2')
    return err({
      code: 'query-data-unavailable',
      expected: 'a decoded /2 River Bake with exact solver-normal texture identity',
      hint: 'decode the complete grid and solver-normal pair before Runtime publication',
      detail: { guid, bodyGeneration, lineageVersion: lineage?.version },
    });
  const captured = assets.snapshot(normalTextureHandle);
  if (!captured.ok) return captured;
  const snapshot = captured.value;
  const revision = snapshot.version(normalTextureHandle);
  const loadedGuid = assets.guidOf(normalTextureHandle);
  const texture = snapshot.read<Asset>(normalTextureHandle);
  if (
    !revision.ok ||
    revision.value !== lineage.normalTextureRevision ||
    loadedGuid?.toLowerCase() !== lineage.normalTextureGuid.toLowerCase() ||
    !texture.ok ||
    texture.value.kind !== 'texture'
  ) {
    snapshot.dispose();
    return err({
      code: 'query-data-unavailable',
      expected: 'the exact loaded solver-normal GUID and revision decoded into this /2 pair',
      hint: 'retry from a Runtime Asset snapshot whose version still matches the captured Bake pair',
      detail: {
        guid,
        bodyGeneration,
        normalTextureGuid: lineage.normalTextureGuid,
        expectedRevision: lineage.normalTextureRevision,
        actualGuid: loadedGuid,
        actualRevision: revision.ok ? revision.value : undefined,
        assetKind: texture.ok ? texture.value.kind : undefined,
      },
    });
  }
  let water: WaterSystem;
  try {
    water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  } catch {
    snapshot.dispose();
    return err({
      code: 'missing-dependency',
      expected: 'the active WaterSystem resource installed by waterScenePlugin',
      hint: 'publish the River Bake only while its Water Scene is mounted',
      detail: { guid, bodyGeneration },
    });
  }
  const published = water.publishBakedQueryGrid(guid, bodyGeneration, {
    kind: 'durable-pack',
    enabled: true,
    componentValid: true,
    dataValid: true,
    grid,
  });
  if (!published.ok) {
    snapshot.dispose();
    return published;
  }
  const key = canonicalJson(lineage);
  const lease: RiverBakeNormalAssetLease = Object.freeze({
    key,
    handle: normalTextureHandle,
    guid: lineage.normalTextureGuid,
    revision: lineage.normalTextureRevision,
    snapshot,
  });
  const leases = state.riverBakeNormalAssets.get(guid) ?? {};
  if (leases.accepted?.key === key || leases.candidate?.key === key) {
    snapshot.dispose();
  } else {
    leases.candidate?.snapshot.dispose();
    leases.candidate = lease;
    state.riverBakeNormalAssets.set(guid, leases);
  }
  reconcileRiverBakeNormalAssetLeases(world, water);
  return published;
}

export type WaterSceneRiverBakeNormalTexture = Readonly<{
  guid: string;
  handle: AssetHandle<'texture'>;
  revision: number;
  texture: TextureAsset;
}>;

/** Read the exact accepted solver-normal version retained by the Water Scene Runtime. */
export function waterSceneRiverBakeNormalTexture(
  world: World,
  entity: number,
): WaterSceneRiverBakeNormalTexture | undefined {
  const state = states.get(world);
  const guid = `scene-entity:${entity}`;
  const lease = state?.riverBakeNormalAssets.get(guid)?.accepted;
  if (!state || !lease || state.disposing) return undefined;
  let water: WaterSystem;
  try {
    water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  } catch {
    return undefined;
  }
  const body = water.snapshot(guid);
  const accepted = body ? water.bakedQueryGrid(guid, body.sceneGeneration)?.grid : undefined;
  if (riverBakePairKey(accepted) !== lease.key) return undefined;
  const revision = lease.snapshot.version(lease.handle);
  const texture = lease.snapshot.read<Asset>(lease.handle);
  if (
    !revision.ok ||
    revision.value !== lease.revision ||
    !texture.ok ||
    texture.value.kind !== 'texture'
  )
    return undefined;
  return Object.freeze({
    guid: lease.guid,
    handle: lease.handle,
    revision: lease.revision,
    texture: texture.value,
  });
}

export function waterSceneSnapshot(world: World, entity: number): WaterBodySnapshot | undefined {
  return states.get(world)?.leases.get(`scene-entity:${entity}`)?.snapshot;
}

/** Resolve the accepted Live or paired /2 Baked River source for one mounted Body. */
export function waterSceneWaterSurfaceSource(
  world: World,
  bodyGuid: string,
  source: 'live' | 'baked',
  sourceRecipeGuid?: string,
): WaterSurfaceSourceDescriptor | undefined {
  if (bodyGuid.length === 0 || !world.hasResource(WATER_SYSTEM_RESOURCE)) return undefined;
  return world
    .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    .waterSurfaceSource(bodyGuid, world.identity, source, sourceRecipeGuid);
}

export type WaterSceneWaterInfoMesh = Readonly<{ guid: string; version: string; mesh: MeshAsset }>;

export type WaterSceneWaterInfoGeometry = Readonly<{
  bodyEntity: number;
  bodyGuid: string;
  sourceAssetGuid: string;
  bodyTransformM: readonly number[];
  geometryGeneration: number;
  geometryReceipt: NonNullable<WaterBodySnapshot['outputReceipts']['geometry']>;
  undilated: WaterSceneWaterInfoMesh;
  dilated?: WaterSceneWaterInfoMesh;
}>;

/** Resolve the accepted R1 WaterInfo geometry closure for a Body Scene instance. */
export function waterSceneWaterInfoGeometry(
  world: World,
  entity: number,
): WaterSceneWaterInfoGeometry | undefined {
  if (!world.hasResource(WATER_SYSTEM_RESOURCE)) return undefined;
  const snapshot = world
    .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    .snapshot(`scene-entity:${entity}`);
  const receipt = snapshot?.outputReceipts.geometry;
  if (
    !snapshot ||
    snapshot.dirty.has('geometry') ||
    snapshot.outputs.geometry !== 'ready' ||
    !receipt ||
    receipt.outputGeneration !== snapshot.outputGenerations.geometry ||
    !snapshot.asset.flags.affectsWaterInfo ||
    !snapshot.asset.waterInfoMeshGuid
  )
    return undefined;
  const resolveMesh = (
    guid: string,
    field: 'waterInfoMeshGuid' | 'dilatedWaterInfoMeshGuid',
  ): WaterSceneWaterInfoMesh | undefined => {
    const dependency = snapshot.dependencies.find(
      (item) =>
        item.kind === 'mesh' &&
        item.field === field &&
        item.guid.toLowerCase() === guid.toLowerCase(),
    );
    const version = waterDependencyRevision(dependency);
    if (
      dependency?.status !== 'valid' ||
      version === undefined ||
      typeof dependency.payload !== 'object' ||
      dependency.payload === null ||
      (dependency.payload as Asset).kind !== 'mesh'
    )
      return undefined;
    return Object.freeze({ guid, version, mesh: dependency.payload as MeshAsset });
  };
  const undilated = resolveMesh(snapshot.asset.waterInfoMeshGuid, 'waterInfoMeshGuid');
  if (!undilated) return undefined;
  let dilated: WaterSceneWaterInfoMesh | undefined;
  if (snapshot.asset.dilatedWaterInfoMeshGuid) {
    dilated = resolveMesh(snapshot.asset.dilatedWaterInfoMeshGuid, 'dilatedWaterInfoMeshGuid');
    if (!dilated) return undefined;
  }
  return Object.freeze({
    bodyEntity: entity,
    bodyGuid: snapshot.guid,
    sourceAssetGuid: snapshot.sourceAssetGuid,
    bodyTransformM: Object.freeze([...snapshot.worldMatrixM]),
    geometryGeneration: receipt.outputGeneration,
    geometryReceipt: Object.freeze({ ...receipt }),
    undilated,
    ...(dilated ? { dilated } : {}),
  });
}

/** Build the current Zone-generation CPU tile view; returned MeshAssets enter the generic Renderer mesh draw path. */
export function waterSceneBuildMeshView(
  world: World,
  zoneEntity: number,
  view: WaterMeshViewInput,
): Result<WaterZoneMeshPublication, WaterError> {
  const state = states.get(world);
  if (!state || !world.hasResource(WATER_SYSTEM_RESOURCE))
    return err({
      code: 'missing-dependency',
      expected: 'a live waterScenePlugin and WaterSystem resource',
      hint: 'install waterScenePlugin before building Zone CPU WaterMesh views',
    });
  const instanceId = `scene-entity:${zoneEntity}`;
  const live = state.zoneEntities.get(instanceId);
  if (!live?.asset)
    return err({
      code: 'zone-unbound',
      expected: 'a live WaterZoneInstance with an accepted Zone payload',
      hint: 'mount the Zone before requesting its CPU tile view',
    });
  const observe = currentWaterProfileObserver(world);
  return world
    .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    .buildZoneMeshView(live.guid, live.generation, live.asset, view, observe);
}

/** Accepted Zone identity and transform for renderer-owned per-view extraction. */
export function waterSceneZoneSnapshot(world: World, zoneGuid: string) {
  const state = states.get(world);
  const zone = state?.zones.get(zoneGuid);
  const instance =
    zone &&
    [...(state?.zoneEntities.values() ?? [])].find(
      (candidate) =>
        candidate.guid === zoneGuid && candidate.generation === zone.generation && candidate.asset,
    );
  if (!zone || !instance?.asset) return undefined;
  return Object.freeze({
    guid: zoneGuid,
    sourceRevision: instance.version,
    generation: zone.generation,
    worldMatrixM: Object.freeze([...zone.worldMatrixM]),
    asset: instance.asset,
  });
}

/** Build all accepted live Zones for one renderer view, preserving each Zone publication. */
export function waterSceneBuildMeshViews(
  world: World,
  view: WaterMeshViewInput,
): readonly WaterZoneMeshPublication[] {
  const state = states.get(world);
  if (!state || !world.hasResource(WATER_SYSTEM_RESOURCE)) return Object.freeze([]);
  const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const observe = currentWaterProfileObserver(world);
  const publications: WaterZoneMeshPublication[] = [];
  for (const [zoneGuid, zone] of state.zones) {
    const instance = [...state.zoneEntities.values()].find(
      (candidate) =>
        candidate.guid === zoneGuid && candidate.generation === zone.generation && candidate.asset,
    );
    if (!instance?.asset) continue;
    const result = system.buildZoneMeshView(
      zoneGuid,
      zone.generation,
      instance.asset,
      view,
      observe,
    );
    if (result.ok) publications.push(result.value);
  }
  return Object.freeze(publications);
}

/** Read the most recent accepted CPU tile view for a Zone and renderer view identity. */
export function waterSceneMeshView(
  world: World,
  zoneGuid: string,
  viewId: string,
): WaterZoneMeshPublication | undefined {
  if (!world.hasResource(WATER_SYSTEM_RESOURCE)) return undefined;
  return world
    .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    .zoneMeshView(zoneGuid, viewId, currentWaterProfileObserver(world));
}

/** Zone-owned Landscape input state for WaterInfo ground capture. */
export function waterSceneZoneGround(world: World, zoneGuid: string) {
  if (!world.hasResource(WATER_SYSTEM_RESOURCE))
    return err({
      code: 'missing-dependency',
      expected: 'a live WaterSystem resource',
      hint: 'install waterScenePlugin before reading Zone ground input',
    } satisfies WaterError);
  return ok(
    world
      .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
      .zoneGroundSnapshot(zoneGuid, currentWaterProfileObserver(world)),
  );
}

export function invalidateWaterSceneZoneGround(
  world: World,
  zoneGuid: string,
  zoneGeneration: number,
) {
  if (!world.hasResource(WATER_SYSTEM_RESOURCE))
    return err({
      code: 'missing-dependency',
      expected: 'a live WaterSystem resource',
      hint: 'install waterScenePlugin before invalidating Zone ground input',
    } satisfies WaterError);
  return world
    .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    .invalidateZoneGround(zoneGuid, zoneGeneration, currentWaterProfileObserver(world));
}

export function acceptWaterSceneZoneGround(world: World, zoneGuid: string, generation: number) {
  if (!world.hasResource(WATER_SYSTEM_RESOURCE))
    return err({
      code: 'missing-dependency',
      expected: 'a live WaterSystem resource',
      hint: 'install waterScenePlugin before accepting Zone ground input',
    } satisfies WaterError);
  return world
    .getResource<WaterSystem>(WATER_SYSTEM_RESOURCE)
    .acceptZoneGround(zoneGuid, generation);
}

function replaceStatusValues(
  current: readonly string[],
  next: readonly string[],
): readonly string[] {
  if (current.length === next.length && current.every((value, index) => value === next[index]))
    return current;
  return Object.freeze([...next]);
}

function replaceRecookStatus(
  current: readonly WaterSceneGeometryRecookRequired[],
  next: readonly WaterSceneGeometryRecookRequired[],
): readonly WaterSceneGeometryRecookRequired[] {
  if (
    current.length === next.length &&
    current.every(
      (value, index) =>
        value.entity === next[index]?.entity && value.bodyGuid === next[index]?.bodyGuid,
    )
  )
    return current;
  return Object.freeze(next.map((value) => Object.freeze(value)));
}

export function reconcileWaterScene(
  world: World,
  assets: WaterSceneAssetAccess,
  water: WaterSystem,
  status?: WaterSceneStatus,
  readWorldMatrix: (entity: number) => readonly number[] = (entity) =>
    worldMatrixFor(world, entity),
): void {
  const state = states.get(world);
  if (!state) return;
  const previousZones = new Map(state.zones);
  const seenZoneEntities = new Set<string>();
  const invalidZoneTransforms = new Set<string>();
  const nextZoneEntities = new Map(state.zoneEntities);
  const zoneOwners = new Map<string, string[]>();
  const zoneCandidates: {
    readonly instanceId: string;
    readonly entity: number;
    readonly handle: AssetHandle<'water-zone'>;
    readonly guid: string;
  }[] = [];
  const collectZoneCandidates = () => {
    for (const span of world
      .query({ read: [WaterZoneInstance] })
      .unwrap()
      .spans()
      .unwrap()) {
      const entities = span.entities;
      const zones = span.get(WaterZoneInstance).zone;
      for (let index = 0; index < span.length; index++) {
        const entity = entities[index] as EntityHandle;
        const instanceId = `scene-entity:${entity}`;
        seenZoneEntities.add(instanceId);
        const handle = zones.get(index) as AssetHandle<'water-zone'>;
        const guid = assets.sourceGuid(handle);
        if (!guid) continue;
        zoneCandidates.push({ instanceId, entity, handle, guid });
        const owners = zoneOwners.get(guid) ?? [];
        owners.push(instanceId);
        zoneOwners.set(guid, owners);
      }
    }
  };
  collectZoneCandidates();
  const duplicateZoneAssetGuids = [...zoneOwners]
    .filter(([, entities]) => entities.length > 1)
    .map(([guid]) => guid)
    .sort();
  const duplicates = new Set(duplicateZoneAssetGuids);
  const captureZoneVersions = (state: Lifecycle) => {
    for (const { instanceId, entity, handle, guid } of zoneCandidates) {
      if (duplicates.has(guid)) continue;
      const version = assets.version(handle);
      if (version === undefined) continue;
      const worldMatrixM = readWorldMatrix(entity);
      if (!validMatrix(worldMatrixM)) {
        invalidZoneTransforms.add(instanceId);
        continue;
      }
      const previous = state.zoneVersions.get(guid);
      const unchanged =
        state.zones.has(guid) &&
        previous?.handle === handle &&
        previous?.version === version &&
        sameMatrix(previous.worldMatrixM, worldMatrixM);
      const generation =
        previous && unchanged ? previous.generation : (previous?.generation ?? 0) + 1;
      const candidate = waterSceneAssetSnapshot(state, assets, handle, guid, version, 'water-zone');
      if (candidate === undefined) continue;
      if (!unchanged) state.zoneVersions.set(guid, { handle, version, generation, worldMatrixM });
      nextZoneEntities.set(instanceId, {
        handle,
        guid,
        generation,
        version,
        worldMatrixM,
        asset: candidate.payload as WaterZoneAsset,
      });
    }
  };
  captureZoneVersions(state);
  const publishZoneEntities = (state: Lifecycle) => {
    for (const [instanceId, zone] of nextZoneEntities)
      if (duplicates.has(zone.guid)) nextZoneEntities.delete(instanceId);
    if (status)
      status.duplicateZoneAssetGuids = replaceStatusValues(
        status.duplicateZoneAssetGuids,
        duplicateZoneAssetGuids,
      );
    if (status)
      status.invalidZoneTransforms = replaceStatusValues(
        status.invalidZoneTransforms,
        [...invalidZoneTransforms].sort(),
      );
    for (const instanceId of nextZoneEntities.keys())
      if (!seenZoneEntities.has(instanceId)) nextZoneEntities.delete(instanceId);
    state.zoneEntities.clear();
    for (const [instanceId, zone] of nextZoneEntities) state.zoneEntities.set(instanceId, zone);
    state.zones.clear();
    for (const zone of nextZoneEntities.values())
      if (!duplicates.has(zone.guid))
        state.zones.set(zone.guid, {
          handle: zone.handle,
          generation: zone.generation,
          version: zone.version,
          worldMatrixM: zone.worldMatrixM,
        });
  };
  publishZoneEntities(state);
  const changedZoneGuids = new Set<string>();
  const collectChangedZoneGuids = (state: Lifecycle) => {
    for (const guid of new Set([...previousZones.keys(), ...state.zones.keys()])) {
      const before = previousZones.get(guid);
      const after = state.zones.get(guid);
      if (
        !before ||
        !after ||
        before.generation !== after.generation ||
        !sameMatrix(before.worldMatrixM, after.worldMatrixM)
      )
        changedZoneGuids.add(guid);
    }
  };
  collectChangedZoneGuids(state);
  const zoneBounds = new Map<string, { minM: [number, number]; maxM: [number, number] }>();
  const captureZoneBounds = (state: Lifecycle) => {
    for (const zone of state.zoneEntities.values()) {
      const acceptedZone = state.zones.get(zone.guid);
      if (!zone.asset || acceptedZone?.generation !== zone.generation) continue;
      const extent = zone.asset.extentM;
      const bounds = transformedXZBounds(
        zone.worldMatrixM,
        -extent.spanXM / 2,
        -extent.spanZM / 2,
        extent.spanXM / 2,
        extent.spanZM / 2,
      );
      if (bounds) zoneBounds.set(zone.guid, bounds);
    }
  };
  captureZoneBounds(state);
  const terrainProviderRows = world.query({ read: [WaterTerrainProvider] }).unwrap();
  const terrainProviderChanges = state.terrainProviderProjection.read();
  for (const index of terrainProviderChanges.indices) {
    const entity = state.terrainProviderProjection.entity(index);
    const handle =
      entity === undefined
        ? undefined
        : world[worldRead].getFieldValue(entity as EntityHandle, WaterTerrainProvider, 'terrain');
    trackTerrainProviderHandle(state, index, entity, handle as AssetHandle<'terrain'> | undefined);
  }
  terrainProviderChanges.accept();
  const terrainCandidates: WaterZoneTerrainProviderInput[] = [];
  const pendingTerrainEntities = new Set<number>();
  const collectTerrainCandidates = (state: Lifecycle) => {
    for (const span of terrainProviderRows.spans().unwrap()) {
      const entities = span.entities;
      const terrains = span.get(WaterTerrainProvider).terrain;
      for (let index = 0; index < span.length; index++) {
        const entity = entities[index] as EntityHandle;
        const provider = { terrain: terrains.get(index) as AssetHandle<'terrain'> };
        const terrainGuid = assets.sourceGuid(provider.terrain);
        const terrainVersion = assets.version(provider.terrain);
        const matrix = readWorldMatrix(entity);
        if (!terrainGuid || terrainVersion === undefined) {
          pendingTerrainEntities.add(entity);
          continue;
        }
        const candidate = waterSceneAssetSnapshot(
          state,
          assets,
          provider.terrain,
          terrainGuid,
          terrainVersion,
          'terrain',
        );
        if (
          candidate === undefined ||
          !terrainTranslationValid(candidate.payload as TerrainAsset, matrix)
        ) {
          pendingTerrainEntities.add(entity);
          continue;
        }
        const terrain = candidate.payload as TerrainAsset;
        const bounds = transformedXZBounds(
          matrix,
          0,
          0,
          (terrain.columns - 1) * terrain.spacing,
          (terrain.rows - 1) * terrain.spacing,
        );
        if (!bounds) {
          pendingTerrainEntities.add(entity);
          continue;
        }
        terrainCandidates.push({
          entity: entity,
          terrainGuid,
          terrainVersion,
          worldMatrixM: matrix,
          boundsXZ: bounds,
          terrainAsset: terrain,
        });
      }
    }
  };
  collectTerrainCandidates(state);
  const providersByZone = intersectWaterTerrainProvidersWithZones(
    [...zoneBounds].map(([guid, boundsXZ]) => ({ guid, boundsXZ })),
    terrainCandidates,
  );
  const pendingZoneGuids = new Set<string>();
  // An unreadable revision has no trustworthy bounds. The previous accepted
  // roster cannot rule out new overlaps after a move or footprint expansion.
  if (pendingTerrainEntities.size > 0)
    for (const zoneGuid of state.zones.keys()) pendingZoneGuids.add(zoneGuid);
  const reconcileSceneZoneGroundAndRetirement = (state: Lifecycle) => {
    for (const [zoneGuid, zone] of state.zones) {
      if (pendingZoneGuids.has(zoneGuid)) {
        water.markZoneGroundInputsPending(zoneGuid, zone.generation);
      } else {
        water.reconcileZoneGroundInputs(
          zoneGuid,
          zone.generation,
          providersByZone.get(zoneGuid) ?? [],
        );
      }
    }
    for (const [zoneGuid, previous] of previousZones) {
      const current = state.zones.get(zoneGuid);
      if (!current || current.handle !== previous.handle)
        retireAssetSnapshot(state, previous.handle, 'water-zone');
      if (!current) {
        water.unobserveZoneGround(zoneGuid);
        water.retireWaterMeshZone(zoneGuid);
      }
    }
  };
  reconcileSceneZoneGroundAndRetirement(state);

  const seenBodyInstances = new Set<string>();
  const invalidBodyTransforms = new Set<string>();
  const invalidExclusionTransforms = new Set<string>();
  const invalidExclusionBodyEntities = new Set<string>();
  const unsupportedCustomParticipation = new Set<string>();
  const waterGeometryRecookRequired: WaterSceneGeometryRecookRequired[] = [];
  const materialAdmissionFailures: WaterSceneDependencyFailure[] = [];
  const recordMaterialAdmissionFailure = (bodyGuid: string, error: WaterError) => {
    if (error.code !== 'query-data-unavailable') return;
    const detail = error.detail as { materialGuid?: unknown } | undefined;
    materialAdmissionFailures.push(
      Object.freeze({
        guid: typeof detail?.materialGuid === 'string' ? detail.materialGuid : bodyGuid,
        kind: 'material',
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: { bodyGuid, cause: error.detail },
      }),
    );
  };
  const desired = new Map<
    string,
    {
      entity: number;
      handle: AssetHandle<'water-body'>;
      assetSnapshot: WaterSceneAssetSnapshot;
      sourceAssetGuid: string;
      version: number;
      payload: WaterBodyAsset;
      worldMatrixM: readonly number[];
      queryParts?: readonly Float32Array[] | null;
      exclusionVolumes: WaterExclusionVolumeSnapshot[];
      dependencies: readonly WaterDependencySnapshot[];
      sourcePublication?: WaterBodySnapshot['sourcePublication'];
    }
  >();
  const collectDesiredBodies = (state: Lifecycle) => {
    for (const span of world
      .query({ read: [WaterBodyInstance] })
      .unwrap()
      .spans()
      .unwrap()) {
      const entities = span.entities;
      const bodies = span.get(WaterBodyInstance).body;
      for (let index = 0; index < span.length; index++) {
        const entity = entities[index] as EntityHandle;
        const instanceId = `scene-entity:${entity}`;
        seenBodyInstances.add(instanceId);
        const handle = bodies.get(index) as AssetHandle<'water-body'>;
        const guid = assets.sourceGuid(handle);
        const version = assets.version(handle);
        if (!guid || version === undefined) continue;
        const candidate = waterSceneAssetSnapshot(
          state,
          assets,
          handle,
          guid,
          version,
          'water-body',
          false,
        );
        if (candidate === undefined) continue;
        if (candidate.payload.kind !== 'water-body') continue;
        const payload = candidate.payload;
        const customWaterInfoSupported =
          payload.type === 'custom' &&
          payload.flags.affectsWaterInfo &&
          !!payload.customMeshOverrideGuid &&
          !!payload.waterInfoMeshGuid;
        if (
          payload.type === 'custom' &&
          payload.flags.affectsWaterInfo &&
          !customWaterInfoSupported
        )
          unsupportedCustomParticipation.add(instanceId);
        const worldMatrixM = readWorldMatrix(entity);
        if (!validMatrix(worldMatrixM)) {
          invalidBodyTransforms.add(instanceId);
          continue;
        }
        const waterBody = payload;
        const inspectGeometryTransform = () => {
          const geometryTransformMatches =
            waterBody.type === 'river'
              ? sameSplineMetric(
                  waterBody.geometryAuthoringWorldMatrixM ?? IDENTITY_MATRIX,
                  worldMatrixM,
                )
              : waterBody.geometryAuthoringWorldMatrixM &&
                (waterBody.type === 'lake'
                  ? sameMatrixBasisF32(waterBody.geometryAuthoringWorldMatrixM, worldMatrixM)
                  : sameMatrixF32(waterBody.geometryAuthoringWorldMatrixM, worldMatrixM));
          return geometryTransformMatches;
        };
        const geometryTransformMatches = inspectGeometryTransform();
        if (
          (waterBody.type === 'river' ||
            ((waterBody.type === 'lake' ||
              (waterBody.type === 'ocean' && waterBody.centerOnWaterZone !== false)) &&
              waterBody.geometryAuthoringWorldMatrixM)) &&
          !geometryTransformMatches
        ) {
          waterGeometryRecookRequired.push({
            entity: entity,
            bodyGuid: guid,
            code: 'requires-recook',
            expected:
              'Scene Body world transform matches the transform used for world-dependent Water geometry cooking',
            hint: 'recook the WaterBody with its current authoring world transform before accepting visible geometry at this placement',
          });
          continue;
        }
        desired.set(instanceId, {
          entity: entity,
          handle,
          assetSnapshot: candidate,
          sourceAssetGuid: guid,
          version,
          payload: waterBody,
          worldMatrixM,
          exclusionVolumes: [],
          dependencies: collectWaterDependencies(waterBody, assets),
          sourcePublication: candidate.sourcePublication,
        });
      }
    }
  };
  collectDesiredBodies(state);
  assets.syncWaterGeometryMeshes?.(
    [
      ...new Set(
        [...desired.values()].flatMap(
          (target) =>
            waterGeometryMeshReferences(target.payload)?.map((reference) => reference.guid) ?? [],
        ),
      ),
    ].sort(),
  );
  const fluidRecipeDependencies: { guid: string; kind: 'texture' | 'gpu-texture' }[] = [];
  for (const span of world
    .query({ read: [WaterFluidSimulation] })
    .unwrap()
    .spans()
    .unwrap()) {
    const recipes = span.get(WaterFluidSimulation).recipe;
    for (let index = 0; index < span.length; index++) {
      const recipe = assets.read(recipes.get(index) as AssetHandle<'water-simulation-recipe'>);
      if (recipe?.kind === 'water-simulation-recipe' && recipe.system === 'fluid-simulation')
        fluidRecipeDependencies.push({
          guid: recipe.impulseNoiseGuid,
          kind: impulseNoiseKind(assets, recipe.impulseNoiseGuid),
        });
    }
  }
  assets.syncBodyDependencies?.(
    [
      ...new Map(
        [
          ...[...desired.values()].flatMap((target) => target.dependencies),
          ...[...nextZoneEntities.values()].flatMap(({ asset }) =>
            collectWaterReferenceDependencies(
              asset?.farMaterialGuid === undefined
                ? []
                : [{ guid: asset.farMaterialGuid, kind: 'material', field: 'farMaterialGuid' }],
              assets,
            ),
          ),
          ...fluidRecipeDependencies,
        ]
          .filter((dependency) => dependency.kind !== 'mesh')
          .map(
            (dependency) =>
              [
                `${dependency.kind.toLowerCase()}\u0000${dependency.guid.toLowerCase()}`,
                dependency,
              ] as const,
          ),
      ).values(),
    ].map(({ guid, kind }) => ({ guid, kind })),
  );
  const liveQueryGeometryKeys = new Set(
    [...desired.values()].map((target) => `${target.sourceAssetGuid}:${target.version}`),
  );
  for (const key of state.queryPrismParts.keys())
    if (!liveQueryGeometryKeys.has(key)) state.queryPrismParts.delete(key);
  for (const target of desired.values()) cacheWaterQueryPrismParts(world, target);

  const liveBodyEntities = new Set([...desired.values()].map((target) => target.entity));
  const collectBodyExclusions = () => {
    for (const span of world
      .query({ read: [WaterExclusionVolume] })
      .unwrap()
      .spans()
      .unwrap()) {
      const entities = span.entities;
      const modes = span.get(WaterExclusionVolume).mode;
      for (let index = 0; index < span.length; index++) {
        const entity = entities[index] as EntityHandle;
        const instanceId = `scene-entity:${entity}`;
        const component = world.get(entity, WaterExclusionVolume).unwrap();
        const worldMatrixM = readWorldMatrix(entity);
        const mode = modes[index];
        const waterBodies = Array.from(component.waterBodies);
        if (
          !validMatrix(worldMatrixM) ||
          component.centerM.length !== 3 ||
          !Array.from(component.centerM).every(Number.isFinite) ||
          component.halfExtentsM.length !== 3 ||
          !Array.from(component.halfExtentsM).every(
            (value) => Number.isFinite(value) && value > 0,
          ) ||
          (mode !== WaterExclusionMode.addListedBodiesToExclusion &&
            mode !== WaterExclusionMode.removeListedBodiesFromExclusion)
        ) {
          invalidExclusionTransforms.add(instanceId);
          continue;
        }
        for (const bodyEntity of waterBodies)
          if (!liveBodyEntities.has(bodyEntity))
            invalidExclusionBodyEntities.add(`${instanceId}->scene-entity:${bodyEntity}`);
        const centerM = Array.from(component.centerM) as [number, number, number];
        const halfExtentsM = Array.from(component.halfExtentsM) as [number, number, number];
        const exclusionWorldMatrixM = Array.from(worldMatrixM);
        for (const target of desired.values()) {
          const listed = waterBodies.includes(target.entity);
          const excludes =
            mode === WaterExclusionMode.addListedBodiesToExclusion ? listed : !listed;
          if (
            excludes &&
            waterExclusionIntersectsSceneBody(
              world,
              target,
              centerM,
              halfExtentsM,
              exclusionWorldMatrixM,
            )
          )
            target.exclusionVolumes.push({
              entity: entity,
              centerM,
              halfExtentsM,
              worldMatrixM: exclusionWorldMatrixM,
            });
        }
      }
    }
  };
  collectBodyExclusions();
  const reconcileDesiredSceneBodies = (state: Lifecycle) => {
    for (const [instanceId, target] of desired) {
      const current = state.bodies.get(instanceId);
      if (current?.retiring) continue;
      if (waterCollisionAdmissionIsInFlight(world, water, instanceId, target.entity)) continue;
      let leaseUpdated = false;
      const activeSnapshot = water.snapshot(instanceId);
      const stagedSceneCandidate = water.sceneCandidateSnapshot(instanceId);
      const nativeSourceOwned = waterNativeSourceAttached(world, instanceId, target.entity);
      if (
        current &&
        stagedSceneCandidate?.sourceVersion === String(target.version) &&
        stagedSceneCandidate.sourceAssetGuid === target.sourceAssetGuid &&
        sameMatrixF32(stagedSceneCandidate.worldMatrixM, target.worldMatrixM) &&
        canonicalJson(stagedSceneCandidate.dependencies) === canonicalJson(target.dependencies)
      ) {
        state.bodies.set(instanceId, {
          ...current,
          entity: target.entity,
          sourceAssetGuid: target.sourceAssetGuid,
          version: target.version,
          dependencies: target.dependencies,
        });
        continue;
      }
      const stageOwnedRiverReplacement = () => {
        const nativeSourceOwnedRiver =
          current !== undefined &&
          activeSnapshot?.asset.type === 'river' &&
          activeSnapshot.asset.collision.enabled &&
          nativeSourceOwned;
        if (current && nativeSourceOwnedRiver && target.payload.type !== 'river') {
          const refusal: WaterError = {
            code: 'invalid-source',
            expected:
              'the accepted source-owned River remains active until its exact empty static Native retirement is published',
            hint: 'remove the River Scene instance, wait for Native source retirement, then mount the replacement source',
            detail: {
              sourceOwnershipExit: true,
              guid: instanceId,
              acceptedSourceAssetGuid: activeSnapshot.sourceAssetGuid,
              requestedSourceAssetGuid: target.sourceAssetGuid,
              acceptedSourceVersion: activeSnapshot.sourceVersion,
              requestedSourceVersion: String(target.version),
              requestedType: target.payload.type,
              requestedCollisionEnabled: target.payload.collision.enabled,
            },
          };
          if (status)
            status.waterCollisionFailures = Object.freeze([
              ...status.waterCollisionFailures.filter(
                (failure) => failure.entity !== target.entity,
              ),
              Object.freeze({
                entity: target.entity,
                bodyGuid: instanceId,
                stage: 'cook' as const,
                ...collisionFailureFields(refusal),
              }),
            ]);
          return true;
        }
        const inspectGuardedRiverReplacement = () => {
          return (
            current !== undefined &&
            target.payload.type === 'river' &&
            ((nativeSourceOwnedRiver &&
              (current.sourceAssetGuid !== target.sourceAssetGuid ||
                activeSnapshot.sourceAssetGuid !== target.sourceAssetGuid ||
                !sameMatrixF32(activeSnapshot.worldMatrixM, target.worldMatrixM) ||
                canonicalJson(activeSnapshot.asset.collision) !==
                  canonicalJson(target.payload.collision) ||
                activeSnapshot.asset.geometrySnapshot?.collisionDescriptor?.digest !==
                  target.payload.geometrySnapshot?.collisionDescriptor?.digest)) ||
              (activeSnapshot?.asset.type === 'river' &&
                activeSnapshot.outputReceipts.collision !== undefined &&
                (current.sourceAssetGuid !== target.sourceAssetGuid ||
                  !sameMatrixF32(activeSnapshot.worldMatrixM, target.worldMatrixM) ||
                  canonicalJson(activeSnapshot.asset.collision) !==
                    canonicalJson(target.payload.collision) ||
                  activeSnapshot.asset.geometrySnapshot?.collisionDescriptor?.digest !==
                    target.payload.geometrySnapshot?.collisionDescriptor?.digest)) ||
              (activeSnapshot?.asset.type === 'river' &&
                !activeSnapshot.asset.collision.enabled &&
                target.payload.collision.enabled &&
                waterNativeCollisionRetired(world, instanceId, target.entity)))
          );
        };
        const guardedRiverSourceReplacement = inspectGuardedRiverReplacement();
        if (current && guardedRiverSourceReplacement) {
          const staged = water.stageRiverReload(
            instanceId,
            String(target.version),
            target.payload,
            target.sourceAssetGuid,
            target.worldMatrixM,
            target.exclusionVolumes,
            target.dependencies,
            target.sourcePublication,
          );
          if (staged.ok) {
            state.bodies.set(instanceId, {
              ...current,
              entity: target.entity,
              sourceAssetGuid: target.sourceAssetGuid,
              version: target.version,
              dependencies: target.dependencies,
            });
            return true;
          }
          if (status)
            status.waterCollisionFailures = Object.freeze([
              ...status.waterCollisionFailures.filter(
                (failure) => failure.entity !== target.entity,
              ),
              Object.freeze({
                entity: target.entity,
                bodyGuid: instanceId,
                stage: 'cook' as const,
                ...collisionFailureFields(staged.error),
              }),
            ]);
          return true;
        }
        return false;
      };
      if (stageOwnedRiverReplacement()) continue;
      const updateSceneBodySource = () => {
        if (
          !current ||
          current.handle !== target.handle ||
          current.version !== target.version ||
          current.sourceAssetGuid !== target.sourceAssetGuid
        ) {
          const mounted = current
            ? water.hotReloadBody(
                instanceId,
                String(target.version),
                target.payload,
                target.sourceAssetGuid,
                target.worldMatrixM,
                target.sourcePublication,
              )
            : water.mountBody(
                instanceId,
                String(target.version),
                target.payload,
                target.sourceAssetGuid,
                target.worldMatrixM,
                target.sourcePublication,
                Number(target.entity),
              );
          if (!mounted.ok) {
            recordMaterialAdmissionFailure(instanceId, mounted.error);
            return true;
          }
          if (current) {
            const invalidated = dependencyInvalidations(
              target.payload,
              current.dependencies,
              target.dependencies,
            );
            if (invalidated.length) water.invalidate(instanceId, invalidated);
          }
          state.bodies.set(instanceId, {
            ...current,
            entity: target.entity,
            handle: target.handle,
            sourceAssetGuid: target.sourceAssetGuid,
            version: target.version,
            dependencies: target.dependencies,
          });
          if (
            current &&
            current.handle !== target.handle &&
            !hasOtherLiveBodyAssetOwner(state, instanceId, current.handle)
          )
            retireAssetSnapshot(state, current.handle, 'water-body');
          leaseUpdated = true;
        } else {
          if (
            target.payload.type === 'river' &&
            target.payload.collision.enabled &&
            activeSnapshot !== undefined &&
            waterRiverTransformRequiresStaging(
              world,
              instanceId,
              target.entity as EntityHandle,
              activeSnapshot,
              current,
            ) &&
            !sameMatrixF32(activeSnapshot.worldMatrixM, target.worldMatrixM)
          ) {
            const staged = water.stageRiverTransform(
              instanceId,
              target.worldMatrixM,
              target.exclusionVolumes,
              target.dependencies,
            );
            if (staged.ok) return true;
            if (status)
              status.waterCollisionFailures = Object.freeze([
                ...status.waterCollisionFailures.filter(
                  (failure) => failure.entity !== target.entity,
                ),
                Object.freeze({
                  entity: target.entity,
                  bodyGuid: instanceId,
                  stage: 'cook' as const,
                  ...collisionFailureFields(staged.error),
                }),
              ]);
            return true;
          }
          const refreshSceneBodyTransformAndDependencies = (
            currentBody: NonNullable<typeof current>,
          ) => {
            const previousGeneration = water.snapshot(instanceId)?.sceneGeneration;
            const updated = water.updateInstanceTransform(instanceId, target.worldMatrixM);
            if (!updated.ok) invalidBodyTransforms.add(instanceId);
            const dependencies = collectWaterDependencies(target.payload, assets);
            const invalidated = dependencyInvalidations(
              target.payload,
              currentBody.dependencies,
              dependencies,
            );
            const refreshed = invalidated.length
              ? water.refreshDependencies(instanceId, invalidated)
              : undefined;
            const acceptedDependencies = refreshed?.ok ?? true;
            if (refreshed?.ok === false)
              recordMaterialAdmissionFailure(instanceId, refreshed.error);
            if (refreshed?.ok && refreshed.value) leaseUpdated = true;
            if (updated.ok && water.snapshot(instanceId)?.sceneGeneration !== previousGeneration)
              leaseUpdated = true;
            state.bodies.set(instanceId, {
              ...currentBody,
              ...(acceptedDependencies ? { dependencies } : {}),
            });
          };
          refreshSceneBodyTransformAndDependencies(current);
        }
        return false;
      };
      if (updateSceneBodySource()) continue;
      const publishSceneBodyAcceptance = () => {
        persistWaterSceneAssetSnapshot(state, assets, target.assetSnapshot);
        const exclusionsUpdated = water.setExclusionVolumes(instanceId, target.exclusionVolumes);
        if (exclusionsUpdated.ok && exclusionsUpdated.value) leaseUpdated = true;
        const beforeAcceptance = water.snapshot(instanceId);
        if (target.queryParts && target.queryParts.length > 0)
          publishWaterQuery(water, state, instanceId, target);
        if (beforeAcceptance)
          publishWaterGeometry(water, state, instanceId, target.dependencies, beforeAcceptance);
        if (
          target.payload.collision.enabled ||
          pendingWaterCollision.get(world)?.has(target.entity)
        )
          ensureWaterRigidBody(world, instanceId, target.entity, status);
        const afterAcceptance = water.snapshot(instanceId);
        if (
          beforeAcceptance &&
          afterAcceptance &&
          (beforeAcceptance.outputs.geometry !== afterAcceptance.outputs.geometry ||
            beforeAcceptance.outputs.query !== afterAcceptance.outputs.query ||
            beforeAcceptance.outputs.collision !== afterAcceptance.outputs.collision)
        )
          leaseUpdated = true;
        if (leaseUpdated) replaceSceneLease(state, water, instanceId);
      };
      publishSceneBodyAcceptance();
    }
  };
  reconcileDesiredSceneBodies(state);
  const retireMissingSceneBodies = (state: Lifecycle) => {
    for (const [instanceId, current] of state.bodies) {
      if (!seenBodyInstances.has(instanceId)) {
        if (!current.retiring) {
          const cancelPendingSceneBodyCollision = () => {
            const pending = pendingWaterCollision.get(world)?.get(current.entity);
            const phase =
              (pending?.pairedBake || pending?.stagedScene) && pending.bodyGeneration !== undefined
                ? water.bakedQueryGridCandidatePhase(
                    instanceId,
                    pending.bodyGeneration,
                    pending.revision,
                  )
                : undefined;
            if (
              (pending?.pairedBake || pending?.stagedScene) &&
              pending.candidate &&
              (pending.candidate.state === 'queued' || pending.candidate.state === 'failed') &&
              phase !== undefined
            ) {
              let physics: PhysicsWorld | undefined;
              try {
                physics = world.getResource<PhysicsWorld>(PhysicsWorldResource);
              } catch {
                /* Report below; a queued native candidate cannot be dropped without Physics. */
              }
              const cancelled = physics
                ? cancelWaterCollisionCandidate(physics, pending.candidate)
                : err(
                    new Error('PhysicsWorld is unavailable while cancelling a queued River Bake'),
                  );
              if (!cancelled.ok) {
                if (status)
                  status.waterCollisionFailures = Object.freeze([
                    ...status.waterCollisionFailures.filter(
                      (failure) => failure.entity !== current.entity,
                    ),
                    Object.freeze({
                      entity: current.entity,
                      bodyGuid: instanceId,
                      stage: 'admit' as const,
                      ...collisionFailureFields(cancelled.error),
                    }),
                  ]);
                return true;
              }
              if (pending.pairedBake)
                water.rejectBakedQueryGridCandidate(
                  instanceId,
                  requireWaterValue(pending.bodyGeneration),
                  pending.revision,
                );
              else
                water.releaseBakedQueryGridCandidate(
                  instanceId,
                  requireWaterValue(pending.bodyGeneration),
                  pending.revision,
                );
              pendingWaterCollision.get(world)?.delete(current.entity);
            }
            return false;
          };
          if (cancelPendingSceneBodyCollision()) continue;
          if (waterCollisionAdmissionIsInFlight(world, water, instanceId, current.entity)) continue;
          const unmounted = water.unmountBody(instanceId);
          if (!unmounted.ok) {
            if (status)
              status.waterCollisionFailures = Object.freeze([
                ...status.waterCollisionFailures.filter(
                  (failure) => failure.entity !== current.entity,
                ),
                Object.freeze({
                  entity: current.entity,
                  bodyGuid: instanceId,
                  stage: 'admit' as const,
                  ...collisionFailureFields(unmounted.error),
                }),
              ]);
            continue;
          }
          const lease = state.leases.get(instanceId);
          if (lease) {
            const released = water.releaseSnapshot(lease);
            if (!released.ok) continue;
          }
          state.leases.delete(instanceId);
          state.bodies.set(instanceId, { ...current, retiring: true });
          if (!hasOtherLiveBodyAssetOwner(state, instanceId, current.handle))
            retireAssetSnapshot(state, current.handle, 'water-body');
        }
      }
    }
  };
  retireMissingSceneBodies(state);
  const refreshChangedZoneBodies = (state: Lifecycle) => {
    if (changedZoneGuids.size)
      for (const snapshot of water.snapshots()) {
        const mount = state.bodies.get(snapshot.guid);
        if (mount && waterCollisionAdmissionIsInFlight(world, water, snapshot.guid, mount.entity))
          continue;
        const zoneGuid = snapshot.asset.zoneGuid;
        if (!zoneGuid || !changedZoneGuids.has(zoneGuid)) continue;
        const invalidated: WaterDirtyKind[] = [];
        if (snapshot.asset.flags.affectsWaterInfo) invalidated.push('waterInfo' as const);
        if (snapshot.asset.flags.affectsWaterMesh) invalidated.push('waterMesh' as const);
        if (invalidated.length) {
          const refreshed = water.refreshDependencies(snapshot.guid, invalidated);
          if (!refreshed.ok) recordMaterialAdmissionFailure(snapshot.guid, refreshed.error);
          else {
            if (!refreshed.value) water.invalidate(snapshot.guid, invalidated);
            replaceSceneLease(state, water, snapshot.guid);
          }
        }
      }
  };
  refreshChangedZoneBodies(state);
  const publishSceneValidationStatus = () => {
    if (status)
      status.invalidBodyTransforms = replaceStatusValues(
        status.invalidBodyTransforms,
        [...invalidBodyTransforms].sort(),
      );
    if (status)
      status.invalidExclusionTransforms = replaceStatusValues(
        status.invalidExclusionTransforms,
        [...invalidExclusionTransforms].sort(),
      );
    if (status)
      status.invalidExclusionBodyEntities = replaceStatusValues(
        status.invalidExclusionBodyEntities,
        [...invalidExclusionBodyEntities].sort(),
      );
    if (status)
      status.unsupportedCustomParticipation = replaceStatusValues(
        status.unsupportedCustomParticipation,
        [...unsupportedCustomParticipation].sort(),
      );
    if (status)
      status.waterGeometryRecookRequired = replaceRecookStatus(
        status.waterGeometryRecookRequired,
        waterGeometryRecookRequired.sort((a, b) => a.entity - b.entity),
      );
    if (status)
      status.waterDependencyFailures = Object.freeze(
        [
          ...status.waterDependencyFailures.filter(
            (failure) => failure.code !== 'query-data-unavailable',
          ),
          ...materialAdmissionFailures,
        ].sort((left, right) =>
          `${left.kind}:${left.guid}`.localeCompare(`${right.kind}:${right.guid}`),
        ),
      );
  };
  publishSceneValidationStatus();
  const fluidInputs: WaterFluidInstanceInput[] = [];
  const fluidFailures: WaterFluidError[] = [];
  const collectFluidInputs = () => {
    for (const span of world
      .query({ read: [WaterFluidSimulation] })
      .unwrap()
      .spans()
      .unwrap()) {
      const entities = span.entities;
      const columns = span.get(WaterFluidSimulation);
      for (let index = 0; index < span.length; index++) {
        const entity = entities[index] as EntityHandle;
        const component = {
          recipe: columns.recipe.get(index) as AssetHandle<'water-simulation-recipe'>,
          body: columns.body[index],
          enabled: columns.enabled[index] !== 0,
          resetRevision: columns.resetRevision[index] as number,
        };
        const instanceId = `scene-entity:${entity}`;
        const recipe = assets.read(component.recipe);
        const recipeGuid = assets.sourceGuid(component.recipe);
        const version = assets.version(component.recipe);
        const bodyGuid = `scene-entity:${component.body}`;
        const body = water.snapshot(bodyGuid);
        const matrix = readWorldMatrix(entity);
        const waveX = columns.waveFoamCenterM[index * 3];
        const waveY = columns.waveFoamCenterM[index * 3 + 1];
        const waveZ = columns.waveFoamCenterM[index * 3 + 2];
        if (
          recipe?.kind !== 'water-simulation-recipe' ||
          recipe.system !== 'fluid-simulation' ||
          recipeGuid === undefined ||
          version === undefined ||
          body === undefined ||
          !validMatrix(matrix) ||
          waveX === undefined ||
          waveY === undefined ||
          waveZ === undefined
        ) {
          fluidFailures.push({
            code: 'fluid-instance-invalid',
            expected: 'a loaded fluid recipe, specified live WaterBody and finite grid transform',
            hint: 'bind the saved Scene fluid component to its recipe and WaterBody entity',
            detail: { instanceId, field: 'scene-closure', reason: 'unresolved-scene-closure' },
          });
          continue;
        }
        const noiseKind = impulseNoiseKind(assets, recipe.impulseNoiseGuid);
        const { payload: _noisePayload, ...impulseNoiseDependency } = assets.dependency?.(
          recipe.impulseNoiseGuid,
          noiseKind,
        ) ?? { guid: recipe.impulseNoiseGuid, kind: noiseKind, status: 'unavailable' as const };
        fluidInputs.push({
          instanceId,
          recipeGuid,
          recipeVersion: String(version),
          recipe,
          bodyGuid,
          bodyGeneration: body.sceneGeneration,
          centerM: [matrix[12], matrix[13], matrix[14]],
          waveFoamCenterM: [waveX, waveY, waveZ],
          enabled: component.enabled,
          resetRevision: component.resetRevision,
          impulseNoiseDependency,
        });
      }
    }
  };
  collectFluidInputs();
  const reconciled = water.fluid.reconcile(fluidInputs);
  if (!reconciled.ok) fluidFailures.push(reconciled.error);
  if (status) status.waterFluidFailures = Object.freeze(fluidFailures);
}

function waterGeometryMeshReferences(
  body: WaterBodyAsset,
): readonly { readonly guid: string; readonly field: string }[] | undefined {
  const references: { guid: string; field: string }[] = [];
  if (body.renderOptions?.visible !== false) {
    if (body.type === 'river') {
      const segments = body.riverSegmentMeshGuids ?? [];
      if (segments.length !== body.spline.points.length - 1) return undefined;
      for (const [index, guid] of segments.entries())
        references.push({ guid, field: `riverSegmentMeshGuids[${index}]` });
    } else if (body.type === 'custom') {
      if (!body.customMeshOverrideGuid) return undefined;
      references.push({ guid: body.customMeshOverrideGuid, field: 'customMeshOverrideGuid' });
    } else {
      if (!body.visibleMeshGuid) return undefined;
      references.push({ guid: body.visibleMeshGuid, field: 'visibleMeshGuid' });
    }
  }
  if (body.flags.affectsWaterInfo) {
    if (!body.waterInfoMeshGuid) return undefined;
    references.push({ guid: body.waterInfoMeshGuid, field: 'waterInfoMeshGuid' });
    const dilatedRequired =
      body.type !== 'custom' &&
      body.waterGeometryVersion === 2 &&
      (body.shapeDilationM ?? WATER_BODY_DEFAULT_SHAPE_DILATION_M) > 0;
    if (dilatedRequired && !body.dilatedWaterInfoMeshGuid) return undefined;
    if (body.dilatedWaterInfoMeshGuid) {
      references.push({ guid: body.dilatedWaterInfoMeshGuid, field: 'dilatedWaterInfoMeshGuid' });
    }
  }
  return references;
}

function meshPayloadDigest(mesh: MeshAsset): string | undefined {
  if (
    mesh.kind !== 'mesh' ||
    !(mesh.vertices instanceof Float32Array) ||
    mesh.vertices.length === 0 ||
    !mesh.attributes?.position
  )
    return undefined;
  const digestBuffer = (value: ArrayBuffer | ArrayBufferView | undefined) => {
    if (value === undefined) return undefined;
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return sha256Bytes(bytes);
  };
  return sha256(
    canonicalJson({
      vertices: digestBuffer(mesh.vertices),
      indices: digestBuffer(mesh.indices),
      attributes: Object.fromEntries(
        Object.entries(mesh.attributes).map(([name, value]) => [name, digestBuffer(value)]),
      ),
      aabb: digestBuffer(mesh.aabb),
      submeshes: mesh.submeshes,
    }),
  );
}

function publishWaterGeometry(
  water: WaterSystem,
  state: Lifecycle,
  guid: string,
  sourceDependencies: readonly WaterDependencySnapshot[],
  snapshot: WaterBodySnapshot,
): void {
  if (!snapshot.dirty.has('geometry')) return;
  if (!snapshot.asset.geometrySnapshot || !validateWaterRuntimeBody(snapshot.asset).ok) return;
  const references = waterGeometryMeshReferences(snapshot.asset);
  if (!references) return;
  const dependencies = references.map((reference) =>
    sourceDependencies.find(
      (dependency) =>
        dependency.kind === 'mesh' &&
        dependency.field === reference.field &&
        dependency.guid.toLowerCase() === reference.guid.toLowerCase(),
    ),
  );
  const resolved: Array<{
    reference: (typeof references)[number];
    dependency: WaterDependencySnapshot;
  }> = [];
  for (const [index, reference] of references.entries()) {
    const dependency = dependencies[index];
    if (
      dependency?.status !== 'valid' ||
      waterDependencyRevision(dependency) === undefined ||
      typeof dependency.payload !== 'object' ||
      dependency.payload === null ||
      (dependency.payload as Asset).kind !== 'mesh'
    )
      return;
    resolved.push({ reference, dependency });
  }
  const meshes: MeshAsset[] = [];
  for (const { dependency } of resolved) meshes.push(dependency.payload as MeshAsset);
  const inputKey = sha256(
    canonicalJson({
      bodyVersion: snapshot.sourceVersion,
      sourcePublication: snapshot.sourcePublication,
      outputGeneration: snapshot.outputGenerations.geometry,
      references: resolved.map(({ reference, dependency }) => ({
        guid: reference.guid.toLowerCase(),
        field: reference.field,
        revision: waterDependencyRevision(dependency),
      })),
    }),
  );
  let receipt = state.geometryConsumerOutputs.get(guid);
  if (receipt?.inputKey !== inputKey) {
    const meshDigests = meshes.map(meshPayloadDigest);
    if (meshDigests.some((digest) => digest === undefined)) return;
    const digested = resolved.flatMap(({ reference, dependency }, index) => {
      const digest = meshDigests[index];
      return digest === undefined ? [] : [{ reference, dependency, digest }];
    });
    if (digested.length !== resolved.length) return;
    receipt = {
      inputKey,
      generation: state.geometryConsumerGeneration + 1,
      digest: sha256(
        canonicalJson({
          consumer: 'water-scene-loaded-meshes/1',
          sourceAssetGuid: snapshot.sourceAssetGuid,
          sourceVersion: snapshot.sourceVersion,
          sourcePublication: snapshot.sourcePublication,
          outputGeneration: snapshot.outputGenerations.geometry,
          meshes: digested.map(({ reference, dependency, digest }) => ({
            guid: reference.guid.toLowerCase(),
            revision: waterDependencyRevision(dependency),
            digest,
          })),
          geometry: snapshot.asset.geometrySnapshot,
        }),
      ),
    };
  }
  const accepted = water.acceptOutput(guid, 'geometry', snapshot.outputGenerations.geometry, {
    generation: receipt.generation,
    digest: receipt.digest,
  });
  if (!accepted.ok) return;
  state.geometryConsumerGeneration = Math.max(state.geometryConsumerGeneration, receipt.generation);
  state.geometryConsumerOutputs.set(guid, receipt);
}

function publishWaterQuery(
  water: WaterSystem,
  state: Lifecycle,
  guid: string,
  target: SceneWaterBodyTarget,
): void {
  const snapshot = water.snapshot(guid);
  const cached = state.queryPrismParts.get(`${target.sourceAssetGuid}:${target.version}`);
  if (!snapshot?.dirty.has('query') || !cached || target.queryParts !== cached.parts) return;
  const consumerGeneration = state.queryConsumerGeneration + 1;
  const digest = sha256(
    canonicalJson({
      consumer: 'water-query-prism-exclusion/1',
      prism: cached.digest,
      instanceTransform: snapshot.worldMatrixM,
      exclusions: snapshot.exclusionVolumes,
    }),
  );
  const accepted = water.acceptOutput(guid, 'query', snapshot.outputGenerations.query, {
    generation: consumerGeneration,
    digest,
  });
  if (accepted.ok) state.queryConsumerGeneration = consumerGeneration;
}

function cancelWaterCollisionCandidate(
  physics: PhysicsWorld,
  candidate: DerivedPhysicsCandidate,
): Result<void, Error> {
  const cancelled = physics.cancelDerivedShapeCandidate?.(candidate);
  return (
    cancelled ?? err(new Error('Physics cannot confirm Water collision candidate cancellation'))
  );
}

function collectWaterDependencies(
  asset: WaterBodyAsset,
  assets: WaterSceneAssetAccess,
): readonly WaterDependencySnapshot[] {
  const direct: Array<{ guid: string; kind: string; field: string }> = [
    { guid: asset.surfaceMaterialGuid, kind: 'material', field: 'surfaceMaterialGuid' },
  ];
  for (const [index, guid] of asset.riverSegmentMeshGuids?.entries() ?? [])
    direct.push({ guid, kind: 'mesh', field: `riverSegmentMeshGuids[${index}]` });
  if (asset.customMeshOverrideGuid)
    direct.push({
      guid: asset.customMeshOverrideGuid,
      kind: 'mesh',
      field: 'customMeshOverrideGuid',
    });
  if (asset.collision.meshGuid)
    direct.push({ guid: asset.collision.meshGuid, kind: 'mesh', field: 'collision.meshGuid' });
  for (const field of [
    'visibleMeshGuid',
    'waterInfoMeshGuid',
    'dilatedWaterInfoMeshGuid',
    'brushShapeMeshGuid',
    'collisionMeshGuid',
  ] as const) {
    const guid = asset[field];
    if (guid) direct.push({ guid, kind: 'mesh', field });
  }
  const slots = [
    ['riverToLakeTransitionMaterialGuid', asset.riverToLakeTransitionMaterialGuid],
    ['riverToOceanTransitionMaterialGuid', asset.riverToOceanTransitionMaterialGuid],
    ['waterInfoMaterialGuid', asset.waterInfoMaterialGuid],
    ['lodMaterialGuid', asset.lodMaterialGuid],
    ['underwaterPostProcessMaterialGuid', asset.underwaterPostProcessMaterialGuid],
  ] as const;
  for (const [field, guid] of slots) if (guid) direct.push({ guid, kind: 'material', field });
  if (asset.zoneGuid) direct.push({ guid: asset.zoneGuid, kind: 'water-zone', field: 'zoneGuid' });
  if (asset.waveSetGuid)
    direct.push({ guid: asset.waveSetGuid, kind: 'water-wave-set', field: 'waveSetGuid' });
  return collectWaterReferenceDependencies(direct, assets);
}

function collectWaterReferenceDependencies(
  references: readonly Readonly<{ guid: string; kind: string; field: string }>[],
  assets: WaterSceneAssetAccess,
): readonly WaterDependencySnapshot[] {
  const dependencies = new Map<string, WaterDependencySnapshot>();
  const visit = (guid: string, kind: string, field: string, seen: Set<string>) => {
    const identity = `${kind}\u0000${guid}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const dependency = assets.dependency?.(guid, kind) ?? {
      guid,
      kind,
      status: 'unavailable' as const,
    };
    dependencies.set(`${field}\u0000${identity}`, { ...dependency, field });
    for (const parentGuid of assets.dependencyParents?.(guid, kind) ?? [])
      visit(parentGuid, 'material', field, seen);
  };
  for (const reference of references)
    visit(reference.guid, reference.kind, reference.field, new Set());
  return Object.freeze(
    [...dependencies.values()].sort((left, right) =>
      `${left.field}:${left.guid}`.localeCompare(`${right.field}:${right.guid}`),
    ),
  );
}

function dependencyInvalidations(
  asset: WaterBodyAsset,
  previous: readonly WaterDependencySnapshot[],
  next: readonly WaterDependencySnapshot[],
): WaterDirtyKind[] {
  const identity = (dependency: WaterDependencySnapshot) =>
    `${dependency.field}\u0000${dependency.kind}\u0000${dependency.guid}`;
  const old = new Map(previous.map((dependency) => [identity(dependency), dependency]));
  const current = new Map(next.map((dependency) => [identity(dependency), dependency]));
  const dirty = new Set<WaterDirtyKind>();
  for (const key of new Set([...old.keys(), ...current.keys()])) {
    const before = old.get(key);
    const after = current.get(key);
    if (
      before &&
      after &&
      before.status === after.status &&
      before.actualKind === after.actualKind &&
      waterDependencyRevision(before) === waterDependencyRevision(after)
    )
      continue;
    const kind = (after ?? before)?.kind;
    const field = (after ?? before)?.field;
    const invalidateWaterDependencyKind = (kind: string | undefined, field: string | undefined) => {
      if (kind === 'water-wave-set') {
        dirty.add('query');
        if (asset.flags.affectsWaterInfo) dirty.add('waterInfo');
        if (asset.flags.affectsWaterMesh) dirty.add('waterMesh');
      } else if (kind === 'mesh') {
        const invalidateMeshDependency = (field: string | undefined) => {
          if (field === 'collisionMeshGuid' || field === 'collision.meshGuid')
            dirty.add('collision');
          if (field === 'brushShapeMeshGuid') dirty.add('terrainBrush');
          if (field === 'waterInfoMeshGuid' || field === 'dilatedWaterInfoMeshGuid') {
            dirty.add('waterInfo');
            dirty.add('geometry');
          }
          if (
            field === 'riverSegmentMeshGuids' ||
            field?.startsWith('riverSegmentMeshGuids[') ||
            field === 'visibleMeshGuid' ||
            field === 'customMeshOverrideGuid'
          ) {
            dirty.add('geometry');
            dirty.add('query');
            if (asset.flags.affectsWaterMesh) dirty.add('waterMesh');
            if (
              asset.flags.affectsWaterInfo &&
              (field === 'customMeshOverrideGuid' || field === 'visibleMeshGuid')
            )
              dirty.add('waterInfo');
          }
        };
        invalidateMeshDependency(field);
      } else if (kind === 'material') {
        dirty.add('material');
        if (field === 'waterInfoMaterialGuid' && asset.flags.affectsWaterInfo)
          dirty.add('waterInfo');
        if (
          [
            'surfaceMaterialGuid',
            'riverToLakeTransitionMaterialGuid',
            'riverToOceanTransitionMaterialGuid',
            'lodMaterialGuid',
          ].includes(field ?? '') &&
          asset.flags.affectsWaterMesh
        )
          dirty.add('waterMesh');
      }
    };
    invalidateWaterDependencyKind(kind, field);
  }
  return [...dirty];
}

/** Resolve admitted material references through the Registry's owned asset closure. */
export function registryWaterMaterialReference(
  assets: AssetRegistry,
  guid: string,
): WaterMaterialResolution {
  const handle = runtimeAssetReference(assets, guid);
  if (handle === undefined) return { kind: 'unavailable' };
  try {
    const result = assets.read(handle as AssetHandle);
    if (!result.ok) return { kind: 'unavailable' };
    const material = result.value as Asset;
    if (material.kind !== 'material') return { kind: 'invalid-kind' };
    const parentGuid = assets
      .catalogEntry(guid)
      ?.refs?.find((reference) => assets.catalogEntry(reference)?.kind === 'material');
    const projection = assets.getMaterialProjectionForPayload(material);
    return {
      kind: 'valid',
      asset: { ...material, ...(parentGuid === undefined ? {} : { parent: parentGuid }) },
      ...(projection === undefined
        ? {}
        : {
            publishedPasses: projection.passes.flatMap((pass) => {
              const authoredPass = material.passes?.find((entry) => entry.name === pass.name);
              const lightMode =
                authoredPass === undefined ? undefined : materialPassLightMode(authoredPass);
              return lightMode === undefined
                ? []
                : [
                    {
                      lightMode,
                      abis: pass.programs.flatMap((program) =>
                        program.abi === undefined ? [] : [program.abi],
                      ),
                    },
                  ];
            }),
          }),
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

function boundsOverlap(
  left: { readonly minM: readonly [number, number]; readonly maxM: readonly [number, number] },
  right: { readonly minM: readonly [number, number]; readonly maxM: readonly [number, number] },
): boolean {
  return (
    left.minM[0] <= right.maxM[0] &&
    left.maxM[0] >= right.minM[0] &&
    left.minM[1] <= right.maxM[1] &&
    left.maxM[1] >= right.minM[1]
  );
}

type ZoneGroundBounds = Readonly<{
  guid: string;
  boundsXZ: { readonly minM: readonly [number, number]; readonly maxM: readonly [number, number] };
}>;

export function intersectWaterTerrainProvidersWithZones(
  zones: readonly ZoneGroundBounds[],
  providers: readonly WaterZoneTerrainProviderInput[],
): ReadonlyMap<string, readonly WaterZoneTerrainProviderInput[]> {
  const result = new Map<string, WaterZoneTerrainProviderInput[]>();
  for (const zone of [...zones].sort((left, right) => left.guid.localeCompare(right.guid))) {
    const matches = providers
      .filter((provider) => boundsOverlap(provider.boundsXZ, zone.boundsXZ))
      .sort((left, right) => left.entity - right.entity);
    if (matches.length > 0) result.set(zone.guid, matches);
  }
  return result;
}

function worldMatrixFor(world: World, entity: number): readonly number[] {
  const result = world.get(entity as EntityHandle, GlobalTransform);
  return result.ok
    ? Array.from(result.value.world)
    : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function waterExclusionIntersectsSceneBody(
  world: World,
  target: SceneWaterBodyTarget,
  centerM: readonly number[],
  halfExtentsM: readonly number[],
  exclusionWorldMatrixM: readonly number[],
): boolean {
  const queryParts = cacheWaterQueryPrismParts(world, target);
  return (
    queryParts !== null &&
    waterExclusionIntersectsQueryPrismParts(
      queryParts,
      target.worldMatrixM,
      centerM,
      halfExtentsM,
      exclusionWorldMatrixM,
    )
  );
}

export function waterExclusionIntersectsBody(
  body: WaterBodyAsset,
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
  const query = waterBodyQueryPrismParts(body);
  if (!query.ok) return false;
  return waterExclusionIntersectsQueryPrismParts(
    query.value,
    bodyWorldMatrixM,
    centerM,
    halfExtentsM,
    exclusionWorldMatrixM,
  );
}

function sameMatrix(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMatrixF32(left: readonly number[], right: readonly number[]): boolean {
  if (!isMatrix4(left) || !isMatrix4(right)) return false;
  return left.every((value, index) => {
    const other = right[index];
    return other !== undefined && sameF32QuantizedValue(value, other);
  });
}

function sameMatrixBasisF32(left: readonly number[], right: readonly number[]): boolean {
  return (
    isMatrix4(left) &&
    isMatrix4(right) &&
    left.every((value, index) => {
      const other = right[index];
      return index === 12 || index === 13 || index === 14
        ? true
        : other !== undefined && sameF32QuantizedValue(value, other);
    })
  );
}

function sameF32QuantizedValue(left: number, right: number): boolean {
  const tolerance = 4 * 2 ** -23 * Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= tolerance;
}

function sameVectorF32(left: readonly number[], right: ArrayLike<number>): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const other = right[index];
      return other !== undefined && sameF32QuantizedValue(value, other);
    })
  );
}

import {
  type BodyMount,
  cacheWaterQueryPrismParts,
  isMatrix4,
  type Lifecycle,
  type RegistryVersionedWaterDependency,
  type RegistryWaterSceneAssetAccess,
  type RiverBakeNormalAssetLease,
  registryAccess,
  type SceneWaterBodyTarget,
  sameSplineMetric,
  states,
  transformedXZBounds,
  validMatrix,
  versionedRegistryAccesses,
  type WaterSceneAssetAccess,
  type WaterSceneAssetSnapshot,
  type WaterSceneCollisionFailure,
  type WaterSceneDependencyFailure,
  type WaterSceneGeometryMeshFailure,
  type WaterSceneGeometryRecookRequired,
  type WaterSceneStatus,
  waterExclusionIntersectsQueryPrismParts,
  waterSceneAssetSnapshot,
  waterSceneCurrentAssetMetadata,
} from './water-scene-inputs';

export {
  resolveWaterSceneDependencyHandle,
  type WaterSceneAssetAccess,
  type WaterSceneCollisionFailure,
  type WaterSceneDependencyFailure,
  type WaterSceneGeometryMeshFailure,
  type WaterSceneGeometryRecookRequired,
  type WaterSceneStatus,
} from './water-scene-inputs';
