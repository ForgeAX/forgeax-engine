import {
  runtimeAssetReference,
  runtimeAssetRegistry,
} from '@forgeax/engine-assets-runtime/internal';

import { type EntityHandle, Time } from '@forgeax/engine-ecs';

import type { TerrainAsset } from '@forgeax/engine-types';

import { err, materialPassLightMode, ok, type Result } from '@forgeax/engine-types';

import {
  buildWaterWaveUploadBody,
  buildWaterWaveUploadPlan,
  createWaterInfoContext,
  snapshotWaterBakedQueryGrid,
  WATER_SYSTEM_RESOURCE,
  type WaterBodySnapshot,
  type WaterInfoContext,
  WaterInfoSliceAllocator,
  type WaterOperationObserver,
  type WaterSystem,
  type WaterWaveUploadBody,
  type WaterZoneGroundQuerySnapshot,
  type WaterZoneGroundSnapshot,
  type WaterZoneSnapshot,
  waterBodyOwnerKey,
  waterInfoDescriptorBytes,
  waterInfoSliceReservationKey,
  waterInfoZoneTransformSupported,
  waterMeshGridTemplate,
} from '@forgeax/engine-water';

import {
  requireWaterValue,
  waterMeshCandidateViewsForRenderer,
  waterZoneMeshViewForRenderer,
} from '@forgeax/engine-water/internal';

import { type RenderError, RenderFeatureCapabilityMissingError } from '../errors/render';

import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureWork,
} from '../features/plan';

import { captureFeatureSourceAssetVersion } from '../features/source';

import type {
  RenderFeature,
  RenderFeatureExtractContext,
  RenderFeatureSubmission,
} from '../features/types';

import { materialProgramSelectionsForMaterial } from '../render-system-extract';

import { buildWaterGpuMeshZone, type WaterGpuMeshZone } from './gpu-mesh-source';

import {
  appendWaterInfoTerrainTriangles,
  buildWaterInfoTriangleBuffer,
  WATER_INFO_TRIANGLE_STRIDE_FLOATS,
  type WaterInfoMeshView,
  type WaterInfoTriangleSource,
  waterInfoMeshView,
} from './water-info-producer';

const WATER_INFO_PROFILE_WORK = Object.freeze([
  'water/mesh/owner-roster',
  'water/render/wgpu-mesh-owner-matching',
  'water/render/wgpu-mesh-signature-matching',
  'water/zone/ground-snapshot-copy',
]);

const WATER_FALLBACK_DEPTH_M = 30;

/** A missing exact row is retryable only when its accepted dependency is still loading. */
export function waterGpuMeshPublicationReadiness(
  source: WaterGpuMeshZone,
  publication: WaterInfoFramePublication,
): Result<RenderFeaturePlan['pendingSource'], RenderError> {
  if (source.viewIdentity !== publication.viewIdentity)
    return err(
      featureFailure('the exact GPU Water publication view', {
        sourceView: source.viewIdentity,
        publicationView: publication.viewIdentity,
      }),
    );
  let pendingSource: RenderFeaturePlan['pendingSource'];
  for (const body of source.bodies) {
    const key = waterBodyOwnerKey(
      source.worldIdentity,
      body.guid,
      body.generation,
      source.zone.generation,
    );
    const index = publication.waveUploadPlan.bodyIndices.get(key);
    const row = index === undefined ? undefined : publication.waveUploadPlan.bodyData[index];
    if (body.waveDependency.kind === 'pending') {
      if (row !== undefined)
        return err(
          featureFailure('no WaveParam row for an unresolved accepted WaveSet dependency', {
            key,
            guid: body.waveDependency.guid,
          }),
        );
      pendingSource ??= { resource: body.waveDependency.guid, reason: 'asset-dependency-pending' };
    } else if (
      row === undefined ||
      row.bodyGeneration !== body.generation ||
      publication.waveUploadPlan.bodyZoneGenerations.get(key) !== source.zone.generation
    )
      return err(
        featureFailure('the exact same-frame WaveParam row for every ready GPU raster body', {
          key,
          view: publication.viewIdentity,
        }),
      );
  }
  return ok(pendingSource);
}

const reservationKey = (reservation: ReturnType<WaterInfoSliceAllocator['reserve']>) =>
  reservation === undefined ? '' : waterInfoSliceReservationKey(reservation);

function parseTupleKey(key: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The material extractor asks for rows by World-qualified owner, never by GUID alone. */
export function waterInfoDescriptorRow(
  feature: object,
  viewIdentity: string,
  frameGeneration: number,
  deviceGeneration: number,
  ownerKey: string,
): WaterInfoDescriptorRow | undefined {
  const state = publicationStates.get(feature);
  if (state === undefined) return undefined;
  const row = (
    state.pending.get(publicationKey(viewIdentity, frameGeneration, deviceGeneration)) ??
    state.submitted.get(publicationKey(viewIdentity, frameGeneration, deviceGeneration)) ??
    state.history.get(historyKey(viewIdentity, deviceGeneration))?.publication
  )?.rows.get(ownerKey);
  return row === undefined
    ? undefined
    : Object.freeze({ ...row, descriptor: new Uint8Array(row.descriptor) });
}

export interface WaterInfoPublicationInspection {
  readonly viewIdentity: string;
  readonly frameGeneration: number;
  readonly deviceGeneration: number;
  readonly graphResourceVersion: string;
  readonly targets: WaterInfoFramePublication['targets'];
  readonly rows: readonly Omit<WaterInfoDescriptorRow, 'descriptor' | 'context'>[];
  readonly unavailable: readonly WaterInfoSourceAvailability[];
}

/** Inspect submitted authority only; pending candidates never establish runtime support. */
export function inspectWaterInfoPublications(
  feature: object | undefined,
  deviceGeneration: number,
): readonly WaterInfoPublicationInspection[] {
  const state = feature === undefined ? undefined : publicationStates.get(feature);
  if (state === undefined) return [];
  return [...state.history.values()].flatMap((history) => {
    const publication = history.publication;
    if (publication === undefined || publication.deviceGeneration !== deviceGeneration) return [];
    return [
      {
        viewIdentity: publication.viewIdentity,
        frameGeneration: publication.frameGeneration,
        deviceGeneration: publication.deviceGeneration,
        graphResourceVersion: publication.graphResourceVersion,
        targets: publication.targets.map((target) => ({ ...target })),
        rows: [...publication.rows.values()].map(
          ({ descriptor: _descriptor, context: _context, ...row }) => ({ ...row }),
        ),
        unavailable: [...publication.waterInfoAvailability.values()].map((value) =>
          structuredClone(value),
        ),
      },
    ];
  });
}

interface WaterInfoZoneRasterInput {
  readonly worldId: number;
  readonly worldIdentity: string;
  readonly zoneGuid: string;
  readonly zone: WaterZoneSnapshot;
  readonly groundGeneration?: number;
  readonly context: WaterInfoPublicationContext;
  readonly captureZM: number;
  readonly waterVertices: Float32Array;
  readonly waterDraws?: readonly WaterInfoWaterDraw[];
  readonly groundVertices: Float32Array;
  readonly dilationVertices: Float32Array;
}

function rasterVerticesForKind(
  triangles: Float32Array,
  context: Pick<WaterInfoContext, 'centerXZ' | 'extentXZ' | 'groundYMinM' | 'waterYMinM'>,
  captureZM: number,
  minimumYM: number,
  kind: 0 | 1 | 2,
): Float32Array {
  const result: number[] = [];
  const depthRange = Math.max(
    captureZM - Math.min(minimumYM, context.groundYMinM, context.waterYMinM),
    1e-6,
  );
  const minX = context.centerXZ[0] - context.extentXZ[0] * 0.5;
  const minZ = context.centerXZ[1] - context.extentXZ[1] * 0.5;
  for (
    let offset = 0;
    offset + WATER_INFO_TRIANGLE_STRIDE_FLOATS <= triangles.length;
    offset += WATER_INFO_TRIANGLE_STRIDE_FLOATS
  ) {
    if (triangles[offset + 12] !== kind) continue;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const positionOffset = offset + vertex * 4;
      const x = requireWaterValue(triangles[positionOffset]);
      const y = requireWaterValue(triangles[positionOffset + 1]);
      const z = requireWaterValue(triangles[positionOffset + 2]);
      const flowOffset = offset + 16 + vertex * 2;
      const clipX = ((x - minX) / context.extentXZ[0]) * 2 - 1;
      const clipY = 1 - ((z - minZ) / context.extentXZ[1]) * 2;
      const clipZ = Math.max(0, Math.min(1, (captureZM - y) / depthRange));
      result.push(
        clipX,
        clipY,
        clipZ,
        captureZM - y,
        requireWaterValue(triangles[flowOffset]),
        requireWaterValue(triangles[flowOffset + 1]),
      );
    }
  }
  return new Float32Array(result);
}

function captureCacheIdentity(
  viewIdentity: string,
  deviceGeneration: number,
  worldIdentity: string,
  zoneGuid: string,
  zoneGeneration: number,
): string {
  return JSON.stringify([viewIdentity, deviceGeneration, worldIdentity, zoneGuid, zoneGeneration]);
}

function captureCacheKey(
  worldId: number,
  worldIdentity: string,
  viewIdentity: string,
  cameraPosition: readonly [number, number, number],
  deviceGeneration: number,
  zone: WaterZoneSnapshot,
  system: WaterSystem,
  extractContext: RenderFeatureExtractContext,
  ground: WaterZoneGroundQuerySnapshot | undefined,
): string {
  const local = zone.asset.waterInfo.localTessellation;
  const bounds = zoneViewBounds(zone, cameraPosition, system, viewIdentity);
  return JSON.stringify({
    worldId,
    worldIdentity,
    viewIdentity: local ? viewIdentity : 'shared',
    deviceGeneration,
    sceneGeneration: system.sceneGeneration,
    zoneGuid: zone.guid,
    zoneGeneration: zone.generation,
    worldMatrixM: zone.worldMatrixM,
    centerXZ: bounds.centerXZ,
    extent: bounds.extentXZ,
    tileSizeM: zone.asset.tileSizeM,
    waterInfo: zone.asset.waterInfo,
    bodies: system
      .snapshots()
      .filter(
        (body) =>
          body.binding.kind === 'bound' &&
          body.binding.zoneGuid === zone.guid &&
          body.binding.zoneGeneration === zone.generation,
      )
      .map((body) => ({
        guid: body.guid,
        sourceVersion: body.sourceVersion,
        generation: body.sceneGeneration,
        worldMatrixM: body.worldMatrixM,
        affectsWaterInfo: body.asset.flags.affectsWaterInfo,
        waterInfoMaterial:
          body.asset.waterInfoMaterialGuid === undefined
            ? undefined
            : waterInfoMaterialCacheToken(
                extractContext,
                worldId,
                body.asset.waterInfoMaterialGuid,
              ),
        dirty: [...body.dirty].sort(),
        geometryOutputStatus: body.outputs.geometry,
        geometryOutput: body.outputReceipts.geometry?.digest ?? '',
        geometryOutputGeneration: body.outputGenerations.geometry,
        dependencies: body.dependencies.map((dependency) => [
          dependency.guid,
          dependency.kind,
          dependency.status,
        ]),
      })),
    ground:
      ground === undefined
        ? null
        : {
            generation: ground.generation,
            zoneGeneration: ground.zoneGeneration,
            pending: ground.pending,
            providers: ground.providers.map((provider) => [
              provider.terrainGuid,
              provider.terrainVersion,
            ]),
          },
  });
}

function proxyOwnerIdentity(
  worldIdentity: string,
  bodyGuid: string,
  bodyGeneration: number,
  zoneGeneration: number,
): string {
  return waterBodyOwnerKey(worldIdentity, bodyGuid, bodyGeneration, zoneGeneration);
}

function retainProxyPublication(
  previous: WaterInfoFramePublication | undefined,
  roster: ReadonlyMap<string, WaterMeshProxyRef>,
  previousTimes: ReadonlyMap<string, number>,
  viewIdentity: string,
  frameGeneration: number,
  deviceGeneration: number,
): Result<WaterInfoFramePublication, RenderError> {
  const rows = new Map<string, WaterInfoDescriptorRow>();
  const remapped = new Map<string, WaterInfoDescriptorRow>();
  for (const row of previous?.rows.values() ?? []) {
    const proxy = roster.get(
      proxyOwnerIdentity(row.worldIdentity, row.bodyGuid, row.bodyGeneration, row.zoneGeneration),
    );
    if (
      proxy === undefined ||
      proxy.owner.waterInfoFormat !== row.targetFormat ||
      row.zoneGuid !== proxy.owner.zoneGuid
    )
      continue;
    if (!previous?.targets.some((target) => target.targetName === row.targetName)) continue;
    const ownerKey = waterBodyOwnerKey(
      proxy.worldIdentity,
      row.bodyGuid,
      row.bodyGeneration,
      row.zoneGeneration,
    );
    const retained = Object.freeze({ ...row, ownerKey, worldId: proxy.worldId });
    rows.set(ownerKey, retained);
    remapped.set(row.ownerKey, retained);
  }
  const waveBodies = new Map<string, WaterWaveUploadBody>();
  for (const body of previous?.waveBodies ?? []) {
    const oldOwnerKey = waterBodyOwnerKey(
      body.worldIdentity,
      body.bodyGuid,
      body.bodyGeneration,
      body.zoneGeneration,
    );
    const row = remapped.get(oldOwnerKey);
    const proxy =
      row === undefined
        ? undefined
        : roster.get(
            proxyOwnerIdentity(
              row.worldIdentity,
              row.bodyGuid,
              row.bodyGeneration,
              row.zoneGeneration,
            ),
          );
    if (row === undefined || proxy === undefined || waveBodies.has(row.ownerKey)) continue;
    waveBodies.set(
      row.ownerKey,
      Object.freeze({
        ...body,
        worldId: row.worldId,
        timeSeconds: proxy.timeSeconds,
        previousTimeSeconds: previousTimes.get(row.ownerKey) ?? body.timeSeconds,
      }),
    );
  }
  const targetNames = new Set([...rows.values()].map((row) => row.targetName));
  const targets = [
    ...new Map(
      (previous?.targets ?? [])
        .filter((target) => targetNames.has(target.targetName))
        .map((target) => [target.targetName, Object.freeze({ ...target, write: false })]),
    ).values(),
  ];
  const bindingSnapshots: WaterInfoBindingSnapshot[] = [];
  for (const target of targets) {
    const source =
      previous?.bindingSnapshots?.find((snapshot) =>
        snapshot.targets.some((row) => row.targetName === target.targetName),
      ) ?? previous;
    if (source === undefined) continue;
    const snapshot = waterInfoTargetBindingSnapshot(source, target, roster, previousTimes);
    if (!snapshot.ok) return snapshot;
    bindingSnapshots.push(snapshot.value);
  }
  const waveUploadPlan = buildWaterWaveUploadPlan([...waveBodies.values()]);
  if (!waveUploadPlan.ok)
    return err(
      featureFailure('valid retained per-view water wave upload plan', {
        viewIdentity,
        cause: waveUploadPlan.error,
      }),
    );
  return ok(
    Object.freeze({
      viewIdentity,
      frameGeneration,
      deviceGeneration,
      graphResourceVersion: targets
        .map((target) => `${target.targetName}:${target.graphResourceVersion}`)
        .join('|'),
      targets: Object.freeze(targets),
      rows,
      waterInfoAvailability: new Map(),
      waveBodies: Object.freeze([...waveBodies.values()]),
      waveUploadPlan: waveUploadPlan.value,
      bindingSnapshots: Object.freeze(bindingSnapshots),
    }),
  );
}

export interface WaterInfoFeatureFrame {
  readonly kind: 'forgeax-water-info-frame';
  readonly views: readonly WaterInfoViewFrame[];
}

function waterInfoSourceFrame(
  context: RenderFeatureExtractContext,
  views: readonly WaterInfoViewFrame[],
  inactiveSourceData: WaterInfoFeatureFrame,
  knownFrames: WeakSet<object>,
): WaterInfoFeatureFrame {
  if (views.length === 0 && !context.world.hasResource(WATER_SYSTEM_RESOURCE))
    return inactiveSourceData;
  const frame: WaterInfoFeatureFrame = Object.freeze({
    kind: 'forgeax-water-info-frame',
    views: Object.freeze(views),
  });
  knownFrames.add(frame);
  return frame;
}

type WaterMeshCandidateView = ReturnType<typeof waterMeshCandidateViewsForRenderer>[number];

type WaterInfoSourceViewFrame = Readonly<{
  viewIdentity: string;
  captures: readonly Readonly<{ system: WaterSystem; capture: WaterInfoZoneRasterInput }>[];
  systems: readonly Readonly<{ worldId: number; worldIdentity: string; system: WaterSystem }>[];
  candidates: readonly Readonly<{
    worldId: number;
    worldIdentity: string;
    system: WaterSystem;
    candidate: WaterMeshCandidateView;
  }>[];
}>;

interface WaterInfoSourceFrame {
  readonly views: readonly WaterInfoSourceViewFrame[];
  readonly beginProfileWork?: NonNullable<
    import('../features/types').RenderFeatureExtractContext['beginProfileWork']
  >;
}

const waterInfoContextInput = (
  context: WaterInfoPublicationContext,
  zone: WaterZoneSnapshot,
  viewId: string,
  deviceGeneration: number,
  frameGeneration: number,
) => ({
  zoneGuid: context.zoneGuid,
  viewId,
  zone: zone.asset,
  centerXZ: context.centerXZ,
  extentXZ: context.extentXZ,
  waterYMinM: context.waterYMinM,
  waterYMaxM: context.waterYMaxM,
  groundYMinM: context.groundYMinM,
  maxVelocityMPerSec: context.maxVelocityMPerSec,
  zoneGeneration: context.zoneGeneration,
  deviceGeneration,
  frameGeneration,
  sourceDigest: context.sourceDigest,
});

function publicationWaveBody(body: WaterWaveUploadBody): WaterInfoPublicationWaveBody {
  const detached = cloneWaterWaveUploadBody(body);
  const heightSource = Object.freeze({
    kind: detached.heightSource.kind,
    fixedHeightM: detached.heightSource.fixedHeightM,
    fixedDepthM: detached.heightSource.fixedDepthM,
    fixedVelocityXZ: detached.heightSource.fixedVelocityXZ,
  });
  return Object.freeze({ ...detached, heightSource });
}

function bodyWaveDependencyPending(body: WaterBodySnapshot): boolean {
  return (
    body.asset.type !== 'river' &&
    body.asset.waveSetGuid !== undefined &&
    body.dependencies.some(
      (dependency) =>
        dependency.field === 'waveSetGuid' &&
        dependency.guid === body.asset.waveSetGuid &&
        dependency.status === 'pending',
    )
  );
}

function isWaterInfoSourceDependency(field: string | undefined): field is string {
  return (
    field === 'waterInfoMeshGuid' ||
    field === 'dilatedWaterInfoMeshGuid' ||
    field === 'visibleMeshGuid' ||
    field === 'customMeshOverrideGuid' ||
    field === 'waterInfoMaterialGuid' ||
    field?.startsWith('riverSegmentMeshGuids[') === true
  );
}

function waterInfoSourceAvailability(
  body: WaterBodySnapshot,
  bodies: readonly WaterBodySnapshot[],
): WaterInfoSourceAvailability {
  const binding = body.binding;
  if (binding.kind !== 'bound')
    return Object.freeze({
      kind: 'missing',
      bodyGuid: body.guid,
      bodyGeneration: body.sceneGeneration,
      field: 'zoneGuid',
      ...(body.asset.zoneGuid === undefined ? {} : { guid: body.asset.zoneGuid }),
    });
  const participants = bodies.filter(
    (candidate) =>
      candidate.asset.flags.affectsWaterInfo &&
      candidate.binding.kind === 'bound' &&
      candidate.binding.zoneGuid === binding.zoneGuid &&
      candidate.binding.zoneGeneration === binding.zoneGeneration,
  );
  const dependencies = participants.flatMap((candidate) =>
    candidate.dependencies
      .filter((dependency) => isWaterInfoSourceDependency(dependency.field))
      .map((dependency) => ({
        bodyGuid: candidate.guid,
        bodyGeneration: candidate.sceneGeneration,
        dependency,
      })),
  );
  for (const { bodyGuid, bodyGeneration, dependency } of dependencies) {
    const reference = {
      bodyGuid,
      bodyGeneration,
      field: requireWaterValue(dependency.field),
      guid: dependency.guid,
    };
    switch (dependency.status) {
      case 'failed':
        return Object.freeze({ ...reference, kind: 'failed', failure: dependency.failure });
      case 'unavailable':
        return Object.freeze({ ...reference, kind: 'missing' });
      case 'invalid-kind':
        return Object.freeze({
          ...reference,
          kind: 'incompatible',
          ...(dependency.actualKind === undefined ? {} : { actualKind: dependency.actualKind }),
        });
      case 'valid':
      case 'pending':
        break;
    }
  }
  const pending = dependencies.find(({ dependency }) => dependency.status === 'pending');
  if (pending !== undefined)
    return Object.freeze({
      kind: 'pending',
      bodyGuid: pending.bodyGuid,
      bodyGeneration: pending.bodyGeneration,
      field: requireWaterValue(pending.dependency.field),
      guid: pending.dependency.guid,
    });
  return Object.freeze({
    kind: 'missing',
    bodyGuid: body.guid,
    bodyGeneration: body.sceneGeneration,
    field: 'waterInfo',
    ...(body.asset.waterInfoMeshGuid === undefined ? {} : { guid: body.asset.waterInfoMeshGuid }),
  });
}

function independentBodyInputs(
  systems: WaterInfoViewFrame['systems'],
  cameraPosition: readonly [number, number, number],
  previousTimes: ReadonlyMap<string, number>,
  worlds: readonly RenderFeatureExtractContext['world'][],
  viewIdentity: string,
): Result<readonly WaterInfoPublicationInputView['bodies'][number][], RenderError> {
  const inputs: WaterInfoPublicationInputView['bodies'][number][] = [];
  for (const { worldId, worldIdentity, system } of systems) {
    const world = worlds[worldId];
    if (world === undefined)
      return err(
        featureFailure('the accepted World for independent Body inputs', {
          worldId,
          worldIdentity,
        }),
      );
    const zones = system.zoneSnapshots();
    const snapshots = system.snapshots();
    for (const body of snapshots) {
      // Mounted Bodies can still await their first Catalog wave dependency.
      if (bodyWaveDependencyPending(body)) continue;
      const zoneGeneration = body.binding.kind === 'bound' ? body.binding.zoneGeneration : 0;
      const ownerKey = waterBodyOwnerKey(
        worldIdentity,
        body.guid,
        body.sceneGeneration,
        zoneGeneration,
      );
      const binding = body.binding;
      const zone =
        binding.kind === 'bound'
          ? zones.find(
              (zone) => zone.guid === binding.zoneGuid && zone.generation === zoneGeneration,
            )
          : undefined;
      if (body.binding.kind === 'bound' && zone === undefined)
        return err(
          featureFailure('the exact accepted bound Zone generation for Body dynamic bounds', {
            ownerKey,
            zoneGuid: body.binding.zoneGuid,
            zoneGeneration,
          }),
        );
      if (zone !== undefined && !waterInfoZoneTransformSupported(zone.worldMatrixM))
        return err(
          featureFailure(
            'axis-aligned WaterZone transform supported by the published center/extent Body ABI',
            {
              ownerKey,
              zoneGuid: zone.guid,
              worldMatrixM: zone.worldMatrixM,
            },
          ),
        );
      const bounds =
        zone === undefined ? undefined : zoneViewBounds(zone, cameraPosition, system, viewIdentity);
      const elapsed = world.getResource(Time).elapsed;
      const timeSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
      const baked = system.bakedQueryGrid(body.guid, body.sceneGeneration);
      const wave = buildWaterWaveUploadBody(body, {
        worldId,
        worldIdentity,
        timeSeconds,
        previousTimeSeconds: previousTimes.get(ownerKey) ?? timeSeconds,
        meshEdgeOverlayEnabled: system.meshEdgeOverlayEnabled(),
        heightSource:
          baked === undefined ? { kind: 'fixed' } : { kind: 'baked', zoneIndex: 0, slice: 0 },
        ...(bounds === undefined
          ? {}
          : {
              dynamicBoundsCenterExtentXZ: [...bounds.centerXZ, ...bounds.extentXZ] as const,
            }),
        ...(baked === undefined ? {} : { bakedGrid: baked.grid }),
      });
      if (!wave.ok)
        return err(
          featureFailure(
            'valid independent Body/wave/Baked input from the accepted Body generation',
            { ownerKey, cause: wave.error },
          ),
        );
      inputs.push(
        Object.freeze({
          kind: 'independent',
          ownerKey,
          worldId,
          worldIdentity,
          bodyGuid: body.guid,
          bodyGeneration: body.sceneGeneration,
          zoneGeneration,
          outputGeneration: body.outputGenerations.waterInfo,
          waterInfoAvailability: waterInfoSourceAvailability(body, snapshots),
          waveBody: publicationWaveBody(wave.value),
        }),
      );
    }
  }
  return ok(Object.freeze(inputs));
}

function appendIndependentBodies(
  publication: WaterInfoFramePublication,
  inputs: readonly WaterInfoPublicationInputView['bodies'][number][],
): Result<WaterInfoFramePublication, RenderError> {
  const bodies = new Map(
    publication.waveBodies.map((body) => [
      waterBodyOwnerKey(
        body.worldIdentity,
        body.bodyGuid,
        body.bodyGeneration,
        body.zoneGeneration,
      ),
      body,
    ]),
  );
  const waterInfoAvailability = new Map<string, WaterInfoSourceAvailability>();
  for (const input of inputs)
    if (input.kind === 'independent' && !publication.rows.has(input.ownerKey)) {
      bodies.set(input.ownerKey, materializePublicationWaveBody(input.waveBody, 0));
      if (input.waterInfoAvailability !== undefined)
        waterInfoAvailability.set(input.ownerKey, input.waterInfoAvailability);
    }
  const waveUploadPlan = buildWaterWaveUploadPlan([...bodies.values()]);
  if (!waveUploadPlan.ok)
    return err(
      featureFailure('valid per-view independent Body/wave/Baked publication', {
        cause: waveUploadPlan.error,
      }),
    );
  return ok(
    Object.freeze({
      ...publication,
      waterInfoAvailability,
      waveBodies: Object.freeze([...bodies.values()]),
      waveUploadPlan: waveUploadPlan.value,
    }),
  );
}

function sourceWaveBody(
  body: WaterBodySnapshot,
  capture: WaterInfoZoneRasterInput,
  worldId: number,
  worldIdentity: string,
  timeSeconds: number,
  previousTimeSeconds: number,
  system: WaterSystem,
): Result<WaterInfoPublicationWaveBody, RenderError> {
  const baked = system.bakedQueryGrid(body.guid, body.sceneGeneration);
  const waveBody = buildWaterWaveUploadBody(body, {
    worldId,
    worldIdentity,
    timeSeconds,
    previousTimeSeconds,
    meshEdgeOverlayEnabled: system.meshEdgeOverlayEnabled(),
    heightSource: !body.asset.flags.affectsWaterInfo
      ? { kind: 'fixed' }
      : { kind: 'water-info', zoneIndex: 0, slice: 0 },
    dynamicBoundsCenterExtentXZ: [...capture.context.centerXZ, ...capture.context.extentXZ],
    ...(baked === undefined ? {} : { bakedGrid: baked.grid }),
  });
  return waveBody.ok
    ? ok(publicationWaveBody(waveBody.value))
    : err(
        featureFailure('valid same-generation water wave upload input', {
          ownerKey: waterBodyOwnerKey(
            worldIdentity,
            body.guid,
            body.sceneGeneration,
            capture.zone.generation,
          ),
          cause: waveBody.error,
        }),
      );
}

function publicationCapture(capture: WaterInfoZoneRasterInput) {
  return Object.freeze({
    worldId: capture.worldId,
    worldIdentity: capture.worldIdentity,
    zoneGuid: capture.zoneGuid,
    zone: Object.freeze({
      guid: capture.zone.guid,
      generation: capture.zone.generation,
      worldMatrixM: Object.freeze([...capture.zone.worldMatrixM]),
      asset: capture.zone.asset,
    }),
    ...(capture.groundGeneration === undefined
      ? {}
      : { groundGeneration: capture.groundGeneration }),
    context: Object.freeze({
      ...capture.context,
      centerXZ: Object.freeze([...capture.context.centerXZ]) as typeof capture.context.centerXZ,
      extentXZ: Object.freeze([...capture.context.extentXZ]) as typeof capture.context.extentXZ,
    }),
    captureZM: capture.captureZM,
    waterVertices: new Float32Array(capture.waterVertices),
    ...(capture.waterDraws === undefined
      ? {}
      : { waterDraws: cloneWaterDraws(capture.waterDraws) }),
    groundVertices: new Float32Array(capture.groundVertices),
    dilationVertices: new Float32Array(capture.dilationVertices),
  });
}

function publicationMeshCandidate(
  worldId: number,
  worldIdentity: string,
  candidate: WaterMeshCandidateView,
): WaterInfoPublicationInputView['meshCandidates'][number] {
  return Object.freeze({
    worldId,
    worldIdentity,
    zoneGuid: candidate.zoneGuid,
    zoneGeneration: candidate.zoneGeneration,
    waterInfoFormat: candidate.waterInfoFormat,
    viewIdentity: candidate.viewId,
    publicationGeneration: candidate.publicationGeneration,
    sourceGenerations: Object.freeze({ ...candidate.sourceGenerations }),
    waterMeshOutputGenerations: Object.freeze({ ...candidate.waterMeshOutputGenerations }),
    owners: Object.freeze(
      candidate.receipt.buckets.flatMap((bucket) =>
        bucket.ownerDraws.map((owner) =>
          Object.freeze({ bodyGuid: owner.ownerGuid, bodyGeneration: owner.ownerGeneration }),
        ),
      ),
    ),
  });
}

function captureWaterGpuMeshes(
  context: RenderFeatureExtractContext,
  viewIdentity: string,
  position: readonly number[],
): Result<readonly WaterGpuMeshZone[], RenderError> {
  const sources: WaterGpuMeshZone[] = [];
  for (const world of [context.world]) {
    if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
    const water = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
    const visibility = context.visibilitySnapshot;
    const observe: WaterOperationObserver | undefined =
      context.beginProfileWork === undefined ? undefined : { begin: context.beginProfileWork };
    const zones = water.zoneSnapshots();
    if (!zones.some((zone) => zone.asset.gpuMesh !== undefined)) continue;
    const roster = water.waterMeshOwnerRoster(viewIdentity, observe);
    const ownerMatchScope = context.beginProfileWork?.('water/render/wgpu-mesh-owner-matching');
    let snapshots: WaterBodySnapshot[];
    try {
      snapshots = water.snapshots().filter((body) => {
        const entity = body.instanceEntity ?? Number(/^scene-entity:(\d+)$/.exec(body.guid)?.[1]);
        return (
          (!Number.isSafeInteger(entity) ||
            visibility?.effective(entity as EntityHandle) !== 'hidden') &&
          roster.some(
            (owner) =>
              owner.bodyGuid === body.guid &&
              owner.bodyGeneration === body.sceneGeneration &&
              body.binding.kind === 'bound' &&
              owner.zoneGuid === body.binding.zoneGuid &&
              owner.zoneGeneration === body.binding.zoneGeneration,
          )
        );
      });
    } finally {
      ownerMatchScope?.end();
    }
    for (const zone of zones) {
      if (zone.asset.gpuMesh === undefined) continue;
      const window = water.zoneViewWindow(zone.guid, viewIdentity, position);
      const signatureMatchScope = context.beginProfileWork?.(
        'water/render/wgpu-mesh-signature-matching',
      );
      let farTiles: NonNullable<Parameters<typeof buildWaterGpuMeshZone>[3]['farTiles']>;
      try {
        farTiles =
          (
            waterMeshCandidateViewsForRenderer(water, viewIdentity).find(
              (publication) =>
                publication.zoneGuid === zone.guid &&
                publication.zoneGeneration === zone.generation,
            ) ?? waterZoneMeshViewForRenderer(water, zone.guid, viewIdentity)
          )?.receipt.instances ?? [];
      } finally {
        signatureMatchScope?.end();
      }
      const source = buildWaterGpuMeshZone(world.identity, zone, snapshots, {
        identity: viewIdentity,
        position,
        ...(window ? { window } : {}),
        farTiles,
      });
      if (!source.ok)
        return err(featureFailure('accepted static GPU WaterMesh sources', source.error));
      if (source.value !== undefined) sources.push(source.value);
    }
  }
  return ok(Object.freeze(sources));
}

function buildWaterInfoSourceFrame(
  context: import('../features/types').RenderFeatureExtractContext,
  bodyTimes: Map<string, Map<string, number>>,
): Result<
  Readonly<{ input: WaterInfoPublicationInput; frame: WaterInfoSourceFrame }>,
  RenderError
> {
  const sourceSession =
    context.receiverSession ?? JSON.stringify([context.world].map((world) => world.identity));
  const observe: WaterOperationObserver | undefined =
    context.beginProfileWork === undefined ? undefined : { begin: context.beginProfileWork };
  const inputViews: WaterInfoPublicationInputView[] = [];
  const sourceViews: WaterInfoSourceViewFrame[] = [];
  for (const view of context.views) {
    const viewFacts = view.frame?.view;
    const sourcePosition =
      viewFacts?.cameraPosition ?? view.selectedView?.position ?? view.selectedCamera?.position;
    if (!view.render || sourcePosition === undefined) continue;
    const cameraPosition: readonly [number, number, number] = [
      Number(sourcePosition[0] ?? 0),
      Number(sourcePosition[1] ?? 0),
      Number(sourcePosition[2] ?? 0),
    ];
    if (!cameraPosition.every(Number.isFinite))
      return err(
        featureFailure('finite parsed source camera position', { viewIdentity: view.identity }),
      );
    const systems: Array<{ worldId: number; worldIdentity: string; system: WaterSystem }> = [];
    const meshOwners: WaterInfoPublicationInputView['meshOwners'][number][] = [];
    const meshCandidates: WaterInfoPublicationInputView['meshCandidates'][number][] = [];
    const candidateRefs: WaterInfoSourceViewFrame['candidates'][number][] = [];
    const captures: Array<{ system: WaterSystem; capture: WaterInfoZoneRasterInput }> = [];
    const sourceBodies: WaterInfoPublicationInputView['bodies'][number][] = [];
    let captureFailure: RenderError | undefined;
    let deferredCapture = false;
    const collectSourceWorldCaptures = (): void => {
      for (let worldId = 0; worldId < [context.world].length; worldId += 1) {
        const world = requireWaterValue(context.world);
        if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
        const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
        const worldIdentity = world.identity;
        const elapsed = world.getResource(Time).elapsed;
        const timeSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
        systems.push({ worldId, worldIdentity, system });
        for (const owner of system.waterMeshOwnerRoster(view.identity, observe))
          meshOwners.push(
            Object.freeze({
              worldId,
              worldIdentity,
              timeSeconds,
              owner: Object.freeze({ ...owner }),
            }),
          );
        const meshSignatureScope = context.beginProfileWork?.(
          'water/render/wgpu-mesh-signature-matching',
        );
        let meshCandidateViews: ReturnType<typeof waterMeshCandidateViewsForRenderer>;
        try {
          meshCandidateViews = waterMeshCandidateViewsForRenderer(system, view.identity);
        } finally {
          meshSignatureScope?.end();
        }
        for (const candidate of meshCandidateViews) {
          meshCandidates.push(publicationMeshCandidate(worldId, worldIdentity, candidate));
          candidateRefs.push({ worldId, worldIdentity, system, candidate });
        }
        for (const zone of system.zoneSnapshots()) {
          const capture = collectZoneRasterInput(
            worldId,
            worldIdentity,
            view.identity,
            cameraPosition,
            zone,
            system,
            context,
            system.zoneGroundQuerySnapshot(zone.guid),
          );
          if (capture === WATER_INFO_CAPTURE_DEFERRED) {
            deferredCapture = true;
            break;
          }
          if (capture !== undefined && 'code' in capture) {
            captureFailure = capture;
            break;
          }
          if (capture === undefined) continue;
          captures.push({ system, capture });
          for (const body of system.snapshots()) {
            if (
              body.binding.kind !== 'bound' ||
              body.binding.zoneGuid !== capture.zoneGuid ||
              body.binding.zoneGeneration !== capture.zone.generation
            )
              continue;
            const ownerKey = waterBodyOwnerKey(
              worldIdentity,
              body.guid,
              body.sceneGeneration,
              capture.zone.generation,
            );
            const waveBody = sourceWaveBody(
              body,
              capture,
              worldId,
              worldIdentity,
              timeSeconds,
              bodyTimes.get(view.identity)?.get(ownerKey) ?? timeSeconds,
              system,
            );
            if (!waveBody.ok) {
              captureFailure = waveBody.error;
              break;
            }
            sourceBodies.push(
              Object.freeze({
                kind: 'water-info',
                ownerKey,
                worldId,
                worldIdentity,
                bodyGuid: body.guid,
                bodyGeneration: body.sceneGeneration,
                outputGeneration: body.outputGenerations.waterInfo,
                zoneGuid: capture.zoneGuid,
                zoneGeneration: capture.zone.generation,
                targetFormat: targetFormatForContext(capture.context.format),
                waveBody: waveBody.value,
              }),
            );
          }
          if (captureFailure !== undefined) break;
        }
        if (captureFailure !== undefined || deferredCapture) break;
      }
    };
    collectSourceWorldCaptures();
    if (captureFailure !== undefined) context.reportError?.(captureFailure);
    const acceptedCaptures = captureFailure === undefined && !deferredCapture ? captures : [];
    const acceptedBodies = acceptedCaptures.length === captures.length ? sourceBodies : [];
    const independentSystems = [context.world].flatMap((world, worldId) =>
      world.hasResource(WATER_SYSTEM_RESOURCE)
        ? [
            {
              worldId,
              worldIdentity: world.identity,
              system: world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE),
            },
          ]
        : [],
    );
    const independent = independentBodyInputs(
      independentSystems,
      cameraPosition,
      bodyTimes.get(view.identity) ?? new Map(),
      [context.world],
      view.identity,
    );
    if (!independent.ok) return independent;
    const acceptedBodyKeys = new Set(acceptedBodies.map((body) => body.ownerKey));
    const gpuMeshes = captureWaterGpuMeshes(context, view.identity, cameraPosition);
    if (!gpuMeshes.ok) return gpuMeshes;
    const sourceFrameGeneration = context.frameNumber;
    inputViews.push(
      Object.freeze({
        viewIdentity: view.identity,
        sourceFrameGeneration,
        gpuMeshes: Object.freeze(
          gpuMeshes.value.map(({ mesh: _mesh, indexCount: _indexCount, ...source }) => source),
        ),
        captures: Object.freeze(acceptedCaptures.map(({ capture }) => publicationCapture(capture))),
        bodies: Object.freeze([
          ...acceptedBodies,
          ...independent.value.filter((body) => !acceptedBodyKeys.has(body.ownerKey)),
        ]),
        meshOwners: Object.freeze(meshOwners),
        meshCandidates: Object.freeze(meshCandidates),
      }),
    );
    sourceViews.push(
      Object.freeze({
        viewIdentity: view.identity,
        captures: Object.freeze(acceptedCaptures),
        systems: Object.freeze(systems),
        candidates: Object.freeze(candidateRefs),
      }),
    );
  }
  return ok(
    Object.freeze({
      input: Object.freeze({
        kind: 'forgeax-water-info-input',
        version: 6,
        sourceSession,
        sourceFrameGeneration: context.frameNumber,
        views: Object.freeze(inputViews),
      }),
      frame: Object.freeze({
        views: Object.freeze(sourceViews),
        ...(context.beginProfileWork === undefined
          ? {}
          : { beginProfileWork: context.beginProfileWork }),
      }),
    }),
  );
}

function cloneWaterDraws(draws: readonly WaterInfoWaterDraw[]): readonly WaterInfoWaterDraw[] {
  return Object.freeze(draws.map((draw) => Object.freeze(structuredClone(draw))));
}

function sameWaterInfoGenerationRows(
  source: WaterInfoPublicationInputView,
  receiver: WaterInfoSourceFeedback['views'][number],
): boolean {
  const sourceRows = new Set(
    source.bodies.map((row) =>
      JSON.stringify([row.ownerKey, row.bodyGeneration, row.outputGeneration, row.zoneGeneration]),
    ),
  );
  const receiverRows = new Set(
    receiver.bodies.map((row) =>
      JSON.stringify([row.ownerKey, row.bodyGeneration, row.outputGeneration, row.zoneGeneration]),
    ),
  );
  return (
    sourceRows.size === source.bodies.length &&
    receiverRows.size === receiver.bodies.length &&
    sourceRows.size === receiverRows.size &&
    [...sourceRows].every((key) => receiverRows.has(key))
  );
}

function feedbackCandidateKey(
  candidate: WaterInfoSourceFeedback['views'][number]['meshCandidates'][number],
): string {
  return JSON.stringify([
    candidate.worldIdentity,
    candidate.zoneGuid,
    candidate.zoneGeneration,
    candidate.publicationGeneration,
  ]);
}

type WaterInfoSubmissionCapture = Readonly<{
  context: Pick<WaterInfoPublicationContext, 'format'>;
  waterVertices: Float32Array;
  waterDraws?: readonly WaterInfoWaterDraw[];
  groundVertices: Float32Array;
  dilationVertices: Float32Array;
}>;

type WaterInfoSubmissionTarget = Readonly<{
  targetName: string;
  targetFormat: 'rgba16float' | 'rgba32float';
  write: boolean;
}>;

type WaterInfoSubmissionPass = RenderFeatureSubmission['works'][number]['passes'][number];

function waterInfoSubmissionPass(value: unknown): WaterInfoSubmissionPass | undefined {
  if (!isWaterInfoWireRecord(value) || !isNonEmptyWireString(value.name)) return undefined;
  if (value.graphics !== undefined) {
    if (
      !isWaterInfoWireRecord(value.graphics) ||
      !Array.isArray(value.graphics.draws) ||
      !value.graphics.draws.every(
        (draw: unknown) => isWaterInfoWireRecord(draw) && typeof draw.kind === 'string',
      )
    )
      return undefined;
  }
  if (
    value.resolvedGpuComputeDispatchCount !== undefined &&
    (!Number.isSafeInteger(value.resolvedGpuComputeDispatchCount) ||
      (value.resolvedGpuComputeDispatchCount as number) < 0)
  )
    return undefined;
  if (
    value.resolvedGpuCompute !== undefined &&
    (!isWaterInfoWireRecord(value.resolvedGpuCompute) ||
      !Array.isArray(value.resolvedGpuCompute.dispatches))
  )
    return undefined;
  return value as unknown as WaterInfoSubmissionPass;
}

function waterInfoPassesForView(
  viewIdentity: string,
  submission: RenderFeatureSubmission | undefined,
): ReadonlyMap<string, WaterInfoSubmissionPass> | undefined {
  const value: unknown = submission;
  if (!isWaterInfoWireRecord(value) || !Array.isArray(value.works)) return undefined;
  const passes = new Map<string, WaterInfoSubmissionPass>();
  let foundScope = false;
  for (const work of value.works) {
    if (!isWaterInfoWireRecord(work)) return undefined;
    const scope = work.scope;
    if (scope === 'frame') continue;
    if (!isWaterInfoWireRecord(scope) || typeof scope.view !== 'string') return undefined;
    if (scope.view !== viewIdentity) continue;
    foundScope = true;
    if (!Array.isArray(work.passes)) return undefined;
    for (const rawPass of work.passes) {
      const pass = waterInfoSubmissionPass(rawPass);
      if (pass === undefined || passes.has(pass.name)) return undefined;
      passes.set(pass.name, pass);
    }
  }
  return foundScope ? passes : undefined;
}

function waterInfoResolvedDispatchCount(pass: WaterInfoSubmissionPass): number | undefined {
  const value: unknown = pass;
  if (!isWaterInfoWireRecord(value)) return undefined;
  const summary = value.resolvedGpuComputeDispatchCount;
  const resolved = value.resolvedGpuCompute;
  if (
    summary !== undefined &&
    (typeof summary !== 'number' || !Number.isSafeInteger(summary) || summary < 0)
  )
    return undefined;
  let local: number | undefined;
  if (resolved !== undefined) {
    if (!isWaterInfoWireRecord(resolved)) return undefined;
    const dispatches = resolved.dispatches;
    if (!Array.isArray(dispatches)) return undefined;
    local = dispatches.length;
  }
  if (summary !== undefined && local !== undefined && summary !== local) return undefined;
  return (summary as number | undefined) ?? local;
}

function waterInfoHasOneDispatch(
  passes: ReadonlyMap<string, WaterInfoSubmissionPass>,
  name: string,
): boolean {
  const pass = passes.get(name);
  return pass !== undefined && waterInfoResolvedDispatchCount(pass) === 1;
}

function waterInfoRasterMatches(
  passes: ReadonlyMap<string, WaterInfoSubmissionPass>,
  name: string,
  vertices: Float32Array,
  drawCount = vertices.length > 0 ? 1 : 0,
): boolean {
  const pass = passes.get(name);
  const value: unknown = pass;
  if (
    !isWaterInfoWireRecord(value) ||
    !isWaterInfoWireRecord(value.graphics) ||
    !Array.isArray(value.graphics.draws) ||
    !(vertices instanceof Float32Array)
  )
    return false;
  const draws = value.graphics.draws;
  return (
    Array.isArray(draws) &&
    draws.length === drawCount &&
    draws.every((draw: unknown) => isWaterInfoWireRecord(draw) && draw.kind === 'draw')
  );
}

function isWaterInfoSubmissionCapture(value: unknown): value is WaterInfoSubmissionCapture {
  return (
    isWaterInfoWireRecord(value) &&
    isWaterInfoWireRecord(value.context) &&
    (value.context.format === 'rgba16f' || value.context.format === 'rgba32f') &&
    value.waterVertices instanceof Float32Array &&
    isWireWaterDraws(value.waterDraws, value.waterVertices.length / 6) &&
    value.groundVertices instanceof Float32Array &&
    value.dilationVertices instanceof Float32Array
  );
}

function isWaterInfoSubmissionTarget(value: unknown): value is WaterInfoSubmissionTarget {
  return (
    isWaterInfoWireRecord(value) &&
    isNonEmptyWireString(value.targetName) &&
    isWireWaterInfoFormat(value.targetFormat) &&
    typeof value.write === 'boolean'
  );
}

/** Prove each target was fully written or explicitly retained for this view. */
function waterInfoViewSubmissionIsComplete(
  viewIdentity: string,
  captures: readonly WaterInfoSubmissionCapture[],
  targets: readonly WaterInfoSubmissionTarget[],
  submission: RenderFeatureSubmission | undefined,
): boolean {
  if (
    !Array.isArray(captures) ||
    !captures.every(isWaterInfoSubmissionCapture) ||
    !Array.isArray(targets) ||
    !targets.every(isWaterInfoSubmissionTarget)
  )
    return false;
  const passes = waterInfoPassesForView(viewIdentity, submission);
  if (passes === undefined || !waterInfoTargetRosterIsValid(targets)) return false;
  if (targets.length === 0) return captures.length === 0;
  if (
    captures.some(
      (capture) =>
        !targets.some(
          (target) => target.targetFormat === targetFormatForContext(capture.context.format),
        ),
    )
  )
    return false;

  const writableCaptures = captures.filter((capture) =>
    targets.some(
      (target) =>
        target.write && target.targetFormat === targetFormatForContext(capture.context.format),
    ),
  );
  for (const target of targets) {
    if (!target.write) {
      if (!waterInfoHasOneDispatch(passes, `water-info-retain-${target.targetName}`)) return false;
      continue;
    }
    const targetCaptures = writableCaptures.filter(
      (capture) => targetFormatForContext(capture.context.format) === target.targetFormat,
    );
    if (
      targetCaptures.length === 0 ||
      !waterInfoHasOneDispatch(passes, `water-info-clear-array-${target.targetName}`)
    )
      return false;
    for (const capture of targetCaptures) {
      const suffix = String(writableCaptures.indexOf(capture));
      const rasterRows = [
        waterInfoRasterMatches(
          passes,
          `water-info-water-raster-${suffix}`,
          capture.waterVertices,
          capture.waterDraws?.filter((draw) => draw.vertexCount > 0).length,
        ),
        waterInfoRasterMatches(
          passes,
          `water-info-ground-raster-${suffix}`,
          capture.groundVertices,
        ),
        waterInfoRasterMatches(
          passes,
          `water-info-dilation-raster-${suffix}`,
          capture.dilationVertices,
        ),
      ];
      if (
        !rasterRows.every(Boolean) ||
        !waterInfoHasOneDispatch(passes, `water-info-merge-${suffix}`) ||
        !waterInfoHasOneDispatch(passes, `water-info-flow-blur-${suffix}`) ||
        !waterInfoHasOneDispatch(passes, `water-info-finalize-${suffix}`)
      )
        return false;
    }
  }
  return true;
}

function sourceViewWasAccepted(
  inputView: WaterInfoPublicationInputView,
  feedbackView: WaterInfoSourceFeedback['views'][number],
  submission: RenderFeatureSubmission | undefined,
): boolean {
  if (
    feedbackView === undefined ||
    inputView.sourceFrameGeneration < 0 ||
    !Number.isSafeInteger(feedbackView.receiverFrameGeneration) ||
    feedbackView.receiverFrameGeneration < 0 ||
    !Number.isSafeInteger(feedbackView.deviceGeneration) ||
    feedbackView.deviceGeneration < 0 ||
    !sameWaterInfoGenerationRows(inputView, feedbackView)
  )
    return false;
  const expectedTargets = new Map<string, string>();
  for (const capture of inputView.captures)
    expectedTargets.set(
      targetFormatForContext(capture.context.format),
      waterInfoTargetDigest(inputView.captures, targetFormatForContext(capture.context.format)),
    );
  const targetsByFormat = new Map<string, (typeof feedbackView.targets)[number][]>();
  if (!waterInfoTargetRosterIsValid(feedbackView.targets)) return false;
  for (const target of feedbackView.targets) {
    const formatTargets = targetsByFormat.get(target.targetFormat) ?? [];
    formatTargets.push(target);
    targetsByFormat.set(target.targetFormat, formatTargets);
    const expectedDigest = expectedTargets.get(target.targetFormat);
    if (target.write && (expectedDigest === undefined || target.sourceDigest !== expectedDigest))
      return false;
  }
  for (const [targetFormat, sourceDigest] of expectedTargets) {
    if (!targetsByFormat.get(targetFormat)?.some((target) => target.sourceDigest === sourceDigest))
      return false;
  }
  if (
    !waterInfoViewSubmissionIsComplete(
      inputView.viewIdentity,
      inputView.captures,
      feedbackView.targets,
      submission,
    )
  )
    return false;
  const candidateKeys = new Set(
    inputView.meshCandidates.map((candidate) =>
      JSON.stringify([
        candidate.worldIdentity,
        candidate.zoneGuid,
        candidate.zoneGeneration,
        candidate.publicationGeneration,
      ]),
    ),
  );
  return feedbackView.meshCandidates.every((candidate) =>
    candidateKeys.has(feedbackCandidateKey(candidate)),
  );
}

/** Source-side WaterInfo feature. Its only cross-worker value is a detached input DTO. */
export function createWaterInfoSourceFeature(): RenderFeature<WaterInfoPublicationInput> {
  const inactiveSourceData: WaterInfoPublicationInput = Object.freeze({
    kind: 'forgeax-water-info-input',
    version: 6,
    sourceSession: 'inactive',
    sourceFrameGeneration: 0,
    views: Object.freeze([]),
  });
  const sourceFrames = new WeakMap<
    WaterInfoPublicationInput,
    {
      readonly frame: WaterInfoSourceFrame;
      submitted: boolean;
    }
  >();
  const bodyTimes = new Map<string, Map<string, number>>();
  return {
    identity: WATER_INFO_FEATURE_IDENTITY,
    inactiveSourceData,
    profileWorkNames: WATER_INFO_PROFILE_WORK,
    placement: 'scene',
    assetDependencies: waterInfoMaterialDependencies,
    extract(context) {
      const built = buildWaterInfoSourceFrame(context, bodyTimes);
      if (!built.ok) return built;
      const liveViews = new Set(built.value.frame.views.map((view) => view.viewIdentity));
      for (const viewIdentity of bodyTimes.keys())
        if (!liveViews.has(viewIdentity)) bodyTimes.delete(viewIdentity);
      if (!context.world.hasResource(WATER_SYSTEM_RESOURCE)) return ok(inactiveSourceData);
      sourceFrames.set(built.value.input, { frame: built.value.frame, submitted: false });
      return ok(built.value.input);
    },
    plan() {
      return ok({ work: [] });
    },
    onSourceFrameSubmitted(input, feedback, submission) {
      if (!isWaterInfoPublicationInput(input) || !isWaterInfoSourceFeedback(feedback)) return;
      const receipt = feedback;
      const matchesSourceReceipt = (): boolean =>
        receipt.sourceSession === input.sourceSession &&
        receipt.sourceFrameGeneration === input.sourceFrameGeneration;
      if (!matchesSourceReceipt()) return;
      const source = sourceFrames.get(input);
      if (source === undefined) return;
      const sourceFrame = source.frame;
      for (const sourceView of sourceFrame.views) {
        const inputView = input.views.find(
          (candidate) => candidate.viewIdentity === sourceView.viewIdentity,
        );
        const feedbackView = receipt.views.find(
          (candidate) => candidate.viewIdentity === sourceView.viewIdentity,
        );
        if (
          inputView === undefined ||
          feedbackView === undefined ||
          inputView.sourceFrameGeneration !== input.sourceFrameGeneration ||
          !sourceViewWasAccepted(inputView, feedbackView, submission)
        )
          continue;
        for (const { system, capture } of sourceView.captures) {
          const targetFormat = targetFormatForContext(capture.context.format);
          const sourceDigest = waterInfoTargetDigest(inputView.captures, targetFormat);
          const target = feedbackView.targets.find(
            (candidate) =>
              candidate.targetFormat === targetFormat && candidate.sourceDigest === sourceDigest,
          );
          const currentZone = system.zoneSnapshots().find((zone) => zone.guid === capture.zoneGuid);
          const currentGround = system.zoneGroundQuerySnapshot(capture.zoneGuid);
          const groundMatches =
            capture.groundGeneration === undefined
              ? currentGround === undefined
              : currentGround?.pending === false &&
                currentGround.generation === capture.groundGeneration &&
                currentGround.zoneGeneration === capture.zone.generation;
          if (
            target?.write === true &&
            currentZone?.generation === capture.zone.generation &&
            groundMatches
          )
            acceptSubmittedWaterInfoGround(
              system,
              capture.zoneGuid,
              capture.groundGeneration,
              true,
            );
          if (
            target?.write !== true ||
            currentZone?.generation !== capture.zone.generation ||
            !groundMatches
          )
            continue;
          const acceptSubmittedSourceBodies = (): void => {
            for (const bodyInput of inputView.bodies) {
              if (
                bodyInput.worldIdentity !== capture.worldIdentity ||
                bodyInput.worldId !== capture.worldId ||
                bodyInput.zoneGuid !== capture.zoneGuid ||
                bodyInput.zoneGeneration !== capture.zone.generation ||
                bodyInput.targetFormat !== targetFormat
              )
                continue;
              const body = system.snapshot(bodyInput.bodyGuid);
              if (
                body === undefined ||
                body.sceneGeneration !== bodyInput.bodyGeneration ||
                body.outputGenerations.waterInfo !== bodyInput.outputGeneration ||
                body.asset.flags.affectsWaterInfo !== true ||
                body.binding.kind !== 'bound' ||
                body.binding.zoneGuid !== capture.zoneGuid ||
                body.binding.zoneGeneration !== capture.zone.generation
              )
                continue;
              system.acceptOutput(bodyInput.bodyGuid, 'waterInfo', bodyInput.outputGeneration, {
                generation: feedbackView.receiverFrameGeneration,
                digest: capture.context.sourceDigest,
              });
            }
          };
          acceptSubmittedSourceBodies();
        }
        const submittedSourceBodyTimes = () => {
          const viewTimes = new Map<string, number>();
          for (const row of inputView.bodies) {
            const ownerKey = waterBodyOwnerKey(
              row.worldIdentity,
              row.bodyGuid,
              row.bodyGeneration,
              row.zoneGeneration,
            );
            viewTimes.set(ownerKey, row.waveBody.timeSeconds);
          }
          for (const { worldIdentity, owner, timeSeconds } of inputView.meshOwners) {
            const ownerKey = waterBodyOwnerKey(
              worldIdentity,
              owner.bodyGuid,
              owner.bodyGeneration,
              owner.zoneGeneration,
            );
            viewTimes.set(ownerKey, timeSeconds);
          }
          return viewTimes;
        };
        const viewTimes = submittedSourceBodyTimes();
        bodyTimes.set(sourceView.viewIdentity, viewTimes);
      }
      source.submitted = true;
    },
    onSourceFrameCompleted(input, completion, feedback, submission) {
      const source = sourceFrames.get(input);
      sourceFrames.delete(input);
      if (
        source?.submitted !== true ||
        !isWaterInfoPublicationInput(input) ||
        !isWaterInfoSourceFeedback(feedback) ||
        feedback.sourceSession !== input.sourceSession ||
        feedback.sourceFrameGeneration !== input.sourceFrameGeneration
      )
        return;
      for (const sourceView of source.frame.views) {
        const inputView = input.views.find((view) => view.viewIdentity === sourceView.viewIdentity);
        const feedbackView = feedback.views.find(
          (view) => view.viewIdentity === sourceView.viewIdentity,
        );
        if (
          inputView === undefined ||
          feedbackView === undefined ||
          feedbackView.deviceGeneration !== completion.deviceGeneration ||
          feedbackView.receiverFrameGeneration !== completion.frameId ||
          !sourceViewWasAccepted(inputView, feedbackView, submission)
        )
          continue;
        for (const { system, worldIdentity, candidate } of sourceView.candidates) {
          const candidateKey = feedbackCandidateKey({
            worldIdentity,
            zoneGuid: candidate.zoneGuid,
            zoneGeneration: candidate.zoneGeneration,
            publicationGeneration: candidate.publicationGeneration,
          });
          if (
            !feedbackView.meshCandidates.some((row) => feedbackCandidateKey(row) === candidateKey)
          )
            continue;
          const capture = sourceView.captures.find(
            (row) =>
              row.system === system &&
              row.capture.zoneGuid === candidate.zoneGuid &&
              row.capture.zone.generation === candidate.zoneGeneration &&
              targetFormatForContext(row.capture.context.format) === candidate.waterInfoFormat,
          );
          if (capture === undefined) continue;
          const owners = candidate.receipt.buckets.flatMap((bucket) => bucket.ownerDraws);
          const exactClosure = owners.every((owner) => {
            if (candidate.sourceGenerations[owner.ownerGuid] !== owner.ownerGeneration)
              return false;
            const ownerKey = waterBodyOwnerKey(
              capture.capture.worldIdentity,
              owner.ownerGuid,
              owner.ownerGeneration,
              candidate.zoneGeneration,
            );
            const bodyInput = inputView.bodies.find((row) => row.ownerKey === ownerKey);
            return (
              bodyInput !== undefined &&
              bodyInput.bodyGeneration === owner.ownerGeneration &&
              bodyInput.zoneGuid === candidate.zoneGuid &&
              bodyInput.zoneGeneration === candidate.zoneGeneration &&
              bodyInput.targetFormat === candidate.waterInfoFormat
            );
          });
          if (exactClosure)
            system.acceptWaterMeshView(
              candidate.zoneGuid,
              sourceView.viewIdentity,
              candidate.publicationGeneration,
            );
        }
      }
    },
    onSourceFrameDiscarded(input) {
      sourceFrames.delete(input);
    },
  };
}

export function isWaterInfoBodyGeometryAccepted(
  body: Pick<WaterBodySnapshot, 'dirty' | 'outputs' | 'outputGenerations' | 'outputReceipts'>,
): boolean {
  const receipt = body.outputReceipts.geometry;
  return (
    !body.dirty.has('geometry') &&
    body.outputs.geometry === 'ready' &&
    receipt !== undefined &&
    receipt.outputGeneration === body.outputGenerations.geometry
  );
}

export function isWaterInfoGroundCurrent(
  ground: WaterZoneGroundSnapshot | undefined,
  zoneGeneration: number,
): boolean {
  return ground === undefined || ground.zoneGeneration === zoneGeneration;
}

export function acceptSubmittedWaterInfoGround(
  system: Pick<WaterSystem, 'acceptZoneGround'>,
  zoneGuid: string,
  groundGeneration: number | undefined,
  targetWritten: boolean,
): void {
  if (groundGeneration === undefined || !targetWritten) return;
  system.acceptZoneGround(zoneGuid, groundGeneration);
}

function acceptSubmittedWaterInfoBodies(frame: WaterInfoViewFrame): void {
  for (const capture of frame.captures) {
    if (capture.source !== 'direct') continue;
    const system = capture.system;
    const target = frame.publication.targets.find(
      (candidate) => candidate.targetFormat === targetFormatForContext(capture.context.format),
    );
    const currentZone = system.zoneSnapshots().find((zone) => zone.guid === capture.zoneGuid);
    const currentGround = system.zoneGroundQuerySnapshot(capture.zoneGuid);
    const groundGenerationMatches =
      capture.groundGeneration === undefined
        ? currentGround === undefined
        : currentGround?.pending === false &&
          currentGround.generation === capture.groundGeneration &&
          currentGround.zoneGeneration === capture.zone.generation;
    if (
      target === undefined ||
      !target.write ||
      target.contentFrameGeneration !== frame.frameGeneration ||
      currentZone?.generation !== capture.zone.generation ||
      !groundGenerationMatches
    )
      continue;
    for (const row of frame.publication.rows.values()) {
      const matchesCaptureRow = (): boolean =>
        !(
          row.frameGeneration !== frame.frameGeneration ||
          row.deviceGeneration !== frame.deviceGeneration ||
          row.context !== capture.context ||
          row.worldId !== capture.worldId ||
          row.worldIdentity !== capture.worldIdentity ||
          row.zoneGuid !== capture.zoneGuid ||
          row.zoneGeneration !== capture.zone.generation ||
          row.ownerKey !==
            waterBodyOwnerKey(
              row.worldIdentity,
              row.bodyGuid,
              row.bodyGeneration,
              row.zoneGeneration,
            ) ||
          row.targetName !== target.targetName ||
          row.targetFormat !== target.targetFormat
        );
      if (!matchesCaptureRow()) continue;
      const body = system.snapshot(row.bodyGuid);
      if (
        body === undefined ||
        body.sceneGeneration !== row.bodyGeneration ||
        body.outputGenerations.waterInfo !== row.outputGeneration ||
        body.binding.kind !== 'bound' ||
        body.binding.zoneGuid !== row.zoneGuid ||
        body.binding.zoneGeneration !== row.zoneGeneration ||
        body.asset.flags.affectsWaterInfo !== true
      )
        continue;
      system.acceptOutput(row.bodyGuid, 'waterInfo', row.outputGeneration, {
        generation: frame.frameGeneration,
        digest: row.context.sourceDigest,
      });
    }
  }
}

const WATER_INFO_CAPTURE_DEFERRED = Symbol('water-info-capture-deferred');

function bodyMesh(
  snapshot: WaterBodySnapshot,
  field: 'waterInfoMeshGuid' | 'dilatedWaterInfoMeshGuid',
): { readonly mesh: WaterInfoMeshView; readonly version: string } | undefined {
  const guid = snapshot.asset[field];
  if (guid === undefined) return undefined;
  const dependency = snapshot.dependencies.find(
    (row) =>
      row.kind === 'mesh' && row.field === field && row.guid.toLowerCase() === guid.toLowerCase(),
  );
  const mesh =
    dependency?.status === 'valid'
      ? waterInfoMeshView(dependency.payload, dependency.payloadArrayKinds)
      : undefined;
  if (mesh === undefined) return undefined;
  return { mesh, version: snapshot.outputReceipts.geometry?.digest ?? snapshot.sourceVersion };
}

function riverFlowXZByVertex(
  snapshot: WaterBodySnapshot,
  mesh: WaterInfoMeshView,
): Float32Array | undefined {
  if (snapshot.asset.type !== 'river') return undefined;
  const positions = mesh.attributes.position;
  const colors = mesh.attributes.color;
  if (colors === undefined || colors.length !== (positions.length / 3) * 4) return undefined;
  const result = new Float32Array((positions.length / 3) * 2);
  const matrix = snapshot.worldMatrixM;
  // River WaterInfo MeshAsset color is the accepted per-vertex flow encoding:
  // R stores speed / 10.24 and G stores the local tangent angle / 2pi.
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const colorOffset = vertex * 4;
    if (!Number.isFinite(colors[colorOffset]) || !Number.isFinite(colors[colorOffset + 1]))
      return undefined;
    const speed =
      Math.max(0, Math.min(1, requireWaterValue(colors[colorOffset]))) * MAX_VELOCITY_M_PER_SEC;
    const angle = requireWaterValue(colors[colorOffset + 1]) * Math.PI * 2;
    const dx =
      requireWaterValue(matrix[0]) * Math.cos(angle) +
      requireWaterValue(matrix[8]) * Math.sin(angle);
    const dz =
      requireWaterValue(matrix[2]) * Math.cos(angle) +
      requireWaterValue(matrix[10]) * Math.sin(angle);
    const length = Math.hypot(dx, dz);
    if (length > 1e-6) {
      result[vertex * 2] = (dx / length) * speed;
      result[vertex * 2 + 1] = (dz / length) * speed;
    }
  }
  return result;
}

function meshWorldYBounds(
  snapshot: WaterBodySnapshot,
  mesh: WaterInfoMeshView,
): readonly [number, number] | undefined {
  const positions = mesh.attributes.position;
  const matrix = snapshot.worldMatrixM;
  const verticalWaveScale = Math.hypot(
    requireWaterValue(matrix[1]),
    requireWaterValue(matrix[5]),
    requireWaterValue(matrix[9]),
  );
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const y =
      requireWaterValue(matrix[1]) * requireWaterValue(positions[offset]) +
      requireWaterValue(matrix[5]) * requireWaterValue(positions[offset + 1]) +
      requireWaterValue(matrix[9]) * requireWaterValue(positions[offset + 2]) +
      requireWaterValue(matrix[13]);
    minimum = Math.min(minimum, y);
    maximum = Math.max(maximum, y);
  }
  const waveExtent = snapshot.asset.maxWaveHeightM * verticalWaveScale;
  return [minimum - waveExtent, maximum + waveExtent];
}

function zoneViewBounds(
  zone: WaterZoneSnapshot,
  cameraPosition: readonly [number, number, number],
  system: WaterSystem,
  viewIdentity: string,
): { centerXZ: readonly [number, number]; extentXZ: readonly [number, number] } {
  const window = system.zoneViewWindow(zone.guid, viewIdentity, cameraPosition);
  if (!window) throw new Error('Accepted Water Zone window is unavailable');
  return window;
}

function isWaterInfoBodySourceReady(
  body: WaterBodySnapshot,
  geometryReceipt: WaterBodySnapshot['outputReceipts']['geometry'],
): boolean {
  return !(
    !isWaterInfoBodyGeometryAccepted(body) ||
    !geometryReceipt ||
    body.dependencies.some(
      (dependency) =>
        isWaterInfoSourceDependency(dependency.field) && dependency.status === 'pending',
    ) ||
    bodyWaveDependencyPending(body)
  );
}

function acceptedBodySources(
  bodies: readonly WaterBodySnapshot[],
  zone: WaterZoneSnapshot,
):
  | {
      sources: (WaterInfoTriangleSource & { readonly bodyGuid: string })[];
      bodyVersions: string[];
      waterMin: number;
      waterMax: number;
      hasWaterInfoParticipants: boolean;
    }
  | RenderError
  | typeof WATER_INFO_CAPTURE_DEFERRED
  | undefined {
  const sources: (WaterInfoTriangleSource & { readonly bodyGuid: string })[] = [];
  const bodyVersions: string[] = [];
  let hasBoundBodies = false;
  let hasWaterInfoParticipants = false;
  let waterMin = Number.POSITIVE_INFINITY;
  let waterMax = Number.NEGATIVE_INFINITY;
  for (const body of bodies) {
    if (
      body.binding.kind !== 'bound' ||
      body.binding.zoneGuid !== zone.guid ||
      body.binding.zoneGeneration !== zone.generation
    )
      continue;
    hasBoundBodies = true;
    if (!body.asset.flags.affectsWaterInfo) continue;
    hasWaterInfoParticipants = true;
    const geometryReceipt = body.outputReceipts.geometry;
    if (!isWaterInfoBodySourceReady(body, geometryReceipt)) return WATER_INFO_CAPTURE_DEFERRED;
    if (geometryReceipt === undefined) return WATER_INFO_CAPTURE_DEFERRED;
    const undilated = bodyMesh(body, 'waterInfoMeshGuid');
    if (undilated === undefined)
      return featureFailure('accepted versioned waterInfoMeshGuid MeshAsset dependency', {
        zoneGuid: zone.guid,
        bodyGuid: body.guid,
        meshGuid: body.asset.waterInfoMeshGuid,
      });
    const flowXZByVertex = riverFlowXZByVertex(body, undilated.mesh);
    if (body.asset.type === 'river' && flowXZByVertex === undefined)
      return featureFailure('per-vertex flow data for the accepted River WaterInfo mesh', {
        zoneGuid: zone.guid,
        bodyGuid: body.guid,
        meshGuid: body.asset.waterInfoMeshGuid,
      });
    sources.push({
      bodyGuid: body.guid,
      mesh: undilated.mesh,
      worldMatrixM: body.worldMatrixM,
      kind: 'water',
      velocityXZ: [0, 0],
      ...(flowXZByVertex === undefined ? {} : { flowXZByVertex }),
    });
    bodyVersions.push(
      JSON.stringify([body.guid, body.sceneGeneration, geometryReceipt.digest, undilated.version]),
    );
    if (body.asset.dilatedWaterInfoMeshGuid !== undefined) {
      const dilated = bodyMesh(body, 'dilatedWaterInfoMeshGuid');
      if (dilated === undefined)
        return featureFailure('accepted versioned dilatedWaterInfoMeshGuid MeshAsset dependency', {
          zoneGuid: zone.guid,
          bodyGuid: body.guid,
          meshGuid: body.asset.dilatedWaterInfoMeshGuid,
        });
      sources.push({
        bodyGuid: body.guid,
        mesh: dilated.mesh,
        worldMatrixM: body.worldMatrixM,
        kind: 'dilation',
      });
      bodyVersions.push(JSON.stringify([body.guid, 'd', dilated.version]));
    }
    const meshBounds = meshWorldYBounds(body, undilated.mesh);
    if (meshBounds === undefined)
      return featureFailure(
        'finite accepted WaterInfo mesh positions for vertical capture bounds',
        { zoneGuid: zone.guid, bodyGuid: body.guid, meshGuid: body.asset.waterInfoMeshGuid },
      );
    waterMin = Math.min(waterMin, meshBounds[0]);
    waterMax = Math.max(waterMax, meshBounds[1]);
  }
  if (!hasBoundBodies) return undefined;
  if (!Number.isFinite(waterMin) || !Number.isFinite(waterMax)) {
    // Fixed-height bodies still need a current descriptor row, but cannot define B-channel normalization.
    waterMin = 0;
    waterMax = 0;
  }
  if (hasWaterInfoParticipants && waterMin === waterMax) {
    waterMin -= 5e-5;
    waterMax += 5e-5;
  }
  return { sources, bodyVersions, waterMin, waterMax, hasWaterInfoParticipants };
}

function resolveWaterInfoMaterial(
  context: RenderFeatureExtractContext,
  worldId: number,
  guid: string,
): Result<NonNullable<WaterInfoWaterDraw['material']>, RenderError> {
  const assets = context.world?.assets;
  if (assets === undefined)
    return err(
      featureFailure('ordinary loaded WaterInfo material', {
        worldId,
        guid,
        reason: 'asset-owner-unavailable',
      }),
    );
  const registry = runtimeAssetRegistry(assets);
  const handle = runtimeAssetReference(registry, guid);
  const captured =
    handle === undefined ? undefined : captureFeatureSourceAssetVersion(context, handle);
  if (handle === undefined || captured?.ok !== true || captured.value.value.kind !== 'material')
    return err(
      featureFailure('ordinary loaded WaterInfo material', {
        worldId,
        guid,
        reason: 'material-unavailable',
      }),
    );
  const { revision, value: material } = captured.value;
  const pass = material.passes?.find(
    (candidate) => materialPassLightMode(candidate) === 'WaterInfo',
  );
  if (pass === undefined)
    return err(
      featureFailure('explicit WaterInfo material pass', { worldId, guid, reason: 'pass-missing' }),
    );
  try {
    const program = materialProgramSelectionsForMaterial(
      material,
      registry,
      context.materialContext,
    )?.find((candidate) => candidate.pass === pass.name);
    const abi = program?.abi;
    if (
      program === undefined ||
      abi === undefined ||
      (abi.bindings !== 'group-0' && abi.bindings !== 'render-material') ||
      abi.sceneDepth !== undefined ||
      abi.vertexInputs.length !== 2 ||
      !abi.vertexInputs.some((input) => input.location === 0 && input.format === 'float32x4') ||
      !abi.vertexInputs.some((input) => input.location === 1 && input.format === 'float32x2')
    )
      return err(
        featureFailure('cooked WaterInfo position/flow material ABI', {
          worldId,
          guid,
          reason: 'abi-unavailable',
        }),
      );
    return ok({
      handle,
      revision,
      shader: program.specializationKey,
      bindings: abi.bindings,
      renderState: {
        cullMode: 'none',
        depthCompare: 'greater',
        depthWriteEnabled: true,
        ...pass.renderState,
      },
    });
  } catch (cause) {
    return err(
      featureFailure('WaterInfo material specialization cooked for this renderer', {
        worldId,
        guid,
        cause,
      }),
    );
  }
}

function waterInfoMaterialDependencies(
  data: WaterInfoFeatureFrame | WaterInfoPublicationInput,
): number[] {
  return data.views.flatMap((view) =>
    view.captures.flatMap((capture) =>
      (capture.waterDraws ?? []).flatMap((draw) =>
        draw.material === undefined ? [] : [draw.material.handle],
      ),
    ),
  );
}

function waterInfoMaterialCacheToken(
  context: RenderFeatureExtractContext,
  worldId: number,
  guid: string,
) {
  const selected = resolveWaterInfoMaterial(context, worldId, guid);
  return selected.ok
    ? [selected.value.handle, selected.value.revision, selected.value.shader]
    : [selected.error.code, guid];
}

function collectZoneRasterInput(
  worldId: number,
  worldIdentity: string,
  viewId: string,
  cameraPosition: readonly [number, number, number],
  zone: WaterZoneSnapshot,
  system: WaterSystem,
  extractContext: RenderFeatureExtractContext,
  expectedGround: WaterZoneGroundQuerySnapshot | undefined,
): WaterInfoZoneRasterInput | RenderError | typeof WATER_INFO_CAPTURE_DEFERRED | undefined {
  if (expectedGround?.pending === true) return WATER_INFO_CAPTURE_DEFERRED;
  if (!waterInfoZoneTransformSupported(zone.worldMatrixM))
    return featureFailure(
      'axis-aligned WaterZone transform supported by the published center/extent descriptor ABI',
      { zoneGuid: zone.guid, worldMatrixM: zone.worldMatrixM },
    );
  const local = zone.asset.waterInfo.localTessellation;
  const qualifiedZoneGuid = JSON.stringify([worldIdentity, zone.guid]);
  const bodies = system.snapshots();
  const selected = acceptedBodySources(bodies, zone);
  if (selected === undefined || selected === WATER_INFO_CAPTURE_DEFERRED) return selected;
  if ('code' in selected) return selected;
  const ground = system.zoneGroundSnapshot(
    zone.guid,
    extractContext.beginProfileWork === undefined
      ? undefined
      : { begin: extractContext.beginProfileWork },
  );
  const currentGround = system.zoneGroundQuerySnapshot(zone.guid);
  const matchesGroundGeneration = (): boolean =>
    !(
      currentGround?.pending === true ||
      expectedGround?.generation !== currentGround?.generation ||
      expectedGround?.zoneGeneration !== currentGround?.zoneGeneration ||
      ground?.generation !== currentGround?.generation ||
      ground?.zoneGeneration !== currentGround?.zoneGeneration ||
      !isWaterInfoGroundCurrent(ground, zone.generation)
    );
  if (!matchesGroundGeneration()) return WATER_INFO_CAPTURE_DEFERRED;
  const rows: number[] = [...buildWaterInfoTriangleBuffer(selected.sources)];
  let groundMin = Number.POSITIVE_INFINITY;
  let groundMax = Number.NEGATIVE_INFINITY;
  const appendAcceptedGround = () => {
    for (const provider of ground?.providers ?? []) {
      const terrain = (provider as typeof provider & { readonly terrainAsset?: TerrainAsset })
        .terrainAsset;
      if (terrain === undefined || terrain.kind !== 'terrain')
        return featureFailure(
          'version-matched accepted TerrainAsset on every intersecting Zone provider',
          {
            zoneGuid: zone.guid,
            terrainGuid: provider.terrainGuid,
            terrainVersion: provider.terrainVersion,
          },
        );
      const before = rows.length;
      appendWaterInfoTerrainTriangles(rows, { terrain, worldMatrixM: provider.worldMatrixM });
      if (rows.length === before)
        return featureFailure('non-empty top-view triangles from accepted TerrainAsset', {
          zoneGuid: zone.guid,
          terrainGuid: provider.terrainGuid,
        });
      for (let z = 0; z < terrain.rows; z += 1)
        for (let x = 0; x < terrain.columns; x += 1) {
          const height =
            requireWaterValue(provider.worldMatrixM[1]) * x * terrain.spacing +
            requireWaterValue(provider.worldMatrixM[5]) *
              requireWaterValue(terrain.heights[z * terrain.columns + x]) +
            requireWaterValue(provider.worldMatrixM[9]) * z * terrain.spacing +
            requireWaterValue(provider.worldMatrixM[13]);
          groundMin = Math.min(groundMin, height);
          groundMax = Math.max(groundMax, height);
        }
    }
    return undefined;
  };
  const groundFailure = appendAcceptedGround();
  if (groundFailure !== undefined) return groundFailure;
  if (!Number.isFinite(groundMin)) {
    groundMin = selected.waterMin - WATER_FALLBACK_DEPTH_M;
    groundMax = selected.waterMax;
  }
  // Empty-water targets have no B samples; extend only their synthetic upper bound for ground A encoding.
  const waterYMaxM = selected.hasWaterInfoParticipants
    ? selected.waterMax
    : Math.max(selected.waterMax, groundMax);
  const bounds = zoneViewBounds(zone, cameraPosition, system, viewId);
  const centerXZ = bounds.centerXZ;
  const sourceDigest = JSON.stringify([
    zone.generation,
    selected.bodyVersions,
    ground?.generation ?? 0,
    ground?.providers.map((row) => [row.terrainGuid, row.terrainVersion]) ?? [],
    centerXZ,
    bounds.extentXZ,
  ]);
  const triangles = new Float32Array([...rows]);
  const captureZM = Math.max(waterYMaxM, groundMax) + UNDERGROUND_DILATION_OFFSET_M;
  const context: WaterInfoPublicationContext = Object.freeze({
    zoneGuid: qualifiedZoneGuid,
    viewId: local ? viewId : 'shared',
    centerXZ,
    extentXZ: bounds.extentXZ,
    waterYMinM: selected.waterMin,
    waterYMaxM,
    groundYMinM: groundMin,
    maxVelocityMPerSec: MAX_VELOCITY_M_PER_SEC,
    format: zone.asset.waterInfo.format,
    widthPx: zone.asset.waterInfo.resolution.widthPx,
    heightPx: zone.asset.waterInfo.resolution.heightPx,
    blurRadius: Math.min(16, Math.max(0, Math.round(zone.asset.waterInfo.blurRadius))),
    zoneGeneration: zone.generation,
    sourceDigest,
  });
  const projectWaterMaterialDraws = () => {
    const waterDraws: WaterInfoWaterDraw[] = [];
    let firstVertex = 0;
    for (const source of selected.sources) {
      if (source.kind !== 'water') continue;
      const vertexCount =
        rasterVerticesForKind(
          buildWaterInfoTriangleBuffer([source]),
          context,
          captureZM,
          groundMin,
          0,
        ).length / 6;
      const body = requireWaterValue(
        bodies.find((candidate) => candidate.guid === source.bodyGuid),
      );
      let material: WaterInfoWaterDraw['material'];
      if (body.asset.waterInfoMaterialGuid !== undefined) {
        const resolved = resolveWaterInfoMaterial(
          extractContext,
          worldId,
          body.asset.waterInfoMaterialGuid,
        );
        if (!resolved.ok) return err(resolved.error);
        material = resolved.value;
      }
      waterDraws.push({
        bodyGuid: body.guid,
        bodyGeneration: body.sceneGeneration,
        firstVertex,
        vertexCount,
        ...(material === undefined ? {} : { material }),
      });
      firstVertex += vertexCount;
    }
    return ok(waterDraws);
  };
  const drawResult = projectWaterMaterialDraws();
  if (!drawResult.ok) return drawResult.error;
  const waterDraws = drawResult.value;
  return {
    worldId,
    worldIdentity,
    zoneGuid: zone.guid,
    zone,
    ...(ground === undefined ? {} : { groundGeneration: ground.generation }),
    context: {
      ...context,
      sourceDigest: JSON.stringify([
        sourceDigest,
        waterDraws.map((draw) => [
          draw.bodyGuid,
          draw.material?.handle,
          draw.material?.revision,
          draw.material?.shader,
        ]),
      ]),
    },
    waterVertices: rasterVerticesForKind(triangles, context, captureZM, groundMin, 0),
    waterDraws,
    groundVertices: rasterVerticesForKind(triangles, context, captureZM, groundMin, 2),
    dilationVertices: rasterVerticesForKind(triangles, context, captureZM, groundMin, 1),
    captureZM,
  };
}

function collectZoneCapture(
  worldId: number,
  worldIdentity: string,
  cacheIdentity: string,
  cacheKey: string,
  expectedGround: WaterZoneGroundQuerySnapshot | undefined,
  viewId: string,
  cameraPosition: readonly [number, number, number],
  deviceGeneration: number,
  frameGeneration: number,
  zone: WaterZoneSnapshot,
  system: WaterSystem,
  allocator: WaterInfoSliceAllocator,
  extractContext: RenderFeatureExtractContext,
): WaterInfoZoneCapture | RenderError | typeof WATER_INFO_CAPTURE_DEFERRED | undefined {
  const raster = collectZoneRasterInput(
    worldId,
    worldIdentity,
    viewId,
    cameraPosition,
    zone,
    system,
    extractContext,
    expectedGround,
  );
  if (raster === undefined || raster === WATER_INFO_CAPTURE_DEFERRED || 'code' in raster)
    return raster;
  const reservation = allocator.reserve({
    zoneGuid: JSON.stringify([worldIdentity, zone.guid]),
    viewId,
    mode: zone.asset.waterInfo.localTessellation ? 'view-local' : 'shared-zone',
    deviceGeneration,
    resourceGroup: targetFormatForContext(
      zone.asset.waterInfo.format === 'rgba32f' ? 'rgba32f' : 'rgba16f',
    ),
  });
  if (reservation === undefined)
    return featureFailure('available WaterInfo array slice within renderer limits', {
      zoneGuid: JSON.stringify([worldIdentity, zone.guid]),
      viewId,
      capacity: allocator.maxSlices,
    });
  const context = createWaterInfoContext(
    {
      zoneGuid: raster.context.zoneGuid,
      viewId,
      zone: zone.asset,
      centerXZ: raster.context.centerXZ,
      extentXZ: raster.context.extentXZ,
      waterYMinM: raster.context.waterYMinM,
      waterYMaxM: raster.context.waterYMaxM,
      groundYMinM: raster.context.groundYMinM,
      maxVelocityMPerSec: raster.context.maxVelocityMPerSec,
      zoneGeneration: raster.context.zoneGeneration,
      deviceGeneration,
      frameGeneration,
      sourceDigest: raster.context.sourceDigest,
    },
    reservation,
  );
  if (context === undefined)
    return featureFailure('valid current WaterInfo descriptor context', {
      zoneGuid: zone.guid,
      viewId,
    });
  return {
    ...raster,
    source: 'direct',
    cacheIdentity,
    cacheKey,
    system,
    context,
    reservation,
  };
}

function materializePublicationWaveBody(
  body: WaterInfoPublicationWaveBody,
  slice: number,
): WaterWaveUploadBody {
  const fixed = Object.freeze({
    fixedHeightM: body.heightSource.fixedHeightM,
    fixedDepthM: body.heightSource.fixedDepthM,
    fixedVelocityXZ: Object.freeze([
      ...body.heightSource.fixedVelocityXZ,
    ]) as typeof body.heightSource.fixedVelocityXZ,
  });
  const heightSource =
    body.heightSource.kind === 'fixed'
      ? Object.freeze({ ...fixed, kind: 'fixed' as const })
      : Object.freeze({ ...fixed, kind: body.heightSource.kind, zoneIndex: slice, slice });
  return Object.freeze({
    ...body,
    heightSource,
    ...(body.bakedGrid === undefined
      ? {}
      : { bakedGrid: snapshotWaterBakedQueryGrid(body.bakedGrid) }),
    ...(body.dynamicBoundsCenterExtentXZ === undefined
      ? {}
      : {
          dynamicBoundsCenterExtentXZ: Object.freeze([
            ...body.dynamicBoundsCenterExtentXZ,
          ]) as typeof body.dynamicBoundsCenterExtentXZ,
        }),
  });
}

function retireWaterInfoReceiverState(
  context: RenderFeaturePlanContext,
  state: WaterInfoPublicationState,
  allocator: WaterInfoSliceAllocator,
  committedReservations: Set<string>,
): void {
  const liveDevices = new Map(
    context.views
      .filter((view) => view.render)
      .map((view) => [view.identity, view.sceneData.deviceGeneration]),
  );
  for (const [key, publication] of state.pending)
    if (liveDevices.get(publication.viewIdentity) !== publication.deviceGeneration)
      state.pending.delete(key);
  for (const [key, publication] of state.submitted)
    if (liveDevices.get(publication.viewIdentity) !== publication.deviceGeneration) {
      state.submitted.delete(key);
      state.reservations.delete(key);
      state.bodyTimes.delete(publication.viewIdentity);
    }
  for (const key of state.history.keys()) {
    const parts = parseTupleKey(key);
    if (
      parts?.length !== 2 ||
      typeof parts[0] !== 'string' ||
      typeof parts[1] !== 'number' ||
      liveDevices.get(parts[0]) !== parts[1]
    )
      state.history.delete(key);
  }
  committedReservations.clear();
  for (const reservations of state.reservations.values())
    for (const key of reservations) committedReservations.add(key);
  allocator.releaseExcept(committedReservations);
}

function materializeWaterInfoPublication(
  input: WaterInfoPublicationInput,
  context: RenderFeaturePlanContext,
  allocator: WaterInfoSliceAllocator,
  state: WaterInfoPublicationState,
  committedReservations: Set<string>,
): Result<WaterInfoFeatureFrame, RenderError> {
  const frameGeneration = context.frame.frameNumber;
  const fail = (failure: RenderError): Result<WaterInfoFeatureFrame, RenderError> => {
    allocator.releaseExcept(committedReservations);
    return err(failure);
  };
  if (
    !Number.isSafeInteger(input.sourceFrameGeneration) ||
    input.sourceFrameGeneration < 0 ||
    !Number.isSafeInteger(frameGeneration) ||
    frameGeneration < 0
  )
    return fail(
      featureFailure('non-negative renderer frame generations for WaterInfo publication', {
        sourceFrameGeneration: input.sourceFrameGeneration,
        receiverFrameGeneration: frameGeneration,
      }),
    );
  const views: WaterInfoViewFrame[] = [];
  const seenViews = new Set<string>();
  retireWaterInfoReceiverState(context, state, allocator, committedReservations);

  for (const inputView of input.views) {
    if (
      seenViews.has(inputView.viewIdentity) ||
      inputView.sourceFrameGeneration !== input.sourceFrameGeneration
    )
      return fail(
        featureFailure(
          'unique WaterInfo view identities with the matching source frame generation',
          {
            viewIdentity: inputView.viewIdentity,
            sourceFrameGeneration: inputView.sourceFrameGeneration,
            expectedFrameGeneration: input.sourceFrameGeneration,
          },
        ),
      );
    seenViews.add(inputView.viewIdentity);
    const planView = context.views.find(
      (view) => view.identity === inputView.viewIdentity && view.render,
    );
    if (planView === undefined) continue;
    const deviceGeneration = planView.sceneData.deviceGeneration;
    const history = observeWaterInfoTargetHistory(
      state,
      inputView.viewIdentity,
      deviceGeneration,
      planView.graphResources,
    );
    allocator.invalidateDevice(deviceGeneration);
    const admitReceivedCaptures = (): Result<WaterInfoZoneCapture[], RenderError> => {
      const captures: WaterInfoZoneCapture[] = [];
      const captureKeys = new Set<string>();
      for (const inputCapture of inputView.captures) {
        if (
          inputCapture.context.zoneGeneration !== inputCapture.zone.generation ||
          inputCapture.zoneGuid !== inputCapture.zone.guid ||
          inputCapture.context.zoneGuid !==
            JSON.stringify([inputCapture.worldIdentity, inputCapture.zoneGuid]) ||
          inputCapture.context.viewId !==
            (inputCapture.zone.asset.waterInfo.localTessellation
              ? inputView.viewIdentity
              : 'shared') ||
          !Number.isFinite(inputCapture.captureZM) ||
          !(inputCapture.waterVertices instanceof Float32Array) ||
          !(inputCapture.groundVertices instanceof Float32Array) ||
          !(inputCapture.dilationVertices instanceof Float32Array) ||
          [
            inputCapture.waterVertices,
            inputCapture.groundVertices,
            inputCapture.dilationVertices,
          ].some((vertices) => vertices.length % 6 !== 0 || !vertices.every(Number.isFinite))
        )
          return err(
            featureFailure('matching WaterZone input and raster generations', {
              viewIdentity: inputView.viewIdentity,
              zoneGuid: inputCapture.zoneGuid,
              zoneGeneration: inputCapture.context.zoneGeneration,
              snapshotGeneration: inputCapture.zone.generation,
            }),
          );
        const captureKey = JSON.stringify([
          inputCapture.worldIdentity,
          inputCapture.zoneGuid,
          inputCapture.zone.generation,
        ]);
        if (captureKeys.has(captureKey))
          return err(
            featureFailure('unique WaterInfo capture per World/Zone generation', { captureKey }),
          );
        captureKeys.add(captureKey);
        const local = inputCapture.zone.asset.waterInfo.localTessellation;
        const reservation = allocator.reserve({
          zoneGuid: inputCapture.context.zoneGuid,
          viewId: inputView.viewIdentity,
          mode: local ? 'view-local' : 'shared-zone',
          deviceGeneration,
          resourceGroup: targetFormatForContext(inputCapture.context.format),
        });
        if (reservation === undefined) {
          return err(
            featureFailure('available WaterInfo array slice within renderer limits', {
              zoneGuid: inputCapture.context.zoneGuid,
              viewId: inputView.viewIdentity,
              capacity: allocator.maxSlices,
            }),
          );
        }
        const waterContext = createWaterInfoContext(
          waterInfoContextInput(
            inputCapture.context,
            inputCapture.zone,
            inputView.viewIdentity,
            deviceGeneration,
            frameGeneration,
          ),
          reservation,
        );
        if (waterContext === undefined) {
          return err(
            featureFailure('valid receiver WaterInfo descriptor context', {
              viewIdentity: inputView.viewIdentity,
              zoneGuid: inputCapture.zoneGuid,
            }),
          );
        }
        captures.push({
          source: 'received',
          worldId: inputCapture.worldId,
          worldIdentity: inputCapture.worldIdentity,
          zoneGuid: inputCapture.zoneGuid,
          zone: inputCapture.zone,
          ...(inputCapture.groundGeneration === undefined
            ? {}
            : { groundGeneration: inputCapture.groundGeneration }),
          context: waterContext,
          reservation,
          waterVertices: new Float32Array(inputCapture.waterVertices),
          ...(inputCapture.waterDraws === undefined
            ? {}
            : { waterDraws: cloneWaterDraws(inputCapture.waterDraws) }),
          groundVertices: new Float32Array(inputCapture.groundVertices),
          dilationVertices: new Float32Array(inputCapture.dilationVertices),
          captureZM: inputCapture.captureZM,
        });
      }

      return ok(captures);
    };
    const captureResult = admitReceivedCaptures();
    if (!captureResult.ok) return fail(captureResult.error);
    const captures = captureResult.value;

    const previousPublication = history.publication;
    const targets = planWaterInfoTargets(captures, history, frameGeneration);

    const projectReceivedBodyRows = () => {
      const rows = new Map<string, WaterInfoDescriptorRow>();
      const waveBodies = new Map<string, WaterWaveUploadBody>();
      for (const capture of captures) {
        const targetFormat = targetFormatForContext(capture.context.format);
        const target = targets.find((candidate) => candidate.targetFormat === targetFormat);
        if (target === undefined) continue;
        for (const bodyInput of inputView.bodies) {
          if (
            bodyInput.worldId !== capture.worldId ||
            bodyInput.worldIdentity !== capture.worldIdentity ||
            bodyInput.zoneGuid !== capture.zoneGuid ||
            bodyInput.zoneGeneration !== capture.zone.generation ||
            bodyInput.targetFormat !== targetFormat
          )
            continue;
          const ownerKey = waterBodyOwnerKey(
            bodyInput.worldIdentity,
            bodyInput.bodyGuid,
            bodyInput.bodyGeneration,
            bodyInput.zoneGeneration,
          );
          if (bodyInput.ownerKey !== ownerKey) {
            return err(
              featureFailure(
                'WaterInfo body owner key qualified by exact World/body/Zone generations',
                { ownerKey: bodyInput.ownerKey },
              ),
            );
          }
          const sourceWave = bodyInput.waveBody;
          if (
            sourceWave.worldId !== bodyInput.worldId ||
            sourceWave.worldIdentity !== bodyInput.worldIdentity ||
            sourceWave.bodyGuid !== bodyInput.bodyGuid ||
            sourceWave.bodyGeneration !== bodyInput.bodyGeneration ||
            sourceWave.zoneGeneration !== bodyInput.zoneGeneration ||
            (sourceWave.heightSource.kind !== 'fixed' &&
              sourceWave.heightSource.kind !== 'water-info' &&
              sourceWave.heightSource.kind !== 'baked')
          ) {
            return err(
              featureFailure('Wave upload body matched to its WaterInfo owner generations', {
                ownerKey,
              }),
            );
          }
          const row: WaterInfoDescriptorRow = Object.freeze({
            ownerKey,
            worldId: bodyInput.worldId,
            worldIdentity: bodyInput.worldIdentity,
            bodyGuid: bodyInput.bodyGuid,
            bodyGeneration: bodyInput.bodyGeneration,
            outputGeneration: bodyInput.outputGeneration,
            zoneGuid: bodyInput.zoneGuid,
            zoneGeneration: bodyInput.zoneGeneration,
            deviceGeneration,
            frameGeneration,
            targetName: target.targetName,
            targetFormat,
            slice: capture.context.slice,
            descriptor: waterInfoDescriptorBytes(capture.context),
            context: capture.context,
          });
          rows.set(ownerKey, row);
          waveBodies.set(
            ownerKey,
            materializePublicationWaveBody(bodyInput.waveBody, capture.context.slice),
          );
        }
      }

      return ok({ rows, waveBodies });
    };
    const joinedBodies = projectReceivedBodyRows();
    if (!joinedBodies.ok) return fail(joinedBodies.error);
    const { rows, waveBodies } = joinedBodies.value;

    const receiverProxyRoster = (): Map<string, WaterMeshProxyRef> => {
      const proxyRoster = new Map<string, WaterMeshProxyRef>();
      for (const entry of inputView.meshOwners)
        proxyRoster.set(
          proxyOwnerIdentity(
            entry.worldIdentity,
            entry.owner.bodyGuid,
            entry.owner.bodyGeneration,
            entry.owner.zoneGeneration,
          ),
          {
            worldId: entry.worldId,
            worldIdentity: entry.worldIdentity,
            timeSeconds: entry.timeSeconds,
            owner: entry.owner,
          },
        );
      return proxyRoster;
    };
    const proxyRoster = receiverProxyRoster();
    const retained = retainProxyPublication(
      previousPublication,
      proxyRoster,
      state.bodyTimes.get(inputView.viewIdentity) ?? new Map(),
      inputView.viewIdentity,
      frameGeneration,
      deviceGeneration,
    );
    if (!retained.ok) {
      return fail(retained.error);
    }
    const combineReceiverPublication = () => {
      const combinedRows = new Map<string, WaterInfoDescriptorRow>(retained.value.rows);
      for (const [ownerKey, row] of rows) combinedRows.set(ownerKey, row);
      const combinedWaveBodies = new Map<string, WaterWaveUploadBody>();
      for (const [ownerKey, body] of waveBodies) combinedWaveBodies.set(ownerKey, body);
      for (const body of retained.value.waveBodies) {
        const ownerKey = waterBodyOwnerKey(
          body.worldIdentity,
          body.bodyGuid,
          body.bodyGeneration,
          body.zoneGeneration,
        );
        if (combinedRows.has(ownerKey) && !combinedWaveBodies.has(ownerKey))
          combinedWaveBodies.set(ownerKey, body);
      }
      const retainedNames = new Set(
        [...combinedRows.values()]
          .filter((row) => !targets.some((target) => target.targetName === row.targetName))
          .map((row) => row.targetName),
      );
      const previousTargets = new Map(
        retained.value.targets.map((target) => [target.targetName, target]),
      );
      const retainedTargets = [...retainedNames].flatMap((targetName) => {
        const target = previousTargets.get(targetName);
        return target === undefined ? [] : [Object.freeze({ ...target, write: false })];
      });
      const publicationTargets = [...targets, ...retainedTargets];
      const retainedWaveBodies = [...combinedWaveBodies]
        .filter(([ownerKey]) => combinedRows.has(ownerKey))
        .map(([, body]) => body);
      return { combinedRows, retainedNames, publicationTargets, retainedWaveBodies };
    };
    const { combinedRows, retainedNames, publicationTargets, retainedWaveBodies } =
      combineReceiverPublication();
    const waveUploadPlan = buildWaterWaveUploadPlan(retainedWaveBodies);
    if (!waveUploadPlan.ok) {
      return fail(
        featureFailure('valid per-view water wave upload plan', {
          viewIdentity: inputView.viewIdentity,
          cause: waveUploadPlan.error,
        }),
      );
    }
    const admitPublicationTargetCapabilities = (): RenderError | undefined => {
      for (const target of publicationTargets) {
        const renderableCapability =
          target.targetFormat === 'rgba32float'
            ? context.caps.rgba32floatRenderable
            : context.caps.rgba16floatRenderable;
        if (renderableCapability !== true) {
          return new RenderFeatureCapabilityMissingError(
            WATER_INFO_FEATURE_IDENTITY,
            -1,
            target.targetFormat === 'rgba32float'
              ? 'rgba32floatRenderable'
              : 'rgba16floatRenderable',
          );
        }
        const storageCapability =
          target.targetFormat === 'rgba32float'
            ? context.caps.rgba32floatStorage
            : context.caps.rgba16floatStorage;
        if (storageCapability !== true) {
          return new RenderFeatureCapabilityMissingError(
            WATER_INFO_FEATURE_IDENTITY,
            -1,
            target.targetFormat === 'rgba32float' ? 'rgba32floatStorage' : 'rgba16floatStorage',
          );
        }
      }
      return undefined;
    };
    const capabilityFailure = admitPublicationTargetCapabilities();
    if (capabilityFailure !== undefined) return fail(capabilityFailure);
    const graphResourceVersion = publicationTargets
      .map((target) => `${target.targetName}:${target.graphResourceVersion}`)
      .join('|');
    const publication: WaterInfoFramePublication = Object.freeze({
      viewIdentity: inputView.viewIdentity,
      frameGeneration,
      deviceGeneration,
      graphResourceVersion,
      targets: Object.freeze(publicationTargets),
      rows: combinedRows,
      waterInfoAvailability: new Map(),
      waveBodies: Object.freeze(retainedWaveBodies),
      waveUploadPlan: waveUploadPlan.value,
      bindingSnapshots: Object.freeze(
        (retained.value.bindingSnapshots ?? []).filter((snapshot) =>
          snapshot.targets.some((target) => retainedNames.has(target.targetName)),
        ),
      ),
      gpuMeshes: Object.freeze(
        inputView.gpuMeshes.map((source) => {
          const template = waterMeshGridTemplate(Math.log2(source.quadsPerDraw), 0, false).unwrap();
          return Object.freeze({
            ...structuredClone(source),
            mesh: template.mesh,
            indexCount: template.indexCount,
          });
        }),
      ),
    });
    const independentPublication = appendIndependentBodies(publication, inputView.bodies);
    if (!independentPublication.ok) return fail(independentPublication.error);
    const frame: WaterInfoViewFrame = Object.freeze({
      viewIdentity: inputView.viewIdentity,
      deviceGeneration,
      frameGeneration,
      history,
      captures: Object.freeze(captures),
      systems: Object.freeze([]),
      ...(context.beginProfileWork === undefined
        ? {}
        : { beginProfileWork: context.beginProfileWork }),
      publication: independentPublication.value,
    });
    views.push(frame);
  }
  const frame: WaterInfoFeatureFrame = Object.freeze({
    kind: 'forgeax-water-info-frame',
    views: Object.freeze(views),
  });
  for (const view of frame.views)
    state.pending.set(
      publicationKey(view.viewIdentity, view.frameGeneration, view.deviceGeneration),
      view.publication,
    );
  return ok(frame);
}

function receiverFeedbackForWaterInfoInput(
  input: WaterInfoPublicationInput,
  frame: WaterInfoFeatureFrame,
): WaterInfoSourceFeedback {
  const feedbackViews = frame.views.flatMap((view) => {
    const inputView = input.views.find((candidate) => candidate.viewIdentity === view.viewIdentity);
    if (inputView === undefined) return [];
    const bodies = inputView.bodies
      .filter((body) => {
        if (body.kind === 'independent') {
          const index = view.publication.waveUploadPlan.bodyIndices.get(body.ownerKey);
          const row =
            index === undefined ? undefined : view.publication.waveUploadPlan.bodyData[index];
          return (
            row?.bodyGeneration === body.bodyGeneration &&
            view.publication.waveUploadPlan.bodyZoneGenerations.get(body.ownerKey) ===
              body.zoneGeneration
          );
        }
        const row = view.publication.rows.get(body.ownerKey);
        return (
          row !== undefined &&
          row.bodyGeneration === body.bodyGeneration &&
          row.outputGeneration === body.outputGeneration &&
          row.zoneGeneration === body.zoneGeneration
        );
      })
      .map((body) =>
        Object.freeze({
          ownerKey: body.ownerKey,
          bodyGeneration: body.bodyGeneration,
          outputGeneration: body.outputGeneration,
          zoneGeneration: body.zoneGeneration,
        }),
      );
    const meshCandidates = inputView.meshCandidates
      .filter((candidate) => {
        const capture = view.captures.find(
          (row) =>
            row.worldIdentity === candidate.worldIdentity &&
            row.zoneGuid === candidate.zoneGuid &&
            row.zone.generation === candidate.zoneGeneration &&
            targetFormatForContext(row.context.format) === candidate.waterInfoFormat,
        );
        if (capture === undefined) return false;
        return candidate.owners.every((owner) => {
          if (candidate.sourceGenerations[owner.bodyGuid] !== owner.bodyGeneration) return false;
          const ownerKey = waterBodyOwnerKey(
            candidate.worldIdentity,
            owner.bodyGuid,
            owner.bodyGeneration,
            candidate.zoneGeneration,
          );
          const row = view.publication.rows.get(ownerKey);
          return (
            row !== undefined &&
            row.zoneGuid === candidate.zoneGuid &&
            row.zoneGeneration === candidate.zoneGeneration &&
            row.targetFormat === candidate.waterInfoFormat &&
            view.publication.waveUploadPlan.bodyIndices.has(ownerKey)
          );
        });
      })
      .map((candidate) =>
        Object.freeze({
          worldIdentity: candidate.worldIdentity,
          zoneGuid: candidate.zoneGuid,
          zoneGeneration: candidate.zoneGeneration,
          publicationGeneration: candidate.publicationGeneration,
        }),
      );
    return [
      Object.freeze({
        viewIdentity: view.viewIdentity,
        receiverFrameGeneration: view.frameGeneration,
        deviceGeneration: view.deviceGeneration,
        targets: Object.freeze(
          view.publication.targets.map((target) =>
            Object.freeze({
              targetName: target.targetName,
              targetFormat: target.targetFormat,
              sourceDigest: target.sourceDigest,
              write: target.write,
            }),
          ),
        ),
        bodies: Object.freeze(bodies),
        meshCandidates: Object.freeze(meshCandidates),
      }),
    ];
  });
  return Object.freeze({
    kind: 'forgeax-water-info-submitted',
    sourceSession: input.sourceSession,
    sourceFrameGeneration: input.sourceFrameGeneration,
    views: Object.freeze(feedbackViews),
  });
}

type WaterInfoCaptureDeferralRequest = Readonly<{
  viewIdentity: string;
  deviceGeneration: number;
}>;

type WaterInfoCaptureDeferralObservation = WaterInfoCaptureDeferralRequest &
  Readonly<{
    frameGeneration: number;
    retainedTargets: readonly Readonly<{
      targetName: string;
      contentFrameGeneration: number;
    }>[];
    candidateTargets: readonly string[];
  }>;

/** Internal native-test control; ordinary feature construction has no fault state. */
export function createWaterInfoCaptureDeferralProbe() {
  let request: WaterInfoCaptureDeferralRequest | undefined;
  let deferred: WaterInfoCaptureDeferralObservation | undefined;
  return Object.freeze({
    feature: createWaterInfoFeatureOwned((observation) => {
      if (
        request?.viewIdentity !== observation.viewIdentity ||
        request.deviceGeneration !== observation.deviceGeneration
      )
        return false;
      request = undefined;
      deferred = observation;
      return true;
    }),
    deferNextCapture(next: WaterInfoCaptureDeferralRequest) {
      request = Object.freeze({ ...next });
      deferred = undefined;
    },
    inspect() {
      return Object.freeze({ request: request ?? null, deferred: deferred ?? null });
    },
  });
}

export function createWaterInfoFeature(): RenderFeature<WaterInfoFeatureFrame> {
  return createWaterInfoFeatureOwned();
}

function createWaterInfoFeatureOwned(
  deferCapture?: (observation: WaterInfoCaptureDeferralObservation) => boolean,
): RenderFeature<WaterInfoFeatureFrame> {
  const inactiveSourceData: WaterInfoFeatureFrame = Object.freeze({
    kind: 'forgeax-water-info-frame',
    views: Object.freeze([]),
  });
  const allocator = new WaterInfoSliceAllocator(MAX_WATER_INFO_SLICES);
  const state: WaterInfoPublicationState = {
    pending: new Map(),
    submitted: new Map(),
    bodyTimes: new Map(),
    reservations: new Map(),
    history: new Map(),
    captureCache: new Map(),
  };
  const committedReservations = new Set<string>();
  const receiverFrames = new WeakMap<WaterInfoPublicationInput, WaterInfoFeatureFrame>();
  const knownFrames = new WeakSet<object>();
  const meshCompletionKey = (frame: number, device: number) => JSON.stringify([frame, device]);
  const submittedMeshCandidates = new Map<
    string,
    readonly Readonly<{
      frame: WaterInfoViewFrame;
      system: WaterSystem;
      candidate: WaterMeshCandidateView;
    }>[]
  >();
  const feature: RenderFeature<WaterInfoFeatureFrame> = {
    identity: WATER_INFO_FEATURE_IDENTITY,
    inactiveSourceData,
    source: createWaterInfoSourceFeature() as RenderFeature<unknown>,
    profileWorkNames: WATER_INFO_PROFILE_WORK,
    placement: 'scene',
    requiredCapabilities: ['compute', 'storageBuffer', 'storageTexture'],
    shaderModuleMode: 'immediate',
    assetDependencies: waterInfoMaterialDependencies,
    requiredMaterialShaders: [
      WATER_INFO_RASTER_WATER_ID,
      WATER_INFO_RASTER_GROUND_ID,
      WATER_INFO_RASTER_DILATION_ID,
    ],
    extract(context) {
      const observe: WaterOperationObserver | undefined =
        context.beginProfileWork === undefined ? undefined : { begin: context.beginProfileWork };
      const liveViewDevices = new Map(
        context.views
          .filter((view) => view.render && view.frame?.view !== undefined)
          .map((view) => [
            view.identity,
            requireWaterValue(requireWaterValue(view.frame).view).deviceGeneration,
          ]),
      );
      const retireExtractedOwners = (): void => {
        for (const [key, candidates] of submittedMeshCandidates) {
          if (
            !candidates.some(
              ({ frame }) =>
                liveViewDevices.get(frame.viewIdentity) === frame.deviceGeneration &&
                state.history.get(historyKey(frame.viewIdentity, frame.deviceGeneration)) ===
                  frame.history,
            )
          )
            submittedMeshCandidates.delete(key);
        }
        for (const world of [context.world]) {
          if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
          const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
          for (const [viewId, deviceGeneration] of liveViewDevices)
            system.observeWaterMeshViewDevice(viewId, deviceGeneration);
        }
        for (const [key, publication] of state.pending) {
          if (liveViewDevices.get(publication.viewIdentity) === publication.deviceGeneration)
            continue;
          state.pending.delete(key);
        }
        for (const [key, publication] of state.submitted) {
          if (liveViewDevices.get(publication.viewIdentity) === publication.deviceGeneration)
            continue;
          state.submitted.delete(key);
          state.reservations.delete(key);
          state.bodyTimes.delete(publication.viewIdentity);
        }
        for (const key of state.history.keys()) {
          const parts = parseTupleKey(key);
          if (
            parts?.length !== 2 ||
            typeof parts[0] !== 'string' ||
            typeof parts[1] !== 'number' ||
            liveViewDevices.get(parts[0]) !== parts[1]
          )
            state.history.delete(key);
        }
        const retireDeadCaptureCache = () => {
          for (const key of state.captureCache.keys()) {
            const parts = parseTupleKey(key);
            if (
              parts?.length !== 5 ||
              typeof parts[0] !== 'string' ||
              typeof parts[1] !== 'number' ||
              typeof parts[2] !== 'string' ||
              liveViewDevices.get(parts[0]) !== parts[1] ||
              ![context.world].some((world) => world.identity === parts[2])
            )
              state.captureCache.delete(key);
          }
        };
        retireDeadCaptureCache();
        for (const viewIdentity of state.bodyTimes.keys())
          if (!liveViewDevices.has(viewIdentity)) state.bodyTimes.delete(viewIdentity);
        committedReservations.clear();
        for (const reservations of state.reservations.values())
          for (const key of reservations) committedReservations.add(key);
        allocator.releaseExcept(committedReservations);
      };
      retireExtractedOwners();
      const views: WaterInfoViewFrame[] = [];
      const liveCaptureIdentitiesByView = new Map<string, Set<string>>();
      const reservationKeysToKeep = (): Set<string> => {
        const keys = new Set(committedReservations);
        for (const frame of views)
          for (const capture of frame.captures) keys.add(reservationKey(capture.reservation));
        return keys;
      };
      for (const view of context.views) {
        if (!view.render || !view.frame?.view) continue;
        const facts = view.frame.view;
        allocator.invalidateDevice(facts.deviceGeneration);
        const history = observeWaterInfoTargetHistory(
          state,
          view.identity,
          facts.deviceGeneration,
          view.graphResources,
        );
        const previousPublication = history.publication;
        const proxyRoster = new Map<string, WaterMeshProxyRef>();
        const systems: Array<
          Readonly<{ worldId: number; worldIdentity: string; system: WaterSystem }>
        > = [];
        const collectViewProxyRoster = (): void => {
          for (let worldId = 0; worldId < [context.world].length; worldId += 1) {
            const world = requireWaterValue(context.world);
            if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
            const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
            systems.push({ worldId, worldIdentity: world.identity, system });
            const elapsed = world.getResource(Time).elapsed;
            const timeSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
            for (const owner of system.waterMeshOwnerRoster(view.identity, observe)) {
              proxyRoster.set(
                proxyOwnerIdentity(
                  world.identity,
                  owner.bodyGuid,
                  owner.bodyGeneration,
                  owner.zoneGeneration,
                ),
                {
                  worldId,
                  worldIdentity: world.identity,
                  timeSeconds,
                  owner,
                },
              );
            }
          }
        };
        collectViewProxyRoster();
        const captures: WaterInfoZoneCapture[] = [];
        let retryError: RenderError | undefined;
        let deferredCapture = false;
        const retainPreviousOnFailure = (failure?: RenderError): Result<void, RenderError> => {
          if (failure !== undefined) context.reportError?.(failure);
          allocator.releaseExcept(reservationKeysToKeep());
          const retained = retainProxyPublication(
            previousPublication,
            proxyRoster,
            state.bodyTimes.get(view.identity) ?? new Map(),
            view.identity,
            context.frameNumber,
            facts.deviceGeneration,
          );
          if (!retained.ok) return err(retained.error);
          const publication = retained.value;
          views.push(
            Object.freeze({
              viewIdentity: view.identity,
              deviceGeneration: facts.deviceGeneration,
              frameGeneration: context.frameNumber,
              history,
              captures: Object.freeze([]),
              systems: Object.freeze(systems),
              publication,
            }),
          );
          return ok(undefined);
        };
        const liveCaptureIdentities = new Set<string>();
        liveCaptureIdentitiesByView.set(view.identity, liveCaptureIdentities);
        const collectViewCaptures = (): void => {
          for (let worldId = 0; worldId < [context.world].length; worldId += 1) {
            const world = requireWaterValue(context.world);
            if (!world.hasResource(WATER_SYSTEM_RESOURCE)) continue;
            const system = world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
            for (const zone of system.zoneSnapshots()) {
              const cacheIdentity = captureCacheIdentity(
                view.identity,
                facts.deviceGeneration,
                world.identity,
                zone.guid,
                zone.generation,
              );
              liveCaptureIdentities.add(cacheIdentity);
              const expectedGround = system.zoneGroundQuerySnapshot(zone.guid);
              const cacheKey = captureCacheKey(
                worldId,
                world.identity,
                view.identity,
                facts.cameraPosition,
                facts.deviceGeneration,
                zone,
                system,
                context,
                expectedGround,
              );
              const cached = state.captureCache.get(cacheIdentity);
              if (cached?.key === cacheKey && cached.capture.system === system) {
                captures.push(cached.capture);
                continue;
              }
              const capture = collectZoneCapture(
                worldId,
                world.identity,
                cacheIdentity,
                cacheKey,
                expectedGround,
                view.identity,
                facts.cameraPosition,
                facts.deviceGeneration,
                context.frameNumber,
                zone,
                system,
                allocator,
                context,
              );
              if (capture === WATER_INFO_CAPTURE_DEFERRED) {
                deferredCapture = true;
                break;
              }
              if (capture !== undefined && 'code' in capture) {
                retryError = capture;
                break;
              }
              if (capture !== undefined) captures.push(capture);
            }
            if (retryError !== undefined || deferredCapture) break;
          }
        };
        collectViewCaptures();
        if (retryError !== undefined || deferredCapture || captures.length === 0) {
          const retained = retainPreviousOnFailure(retryError);
          if (!retained.ok) return retained;
          continue;
        }
        const targets = planWaterInfoTargets(captures, history, context.frameNumber);
        const shouldDeferCandidateCapture = (): boolean =>
          Boolean(
            previousPublication !== undefined &&
              targets.some((target) => target.write) &&
              deferCapture?.(
                Object.freeze({
                  viewIdentity: view.identity,
                  deviceGeneration: facts.deviceGeneration,
                  frameGeneration: context.frameNumber,
                  retainedTargets: Object.freeze(
                    previousPublication.targets.map((target) =>
                      Object.freeze({
                        targetName: target.targetName,
                        contentFrameGeneration: target.contentFrameGeneration,
                      }),
                    ),
                  ),
                  candidateTargets: Object.freeze(targets.map((target) => target.targetName)),
                }),
              ),
          );
        if (shouldDeferCandidateCapture()) {
          const retained = retainPreviousOnFailure();
          if (!retained.ok) return retained;
          continue;
        }
        const rows = new Map<string, WaterInfoDescriptorRow>();
        const waveBodies: WaterWaveUploadBody[] = [];
        const projectDirectBodyRows = (): void => {
          for (const capture of captures) {
            const ownerWorld = context.world;
            if (ownerWorld === undefined || !ownerWorld.hasResource(WATER_SYSTEM_RESOURCE))
              continue;
            const ownerSystem = ownerWorld.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
            const elapsed = ownerWorld.getResource(Time).elapsed;
            const timeSeconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
            for (const body of ownerSystem.snapshots()) {
              if (
                body.binding.kind !== 'bound' ||
                body.binding.zoneGuid !== capture.zoneGuid ||
                body.binding.zoneGeneration !== capture.zone.generation
              )
                continue;
              const ownerWorldIdentity = ownerWorld.identity;
              const ownerKey = waterBodyOwnerKey(
                ownerWorldIdentity,
                body.guid,
                body.sceneGeneration,
                capture.zone.generation,
              );
              rows.set(
                ownerKey,
                Object.freeze({
                  ownerKey,
                  worldId: capture.worldId,
                  worldIdentity: ownerWorldIdentity,
                  bodyGuid: body.guid,
                  bodyGeneration: body.sceneGeneration,
                  outputGeneration: body.outputGenerations.waterInfo,
                  zoneGuid: capture.zoneGuid,
                  zoneGeneration: capture.zone.generation,
                  deviceGeneration: facts.deviceGeneration,
                  frameGeneration: context.frameNumber,
                  targetName: requireWaterValue(
                    targets.find(
                      (target) =>
                        target.targetFormat === targetFormatForContext(capture.context.format),
                    ),
                  ).targetName,
                  targetFormat: targetFormatForContext(capture.context.format),
                  slice: capture.context.slice,
                  descriptor: waterInfoDescriptorBytes(capture.context),
                  context: capture.context,
                }),
              );
              const previousTimeSeconds =
                state.bodyTimes.get(view.identity)?.get(ownerKey) ?? timeSeconds;
              const baked = ownerSystem.bakedQueryGrid(body.guid, body.sceneGeneration);
              const waveBody = buildWaterWaveUploadBody(body, {
                worldId: capture.worldId,
                worldIdentity: ownerWorldIdentity,
                timeSeconds,
                previousTimeSeconds,
                meshEdgeOverlayEnabled: ownerSystem.meshEdgeOverlayEnabled(),
                heightSource: !body.asset.flags.affectsWaterInfo
                  ? { kind: 'fixed' }
                  : {
                      kind: 'water-info',
                      zoneIndex: capture.context.slice,
                      slice: capture.context.slice,
                    },
                dynamicBoundsCenterExtentXZ: [
                  ...capture.context.centerXZ,
                  ...capture.context.extentXZ,
                ],
                ...(baked ? { bakedGrid: baked.grid } : {}),
              });
              if (!waveBody.ok) {
                retryError = featureFailure('valid same-generation water wave upload input', {
                  ownerKey,
                  cause: waveBody.error,
                });
                break;
              }
              waveBodies.push(waveBody.value);
            }
            if (retryError !== undefined) break;
          }
        };
        projectDirectBodyRows();
        if (retryError !== undefined) {
          const retained = retainPreviousOnFailure(retryError);
          if (!retained.ok) return retained;
          continue;
        }
        const retainedPrevious = retainProxyPublication(
          previousPublication,
          proxyRoster,
          state.bodyTimes.get(view.identity) ?? new Map(),
          view.identity,
          context.frameNumber,
          facts.deviceGeneration,
        );
        if (!retainedPrevious.ok) {
          allocator.releaseExcept(reservationKeysToKeep());
          return retainedPrevious;
        }
        const combineRetainedBodyPublication = () => {
          const combinedRows = new Map<string, WaterInfoDescriptorRow>(retainedPrevious.value.rows);
          for (const [ownerKey, row] of rows) combinedRows.set(ownerKey, row);
          const combinedWaveBodies = new Map<string, WaterWaveUploadBody>();
          for (const body of waveBodies)
            combinedWaveBodies.set(
              waterBodyOwnerKey(
                body.worldIdentity,
                body.bodyGuid,
                body.bodyGeneration,
                body.zoneGeneration,
              ),
              body,
            );
          for (const body of retainedPrevious.value.waveBodies) {
            const ownerKey = waterBodyOwnerKey(
              body.worldIdentity,
              body.bodyGuid,
              body.bodyGeneration,
              body.zoneGeneration,
            );
            if (combinedRows.has(ownerKey) && !combinedWaveBodies.has(ownerKey))
              combinedWaveBodies.set(ownerKey, body);
          }
          const retainedNames = new Set(
            [...combinedRows.values()]
              .filter((row) => !targets.some((target) => target.targetName === row.targetName))
              .map((row) => row.targetName),
          );
          const previousTargets = new Map(
            retainedPrevious.value.targets.map((target) => [target.targetName, target]),
          );
          const retainedTargets = [...retainedNames].flatMap((targetName) => {
            const target = previousTargets.get(targetName);
            return target === undefined ? [] : [Object.freeze({ ...target, write: false })];
          });
          const publicationTargets = [...targets, ...retainedTargets];
          const retainedWaveBodies = [...combinedWaveBodies]
            .filter(([ownerKey]) => combinedRows.has(ownerKey))
            .map(([, body]) => body);
          return { combinedRows, retainedNames, publicationTargets, retainedWaveBodies };
        };
        const { combinedRows, retainedNames, publicationTargets, retainedWaveBodies } =
          combineRetainedBodyPublication();
        const waveUploadPlan = buildWaterWaveUploadPlan(retainedWaveBodies);
        if (!waveUploadPlan.ok) {
          const retained = retainPreviousOnFailure(
            featureFailure('valid per-view water wave upload plan', {
              viewIdentity: view.identity,
              cause: waveUploadPlan.error,
            }),
          );
          if (!retained.ok) return retained;
          continue;
        }
        const admitDirectTargetCapabilities = () => {
          for (const target of publicationTargets) {
            const renderableCapability =
              target.targetFormat === 'rgba32float'
                ? context.caps?.rgba32floatRenderable
                : context.caps?.rgba16floatRenderable;
            if (renderableCapability !== true) {
              allocator.releaseExcept(reservationKeysToKeep());
              return err(
                new RenderFeatureCapabilityMissingError(
                  WATER_INFO_FEATURE_IDENTITY,
                  -1,
                  target.targetFormat === 'rgba32float'
                    ? 'rgba32floatRenderable'
                    : 'rgba16floatRenderable',
                ),
              );
            }
            const storageCapability =
              target.targetFormat === 'rgba32float'
                ? context.caps?.rgba32floatStorage
                : context.caps?.rgba16floatStorage;
            if (storageCapability !== true) {
              allocator.releaseExcept(reservationKeysToKeep());
              return err(
                new RenderFeatureCapabilityMissingError(
                  WATER_INFO_FEATURE_IDENTITY,
                  -1,
                  target.targetFormat === 'rgba32float'
                    ? 'rgba32floatStorage'
                    : 'rgba16floatStorage',
                ),
              );
            }
          }
          return undefined;
        };
        const capabilityFailure = admitDirectTargetCapabilities();
        if (capabilityFailure !== undefined) return capabilityFailure;
        const graphResourceVersion = publicationTargets
          .map((target) => `${target.targetName}:${target.graphResourceVersion}`)
          .join('|');
        const publication: WaterInfoFramePublication = Object.freeze({
          viewIdentity: view.identity,
          frameGeneration: context.frameNumber,
          deviceGeneration: facts.deviceGeneration,
          graphResourceVersion,
          targets: Object.freeze(publicationTargets),
          rows: combinedRows,
          waterInfoAvailability: new Map(),
          waveBodies: Object.freeze(retainedWaveBodies),
          waveUploadPlan: waveUploadPlan.value,
          bindingSnapshots: Object.freeze(
            (retainedPrevious.value.bindingSnapshots ?? []).filter((snapshot) =>
              snapshot.targets.some((target) => retainedNames.has(target.targetName)),
            ),
          ),
        });
        views.push(
          Object.freeze({
            viewIdentity: view.identity,
            deviceGeneration: facts.deviceGeneration,
            frameGeneration: context.frameNumber,
            history,
            captures: Object.freeze(captures),
            systems: Object.freeze(systems),
            publication,
          }),
        );
      }
      const appendIndependentViewPublication = () => {
        for (const key of state.captureCache.keys()) {
          const parts = parseTupleKey(key);
          if (
            parts?.length === 5 &&
            typeof parts[0] === 'string' &&
            typeof parts[1] === 'number' &&
            liveViewDevices.get(parts[0]) === parts[1] &&
            !liveCaptureIdentitiesByView.get(parts[0])?.has(key)
          )
            state.captureCache.delete(key);
        }
        for (let index = 0; index < views.length; index += 1) {
          const view = requireWaterValue(views[index]);
          const cameraPosition = context.views.find(
            (candidate) => candidate.identity === view.viewIdentity,
          )?.frame?.view?.cameraPosition;
          if (cameraPosition === undefined)
            return err(
              featureFailure('the selected view camera position for independent Body bounds', {
                viewIdentity: view.viewIdentity,
              }),
            );
          const independent = independentBodyInputs(
            view.systems,
            cameraPosition,
            state.bodyTimes.get(view.viewIdentity) ?? new Map(),
            [context.world],
            view.viewIdentity,
          );
          if (!independent.ok) return independent;
          const publication = appendIndependentBodies(view.publication, independent.value);
          if (!publication.ok) return publication;
          const gpuMeshes = captureWaterGpuMeshes(context, view.viewIdentity, cameraPosition);
          if (!gpuMeshes.ok) return gpuMeshes;
          const current = Object.freeze({ ...publication.value, gpuMeshes: gpuMeshes.value });
          views[index] = Object.freeze({ ...view, publication: current });
          state.pending.set(
            publicationKey(view.viewIdentity, view.frameGeneration, view.deviceGeneration),
            current,
          );
        }
        return undefined;
      };
      const independentFailure = appendIndependentViewPublication();
      if (independentFailure !== undefined) return independentFailure;
      return ok(waterInfoSourceFrame(context, views, inactiveSourceData, knownFrames));
    },
    plan(data: WaterInfoFeatureFrame | WaterInfoPublicationInput, context) {
      let frame: WaterInfoFeatureFrame;
      let sourceFeedback: WaterInfoSourceFeedback | undefined;
      const dataKind = waterInfoFrameDataKind(data);
      switch (dataKind) {
        case 'publication-input': {
          if (!isWaterInfoPublicationInput(data))
            return err(
              featureFailure('well-formed WaterInfo publication wire input', {
                kind: 'forgeax-water-info-input',
              }),
            );
          const materialized = materializeWaterInfoPublication(
            data,
            context,
            allocator,
            state,
            committedReservations,
          );
          if (!materialized.ok) return materialized;
          frame = materialized.value;
          knownFrames.add(frame);
          receiverFrames.set(data, frame);
          sourceFeedback = receiverFeedbackForWaterInfoInput(data, frame);
          break;
        }
        case 'feature-frame':
          if (data !== inactiveSourceData && !knownFrames.has(data as object))
            return err(
              featureFailure('internally extracted WaterInfo feature frame', {
                kind: 'forgeax-water-info-frame',
              }),
            );
          frame = data as WaterInfoFeatureFrame;
          break;
        default:
          return err(
            featureFailure(
              'recognized WaterInfo publication input or internally extracted feature frame',
              { kind: dataKind },
            ),
          );
      }
      let pendingSource: RenderFeaturePlan['pendingSource'];
      for (const viewFrame of frame.views)
        for (const source of viewFrame.publication.gpuMeshes ?? []) {
          const signatureMatchScope = context.beginProfileWork?.(
            'water/render/wgpu-mesh-signature-matching',
          );
          let readiness: ReturnType<typeof waterGpuMeshPublicationReadiness>;
          try {
            readiness = waterGpuMeshPublicationReadiness(source, viewFrame.publication);
          } finally {
            signatureMatchScope?.end();
          }
          if (!readiness.ok) return readiness;
          pendingSource ??= readiness.value;
        }
      if (pendingSource !== undefined)
        return ok({ pendingSource, work: [] } satisfies RenderFeaturePlan);
      const work: RenderFeatureWork[] = [];
      for (const viewFrame of frame.views) {
        const row = makeWork(viewFrame, context);
        if (!row.ok) return row;
        work.push(row.value);
      }
      return ok({
        work,
        ...(sourceFeedback === undefined ? {} : { sourceFeedback }),
      } satisfies RenderFeaturePlan);
    },
    onFrameSubmitted(data: WaterInfoFeatureFrame | WaterInfoPublicationInput, submission) {
      const meshCandidates: Array<
        NonNullable<ReturnType<typeof submittedMeshCandidates.get>>[number]
      > = [];
      const dataKind = waterInfoFrameDataKind(data);
      let receivedInput: WaterInfoPublicationInput | undefined;
      let frameData: WaterInfoFeatureFrame | undefined;
      if (dataKind === 'publication-input') {
        if (!isWaterInfoPublicationInput(data)) return;
        receivedInput = data;
        frameData = receiverFrames.get(receivedInput);
      } else if (dataKind === 'feature-frame' && knownFrames.has(data as object)) {
        frameData = data as WaterInfoFeatureFrame;
      } else return;
      if (frameData === undefined) return;
      const acceptedViews = new Set(
        frameData.views
          .filter(
            (frame) =>
              state.history.get(historyKey(frame.viewIdentity, frame.deviceGeneration)) ===
                frame.history &&
              waterInfoViewSubmissionIsComplete(
                frame.viewIdentity,
                frame.captures,
                frame.publication.targets,
                submission,
              ),
          )
          .map((frame) => frame.viewIdentity),
      );
      const submittedViews = frameData.views.filter((frame) =>
        acceptedViews.has(frame.viewIdentity),
      );
      const submittedByView = new Map(
        submittedViews.map((frame) => [
          frame.viewIdentity,
          publicationKey(frame.viewIdentity, frame.frameGeneration, frame.deviceGeneration),
        ]),
      );
      for (const frame of frameData.views) {
        const key = publicationKey(
          frame.viewIdentity,
          frame.frameGeneration,
          frame.deviceGeneration,
        );
        const pending = state.pending.get(key);
        if (!acceptedViews.has(frame.viewIdentity)) {
          if (pending === frame.publication) state.pending.delete(key);
          continue;
        }
        if (pending === frame.publication) {
          state.submitted.set(key, pending);
          frame.history.publication = pending;
          state.pending.delete(key);
          const commitSubmittedTargetHistory = () => {
            for (const target of pending.targets) {
              if (!target.write) continue;
              frame.history.activeTargets.set(target.targetFormat, target);
            }
            const viewTimes = new Map<string, number>();
            for (const bodyKey of pending.waveUploadPlan.bodyIndices.keys()) {
              const bodyIndex = pending.waveUploadPlan.bodyIndices.get(bodyKey);
              const bodyData =
                bodyIndex === undefined ? undefined : pending.waveUploadPlan.bodyData[bodyIndex];
              if (bodyData !== undefined) viewTimes.set(bodyKey, bodyData.timeSeconds);
            }
            state.bodyTimes.set(frame.viewIdentity, viewTimes);
          };
          commitSubmittedTargetHistory();
          const reservations = new Set<string>();
          const commitCaptureReservations = () => {
            for (const capture of frame.captures) {
              const target = pending.targets.find(
                (candidate) =>
                  candidate.targetFormat === targetFormatForContext(capture.context.format),
              );
              if (capture.source === 'direct')
                acceptSubmittedWaterInfoGround(
                  capture.system,
                  capture.zoneGuid,
                  capture.groundGeneration,
                  target?.write === true,
                );
              if (target?.write === true)
                allocator.commit(capture.reservation, {
                  frameGeneration: frame.frameGeneration,
                  graphResourceVersion: capture.context.graphResourceVersion,
                });
              reservations.add(reservationKey(capture.reservation));
              if (capture.source === 'direct')
                state.captureCache.set(capture.cacheIdentity, { key: capture.cacheKey, capture });
            }
            acceptSubmittedWaterInfoBodies(frame);
          };
          commitCaptureReservations();
          const collectSubmittedMeshCandidates = (): void => {
            for (const { worldIdentity, system } of frame.systems) {
              for (const candidate of waterMeshCandidateViewsForRenderer(
                system,
                frame.viewIdentity,
              )) {
                const zoneCapture = frame.captures.some(
                  (capture) =>
                    capture.source === 'direct' &&
                    capture.system === system &&
                    capture.zone.guid === candidate.zoneGuid &&
                    capture.zone.generation === candidate.zoneGeneration &&
                    targetFormatForContext(capture.context.format) === candidate.waterInfoFormat,
                );
                if (!zoneCapture) continue;
                const owners = candidate.receipt.buckets.flatMap((bucket) => bucket.ownerDraws);
                const exactClosure = owners.every((owner) => {
                  if (candidate.sourceGenerations[owner.ownerGuid] !== owner.ownerGeneration)
                    return false;
                  const ownerKey = waterBodyOwnerKey(
                    worldIdentity,
                    owner.ownerGuid,
                    owner.ownerGeneration,
                    candidate.zoneGeneration,
                  );
                  const row = pending.rows.get(ownerKey);
                  return (
                    row !== undefined &&
                    row.worldIdentity === worldIdentity &&
                    row.bodyGeneration === owner.ownerGeneration &&
                    row.zoneGuid === candidate.zoneGuid &&
                    row.zoneGeneration === candidate.zoneGeneration &&
                    row.targetFormat === candidate.waterInfoFormat &&
                    row.frameGeneration === frame.frameGeneration &&
                    pending.waveUploadPlan.bodyIndices.has(ownerKey)
                  );
                });
                if (exactClosure) meshCandidates.push({ frame, system, candidate });
              }
            }
          };
          collectSubmittedMeshCandidates();
          state.reservations.set(key, reservations);
        }
      }
      const retirePreviousSubmissions = () => {
        for (const [key, publication] of state.submitted) {
          const submittedKey = submittedByView.get(publication.viewIdentity);
          if (submittedKey === undefined || submittedKey === key) continue;
          state.submitted.delete(key);
          state.reservations.delete(key);
        }
        for (const row of meshCandidates) {
          const key = meshCompletionKey(row.frame.frameGeneration, row.frame.deviceGeneration);
          submittedMeshCandidates.set(key, [...(submittedMeshCandidates.get(key) ?? []), row]);
        }
        const liveViewIdentities = new Set(frameData.views.map((frame) => frame.viewIdentity));
        for (const viewIdentity of state.bodyTimes.keys())
          if (!liveViewIdentities.has(viewIdentity)) state.bodyTimes.delete(viewIdentity);
        committedReservations.clear();
        for (const reservations of state.reservations.values())
          for (const key of reservations) committedReservations.add(key);
        allocator.releaseExcept(committedReservations);
      };
      retirePreviousSubmissions();
      if (receivedInput !== undefined) receiverFrames.delete(receivedInput);
    },
    onFrameReceipt(receipt) {
      const key = meshCompletionKey(receipt.frameId, receipt.deviceGeneration);
      const candidates = submittedMeshCandidates.get(key);
      if (candidates === undefined) return;
      void receipt.completed
        .then((completed) => {
          if (submittedMeshCandidates.get(key) !== candidates) return;
          submittedMeshCandidates.delete(key);
          if (!completed.ok) return;
          for (const { frame, system, candidate } of candidates) {
            if (
              frame.frameGeneration !== receipt.frameId ||
              frame.deviceGeneration !== receipt.deviceGeneration ||
              state.history.get(historyKey(frame.viewIdentity, frame.deviceGeneration)) !==
                frame.history
            )
              continue;
            system.acceptWaterMeshView(
              candidate.zoneGuid,
              frame.viewIdentity,
              candidate.publicationGeneration,
            );
          }
        })
        .catch(() => {
          if (submittedMeshCandidates.get(key) === candidates) submittedMeshCandidates.delete(key);
        });
    },
    onFrameAborted(data: WaterInfoFeatureFrame | WaterInfoPublicationInput) {
      const dataKind = waterInfoFrameDataKind(data);
      let receivedInput: WaterInfoPublicationInput | undefined;
      let frameData: WaterInfoFeatureFrame | undefined;
      if (dataKind === 'publication-input') {
        if (!isWaterInfoPublicationInput(data)) return;
        receivedInput = data;
        frameData = receiverFrames.get(receivedInput);
      } else if (dataKind === 'feature-frame' && knownFrames.has(data as object)) {
        frameData = data as WaterInfoFeatureFrame;
      } else return;
      if (frameData === undefined) return;
      knownFrames.delete(frameData);
      for (const frame of frameData.views) {
        submittedMeshCandidates.delete(
          meshCompletionKey(frame.frameGeneration, frame.deviceGeneration),
        );
        const key = publicationKey(
          frame.viewIdentity,
          frame.frameGeneration,
          frame.deviceGeneration,
        );
        if (state.pending.get(key) === frame.publication) state.pending.delete(key);
      }
      allocator.releaseExcept(committedReservations);
      if (receivedInput !== undefined) receiverFrames.delete(receivedInput);
    },
  };
  publicationStates.set(feature, state);
  return feature;
}

import {
  cloneWaterWaveUploadBody,
  featureFailure,
  historyKey,
  isNonEmptyWireString,
  isWaterInfoPublicationInput,
  isWaterInfoSourceFeedback,
  isWaterInfoWireRecord,
  isWireWaterDraws,
  isWireWaterInfoFormat,
  MAX_VELOCITY_M_PER_SEC,
  MAX_WATER_INFO_SLICES,
  makeWork,
  observeWaterInfoTargetHistory,
  planWaterInfoTargets,
  publicationKey,
  publicationStates,
  targetFormatForContext,
  UNDERGROUND_DILATION_OFFSET_M,
  WATER_INFO_FEATURE_IDENTITY,
  WATER_INFO_RASTER_DILATION_ID,
  WATER_INFO_RASTER_GROUND_ID,
  WATER_INFO_RASTER_WATER_ID,
  type WaterInfoBindingSnapshot,
  type WaterInfoDescriptorRow,
  type WaterInfoFramePublication,
  type WaterInfoPublicationContext,
  type WaterInfoPublicationInput,
  type WaterInfoPublicationInputView,
  type WaterInfoPublicationState,
  type WaterInfoPublicationWaveBody,
  type WaterInfoSourceAvailability,
  type WaterInfoSourceFeedback,
  type WaterInfoViewFrame,
  type WaterInfoWaterDraw,
  type WaterInfoZoneCapture,
  type WaterMeshProxyRef,
  waterInfoFrameDataKind,
  waterInfoTargetBindingSnapshot,
  waterInfoTargetDigest,
  waterInfoTargetRosterIsValid,
} from './water-info-publication-work';

export {
  WATER_INFO_FEATURE_IDENTITY,
  type WaterInfoDescriptorRow,
  type WaterInfoFramePublication,
  type WaterInfoPublicationInput,
  type WaterInfoPublicationInputView,
  type WaterInfoSourceFeedback,
  waterInfoFramePublication,
  waterInfoFramePublicationForRenderer,
  waterInfoMaterialBindingSnapshots,
  waterInfoTargetRosterIsValid,
} from './water-info-publication-work';
