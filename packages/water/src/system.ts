import type { PhysicsWorld } from '@forgeax/engine-physics';
import {
  canonicalJson,
  err,
  isCurrentOutputPostProcessAbi,
  isMaterialDeformationProgramAbi,
  isMaterialProgramSystemInputs,
  isMaterialSurfaceModel,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  type WaterAdvancedError,
  type WaterAdvancedRecipe,
  WaterAdvancedSimulation,
  waterAdvancedOutputNames,
} from './advanced-simulation.js';
import { waterBodyRenderBounds } from './body-geometry.js';
import {
  snapshotWaterBakedQueryGrid,
  snapshotWaterBakedQueryLineage,
  type Vec2,
  WATER_MISSING_MATERIAL_ABI,
  type WaterBakedQueryGrid,
  type WaterBakedQueryPublication,
  type WaterBodyAsset,
  type WaterBodySnapshot,
  type WaterDependencyArrayKind,
  type WaterDependencySnapshot,
  type WaterDirtyKind,
  type WaterError,
  type WaterExclusionVolumeSnapshot,
  type WaterMaterialSlotStatus,
  type WaterOperationObserver,
  type WaterOutputAvailability,
  type WaterOutputReceipt,
  type WaterOutputStatus,
  type WaterQueryInput,
  type WaterQueryResult,
  type WaterSnapshotLease,
  type WaterSurfaceSourceDescriptor,
  type WaterTerrainQuerySample,
  type WaterZoneAsset,
  type WaterZoneBinding,
  type WaterZoneGroundQuerySnapshot,
  type WaterZoneGroundSnapshot,
  type WaterZoneTerrainProviderInput,
} from './contracts.js';
import { WaterFluidSimulationSystem } from './fluid-simulation.js';
import { WaterOceanPatch } from './ocean-patch.js';
import { beginWaterOperation, endWaterOperation } from './operation-observation.js';
import {
  preparedWaterQueryNeedsTerrain,
  queryPreparedWaterBodySnapshot,
  queryWaterBodySnapshot,
  type WaterQueryBodySnapshot,
} from './query.js';
import type { WaterResidualQueryBinding, WaterResidualQuerySource } from './query-residual.js';
import { prepareWaterQuerySpline, type WaterQuerySplinePreparation } from './query-spline.js';
import { requireWaterValue } from './required-value.js';
import { registerWaterSystemInternalAccess } from './system-internal.js';
import { validateWaterRuntimeBody, waterRiverBakeGeometryProjectionHash } from './validate.js';
import {
  selectPreparedWaterView,
  WATER_DEFAULT_UNDERWATER_TRACE_FILTER_MASK,
  type WaterViewAudioTransition,
  type WaterViewError,
  type WaterViewInput,
  type WaterViewState,
} from './view-state.js';
import {
  buildWaterMeshView,
  type WaterMeshBodyInput,
  type WaterMeshViewInput,
  type WaterMeshViewReceipt,
} from './water-mesh.js';
import {
  buildPreparedWaterWaveUploadBody,
  buildWaterWaveUploadPlan as packWaterWaveUploadPlan,
  prepareWaterBodyWaves,
  type WaterBodyWavePreparation,
  type WaterWaveUploadBody,
  type WaterWaveUploadPlan,
  type WaterWaveUploadSnapshotContext,
  waterBodyWaveOriginXZ,
} from './waves.js';
import { createWaterZoneViewWindow, type WaterZoneViewWindow } from './zone-view-window.js';

function initialDirty(asset: WaterBodyAsset): Set<WaterDirtyKind> {
  const dirty = new Set<WaterDirtyKind>(['geometry', 'query']);
  if (asset.flags.affectsWaterInfo) dirty.add('waterInfo');
  if (asset.flags.affectsWaterMesh) dirty.add('waterMesh');
  if (asset.flags.affectsLandscape) dirty.add('terrainBrush');
  if (asset.collision.enabled) dirty.add('collision');
  if (hasMaterialSlots(asset)) dirty.add('material');
  return dirty;
}
const OUTPUT_KINDS: readonly WaterDirtyKind[] = [
  'geometry',
  'waterInfo',
  'waterMesh',
  'terrainBrush',
  'collision',
  'query',
  'material',
];
function outputGenerations(
  generation: number,
  previous?: ReadonlyMap<WaterDirtyKind, number>,
  changed: Iterable<WaterDirtyKind> = OUTPUT_KINDS,
): Map<WaterDirtyKind, number> {
  const result = new Map(
    OUTPUT_KINDS.map((kind) => [kind, previous?.get(kind) ?? generation] as const),
  );
  for (const kind of changed) result.set(kind, generation);
  return result;
}
function sameBakedQueryGridFields(left: WaterBakedQueryGrid, right: WaterBakedQueryGrid): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.originY === right.originY &&
    left.originXZ[0] === right.originXZ[0] &&
    left.originXZ[1] === right.originXZ[1] &&
    left.spacingXZ[0] === right.spacingXZ[0] &&
    left.spacingXZ[1] === right.spacingXZ[1] &&
    left.samples.length === right.samples.length &&
    left.samples.every((sample, index) => Object.is(sample, right.samples[index]))
  );
}
function sameBakedQueryGrid(left: WaterBakedQueryGrid, right: WaterBakedQueryGrid): boolean {
  return (
    sameBakedQueryGridFields(left, right) &&
    canonicalJson(left.lineage ?? null) === canonicalJson(right.lineage ?? null)
  );
}
function hasMaterialSlots(asset: WaterBodyAsset): boolean {
  return [
    asset.surfaceMaterialGuid,
    asset.riverToLakeTransitionMaterialGuid,
    asset.riverToOceanTransitionMaterialGuid,
    asset.waterInfoMaterialGuid,
    asset.lodMaterialGuid,
    asset.underwaterPostProcessMaterialGuid,
  ].some((guid) => guid !== undefined);
}
function outputStatuses(
  asset: WaterBodyAsset,
  zoneBound: boolean,
  dirty: ReadonlySet<WaterDirtyKind>,
  accepted: ReadonlyMap<WaterDirtyKind, WaterOutputReceipt>,
  generations: ReadonlyMap<WaterDirtyKind, number>,
): WaterOutputStatus {
  const status = (
    kind: WaterDirtyKind,
    requested: boolean,
    zoneRequired = false,
  ): WaterOutputAvailability => {
    if (!requested) return 'not-requested';
    if (zoneRequired && !zoneBound) return 'zone-unbound';
    const receipt = accepted.get(kind);
    if (receipt)
      return dirty.has(kind) || receipt.outputGeneration !== generations.get(kind)
        ? 'stale'
        : 'ready';
    return 'unsupported';
  };
  return Object.freeze({
    geometry: status('geometry', true),
    waterInfo: status('waterInfo', asset.flags.affectsWaterInfo, true),
    waterMesh: status('waterMesh', asset.flags.affectsWaterMesh, true),
    terrainBrush: status('terrainBrush', asset.flags.affectsLandscape),
    collision: status('collision', asset.collision.enabled),
    query: status('query', true),
    material: status('material', hasMaterialSlots(asset)),
  });
}
function fieldsChanged(
  left: WaterBodyAsset,
  right: WaterBodyAsset,
  fields: readonly (keyof WaterBodyAsset)[],
): boolean {
  return fields.some((field) => canonicalJson(left[field]) !== canonicalJson(right[field]));
}
function sameNumberSequence(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}
function isFiniteNumberSequence(values: readonly number[]): boolean {
  for (let index = 0; index < values.length; index++)
    if (!Number.isFinite(values[index])) return false;
  return true;
}
function sameZoneGroundProviderRoster(
  current: readonly WaterZoneTerrainProviderInput[],
  previous: readonly WaterZoneTerrainProviderInput[],
): boolean {
  if (current.length !== previous.length) return false;
  let ordered = current;
  for (let index = 1; index < current.length; index++) {
    const before = current[index - 1];
    const after = current[index];
    if (before === undefined || after === undefined) return false;
    if (before.entity > after.entity) {
      ordered = [...current].sort((left, right) => left.entity - right.entity);
      break;
    }
  }
  for (let index = 0; index < ordered.length; index++) {
    const provider = ordered[index];
    const retained = previous[index];
    if (
      provider === undefined ||
      retained === undefined ||
      provider.entity !== retained.entity ||
      provider.terrainGuid !== retained.terrainGuid ||
      provider.terrainVersion !== retained.terrainVersion ||
      !sameNumberSequence(provider.worldMatrixM, retained.worldMatrixM) ||
      !sameNumberSequence(provider.boundsXZ.minM, retained.boundsXZ.minM) ||
      !sameNumberSequence(provider.boundsXZ.maxM, retained.boundsXZ.maxM)
    )
      return false;
  }
  return true;
}
function bodyGeometryChanged(previous: WaterBodyAsset, asset: WaterBodyAsset): boolean {
  return (
    fieldsChanged(previous, asset, [
      'type',
      'spline',
      'baseHeightM',
      'maxWaveHeightM',
      'maxWaveHeightOffsetM',
      'channelDepthM',
      'queryFootprint',
      'oceanExtentM',
      'oceanCenterM',
      'geometryCook',
    ]) ||
    previous.geometrySnapshot?.queryFootprint.digest !==
      asset.geometrySnapshot?.queryFootprint.digest
  );
}
function reloadChanges(
  previous: Admitted,
  asset: WaterBodyAsset,
  sourceAssetGuid: string,
): Set<WaterDirtyKind> {
  const changed = new Set<WaterDirtyKind>();
  if (sourceAssetGuid !== previous.sourceAssetGuid) {
    for (const kind of initialDirty(asset)) changed.add(kind);
    return changed;
  }
  const geometryChanged = bodyGeometryChanged(previous.asset, asset);
  const dilationChanged = fieldsChanged(previous.asset, asset, ['shapeDilationM']);
  const queryChanged = () =>
    geometryChanged ||
    fieldsChanged(previous.asset, asset, [
      'overlapPriority',
      'heightOffsetM',
      'waveBounds',
      'waveSetGuid',
      'underwaterSettings',
    ]) ||
    previous.asset.geometrySnapshot?.queryVolume.digest !==
      asset.geometrySnapshot?.queryVolume.digest;
  const infoChanged = () =>
    geometryChanged ||
    dilationChanged ||
    fieldsChanged(previous.asset, asset, [
      'zoneGuid',
      'waveSetGuid',
      'heightOffsetM',
      'waveBounds',
      'renderOptions',
      'waterInfoMaterialGuid',
      'fixedWaterDepthM',
    ]) ||
    previous.asset.flags.affectsWaterInfo !== asset.flags.affectsWaterInfo;
  const meshChanged = () =>
    geometryChanged ||
    fieldsChanged(previous.asset, asset, [
      'zoneGuid',
      'waveSetGuid',
      'heightOffsetM',
      'waveBounds',
      'customMeshOverrideGuid',
      'renderOptions',
      'surfaceMaterialGuid',
      'riverToLakeTransitionMaterialGuid',
      'riverToOceanTransitionMaterialGuid',
      'transitionContinuity',
      'lodMaterialGuid',
      'fixedWaterDepthM',
    ]) ||
    previous.asset.flags.affectsWaterMesh !== asset.flags.affectsWaterMesh;
  const terrainChanged = () =>
    geometryChanged ||
    dilationChanged ||
    fieldsChanged(previous.asset, asset, ['heightOffsetM']) ||
    previous.asset.flags.affectsLandscape !== asset.flags.affectsLandscape;
  const collisionChanged = () =>
    previous.asset.type !== asset.type ||
    canonicalJson(previous.asset.collision) !== canonicalJson(asset.collision) ||
    previous.asset.geometrySnapshot?.collisionDescriptor?.digest !==
      asset.geometrySnapshot?.collisionDescriptor?.digest;
  const materialChanged = () =>
    fieldsChanged(previous.asset, asset, [
      'surfaceMaterialGuid',
      'riverToLakeTransitionMaterialGuid',
      'riverToOceanTransitionMaterialGuid',
      'waterInfoMaterialGuid',
      'lodMaterialGuid',
      'underwaterPostProcessMaterialGuid',
    ]);
  if (geometryChanged || dilationChanged) changed.add('geometry');
  if (queryChanged()) changed.add('query');
  if (infoChanged() && (previous.asset.flags.affectsWaterInfo || asset.flags.affectsWaterInfo))
    changed.add('waterInfo');
  if (meshChanged() && (previous.asset.flags.affectsWaterMesh || asset.flags.affectsWaterMesh))
    changed.add('waterMesh');
  if (terrainChanged() && (previous.asset.flags.affectsLandscape || asset.flags.affectsLandscape))
    changed.add('terrainBrush');
  if (collisionChanged()) changed.add('collision');
  if (materialChanged()) changed.add('material');
  return changed;
}
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function waterInfoZoneTransformSupported(matrix: readonly number[]): boolean {
  const epsilon = 1e-5;
  return (
    Array.isArray(matrix) &&
    matrix.length === 16 &&
    Array.from(matrix).every(Number.isFinite) &&
    Math.abs(requireWaterValue(matrix[1])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[2])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[4])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[6])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[8])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[9])) <= epsilon
  );
}
function waterMeshZoneTransformSupported(matrix: readonly number[]): boolean {
  if (!waterInfoZoneTransformSupported(matrix)) return false;
  const scaleX = Math.hypot(
    requireWaterValue(matrix[0]),
    requireWaterValue(matrix[1]),
    requireWaterValue(matrix[2]),
  );
  const scaleZ = Math.hypot(
    requireWaterValue(matrix[8]),
    requireWaterValue(matrix[9]),
    requireWaterValue(matrix[10]),
  );
  return (
    scaleX > 1e-6 &&
    scaleZ > 1e-6 &&
    Math.abs(scaleX - scaleZ) <= Math.max(1, scaleX, scaleZ) * 1e-5
  );
}
function waterMeshBodyTransformSupported(matrix: readonly number[]): boolean {
  const verticalScale = matrix[5] ?? 0;
  const epsilon = Math.max(1, verticalScale) * 1e-5;
  return (
    matrix.length === 16 &&
    matrix.every(Number.isFinite) &&
    verticalScale > 1e-6 &&
    Math.abs(requireWaterValue(matrix[1])) <= epsilon &&
    Math.abs(requireWaterValue(matrix[9])) <= epsilon
  );
}
function transformPoint(
  matrix: readonly number[],
  point: readonly [number, number, number],
): [number, number, number] {
  return [
    requireWaterValue(matrix[0]) * point[0] +
      requireWaterValue(matrix[4]) * point[1] +
      requireWaterValue(matrix[8]) * point[2] +
      requireWaterValue(matrix[12]),
    requireWaterValue(matrix[1]) * point[0] +
      requireWaterValue(matrix[5]) * point[1] +
      requireWaterValue(matrix[9]) * point[2] +
      requireWaterValue(matrix[13]),
    requireWaterValue(matrix[2]) * point[0] +
      requireWaterValue(matrix[6]) * point[1] +
      requireWaterValue(matrix[10]) * point[2] +
      requireWaterValue(matrix[14]),
  ];
}
function copyFrozenSnapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  const previous = seen.get(object);
  if (previous !== undefined) return previous as T;
  if (ArrayBuffer.isView(object)) {
    const view = object as ArrayBufferView & {
      slice?: () => unknown;
    };
    if (typeof view.slice === 'function') return view.slice() as T;
    const copy = new DataView(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    );
    seen.set(object, copy);
    return copy as T;
  }
  if (object instanceof ArrayBuffer) return object.slice(0) as T;
  const copy: object = Array.isArray(object) ? [] : Object.create(Object.getPrototypeOf(object));
  seen.set(object, copy);
  for (const key of Reflect.ownKeys(object)) {
    (copy as Record<PropertyKey, unknown>)[key] = copyFrozenSnapshot(
      (object as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  return Object.freeze(copy) as T;
}
function copyWaterMeshPublication(publication: WaterZoneMeshPublication): WaterZoneMeshPublication {
  return copyFrozenSnapshot(publication);
}
export type WaterZoneResolver = (guid: string) =>
  | {
      readonly generation: number;
      readonly worldMatrixM?: readonly number[];
      readonly asset?: WaterZoneAsset;
    }
  | undefined;
export type WaterZoneEnumerator = () => readonly {
  readonly guid: string;
  readonly generation: number;
  readonly asset: WaterZoneAsset;
}[];
export type WaterZoneSnapshot = Readonly<{
  guid: string;
  generation: number;
  worldMatrixM: readonly number[];
  asset: WaterZoneAsset;
}>;
export type WaterDependencyResolver = (asset: WaterBodyAsset) => readonly WaterDependencySnapshot[];
export type WaterTerrainQueryResolver = (
  body: WaterQueryBodySnapshot,
  ground: WaterZoneGroundQuerySnapshot | undefined,
  positionM: readonly [number, number, number],
) => WaterTerrainQuerySample | undefined;
export type WaterMaterialResolution =
  | {
      readonly kind: 'unavailable' | 'invalid-kind';
    }
  | {
      readonly kind: 'valid';
      readonly asset: {
        readonly parent?: unknown;
        readonly surface?: {
          readonly model: string;
        };
        readonly passes?: readonly {
          readonly name: string;
        }[];
      };
      readonly publishedPasses?: readonly {
        readonly lightMode: string;
        readonly abis: readonly import('@forgeax/engine-types').MaterialProgramAbi[];
      }[];
    };
export type WaterMaterialReferenceResolver = (guid: string) => WaterMaterialResolution;
type ZoneSlot = {
  readonly zoneGuid: string;
  readonly zoneGeneration: number;
  readonly index: number;
};
type Admitted = {
  readonly sourceAssetGuid: string;
  readonly sourcePublication?: WaterBodySnapshot['sourcePublication'];
  readonly instanceEntity?: number;
  readonly version: string;
  readonly asset: WaterBodyAsset;
  readonly dependencies: readonly WaterDependencySnapshot[];
  readonly wavePreparation: WaterBodyWavePreparation;
  readonly splinePreparation: WaterQuerySplinePreparation;
  readonly worldMatrixM: readonly number[];
  readonly exclusionVolumes: readonly WaterExclusionVolumeSnapshot[];
  readonly generation: number;
  readonly outputGenerations: Map<WaterDirtyKind, number>;
  readonly dirty: Set<WaterDirtyKind>;
  readonly acceptedOutputs: Map<WaterDirtyKind, WaterOutputReceipt>;
};
function hasAttachedNativeRiverCollision(body: Admitted | undefined): boolean {
  return (
    body?.instanceEntity !== undefined &&
    body.asset.type === 'river' &&
    body.asset.collision.enabled &&
    body.acceptedOutputs.has('collision')
  );
}
export type WaterZoneMeshPublication = Readonly<{
  zoneGuid: string;
  zoneGeneration: number;
  waterInfoFormat: 'rgba16float' | 'rgba32float';
  viewId: string;
  publicationGeneration: number;
  sourceGenerations: Readonly<Record<string, number>>;
  waterMeshOutputGenerations: Readonly<Record<string, number>>;
  digest: string;
  current: boolean;
  receipt: WaterMeshViewReceipt;
}>;
export type WaterMeshOwnerRosterEntry = Readonly<{
  bodyGuid: string;
  bodyGeneration: number;
  zoneGuid: string;
  zoneGeneration: number;
  waterInfoFormat: 'rgba16float' | 'rgba32float';
}>;
type AcceptedMeshOwner = Readonly<{
  viewId: string;
  zoneGuid: string;
  identity: string | null;
}>;
type BakedQueryGridSource = NonNullable<WaterQueryInput['baked']>;
type BakedQueryGridCandidate = Readonly<{
  bodyGeneration: number;
  outputGeneration: number;
  source: BakedQueryGridSource | null;
  /** Scene transform waiting for its matching native source receipt. */
  sceneCandidate?: Admitted;
  readonly baseBodyGeneration?: number;
  /** The staged Scene cannot commit until it has a qualified replacement for its accepted Bake. */
  readonly requiresBakeReplacement?: boolean;
  /** An explicit clear opts the staged Scene into the base query path. */
  readonly explicitBakeClear?: boolean;
  phase?: 'queued' | 'admitting';
  deferredInvalidations?: readonly WaterDirtyKind[];
}>;
const bakedAdmissionPending = (
  guid: string,
  candidate: BakedQueryGridCandidate | undefined,
): WaterError => ({
  code: 'query-data-unavailable',
  expected:
    'the queued River Bake Physics candidate to be accepted or cancelled before changing its Body source',
  hint: 'retry the Body or Bake mutation after the matching Physics receipt is accepted or cancelled',
  detail: {
    guid,
    ...(candidate === undefined
      ? {}
      : {
          bodyGeneration: candidate.bodyGeneration,
          outputGeneration: candidate.outputGeneration,
        }),
  },
});
function waterMeshOwnerIdentity(entry: WaterMeshOwnerRosterEntry): string {
  return JSON.stringify([
    entry.bodyGuid,
    entry.bodyGeneration,
    entry.zoneGuid,
    entry.zoneGeneration,
    entry.waterInfoFormat,
  ]);
}
function sameMatrixF32(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === 16 &&
    right.length === 16 &&
    left.every((value, index) => {
      const other = right[index];
      if (other === undefined || !Number.isFinite(value) || !Number.isFinite(other)) return false;
      const tolerance = 4 * 2 ** -23 * Math.max(1, Math.abs(value), Math.abs(other));
      return Math.abs(value - other) <= tolerance;
    })
  );
}
/** Scene-local CPU owner. Catalog and Zone payload ownership remain with Registry/Scene. */
export class WaterSystem {
  readonly fluid = new WaterFluidSimulationSystem();
  readonly #advanced = new Map<string, WaterAdvancedSimulation>();
  #oceanPatch: WaterOceanPatch | undefined;
  readonly #bodies = new Map<string, Admitted>();
  readonly #leases = new WeakMap<
    object,
    {
      readonly generationKey: string;
      released: boolean;
    }
  >();
  readonly #leaseCounts = new Map<string, number>();
  #sceneGeneration = 0;
  #zoneSlots = new Map<string, ZoneSlot>();
  readonly #zoneGround = new Map<string, WaterZoneGroundSnapshot>();
  readonly #zoneGroundQueries = new Map<string, WaterZoneGroundQuerySnapshot>();
  readonly #zoneGroundPending = new Map<string, WaterZoneGroundQuerySnapshot>();
  readonly #bakedQueryGrids = new Map<
    string,
    Readonly<{
      bodyGeneration: number;
      source: NonNullable<WaterQueryInput['baked']>;
    }>
  >();
  readonly #bakedQueryGridCandidates = new Map<string, BakedQueryGridCandidate>();
  #bakedQueryRevision = 0;
  readonly #zoneMeshViews = new Map<string, WaterZoneMeshPublication>();
  readonly #zoneMeshCandidates = new Map<string, WaterZoneMeshPublication>();
  readonly #zoneViewWindows = new Map<string, WaterZoneViewWindow>();
  readonly #zoneMeshBuildInputs = new WeakMap<WaterZoneMeshPublication, string>();
  readonly #meshViewEpochs = new Map<string, number>();
  readonly #meshCandidateEpochs = new WeakMap<WaterZoneMeshPublication, number>();
  readonly #acceptedMeshOwners = new Map<string, AcceptedMeshOwner>();
  readonly #meshViewDevices = new Map<string, number>();
  #waterMeshPublicationGeneration = 0;
  #meshEdgeOverlayEnabled = false;
  readonly #viewStates = new Map<string, Result<WaterViewState, WaterViewError>>();
  readonly #audioStates = new Map<string, boolean>();
  readonly #audioListeners = new Set<(transition: WaterViewAudioTransition) => void>();
  #underwaterTraceFilterMask = WATER_DEFAULT_UNDERWATER_TRACE_FILTER_MASK;
  constructor(
    private readonly resolveZone: WaterZoneResolver,
    private readonly resolveDependencies: WaterDependencyResolver = () => [],
    private readonly enumerateZones: WaterZoneEnumerator = () => [],
    private readonly resolveTerrainQuery: WaterTerrainQueryResolver = () => undefined,
  ) {
    registerWaterSystemInternalAccess(
      this,
      Object.freeze({
        buildZoneMeshView: (zoneGuid, zoneGeneration, zone, view) =>
          this.#buildZoneMeshView(zoneGuid, zoneGeneration, zone, view),
        zoneMeshView: (zoneGuid, viewId) => this.#zoneMeshView(zoneGuid, viewId),
        waterMeshCandidateViews: (viewId) => this.#waterMeshCandidateViews(viewId),
        acceptWaterMeshView: (candidate) => this.#acceptWaterMeshView(candidate),
      }),
    );
  }
  setMeshEdgeOverlayEnabled(enabled: boolean): void {
    this.#meshEdgeOverlayEnabled = enabled;
  }
  meshEdgeOverlayEnabled(): boolean {
    return this.#meshEdgeOverlayEnabled;
  }
  /** Build CPU tile candidates for every accepted Zone and one render view. */
  buildLiveZoneMeshViews(
    view: WaterMeshViewInput,
    observe?: WaterOperationObserver,
  ): readonly WaterZoneMeshPublication[] {
    const publications: WaterZoneMeshPublication[] = [];
    for (const zone of this.enumerateZones()) {
      const result = this.buildZoneMeshView(zone.guid, zone.generation, zone.asset, view, observe);
      if (result.ok) publications.push(result.value);
    }
    return Object.freeze(publications);
  }
  /** Immutable accepted Zone payloads for renderer features and WaterInfo extraction. */
  zoneSnapshots(): readonly WaterZoneSnapshot[] {
    return Object.freeze(
      this.enumerateZones().flatMap((zone) => {
        const live = this.resolveZone(zone.guid);
        if (
          !live ||
          live.generation !== zone.generation ||
          (live.asset !== undefined && live.asset !== zone.asset)
        )
          return [];
        return [
          Object.freeze({
            guid: zone.guid,
            generation: zone.generation,
            worldMatrixM: Object.freeze([...(live.worldMatrixM ?? IDENTITY_MATRIX)]),
            asset: zone.asset,
          }),
        ];
      }),
    );
  }
  mountBody(
    guid: string,
    sourceVersion: string,
    source: unknown,
    sourceAssetGuid = guid,
    worldMatrixM: readonly number[] = IDENTITY_MATRIX,
    sourcePublication?: WaterBodySnapshot['sourcePublication'],
    instanceEntity?: number,
  ): Result<WaterBodySnapshot, WaterError> {
    const admitting = this.#bakedQueryGridCandidates.get(guid);
    if (admitting?.phase || admitting?.sceneCandidate !== undefined)
      return err(bakedAdmissionPending(guid, admitting));
    if (hasAttachedNativeRiverCollision(this.#bodies.get(guid)))
      return err({
        code: 'invalid-source',
        expected: 'an explicit River Native retirement before replacing an attached Scene Body',
        hint: 'unmount the River, wait for its matching Native retirement receipt, then mount the replacement',
        detail: { guid, operation: 'mount-body' },
      });
    const validated = validateWaterRuntimeBody(source);
    if (!validated.ok) return validated;
    if (!validMatrix(worldMatrixM))
      return err({
        code: 'invalid-source',
        expected: 'finite 4x4 Scene world matrix in m/Y-up coordinates',
        hint: 'repair the Scene Transform before mounting the WaterBody instance',
      });
    this.#zoneSlots.delete(guid);
    this.#bakedQueryGrids.delete(guid);
    this.#bakedQueryGridCandidates.delete(guid);
    const asset = freezeBody(validated.value);
    const dependencies = freezeDependencies(this.resolveDependencies(asset));
    const generation = ++this.#sceneGeneration;
    this.#oceanPatch?.invalidateQueryBody(guid, generation);
    const admitted = {
      sourceAssetGuid,
      ...(instanceEntity === undefined ? {} : { instanceEntity }),
      version: sourceVersion,
      sourcePublication: sourcePublication && Object.freeze({ ...sourcePublication }),
      asset,
      dependencies,
      wavePreparation: prepareWaterBodyWaves({ asset, dependencies }),
      splinePreparation: prepareWaterQuerySpline(asset.spline),
      worldMatrixM: Object.freeze([...worldMatrixM]),
      exclusionVolumes: Object.freeze([]),
      generation,
      outputGenerations: outputGenerations(generation),
      dirty: initialDirty(asset),
      acceptedOutputs: new Map<WaterDirtyKind, WaterOutputReceipt>(),
    };
    this.#bodies.set(guid, admitted);
    return ok(requireWaterValue(this.snapshot(guid)));
  }
  /** Invalid candidates leave the previously accepted Scene snapshot intact. */
  hotReloadBody(
    guid: string,
    sourceVersion: string,
    source: unknown,
    sourceAssetGuid = guid,
    worldMatrixM?: readonly number[],
    sourcePublication?: WaterBodySnapshot['sourcePublication'],
  ): Result<WaterBodySnapshot, WaterError> {
    const previous = this.#bodies.get(guid);
    const admitting = this.#bakedQueryGridCandidates.get(guid);
    if (admitting?.phase || admitting?.sceneCandidate !== undefined)
      return err(bakedAdmissionPending(guid, admitting));
    const validated = validateWaterRuntimeBody(source);
    if (!validated.ok) return validated;
    const worldMatrix = worldMatrixM ?? previous?.worldMatrixM ?? IDENTITY_MATRIX;
    if (!validMatrix(worldMatrix))
      return err({
        code: 'invalid-source',
        expected: 'finite 4x4 Scene world matrix in m/Y-up coordinates',
        hint: 'repair the Scene Transform before reloading the WaterBody',
      });
    const asset = freezeBody(validated.value);
    const geometryChanged = previous ? bodyGeometryChanged(previous.asset, asset) : true;
    const transformChanged = previous
      ? !previous.worldMatrixM.every((value, index) => value === worldMatrix[index])
      : true;
    const changedSourceIdentity = (): boolean =>
      previous?.sourceAssetGuid !== undefined && previous.sourceAssetGuid !== sourceAssetGuid;
    const sourceChanged = changedSourceIdentity();
    const exclusionVolumes =
      previous && !sourceChanged && !transformChanged
        ? previous.exclusionVolumes
        : Object.freeze([]);
    const dependencies = freezeDependencies(this.resolveDependencies(asset));
    const changed = previous
      ? reloadChanges(previous, asset, sourceAssetGuid)
      : initialDirty(asset);
    const retainsBakedGrid = !geometryChanged && !transformChanged && !sourceChanged;
    const validateRetainedSources = (): Result<void, WaterError> => {
      if (
        hasAttachedNativeRiverCollision(previous) &&
        (asset.type !== 'river' ||
          sourceChanged ||
          geometryChanged ||
          transformChanged ||
          changed.has('collision'))
      )
        return err({
          code: 'invalid-source',
          expected:
            'unchanged River collision geometry and full Scene matrix for a direct source-version rebind',
          hint: 'stage changed River geometry, collision, or pose until its matching Native receipt publishes',
          detail: {
            guid,
            sourceAssetGuidChanged: sourceChanged,
            geometryChanged,
            transformChanged,
            collisionChanged: changed.has('collision'),
            requestedType: asset.type,
          },
        });
      const acceptedBake = this.#bakedQueryGrids.get(guid);
      if (
        acceptedBake !== undefined &&
        previous !== undefined &&
        acceptedBake.bodyGeneration === previous.generation &&
        !retainsBakedGrid
      )
        return err({
          code: 'query-data-unavailable',
          expected:
            'the accepted Bake to remain qualified for the current Body geometry and Scene matrix',
          hint: 'stage a qualified replacement Bake or explicitly clear the accepted Bake before reloading this Body',
          detail: { guid, bodyGeneration: previous?.generation, sourceVersion },
        });

      return ok(undefined);
    };
    const retainedSources = validateRetainedSources();
    if (!retainedSources.ok) return retainedSources;
    const materialSources =
      previous === undefined
        ? undefined
        : this.validateMaterialBakedSources(guid, asset, dependencies, retainsBakedGrid);
    if (materialSources !== undefined) return err(materialSources);
    const prepareOutputInvalidation = () => {
      if (
        !previous ||
        previous.sourceAssetGuid !== sourceAssetGuid ||
        previous.asset.zoneGuid !== asset.zoneGuid ||
        geometryChanged ||
        transformChanged
      )
        this.#zoneSlots.delete(guid);
      const dirty = new Set(previous?.dirty ?? []);
      for (const kind of changed) dirty.add(kind);
      const acceptedOutputs = previous
        ? new Map(previous.acceptedOutputs)
        : new Map<WaterDirtyKind, WaterOutputReceipt>();
      if (previous?.exclusionVolumes.length && (sourceChanged || transformChanged)) {
        dirty.add('query');
        changed.add('query');
        if (
          (previous.asset.type === 'ocean' && previous.asset.collision.enabled) ||
          (asset.type === 'ocean' && asset.collision.enabled)
        ) {
          dirty.add('collision');
          changed.add('collision');
        }
      }

      return { dirty, acceptedOutputs };
    };
    const { dirty, acceptedOutputs } = prepareOutputInvalidation();
    const generation = ++this.#sceneGeneration;
    const rebindRetainedOutputs = (): void => {
      const collisionReceipt = acceptedOutputs.get('collision');
      if (
        previous &&
        collisionReceipt &&
        !dirty.has('collision') &&
        previous.asset.collision.enabled &&
        asset.collision.enabled
      )
        acceptedOutputs.set(
          'collision',
          Object.freeze({
            ...collisionReceipt,
            sourceVersion,
            sceneGeneration: generation,
          }),
        );
      const baked = this.#bakedQueryGrids.get(guid);
      this.#bakedQueryGridCandidates.delete(guid);
      this.#oceanPatch?.invalidateQueryBody(guid, generation);
      if (baked !== undefined && baked.bodyGeneration === previous?.generation && retainsBakedGrid)
        this.#bakedQueryGrids.set(guid, Object.freeze({ ...baked, bodyGeneration: generation }));
    };
    rebindRetainedOutputs();
    this.#bodies.set(guid, {
      sourceAssetGuid,
      ...(previous?.instanceEntity === undefined
        ? {}
        : { instanceEntity: previous.instanceEntity }),
      version: sourceVersion,
      sourcePublication: sourcePublication && Object.freeze({ ...sourcePublication }),
      asset,
      dependencies,
      wavePreparation: prepareWaterBodyWaves({ asset, dependencies }),
      splinePreparation: prepareWaterQuerySpline(asset.spline),
      worldMatrixM: Object.freeze([...worldMatrix]),
      exclusionVolumes,
      generation,
      outputGenerations: outputGenerations(generation, previous?.outputGenerations, changed),
      dirty,
      acceptedOutputs,
    });
    return ok(requireWaterValue(this.snapshot(guid)));
  }
  updateInstanceTransform(guid: string, worldMatrixM: readonly number[]): Result<void, WaterError> {
    const body = this.#bodies.get(guid);
    const admitting = this.#bakedQueryGridCandidates.get(guid);
    if (admitting?.sceneCandidate !== undefined && admitting.phase === undefined)
      return err(bakedAdmissionPending(guid, admitting));
    if (admitting?.phase) return err(bakedAdmissionPending(guid, admitting));
    if (!body)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted Body instance',
        hint: 'mount the Scene WaterBody before updating its Transform',
      });
    if (!validMatrix(worldMatrixM))
      return err({
        code: 'invalid-source',
        expected: 'finite 4x4 Scene world matrix in m/Y-up coordinates',
        hint: 'repair the Scene Transform before updating the WaterBody instance',
      });
    if (body.worldMatrixM.every((value, index) => value === worldMatrixM[index]))
      return ok(undefined);
    const acceptedBake = this.#bakedQueryGrids.get(guid);
    if (acceptedBake?.bodyGeneration === body.generation)
      return err({
        code: 'query-data-unavailable',
        expected: 'the accepted Bake to remain qualified for the current Scene matrix',
        hint: 'stage a qualified replacement Bake or explicitly clear the accepted Bake before moving this Body',
        detail: { guid, bodyGeneration: body.generation },
      });
    if (hasAttachedNativeRiverCollision(body))
      return err({
        code: 'invalid-source',
        expected: 'the accepted full Scene matrix for a source-owned Native River collision',
        hint: 'stage the River transform and accept its paired Native receipt before updating the Body pose',
        detail: { guid, operation: 'update-instance-transform' },
      });
    this.#zoneSlots.delete(guid);
    this.#bakedQueryGrids.delete(guid);
    this.#bakedQueryGridCandidates.delete(guid);
    const invalidated = new Set<WaterDirtyKind>(['geometry', 'query']);
    if (body.asset.flags.affectsWaterInfo) invalidated.add('waterInfo');
    if (body.asset.flags.affectsWaterMesh) invalidated.add('waterMesh');
    if (body.asset.flags.affectsLandscape) invalidated.add('terrainBrush');
    if (body.asset.collision.enabled) invalidated.add('collision');
    if (body.exclusionVolumes.length) {
      invalidated.add('query');
      if (body.asset.type === 'ocean' && body.asset.collision.enabled) invalidated.add('collision');
    }
    const dirty = new Set([...body.dirty, ...invalidated]);
    const generation = ++this.#sceneGeneration;
    this.#oceanPatch?.invalidateQueryBody(guid, generation);
    this.#bodies.set(guid, {
      ...body,
      worldMatrixM: Object.freeze([...worldMatrixM]),
      exclusionVolumes: body.exclusionVolumes.length ? Object.freeze([]) : body.exclusionVolumes,
      generation,
      outputGenerations: outputGenerations(generation, body.outputGenerations, invalidated),
      dirty,
    });
    return ok(undefined);
  }
  /** Stage a collision-enabled River transform while its accepted pose/grid remain live. */
  stageRiverTransform(
    guid: string,
    worldMatrixM: readonly number[],
    exclusionVolumes: readonly WaterExclusionVolumeSnapshot[],
    dependencies?: readonly WaterDependencySnapshot[],
  ): Result<WaterBodySnapshot, WaterError> {
    const body = this.#bodies.get(guid);
    const previous = this.#bakedQueryGridCandidates.get(guid);
    if (!body)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted River Body before staging its transform',
        hint: 'mount the Scene WaterBody before staging a River Bake transform',
      });
    if (body.asset.type !== 'river' || !body.asset.collision.enabled)
      return err({
        code: 'invalid-source',
        expected: 'an enabled-collision River Body with source-owned collision geometry',
        hint: 'use the Water Scene transform path for this River collision candidate',
        detail: { guid, type: body.asset.type, collisionEnabled: body.asset.collision.enabled },
      });
    if (!validMatrix(worldMatrixM))
      return err({
        code: 'invalid-source',
        expected: 'finite 4x4 Scene world matrix in m/Y-up coordinates',
        hint: 'repair the Scene Transform before staging its River Bake replacement',
      });
    if (previous?.phase !== undefined) return err(bakedAdmissionPending(guid, previous));
    if (
      previous?.sceneCandidate !== undefined &&
      previous.baseBodyGeneration === body.generation &&
      previous.sceneCandidate.worldMatrixM.every((value, index) => value === worldMatrixM[index]) &&
      canonicalJson(previous.sceneCandidate.exclusionVolumes) === canonicalJson(exclusionVolumes) &&
      canonicalJson(previous.sceneCandidate.dependencies) ===
        canonicalJson(dependencies ?? body.dependencies)
    )
      return ok(this.snapshotOf(guid, previous.sceneCandidate));
    const invalidated = new Set<WaterDirtyKind>(['geometry', 'query', 'collision']);
    if (body.asset.flags.affectsWaterInfo) invalidated.add('waterInfo');
    if (body.asset.flags.affectsWaterMesh) invalidated.add('waterMesh');
    if (body.asset.flags.affectsLandscape) invalidated.add('terrainBrush');
    const generation = ++this.#sceneGeneration;
    const candidateBody: Admitted = {
      ...body,
      worldMatrixM: Object.freeze([...worldMatrixM]),
      exclusionVolumes: copyFrozenSnapshot(exclusionVolumes),
      ...(dependencies === undefined ? {} : { dependencies: freezeDependencies(dependencies) }),
      generation,
      outputGenerations: outputGenerations(generation, body.outputGenerations, invalidated),
      dirty: new Set([...body.dirty, ...invalidated]),
      acceptedOutputs: new Map(body.acceptedOutputs),
    };
    const outputGeneration = candidateBody.outputGenerations.get('collision') ?? generation;
    const acceptedBake = this.#bakedQueryGrids.get(guid);
    this.#bakedQueryGridCandidates.set(
      guid,
      Object.freeze({
        baseBodyGeneration: body.generation,
        bodyGeneration: generation,
        outputGeneration,
        source: null,
        sceneCandidate: candidateBody,
        ...(acceptedBake?.bodyGeneration === body.generation
          ? { requiresBakeReplacement: true }
          : {}),
      }),
    );
    return ok(this.snapshotOf(guid, candidateBody));
  }
  /** Stage a River source and Scene transform until its matching Native candidate publishes. */
  stageRiverReload(
    guid: string,
    sourceVersion: string,
    source: unknown,
    sourceAssetGuid: string,
    worldMatrixM: readonly number[],
    exclusionVolumes: readonly WaterExclusionVolumeSnapshot[],
    dependencies: readonly WaterDependencySnapshot[],
    sourcePublication?: WaterBodySnapshot['sourcePublication'],
  ): Result<WaterBodySnapshot, WaterError> {
    const active = this.#bodies.get(guid);
    const previous = this.#bakedQueryGridCandidates.get(guid);
    if (!active)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted River Body before staging its source replacement',
        hint: 'mount the Scene WaterBody before staging a River source replacement',
      });
    if (previous?.phase !== undefined) return err(bakedAdmissionPending(guid, previous));
    const validated = validateWaterRuntimeBody(source);
    if (!validated.ok) return validated;
    if (validated.value.type !== 'river')
      return err({
        code: 'invalid-source',
        expected: 'a River replacement for a source-owned Native body',
        hint: 'retire the source-owned River before mounting a different Water Body kind',
        detail: { guid, type: validated.value.type },
      });
    if (!validMatrix(worldMatrixM))
      return err({
        code: 'invalid-source',
        expected: 'finite 4x4 Scene world matrix in m/Y-up coordinates',
        hint: 'repair the Scene Transform before staging its River source replacement',
      });
    const asset = freezeBody(validated.value);
    const frozenDependencies = freezeDependencies(dependencies);
    const matchesStagedSource = (): boolean =>
      Boolean(
        previous?.sceneCandidate !== undefined &&
          previous.baseBodyGeneration === active.generation &&
          previous.sceneCandidate.version === sourceVersion &&
          previous.sceneCandidate.sourceAssetGuid === sourceAssetGuid &&
          canonicalJson(previous.sceneCandidate.asset) === canonicalJson(asset) &&
          previous.sceneCandidate.worldMatrixM.every(
            (value, index) => value === worldMatrixM[index],
          ) &&
          canonicalJson(previous.sceneCandidate.exclusionVolumes) ===
            canonicalJson(exclusionVolumes) &&
          canonicalJson(previous.sceneCandidate.dependencies) === canonicalJson(frozenDependencies),
      );
    if (matchesStagedSource() && previous?.sceneCandidate !== undefined)
      return ok(this.snapshotOf(guid, previous.sceneCandidate));

    const changed = reloadChanges(active, asset, sourceAssetGuid);
    const geometryChanged = bodyGeometryChanged(active.asset, asset);
    const transformChanged = !active.worldMatrixM.every(
      (value, index) => value === worldMatrixM[index],
    );
    const sourceChanged = active.sourceAssetGuid !== sourceAssetGuid;
    const exclusionsChanged =
      canonicalJson(active.exclusionVolumes) !== canonicalJson(exclusionVolumes);
    const acceptedBake = this.#bakedQueryGrids.get(guid);
    const retainsBakedGrid =
      !geometryChanged &&
      !transformChanged &&
      !sourceChanged &&
      acceptedBake?.bodyGeneration === active.generation;
    const collectInvalidations = () => {
      const invalidated = new Set<WaterDirtyKind>([...changed, 'collision']);
      if (geometryChanged || transformChanged || sourceChanged) invalidated.add('geometry');
      if (geometryChanged || transformChanged || sourceChanged || exclusionsChanged)
        invalidated.add('query');
      if (asset.flags.affectsWaterInfo) invalidated.add('waterInfo');
      if (asset.flags.affectsWaterMesh) invalidated.add('waterMesh');
      if (asset.flags.affectsLandscape) invalidated.add('terrainBrush');
      if (exclusionVolumes.length) invalidated.add('query');

      return invalidated;
    };
    const invalidated = collectInvalidations();
    const generation = ++this.#sceneGeneration;
    const acceptedOutputs = new Map(active.acceptedOutputs);
    if (!asset.collision.enabled) acceptedOutputs.delete('collision');
    const candidateBody: Admitted = {
      ...active,
      sourceAssetGuid,
      version: sourceVersion,
      sourcePublication: sourcePublication && Object.freeze({ ...sourcePublication }),
      asset,
      dependencies: frozenDependencies,
      wavePreparation: prepareWaterBodyWaves({ asset, dependencies: frozenDependencies }),
      splinePreparation: prepareWaterQuerySpline(asset.spline),
      worldMatrixM: Object.freeze([...worldMatrixM]),
      exclusionVolumes: copyFrozenSnapshot(exclusionVolumes),
      generation,
      outputGenerations: outputGenerations(generation, active.outputGenerations, invalidated),
      dirty: new Set([...active.dirty, ...invalidated]),
      acceptedOutputs,
    };
    const outputGeneration = candidateBody.outputGenerations.get('collision') ?? generation;
    this.#bakedQueryGridCandidates.set(
      guid,
      Object.freeze({
        baseBodyGeneration: active.generation,
        bodyGeneration: generation,
        outputGeneration,
        source: retainsBakedGrid ? acceptedBake.source : null,
        sceneCandidate: candidateBody,
        ...(acceptedBake?.bodyGeneration === active.generation && !retainsBakedGrid
          ? { requiresBakeReplacement: true }
          : {}),
      }),
    );
    return ok(this.snapshotOf(guid, candidateBody));
  }
  /** True when this staged River cannot move until a qualified replacement grid is available. */
  sceneCandidateRequiresBakedGrid(guid: string, bodyGeneration: number): boolean {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    if (candidate?.bodyGeneration !== bodyGeneration || candidate.sceneCandidate === undefined)
      return false;
    return (
      candidate.source === null &&
      candidate.explicitBakeClear !== true &&
      (candidate.requiresBakeReplacement === true ||
        candidate.sceneCandidate.dependencies.some(
          (dependency) =>
            dependency.kind === 'material' && dependency.materialRequiresBakedSource === true,
        ))
    );
  }
  unmountBody(guid: string): Result<void, WaterError> {
    const admitting = this.#bakedQueryGridCandidates.get(guid);
    if (admitting?.phase) return err(bakedAdmissionPending(guid, admitting));
    this.#oceanPatch?.invalidateQueryBody(guid, undefined);
    for (const [key, simulation] of this.#advanced)
      if (simulation.body.guid === guid) {
        simulation.retire();
        this.#advanced.delete(key);
      }
    if (this.#bodies.delete(guid)) this.#sceneGeneration += 1;
    for (const [viewId, state] of this.#viewStates)
      if (state.ok && state.value.selectedBody === guid) this.releaseViewState(viewId);
    this.#zoneSlots.delete(guid);
    this.#bakedQueryGrids.delete(guid);
    this.#bakedQueryGridCandidates.delete(guid);
    return ok(undefined);
  }
  createAdvancedSimulation(
    recipe: WaterAdvancedRecipe,
    bodyGuid: string,
  ): Result<WaterAdvancedSimulation, WaterAdvancedError> {
    const body = this.snapshot(bodyGuid);
    if (body === undefined)
      return err({
        code: 'water-advanced-invalid-input',
        expected: 'a mounted Body before creating its advanced simulation',
        hint: 'mount the Scene and resolve its current Body instance',
        detail: { recipeGuid: recipe.guid, generation: 0 },
      });
    const key = `${bodyGuid}:${recipe.guid}`;
    const previous = this.#advanced.get(key);
    if (previous && previous.body.generation !== body.sceneGeneration) {
      previous.retire();
      this.#advanced.delete(key);
    }
    if (this.#advanced.has(key))
      return err({
        code: 'water-advanced-invalid-input',
        expected: 'one advanced simulation per Body and recipe',
        hint: 'reset or remove the existing simulation before replacing its recipe',
        detail: { recipeGuid: recipe.guid, generation: body.sceneGeneration },
      });
    const created = WaterAdvancedSimulation.create(
      recipe,
      { guid: bodyGuid, sourceAssetGuid: body.sourceAssetGuid, generation: body.sceneGeneration },
      this,
    );
    if (created.ok) this.#advanced.set(key, created.value);
    return created;
  }
  advancedSimulations(): readonly WaterAdvancedSimulation[] {
    for (const [key, simulation] of this.#advanced)
      if (this.snapshot(simulation.body.guid)?.sceneGeneration !== simulation.body.generation) {
        simulation.retire();
        this.#advanced.delete(key);
      }
    return [...this.#advanced.values()];
  }
  /** Returns one accepted Live or paired /2 Baked source without exposing GPU handles. */
  waterSurfaceSource(
    bodyGuid: string,
    worldIdentity: string,
    source: 'live' | 'baked',
    sourceRecipeGuid?: string,
  ): WaterSurfaceSourceDescriptor | undefined {
    const body = this.snapshot(bodyGuid);
    if (body === undefined || bodyGuid.length === 0 || worldIdentity.length === 0) return undefined;
    if (source === 'live') {
      const candidates = this.advancedSimulations().filter(
        (candidate) => candidate.body.guid === bodyGuid,
      );
      const simulation =
        sourceRecipeGuid === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : candidates.find((candidate) => candidate.recipe.guid === sourceRecipeGuid);
      if (simulation === undefined || simulation.body.generation !== body.sceneGeneration)
        return undefined;
      const frame = simulation.frame();
      if (frame === undefined || frame.generation !== simulation.inspect().generation)
        return undefined;
      const [width, height] = frame.recipe.asset.shallowStageConfig.gridResolution;
      const spacingXZ = [
        frame.transform.extentM[0] / width,
        frame.transform.extentM[1] / height,
      ] as const;
      const localCenter: Vec2 = [
        -frame.transform.extentM[0] * 0.5 + spacingXZ[0] * 0.5,
        -frame.transform.extentM[1] * 0.5 + spacingXZ[1] * 0.5,
      ];
      const cosine = Math.cos(frame.transform.yawRadians),
        sine = Math.sin(frame.transform.yawRadians);
      const originXZ = Object.freeze<Vec2>([
        frame.transform.centerXZ[0] + cosine * localCenter[0] - sine * localCenter[1],
        frame.transform.centerXZ[1] + sine * localCenter[0] + cosine * localCenter[1],
      ]);
      const names = waterAdvancedOutputNames(frame.recipe.guid, bodyGuid, worldIdentity);
      return Object.freeze({
        bodyGuid,
        bodyBindingGeneration: body.sceneGeneration,
        sourceBodyGeneration: frame.body.generation,
        source: 'live',
        sourceRecipeGuid: frame.recipe.guid,
        simulationGeneration: frame.generation,
        sequence: frame.sequence,
        sourceFrame: Object.freeze({
          generation: frame.generation,
          sequence: frame.sequence,
          step: frame.step,
          timeSeconds: frame.timeSeconds,
        }),
        domain: Object.freeze({
          originXZ,
          originY: frame.transform.heightOriginM,
          spacingXZ: Object.freeze<Vec2>(spacingXZ),
          resolution: Object.freeze([width, height]) as readonly [number, number],
          yawRadians: frame.transform.yawRadians,
          basis: 'lattice-axis0-axis1-up/1',
        }),
        textures: Object.freeze({
          kind: 'render-feature-output-pair',
          gridTarget: names.grid,
          solverNormalTarget: names.normal,
        }),
      });
    }
    const baked = this.bakedQueryGrid(bodyGuid, body.sceneGeneration)?.grid;
    const lineage = baked?.lineage;
    if (
      baked === undefined ||
      lineage?.version !== 'water-river-bake/2' ||
      lineage.textureRevision === undefined ||
      lineage.normalTextureGuid.length === 0 ||
      !Number.isSafeInteger(lineage.normalTextureRevision) ||
      lineage.normalTextureRevision < 0 ||
      (sourceRecipeGuid !== undefined && lineage.sourceRecipeGuid !== sourceRecipeGuid) ||
      lineage.sourceBodyGuid.toLowerCase() !== body.sourceAssetGuid.toLowerCase()
    )
      return undefined;
    return Object.freeze({
      bodyGuid,
      bodyBindingGeneration: body.sceneGeneration,
      sourceBodyGeneration: lineage.sourceBodyGeneration,
      source: 'baked',
      sourceRecipeGuid: lineage.sourceRecipeGuid,
      simulationGeneration: lineage.simulationGeneration,
      sequence: lineage.sequence,
      sourceFrame: Object.freeze({ ...lineage.sourceFrame }),
      domain: Object.freeze({
        originXZ: Object.freeze<Vec2>([...baked.originXZ]),
        originY: baked.originY,
        spacingXZ: Object.freeze<Vec2>([...baked.spacingXZ]),
        resolution: Object.freeze([baked.width, baked.height]) as readonly [number, number],
        // River Bake /2 captures its accepted query grid on a world-axis lattice.
        // The source matrix qualifies geometry/pose only; it does not rotate the grid.
        yawRadians: 0,
        basis: lineage.normalBasis,
      }),
      textures: Object.freeze({
        kind: 'pack-texture-pair',
        gridGuid: lineage.textureGuid,
        gridRevision: lineage.textureRevision,
        gridFormat: 'rgba16float',
        solverNormalGuid: lineage.normalTextureGuid,
        solverNormalRevision: lineage.normalTextureRevision,
        solverNormalFormat: lineage.normalTextureFormat,
      }),
    });
  }
  removeAdvancedSimulation(simulation: WaterAdvancedSimulation): void {
    for (const [key, current] of this.#advanced)
      if (current === simulation) {
        current.retire();
        this.#advanced.delete(key);
      }
  }
  requestOceanPatch(recipe: WaterAdvancedRecipe): Result<WaterOceanPatch, WaterAdvancedError> {
    if (this.#oceanPatch) {
      if (
        this.#oceanPatch.recipe.guid === recipe.guid &&
        this.#oceanPatch.recipe.contentVersion === recipe.contentVersion
      )
        return ok(this.#oceanPatch);
      return err(
        this.#oceanPatch.failure(
          'water-advanced-invalid-input',
          'one OceanPatch recipe version per World',
          {
            accepted: {
              guid: this.#oceanPatch.recipe.guid,
              version: this.#oceanPatch.recipe.contentVersion,
            },
            requested: { guid: recipe.guid, version: recipe.contentVersion },
          },
        ),
      );
    }
    const created = WaterOceanPatch.create(recipe);
    if (created.ok) this.#oceanPatch = created.value;
    return created;
  }
  oceanPatch(): WaterOceanPatch | undefined {
    return this.#oceanPatch;
  }
  /** Opt in one Body generation to completed native-clock Ocean residuals. */
  configureOceanPatchQueries(
    binding: WaterResidualQueryBinding | undefined,
  ): Result<void, WaterError> {
    const patch = this.#oceanPatch;
    if (!binding) {
      patch?.configureQueryFeedback(undefined);
      return ok(undefined);
    }
    const body = this.snapshot(binding.bodyGuid),
      config = patch?.recipe.asset.oceanPatchConfig;
    const matrix = body?.worldMatrixM;
    const base =
      body && matrix
        ? Number(matrix[13]) +
          Number(matrix[5]) *
            (body.asset.baseHeightM +
              (body.asset.type === 'ocean' ? (body.asset.heightOffsetM ?? 0) : 0))
        : NaN;
    if (
      !patch ||
      config?.algorithm !== 'mode-projected-gravity/1' ||
      !body ||
      (body.asset.type !== 'ocean' && body.asset.type !== 'lake') ||
      body.sceneGeneration !== binding.bodyGeneration ||
      !binding.worldIdentity ||
      !Number.isFinite(binding.maximumAgeSeconds) ||
      binding.maximumAgeSeconds <= 0 ||
      binding.maximumAgeSeconds > 0.5 ||
      Math.abs(Number(matrix?.[1])) > 1e-6 ||
      Math.abs(Number(matrix?.[9])) > 1e-6 ||
      Math.abs(base - config.baseHeightM) > 1e-5
    )
      return err({
        code: 'query-data-unavailable',
        expected:
          'one current flat Ocean/Lake Body and mode-projected patch with the same source reference height and an explicit native-clock age bound (0,.5] seconds',
        hint: 'publish a matching recipe/Body generation before enabling local residual queries',
        detail: {
          binding,
          bodyGeneration: body?.sceneGeneration,
          bodyHeightM: base,
          sourceHeightM:
            config?.algorithm === 'mode-projected-gravity/1' ? config.baseHeightM : undefined,
        },
      });
    patch.configureQueryFeedback(binding);
    return ok(undefined);
  }
  prepareOceanPatchQueries(
    guid: string,
    generation: number,
    positions: readonly import('./contracts.js').Vec3[],
    receiver?: import('./query-residual.js').WaterResidualQueryReceiver,
  ): void {
    this.#oceanPatch?.requestQueryRegion(guid, generation, positions, receiver);
  }
  retainOceanPatchQueryReceivers(
    receivers: readonly import('./query-residual.js').WaterResidualQueryReceiver[],
  ): void {
    this.#oceanPatch?.retainQueryReceivers(receivers);
  }
  oceanPatchQuerySnapshot(guid: string): WaterResidualQuerySource | undefined {
    return this.#oceanPatch?.queryFeedbackSnapshot(guid);
  }
  oceanPatchQueryLifecycle(guid: string): string | undefined {
    return this.#oceanPatch?.queryLifecycleIdentity(guid);
  }
  removeOceanPatch(): void {
    this.#oceanPatch?.retire();
    this.#oceanPatch = undefined;
  }
  /** Replaces the Scene-associated exclusion set without dirtying shared tile or WaterInfo geometry. */
  setExclusionVolumes(
    guid: string,
    volumes: readonly WaterExclusionVolumeSnapshot[],
  ): Result<boolean, WaterError> {
    const body = this.#bodies.get(guid);
    const admitting = this.#bakedQueryGridCandidates.get(guid);
    if (admitting?.phase) return err(bakedAdmissionPending(guid, admitting));
    if (!body)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted Body instance',
        hint: 'mount the Scene WaterBody before updating its exclusion volumes',
      });
    if (
      volumes.some(
        (volume) =>
          !Number.isSafeInteger(volume.entity) ||
          volume.entity < 0 ||
          volume.centerM.length !== 3 ||
          !volume.centerM.every(Number.isFinite) ||
          volume.halfExtentsM.length !== 3 ||
          !volume.halfExtentsM.every((value) => Number.isFinite(value) && value > 0) ||
          !validMatrix(volume.worldMatrixM),
      )
    )
      return err({
        code: 'invalid-source',
        expected: 'finite transformed 3D Scene exclusion boxes in meters',
        hint: 'repair the WaterExclusionVolume center, extents or Transform',
      });
    const candidate = freezeExclusions(volumes);
    if (canonicalJson(candidate) === canonicalJson(body.exclusionVolumes)) return ok(false);
    const dirty = new Set(body.dirty);
    dirty.add('query');
    if (body.asset.type === 'ocean' && body.asset.collision.enabled) dirty.add('collision');
    const changed: WaterDirtyKind[] = [
      'query',
      ...(body.asset.type === 'ocean' && body.asset.collision.enabled
        ? ['collision' as const]
        : []),
    ];
    const generation = ++this.#sceneGeneration;
    this.#bakedQueryGridCandidates.delete(guid);
    this.#oceanPatch?.invalidateQueryBody(guid, generation);
    this.#bodies.set(guid, {
      ...body,
      exclusionVolumes: candidate,
      generation,
      outputGenerations: outputGenerations(generation, body.outputGenerations, changed),
      dirty,
    });
    return ok(true);
  }
  /** UE-style full 3D EncompassesPoint check; this does not depend on a Physics receipt. */
  isPointExcluded(guid: string, worldPositionM: readonly number[]): boolean {
    const body = this.#bodies.get(guid);
    return (
      !!body &&
      worldPositionM.length === 3 &&
      worldPositionM.every(Number.isFinite) &&
      body.exclusionVolumes.some((volume) => exclusionContainsPoint(volume, worldPositionM))
    );
  }
  /** Record one consumer's accepted output only for the current source and Scene generation. */
  acceptOutput(
    guid: string,
    kind: WaterDirtyKind,
    outputGeneration: number,
    consumerReceipt: {
      readonly generation: number;
      readonly digest: string;
    },
  ): Result<boolean, WaterError> {
    const body = this.#bodies.get(guid);
    if (!body)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted Body snapshot',
        hint: 'mount the Scene WaterBody before accepting an output',
      });
    if (body.outputGenerations.get(kind) !== outputGeneration)
      return err({
        code: 'stale-generation',
        expected: `the current ${kind} consumer generation for this Body instance`,
        hint: 'accept only the output built for the current consumer inputs',
      });
    if (
      !consumerReceipt ||
      !Number.isSafeInteger(consumerReceipt.generation) ||
      consumerReceipt.generation < 0 ||
      typeof consumerReceipt.digest !== 'string' ||
      consumerReceipt.digest.length === 0
    )
      return err({
        code: 'invalid-source',
        expected: 'a detached consumer publication generation and input digest',
        hint: 'accept output only from a consumer publication receipt',
      });
    const requested = () =>
      kind === 'geometry' ||
      kind === 'query' ||
      (kind === 'waterInfo' && body.asset.flags.affectsWaterInfo) ||
      (kind === 'waterMesh' && body.asset.flags.affectsWaterMesh) ||
      (kind === 'terrainBrush' && body.asset.flags.affectsLandscape) ||
      (kind === 'collision' && body.asset.collision.enabled) ||
      (kind === 'material' && hasMaterialSlots(body.asset));
    if (!requested())
      return err({
        code: 'invalid-source',
        expected: `a requested ${kind} output`,
        hint: 'do not publish an output disabled by the accepted Body source',
      });
    const binding = body.asset.zoneGuid ? this.resolveZone(body.asset.zoneGuid) : undefined;
    if ((kind === 'waterInfo' || kind === 'waterMesh') && !binding)
      return err({
        code: 'zone-unbound',
        expected: 'a live Zone binding before accepting Zone-dependent output',
        hint: 'bind the Body to its live Zone before accepting this output',
      });
    const previousReceipt = body.acceptedOutputs.get(kind);
    const alreadyAccepted =
      previousReceipt?.outputGeneration === outputGeneration &&
      previousReceipt.consumerGeneration === consumerReceipt.generation &&
      previousReceipt.digest === consumerReceipt.digest &&
      !body.dirty.has(kind);
    body.acceptedOutputs.set(
      kind,
      Object.freeze({
        sourceVersion: body.version,
        sceneGeneration: body.generation,
        outputGeneration,
        consumerGeneration: consumerReceipt.generation,
        digest: consumerReceipt.digest,
      }),
    );
    body.dirty.delete(kind);
    return ok(!alreadyAccepted);
  }
  /** The ephemeral index is scoped by Zone generation and never becomes identity. */
  bindZoneIndex(
    bodyGuid: string,
    zoneGuid: string,
    zoneGeneration: number,
    index: number,
  ): Result<void, WaterError> {
    const body = this.#bodies.get(bodyGuid);
    const zone = this.resolveZone(zoneGuid);
    if (
      !body ||
      body.asset.zoneGuid !== zoneGuid ||
      !zone ||
      zone.generation !== zoneGeneration ||
      !Number.isInteger(zoneGeneration) ||
      zoneGeneration < 0 ||
      !Number.isInteger(index) ||
      index < 0
    )
      return err({
        code: 'stale-generation',
        expected: 'live body and Zone identity at the supplied generation',
        hint: 'bind using the live Scene Zone GUID, generation, and index',
      });
    this.#zoneSlots.set(bodyGuid, { zoneGuid, zoneGeneration, index });
    return ok(undefined);
  }
  zoneIndex(bodyGuid: string, zoneGuid: string, zoneGeneration: number): number | undefined {
    const slot = this.#zoneSlots.get(bodyGuid);
    const body = this.#bodies.get(bodyGuid);
    const liveZone = this.resolveZone(zoneGuid);
    if (
      !slot ||
      !body ||
      body.asset.zoneGuid !== zoneGuid ||
      slot.zoneGuid !== zoneGuid ||
      slot.zoneGeneration !== zoneGeneration ||
      liveZone?.generation !== zoneGeneration
    )
      return undefined;
    return slot.index;
  }
  /** Track the complete, deterministic set of live Terrain providers intersecting a Zone. */
  observeZoneGroundInputs(
    zoneGuid: string,
    zoneGeneration: number,
    providers: readonly WaterZoneTerrainProviderInput[],
    observe?: WaterOperationObserver,
  ): WaterZoneGroundSnapshot | undefined {
    const snapshot = this.updateZoneGroundInputs(zoneGuid, zoneGeneration, providers);
    return snapshot === undefined ? undefined : this.copyZoneGroundSnapshot(snapshot, observe);
  }
  /** Update accepted ground inputs for the Scene owner without materializing a detached Terrain copy. */
  reconcileZoneGroundInputs(
    zoneGuid: string,
    zoneGeneration: number,
    providers: readonly WaterZoneTerrainProviderInput[],
  ): WaterZoneGroundQuerySnapshot | undefined {
    if (this.updateZoneGroundInputs(zoneGuid, zoneGeneration, providers) === undefined)
      return undefined;
    return this.#zoneGroundQueries.get(zoneGuid);
  }
  /** Retain the accepted roster while a still-live provider awaits a readable candidate. */
  markZoneGroundInputsPending(zoneGuid: string, zoneGeneration: number): void {
    if (!zoneGuid || !Number.isSafeInteger(zoneGeneration) || zoneGeneration < 0) return;
    const previous = this.#zoneGroundPending.get(zoneGuid);
    if (previous?.zoneGeneration === zoneGeneration) return;
    const accepted = this.#zoneGroundQueries.get(zoneGuid);
    const base = accepted?.zoneGeneration === zoneGeneration ? accepted : undefined;
    this.#zoneGroundPending.set(
      zoneGuid,
      Object.freeze({
        zoneGuid,
        zoneGeneration,
        generation: base?.generation ?? 0,
        dirty: base?.dirty ?? true,
        pending: true,
        providers: base?.providers ?? Object.freeze([]),
      }),
    );
  }
  private refreshPendingZoneGroundQuery(zoneGuid: string): void {
    const pending = this.#zoneGroundPending.get(zoneGuid);
    const accepted = this.#zoneGroundQueries.get(zoneGuid);
    if (pending === undefined || accepted?.zoneGeneration !== pending.zoneGeneration) return;
    this.#zoneGroundPending.set(zoneGuid, Object.freeze({ ...accepted, pending: true }));
  }
  private updateZoneGroundInputs(
    zoneGuid: string,
    zoneGeneration: number,
    providers: readonly WaterZoneTerrainProviderInput[],
  ): WaterZoneGroundSnapshot | undefined {
    if (!zoneGuid || !Number.isSafeInteger(zoneGeneration) || zoneGeneration < 0) return undefined;
    const invalidProvider = (provider: WaterZoneTerrainProviderInput): boolean =>
      provider === undefined ||
      !Number.isSafeInteger(provider.entity) ||
      provider.entity < 0 ||
      !provider.terrainGuid ||
      !Number.isSafeInteger(provider.terrainVersion) ||
      provider.terrainVersion < 0 ||
      provider.worldMatrixM.length !== 16 ||
      !isFiniteNumberSequence(provider.worldMatrixM) ||
      provider.boundsXZ.minM.length !== 2 ||
      !isFiniteNumberSequence(provider.boundsXZ.minM) ||
      provider.boundsXZ.maxM.length !== 2 ||
      !isFiniteNumberSequence(provider.boundsXZ.maxM) ||
      (provider.terrainAsset !== undefined &&
        (provider.terrainAsset.kind !== 'terrain' ||
          provider.terrainAsset.columns < 2 ||
          provider.terrainAsset.rows < 2 ||
          provider.terrainAsset.heights.length !==
            provider.terrainAsset.columns * provider.terrainAsset.rows));
    for (const provider of providers) if (invalidProvider(provider)) return undefined;
    const previous = this.#zoneGround.get(zoneGuid);
    if (
      previous !== undefined &&
      previous.zoneGeneration === zoneGeneration &&
      sameZoneGroundProviderRoster(providers, previous.providers)
    ) {
      this.#zoneGroundPending.delete(zoneGuid);
      return previous;
    }
    const fixedProviders = Object.freeze(
      [...providers]
        .sort((left, right) => left.entity - right.entity)
        .map((provider) =>
          Object.freeze({
            ...provider,
            ...(provider.terrainAsset
              ? { terrainAsset: freezeTerrainAssetSnapshot(provider.terrainAsset) }
              : {}),
            worldMatrixM: Object.freeze([...provider.worldMatrixM]),
            boundsXZ: Object.freeze({
              minM: Object.freeze([...provider.boundsXZ.minM]) as readonly [number, number],
              maxM: Object.freeze([...provider.boundsXZ.maxM]) as readonly [number, number],
            }),
          }),
        ),
    );
    const snapshot = Object.freeze({
      zoneGuid,
      zoneGeneration,
      generation: ++this.#sceneGeneration,
      providers: fixedProviders,
      dirty: true,
    });
    this.#zoneGround.set(zoneGuid, snapshot);
    this.#zoneGroundQueries.set(zoneGuid, this.makeZoneGroundQuerySnapshot(snapshot));
    this.#zoneGroundPending.delete(zoneGuid);
    return snapshot;
  }
  zoneGroundSnapshot(
    zoneGuid: string,
    observe?: WaterOperationObserver,
  ): WaterZoneGroundSnapshot | undefined {
    const snapshot = this.#zoneGround.get(zoneGuid);
    return snapshot === undefined ? undefined : this.copyZoneGroundSnapshot(snapshot, observe);
  }
  /** Borrow the immutable Zone ground generation and provider identity without copying Terrain payloads. */
  zoneGroundQuerySnapshot(zoneGuid: string): WaterZoneGroundQuerySnapshot | undefined {
    return this.#zoneGroundPending.get(zoneGuid) ?? this.#zoneGroundQueries.get(zoneGuid);
  }
  private copyZoneGroundSnapshot(
    snapshot: WaterZoneGroundSnapshot,
    observe?: WaterOperationObserver,
  ): WaterZoneGroundSnapshot {
    const scope = beginWaterOperation(observe, 'water/zone/ground-snapshot-copy');
    try {
      return Object.freeze({
        ...snapshot,
        providers: Object.freeze(
          snapshot.providers.map((provider) =>
            Object.freeze({
              ...provider,
              ...(provider.terrainAsset
                ? { terrainAsset: freezeTerrainAssetSnapshot(provider.terrainAsset) }
                : {}),
              worldMatrixM: Object.freeze([...provider.worldMatrixM]),
              boundsXZ: Object.freeze({
                minM: Object.freeze([...provider.boundsXZ.minM]) as readonly [number, number],
                maxM: Object.freeze([...provider.boundsXZ.maxM]) as readonly [number, number],
              }),
            }),
          ),
        ),
      });
    } finally {
      endWaterOperation(scope);
    }
  }
  private makeZoneGroundQuerySnapshot(
    snapshot: WaterZoneGroundSnapshot,
  ): WaterZoneGroundQuerySnapshot {
    return Object.freeze({
      zoneGuid: snapshot.zoneGuid,
      zoneGeneration: snapshot.zoneGeneration,
      generation: snapshot.generation,
      pending: false,
      dirty: snapshot.dirty,
      providers: Object.freeze(
        snapshot.providers.map((provider) =>
          Object.freeze({
            entity: provider.entity,
            terrainGuid: provider.terrainGuid,
            terrainVersion: provider.terrainVersion,
            worldMatrixM: provider.worldMatrixM,
            boundsXZ: provider.boundsXZ,
          }),
        ),
      ),
    });
  }
  zoneViewWindow(
    zoneGuid: string,
    viewId: string,
    positionM: ArrayLike<number>,
  ): WaterZoneViewWindow | undefined {
    if (positionM.length !== 3 || !Array.from(positionM).every(Number.isFinite)) return undefined;
    const zone = this.zoneSnapshots().find((candidate) => candidate.guid === zoneGuid);
    if (!zone) return undefined;
    const key = JSON.stringify([zoneGuid, viewId]);
    const window = createWaterZoneViewWindow(
      zone,
      viewId,
      positionM,
      this.#sceneGeneration,
      this.#zoneViewWindows.get(key),
    );
    this.#zoneViewWindows.set(key, window);
    return window;
  }
  /** Build a CPU quadtree candidate and return a detached caller-owned snapshot. */
  buildZoneMeshView(
    zoneGuid: string,
    zoneGeneration: number,
    zone: WaterZoneAsset,
    view: WaterMeshViewInput,
    observe?: WaterOperationObserver,
  ): Result<WaterZoneMeshPublication, WaterError> {
    const result = this.#buildZoneMeshView(zoneGuid, zoneGeneration, zone, view, observe);
    if (!result.ok) return result;
    const copyScope = beginWaterOperation(observe, 'water/mesh/publication-copy');
    try {
      return ok(copyWaterMeshPublication(result.value));
    } finally {
      endWaterOperation(copyScope);
    }
  }
  #buildZoneMeshView(
    zoneGuid: string,
    zoneGeneration: number,
    zone: WaterZoneAsset,
    view: WaterMeshViewInput,
    observe?: WaterOperationObserver,
  ): Result<WaterZoneMeshPublication, WaterError> {
    const liveZone = this.resolveZone(zoneGuid);
    const matchesAcceptedZone = (): boolean =>
      liveZone?.asset === zone ||
      (liveZone?.asset === undefined &&
        this.enumerateZones().some(
          (snapshot) =>
            snapshot.guid === zoneGuid &&
            snapshot.generation === zoneGeneration &&
            snapshot.asset === zone,
        ));
    if (
      !liveZone ||
      liveZone.generation !== zoneGeneration ||
      !matchesAcceptedZone() ||
      zone.kind !== 'water-zone'
    )
      return err({
        code: 'stale-generation',
        expected: 'the accepted live Zone asset and transform at the requested generation',
        hint: 'reconcile the Scene Zone and pass its accepted asset before building CPU WaterMesh tiles',
      });
    const key = JSON.stringify([zoneGuid, view.viewId]);
    // Accepted Body generations own their frozen geometry/material inputs. A live callback has no such proof.
    const signatureMatchScope = beginWaterOperation(observe, 'water/mesh/input-signature-match');
    let buildInputs: string | undefined;
    let committed: WaterZoneMeshPublication | undefined;
    const matchBuildInputs = () => {
      try {
        buildInputs =
          view.occluded === undefined
            ? canonicalJson({
                zone,
                zoneGeneration,
                worldMatrixM: liveZone.worldMatrixM ?? IDENTITY_MATRIX,
                bodies: [...this.#bodies].map(([guid, body]) => [
                  guid,
                  body.generation,
                  body.outputGenerations.get('waterMesh'),
                ]),
                observerM: view.observerM,
                frustumPlanes: view.frustumPlanes,
                waterInfoBoundsXZ: view.waterInfoBoundsXZ,
              })
            : undefined;
        committed = this.#zoneMeshViews.get(key);
        if (buildInputs !== undefined) {
          if (committed && this.#zoneMeshBuildInputs.get(committed) === buildInputs) {
            this.#zoneMeshCandidates.delete(key);
            return ok(committed);
          }
          const candidate = this.#zoneMeshCandidates.get(key);
          if (candidate && this.#zoneMeshBuildInputs.get(candidate) === buildInputs)
            return ok(candidate);
        }
      } finally {
        endWaterOperation(signatureMatchScope);
      }

      return undefined;
    };
    const retained = matchBuildInputs();
    if (retained !== undefined) return retained;
    const insertionOrder = new Map([...this.#bodies.keys()].map((guid, index) => [guid, index]));
    const snapshots = this.snapshots().filter(
      (snapshot) =>
        snapshot.asset.zoneGuid === zoneGuid &&
        snapshot.binding.kind === 'bound' &&
        snapshot.binding.zoneGeneration === zoneGeneration &&
        snapshot.asset.flags.affectsWaterMesh,
    );
    if (snapshots.some((snapshot) => !waterMeshBodyTransformSupported(snapshot.worldMatrixM)))
      return err({
        code: 'invalid-source',
        expected:
          'WaterMesh Body transforms with a world-horizontal surface (translation, yaw and scale; no pitch or roll)',
        hint: 'remove Body pitch/roll before publishing the flat-XZ WaterMesh surface',
      });
    const projectZoneDomain = (): Result<
      {
        worldMatrix: readonly number[];
        originXZ: Vec2;
        extentX: number;
        extentZ: number;
        maxX: number;
        maxZ: number;
      },
      WaterError
    > => {
      const worldMatrix = liveZone.worldMatrixM ?? IDENTITY_MATRIX;
      if (!waterMeshZoneTransformSupported(worldMatrix))
        return err({
          code: 'invalid-source',
          expected:
            'an axis-aligned WaterZone transform with equal nonzero X/Z scale supported by the square WaterMesh tile ABI',
          hint: 'remove Zone rotation/pitch/roll and use uniform horizontal scale before building WaterMesh tiles',
        });
      const zoneCorners = [
        [-zone.extentM.spanXM / 2, 0, -zone.extentM.spanZM / 2],
        [zone.extentM.spanXM / 2, 0, -zone.extentM.spanZM / 2],
        [zone.extentM.spanXM / 2, 0, zone.extentM.spanZM / 2],
        [-zone.extentM.spanXM / 2, 0, zone.extentM.spanZM / 2],
      ].map((point) => transformPoint(worldMatrix, point as [number, number, number]));
      const minX = Math.min(...zoneCorners.map((point) => point[0])),
        maxX = Math.max(...zoneCorners.map((point) => point[0]));
      const minZ = Math.min(...zoneCorners.map((point) => point[2])),
        maxZ = Math.max(...zoneCorners.map((point) => point[2]));
      const originXZ: Vec2 = [minX, minZ];
      const extentX = maxX - minX,
        extentZ = maxZ - minZ;
      return ok({ worldMatrix, originXZ, extentX, extentZ, maxX, maxZ });
    };
    const zoneDomain = projectZoneDomain();
    if (!zoneDomain.ok) return zoneDomain;
    const { worldMatrix, originXZ, extentX, extentZ, maxX, maxZ } = zoneDomain.value;
    const bodies: WaterMeshBodyInput[] = snapshots.map((snapshot) => {
      const asset = snapshot.asset;
      const bodyMatrix = snapshot.worldMatrixM;
      const footprintY =
        asset.baseHeightM + (asset.type === 'ocean' ? (asset.heightOffsetM ?? 0) : 0);
      const transformRing = (points: readonly Vec2[]) =>
        points.map((point) => {
          const transformed = transformPoint(bodyMatrix, [point[0], footprintY, point[1]]);
          return [transformed[0], transformed[2]] satisfies Vec2;
        });
      const projectFootprint = () => {
        const footprint =
          asset.type === 'lake' && asset.geometrySnapshot?.collisionDescriptor?.footprint
            ? asset.geometrySnapshot.collisionDescriptor.footprint
            : asset.geometrySnapshot?.queryFootprint;
        const polygonRings =
          asset.type === 'custom' && asset.geometrySnapshot?.waterMeshFootprint
            ? asset.geometrySnapshot.waterMeshFootprint.rings.map(transformRing)
            : undefined;
        const polygon =
          asset.type === 'custom' && polygonRings
            ? undefined
            : footprint
              ? { outer: transformRing(footprint.outer), holes: footprint.holes.map(transformRing) }
              : asset.type === 'lake'
                ? { outer: transformRing(asset.queryFootprint), holes: [] }
                : undefined;

        return { polygon, polygonRings };
      };
      const { polygon, polygonRings } = projectFootprint();
      const baseHeightM = transformPoint(bodyMatrix, [
        0,
        asset.baseHeightM + (asset.type === 'ocean' ? (asset.heightOffsetM ?? 0) : 0),
        0,
      ])[1];
      const projectVerticalBounds = () => {
        let worldYBounds: readonly [number, number] = [
          baseHeightM - asset.maxWaveHeightM,
          baseHeightM + asset.maxWaveHeightM,
        ];
        if (asset.type === 'river' && asset.geometrySnapshot) {
          const localYBounds = [
            asset.geometrySnapshot.queryVolume.minimumYM,
            asset.geometrySnapshot.queryVolume.maximumYM,
          ] as const;
          const footprintPoints = [
            ...asset.geometrySnapshot.queryFootprint.outer,
            ...asset.geometrySnapshot.queryFootprint.holes.flat(),
          ];
          const worldYs = footprintPoints.flatMap(([x, z]) =>
            localYBounds.map((y) => transformPoint(bodyMatrix, [x, y, z])[1]),
          );
          if (worldYs.length > 0) {
            const waveHeight = asset.maxWaveHeightM;
            worldYBounds = [Math.min(...worldYs) - waveHeight, Math.max(...worldYs) + waveHeight];
          }
        }
        const meshGuids =
          asset.type === 'river'
            ? (asset.riverSegmentMeshGuids ?? [])
            : asset.type === 'custom'
              ? [asset.customMeshOverrideGuid]
              : [asset.visibleMeshGuid];
        const meshPositions = snapshot.dependencies.flatMap((dependency) => {
          if (dependency.status !== 'valid' || !meshGuids.includes(dependency.guid)) return [];
          const positions = (
            dependency.payload as { attributes?: { position?: unknown } } | undefined
          )?.attributes?.position;
          return Array.isArray(positions) || positions instanceof Float32Array ? [positions] : [];
        });
        const renderBounds = waterBodyRenderBounds(asset, bodyMatrix, meshPositions);
        if (renderBounds)
          worldYBounds = [
            renderBounds.componentYM[0] - asset.maxWaveHeightM,
            renderBounds.componentYM[1] + asset.maxWaveHeightM,
          ];

        return worldYBounds;
      };
      const worldYBounds = projectVerticalBounds();
      const transitionMaterials = {
        ...(asset.riverToLakeTransitionMaterialGuid
          ? { lake: asset.riverToLakeTransitionMaterialGuid }
          : {}),
        ...(asset.riverToOceanTransitionMaterialGuid
          ? { ocean: asset.riverToOceanTransitionMaterialGuid }
          : {}),
      };
      return {
        guid: snapshot.guid,
        generation: snapshot.sceneGeneration,
        type: asset.type,
        visible: asset.renderOptions?.visible !== false,
        affectsWaterMesh: asset.flags.affectsWaterMesh,
        priority: asset.overlapPriority,
        insertionOrder: insertionOrder.get(snapshot.guid) ?? 0,
        materialKey: asset.surfaceMaterialGuid,
        waveOriginXZ: waterBodyWaveOriginXZ(snapshot),
        ...(Object.keys(transitionMaterials).length > 0 ? { transitionMaterials } : {}),
        ...(asset.transitionContinuity === undefined
          ? {}
          : {
              transitionContinuity: {
                centerXZ: ((): Vec2 => {
                  const endpoint = asset.spline.points[asset.spline.points.length - 1];
                  const terminal = requireWaterValue(endpoint);
                  const p = transformPoint(bodyMatrix, terminal.positionM);
                  return [p[0], p[2]];
                })(),
                reachM: asset.transitionContinuity.reachM,
                blendWidthM: asset.transitionContinuity.blendWidthM,
              },
            }),
        baseHeightM,
        maxWaveHeightM: asset.maxWaveHeightM,
        worldYBounds,
        ...(polygon ? { polygon } : {}),
        ...(polygonRings ? { polygonRings } : {}),
      };
    });
    const prepareFarDomain = (): Result<
      {
        tileSizeM: number;
        window: WaterZoneViewWindow | undefined;
        far: import('./water-mesh.js').WaterMeshBuildInput['far'];
        followsViewWindow: boolean;
        farInnerBounds: Readonly<{ minM: Vec2; maxM: Vec2 }>;
      },
      WaterError
    > => {
      const zoneScaleX = Math.hypot(
        requireWaterValue(worldMatrix[0]),
        requireWaterValue(worldMatrix[1]),
        requireWaterValue(worldMatrix[2]),
      );
      const zoneScaleZ = Math.hypot(
        requireWaterValue(worldMatrix[8]),
        requireWaterValue(worldMatrix[9]),
        requireWaterValue(worldMatrix[10]),
      );
      const tileSizeM = zone.tileSizeM * zoneScaleX;
      const hasOcean = bodies.some(
        (body) => body.type === 'ocean' && body.visible && body.affectsWaterMesh,
      );
      const followsViewWindow = zone.farMeshBoundary === 'view-window';
      const invalidViewWindow = (): boolean =>
        followsViewWindow &&
        (!hasOcean ||
          !zone.waterInfo.localTessellation ||
          zone.farExtentM === undefined ||
          zone.farMaterialGuid === undefined);
      if (invalidViewWindow())
        return err({
          code: 'invalid-source',
          expected:
            'view-window far mesh has an active Ocean owner, local tessellation, far extent and material',
          hint: 'enable local Ocean tessellation with far extent and material, or use the default zone boundary',
        });
      const farOwnerCandidates =
        !hasOcean && zone.farOwnerBodyGuid !== undefined
          ? snapshots.filter(
              (snapshot) =>
                snapshot.sourceAssetGuid.toLowerCase() ===
                  requireWaterValue(zone.farOwnerBodyGuid).toLowerCase() &&
                snapshot.asset.renderOptions?.visible !== false,
            )
          : [];
      if (!hasOcean && zone.farOwnerBodyGuid !== undefined && farOwnerCandidates.length !== 1)
        return err({
          code: 'invalid-source',
          expected:
            'exactly one active visible WaterBody instance in this Zone matches farOwnerBodyGuid',
          hint: 'bind one matching Body instance to the Zone, or give repeated instances distinct source assets before publishing no-Ocean far tiles',
          detail: {
            farOwnerBodyGuid: zone.farOwnerBodyGuid,
            matchCount: farOwnerCandidates.length,
          },
        });
      const farOwner = farOwnerCandidates[0];
      const farWaterLevelM =
        !hasOcean && zone.farWaterLevelM !== undefined
          ? transformPoint(worldMatrix, [0, zone.farWaterLevelM, 0])[1]
          : undefined;
      const window = this.zoneViewWindow(zoneGuid, view.viewId, view.observerM);
      let farInnerBounds: Readonly<{ minM: Vec2; maxM: Vec2 }> = {
        minM: originXZ,
        maxM: [maxX, maxZ],
      };
      if (followsViewWindow) {
        if (window === undefined)
          return err({
            code: 'invalid-source',
            expected: 'view-window far mesh has an accepted Zone view window',
            hint: 'restore the current Zone view window before publishing its near and far mesh',
          });
        farInnerBounds = {
          minM: [
            Math.max(
              window.meshOriginXZ[0],
              window.centerXZ[0] - window.extentXZ[0] / 2,
              view.waterInfoBoundsXZ?.minM[0] ?? -Infinity,
            ),
            Math.max(
              window.meshOriginXZ[1],
              window.centerXZ[1] - window.extentXZ[1] / 2,
              view.waterInfoBoundsXZ?.minM[1] ?? -Infinity,
            ),
          ],
          maxM: [
            Math.min(
              window.meshOriginXZ[0] + window.meshExtentXZ[0],
              window.centerXZ[0] + window.extentXZ[0] / 2,
              view.waterInfoBoundsXZ?.maxM[0] ?? Infinity,
            ),
            Math.min(
              window.meshOriginXZ[1] + window.meshExtentXZ[1],
              window.centerXZ[1] + window.extentXZ[1] / 2,
              view.waterInfoBoundsXZ?.maxM[1] ?? Infinity,
            ),
          ],
        };
      }
      const far = zone.farExtentM
        ? {
            extentM: [
              zone.farExtentM.spanXM * zoneScaleX,
              zone.farExtentM.spanZM * zoneScaleZ,
            ] satisfies Vec2,
            innerBoundsXZ: farInnerBounds,
            ...(zone.farMaterialGuid ? { materialKey: zone.farMaterialGuid } : {}),
            ...(farOwner ? { ownerGuid: farOwner.guid } : {}),
            ...(farWaterLevelM === undefined ? {} : { waterLevelM: farWaterLevelM }),
          }
        : undefined;

      return ok({ tileSizeM, window, far, followsViewWindow, farInnerBounds });
    };
    const farDomain = prepareFarDomain();
    if (!farDomain.ok) return farDomain;
    const { tileSizeM, window, far, followsViewWindow, farInnerBounds } = farDomain.value;
    const built = buildWaterMeshView(
      {
        zoneGuid,
        zoneGeneration,
        originXZ: window?.meshOriginXZ ?? originXZ,
        extentM: window?.meshExtentXZ ?? [extentX, extentZ],
        tileSizeM,
        tessellationFactor: zone.tessellationFactor,
        lodScale: zone.lodScale,
        ...(zone.gpuMesh === undefined ? {} : { nearMesh: 'gpu' as const }),
        ...(far ? { far } : {}),
        bodies,
      },
      followsViewWindow ? { ...view, waterInfoBoundsXZ: farInnerBounds } : view,
    );
    if (!built.ok)
      return err({
        code: 'invalid-source',
        expected: 'CPU WaterMesh build inputs derived from accepted Zone and Body snapshots',
        hint: 'retain the prior WaterMesh view and repair the invalid geometry or Zone settings',
        detail: built.error.detail,
      });
    const waterInfoPublicationFormat = (): WaterZoneMeshPublication['waterInfoFormat'] =>
      zone.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float';
    const waterInfoFormat = waterInfoPublicationFormat();
    const sourceGenerations = Object.freeze(
      Object.fromEntries(snapshots.map((snapshot) => [snapshot.guid, snapshot.sceneGeneration])),
    );
    const waterMeshOutputGenerations = Object.freeze(
      Object.fromEntries(
        snapshots.map((snapshot) => [snapshot.guid, snapshot.outputGenerations.waterMesh]),
      ),
    );
    // Candidate publication is synchronous; acceptance is deferred until its WaterInfo/wave closure is submitted.
    const stillCurrent =
      this.resolveZone(zoneGuid)?.generation === zoneGeneration &&
      snapshots.every(
        (snapshot) => this.snapshot(snapshot.guid)?.sceneGeneration === snapshot.sceneGeneration,
      );
    if (!stillCurrent)
      return err({
        code: 'stale-generation',
        expected: 'unchanged Zone and Body generations through mesh publication',
        hint: 'discard this build and retry with the current Scene snapshot',
      });
    const matchPublication = () => {
      const publicationSignatureScope = beginWaterOperation(
        observe,
        'water/mesh/publication-signature-match',
      );
      let digest: string;
      try {
        digest = canonicalJson({
          zoneGuid,
          zoneGeneration,
          waterInfoFormat,
          sourceGenerations,
          waterMeshOutputGenerations,
          viewId: view.viewId,
          layout: built.value.layout,
          instances: built.value.instances,
        });
        if (committed?.digest === digest) {
          this.#zoneMeshCandidates.delete(key);
          if (buildInputs !== undefined) this.#zoneMeshBuildInputs.set(committed, buildInputs);
          return { publication: committed, digest };
        }
      } finally {
        endWaterOperation(publicationSignatureScope);
      }

      return { publication: undefined, digest };
    };
    const matched = matchPublication();
    if (matched.publication !== undefined) return ok(matched.publication);
    const digest = matched.digest;
    const publication: WaterZoneMeshPublication = Object.freeze({
      zoneGuid,
      zoneGeneration,
      waterInfoFormat,
      viewId: view.viewId,
      publicationGeneration: ++this.#waterMeshPublicationGeneration,
      sourceGenerations,
      waterMeshOutputGenerations,
      digest,
      current: true,
      receipt: built.value,
    });
    this.#zoneMeshBuildInputs.set(publication, buildInputs ?? digest);
    this.#meshCandidateEpochs.set(publication, this.#meshViewEpochs.get(view.viewId) ?? 0);
    this.#zoneMeshCandidates.set(key, publication);
    return ok(publication);
  }
  zoneMeshView(
    zoneGuid: string,
    viewId: string,
    observe?: WaterOperationObserver,
  ): WaterZoneMeshPublication | undefined {
    const publication = this.#zoneMeshView(zoneGuid, viewId);
    if (publication === undefined) return undefined;
    const copyScope = beginWaterOperation(observe, 'water/mesh/publication-copy');
    try {
      return copyWaterMeshPublication(publication);
    } finally {
      endWaterOperation(copyScope);
    }
  }
  #zoneMeshView(zoneGuid: string, viewId: string): WaterZoneMeshPublication | undefined {
    const publication = this.#zoneMeshViews.get(JSON.stringify([zoneGuid, viewId]));
    if (!publication) return undefined;
    const current =
      this.resolveZone(zoneGuid)?.generation === publication.zoneGeneration &&
      Object.entries(publication.sourceGenerations).every(
        ([guid, generation]) => this.snapshot(guid)?.sceneGeneration === generation,
      );
    return current === publication.current
      ? publication
      : Object.freeze({ ...publication, current });
  }
  /** Candidate views become the retained proxy only after their WaterInfo/wave closure is submitted. */
  waterMeshCandidateViews(
    viewId: string,
    observe?: WaterOperationObserver,
  ): readonly WaterZoneMeshPublication[] {
    const publications = this.#waterMeshCandidateViews(viewId);
    if (publications.length === 0) return Object.freeze([]);
    const copyScope = beginWaterOperation(observe, 'water/mesh/publication-copy');
    try {
      return Object.freeze(publications.map(copyWaterMeshPublication));
    } finally {
      endWaterOperation(copyScope);
    }
  }
  #waterMeshCandidateViews(viewId: string): readonly WaterZoneMeshPublication[] {
    return Object.freeze(
      [...this.#zoneMeshCandidates.values()].filter((publication) => publication.viewId === viewId),
    );
  }
  /** Retire a view's CPU proxy state when its camera or renderer device ends. */
  retireWaterMeshView(viewId: string): void {
    this.#meshViewEpochs.set(viewId, (this.#meshViewEpochs.get(viewId) ?? 0) + 1);
    for (const [key, window] of this.#zoneViewWindows)
      if (window.viewId === viewId) this.#zoneViewWindows.delete(key);
    for (const [key, publication] of this.#zoneMeshViews)
      if (publication.viewId === viewId) this.#zoneMeshViews.delete(key);
    for (const [key, publication] of this.#zoneMeshCandidates)
      if (publication.viewId === viewId) this.#zoneMeshCandidates.delete(key);
    for (const [key, owner] of this.#acceptedMeshOwners)
      if (owner.viewId === viewId) this.#acceptedMeshOwners.delete(key);
    this.#meshViewDevices.delete(viewId);
  }
  /** Retire publications only when a Zone leaves the Scene, not during a failed replacement. */
  retireWaterMeshZone(zoneGuid: string): void {
    for (const [key, window] of this.#zoneViewWindows)
      if (window.zoneGuid === zoneGuid) this.#zoneViewWindows.delete(key);
    for (const [key, publication] of this.#zoneMeshViews)
      if (publication.zoneGuid === zoneGuid) this.#zoneMeshViews.delete(key);
    for (const [key, publication] of this.#zoneMeshCandidates)
      if (publication.zoneGuid === zoneGuid) this.#zoneMeshCandidates.delete(key);
    for (const [key, owner] of this.#acceptedMeshOwners)
      if (owner.zoneGuid === zoneGuid) this.#acceptedMeshOwners.delete(key);
  }
  retireWaterMeshViewsExcept(viewIds: Iterable<string>): void {
    const live = new Set(viewIds);
    const cached = new Set([
      ...[...this.#zoneMeshViews.values()].map((publication) => publication.viewId),
      ...[...this.#zoneMeshCandidates.values()].map((publication) => publication.viewId),
      ...[...this.#acceptedMeshOwners.values()].map((owner) => owner.viewId),
      ...this.#meshViewDevices.keys(),
      ...[...this.#zoneViewWindows.values()].map((window) => window.viewId),
    ]);
    for (const viewId of cached) if (!live.has(viewId)) this.retireWaterMeshView(viewId);
  }
  observeWaterMeshViewDevice(viewId: string, deviceGeneration: number): void {
    const previous = this.#meshViewDevices.get(viewId);
    if (previous !== undefined && previous !== deviceGeneration) this.retireWaterMeshView(viewId);
    this.#meshViewDevices.set(viewId, deviceGeneration);
  }
  acceptWaterMeshView(zoneGuid: string, viewId: string, publicationGeneration: number): boolean {
    const key = JSON.stringify([zoneGuid, viewId]);
    const candidate = this.#zoneMeshCandidates.get(key);
    return candidate?.publicationGeneration === publicationGeneration
      ? this.#acceptWaterMeshView(candidate)
      : false;
  }
  #acceptWaterMeshView(candidate: WaterZoneMeshPublication): boolean {
    const { zoneGuid, viewId } = candidate;
    const key = JSON.stringify([zoneGuid, viewId]);
    const committed = this.#zoneMeshViews.get(key);
    if (
      !this.#zoneMeshBuildInputs.has(candidate) ||
      this.#meshCandidateEpochs.get(candidate) !== (this.#meshViewEpochs.get(viewId) ?? 0) ||
      (!committed && !this.#zoneMeshCandidates.has(key)) ||
      (committed !== undefined &&
        committed.publicationGeneration > candidate.publicationGeneration) ||
      this.resolveZone(zoneGuid)?.generation !== candidate.zoneGeneration ||
      !Object.entries(candidate.sourceGenerations).every(([guid, generation]) => {
        const body = this.snapshot(guid);
        return (
          body !== undefined &&
          body.sceneGeneration === generation &&
          body.binding.kind === 'bound' &&
          body.asset.flags.affectsWaterMesh === true &&
          body.binding.zoneGuid === zoneGuid &&
          body.binding.zoneGeneration === candidate.zoneGeneration &&
          body.outputGenerations.waterMesh === candidate.waterMeshOutputGenerations[guid]
        );
      }) ||
      !candidate.receipt.buckets.every((bucket) =>
        bucket.ownerDraws.every((draw) => {
          const body = this.snapshot(draw.ownerGuid);
          return (
            body !== undefined &&
            body.sceneGeneration === draw.ownerGeneration &&
            body.binding.kind === 'bound' &&
            body.binding.zoneGuid === zoneGuid &&
            body.binding.zoneGeneration === candidate.zoneGeneration
          );
        }),
      )
    )
      return false;
    for (const [guid, outputGeneration] of Object.entries(candidate.waterMeshOutputGenerations)) {
      const accepted = this.acceptOutput(guid, 'waterMesh', outputGeneration, {
        generation: candidate.publicationGeneration,
        digest: candidate.digest,
      });
      if (!accepted.ok) return false;
    }
    this.#zoneMeshViews.set(key, candidate);
    if (this.#zoneMeshCandidates.get(key) === candidate) this.#zoneMeshCandidates.delete(key);
    for (const guid of Object.keys(candidate.sourceGenerations))
      this.#acceptedMeshOwners.set(JSON.stringify([viewId, guid]), {
        viewId,
        zoneGuid,
        identity: null,
      });
    for (const bucket of candidate.receipt.buckets)
      for (const draw of bucket.ownerDraws) {
        const owner = Object.freeze({
          bodyGuid: draw.ownerGuid,
          bodyGeneration: draw.ownerGeneration,
          zoneGuid,
          zoneGeneration: candidate.zoneGeneration,
          waterInfoFormat: candidate.waterInfoFormat,
        });
        this.#acceptedMeshOwners.set(JSON.stringify([viewId, draw.ownerGuid]), {
          viewId,
          zoneGuid,
          identity: waterMeshOwnerIdentity(owner),
        });
      }
    return true;
  }
  /** Exact CPU proxy generations that extraction can draw for one renderer view. */
  waterMeshOwnerRoster(
    viewId: string,
    observe?: WaterOperationObserver,
  ): readonly WaterMeshOwnerRosterEntry[] {
    const scope = beginWaterOperation(observe, 'water/mesh/owner-roster');
    try {
      const roster = new Map<string, WaterMeshOwnerRosterEntry>();
      const committedOwners = new Set<string>();
      const committedBodyGuids = new Set<string>();
      const addPublication = (publication: WaterZoneMeshPublication, candidate: boolean) => {
        const zone = this.resolveZone(publication.zoneGuid);
        if (publication.viewId !== viewId || zone === undefined) return;
        for (const bucket of publication.receipt.buckets)
          for (const draw of bucket.ownerDraws) {
            const body = this.snapshot(draw.ownerGuid);
            if (
              body === undefined ||
              publication.sourceGenerations[draw.ownerGuid] !== draw.ownerGeneration ||
              body.asset.flags.affectsWaterMesh !== true ||
              body.asset.renderOptions?.visible === false ||
              body.binding.kind !== 'bound'
            )
              continue;
            const entry = Object.freeze({
              bodyGuid: draw.ownerGuid,
              bodyGeneration: draw.ownerGeneration,
              zoneGuid: publication.zoneGuid,
              zoneGeneration: publication.zoneGeneration,
              waterInfoFormat: publication.waterInfoFormat,
            });
            const key = waterMeshOwnerIdentity(entry);
            const acceptedOwnerKey = JSON.stringify([viewId, draw.ownerGuid]);
            const accepted = this.#acceptedMeshOwners.get(acceptedOwnerKey);
            if (
              !candidate &&
              accepted !== undefined &&
              (accepted.identity === null || accepted.identity !== key)
            )
              continue;
            const binding = body.binding;
            const mismatchedCandidate = (): boolean =>
              candidate &&
              ((committedBodyGuids.has(draw.ownerGuid) && !committedOwners.has(key)) ||
                zone.generation !== publication.zoneGeneration ||
                body.sceneGeneration !== draw.ownerGeneration ||
                binding.zoneGuid !== publication.zoneGuid ||
                binding.zoneGeneration !== publication.zoneGeneration);
            if (mismatchedCandidate()) continue;
            roster.set(key, entry);
            if (!candidate) {
              committedOwners.add(key);
              committedBodyGuids.add(draw.ownerGuid);
            }
          }
      };
      for (const publication of this.#zoneMeshViews.values()) addPublication(publication, false);
      for (const publication of this.#zoneMeshCandidates.values())
        addPublication(publication, true);
      for (const body of this.snapshots()) {
        if (
          !body.asset.flags.affectsWaterMesh ||
          body.asset.renderOptions?.visible === false ||
          body.binding.kind !== 'bound' ||
          body.dirty.has('geometry') ||
          body.outputReceipts.geometry === undefined
        )
          continue;
        const zone = this.resolveZone(body.binding.zoneGuid);
        if (!zone?.asset?.gpuMesh || zone.generation !== body.binding.zoneGeneration) continue;
        const entry = Object.freeze({
          bodyGuid: body.guid,
          bodyGeneration: body.sceneGeneration,
          zoneGuid: body.binding.zoneGuid,
          zoneGeneration: body.binding.zoneGeneration,
          waterInfoFormat:
            zone.asset.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
        });
        roster.set(waterMeshOwnerIdentity(entry), entry);
      }
      return Object.freeze([...roster.values()]);
    } finally {
      endWaterOperation(scope);
    }
  }
  /** Invalidate the Zone ground input after an accepted Terrain closure replacement. */
  invalidateZoneGround(
    zoneGuid: string,
    zoneGeneration: number,
    observe?: WaterOperationObserver,
  ): Result<WaterZoneGroundSnapshot, WaterError> {
    const previous = this.#zoneGround.get(zoneGuid);
    const live = this.resolveZone(zoneGuid);
    if (
      !previous ||
      !live ||
      live.generation !== zoneGeneration ||
      previous.zoneGeneration !== zoneGeneration
    )
      return err({
        code: 'stale-generation',
        expected: 'the accepted Terrain belongs to the current Zone generation',
        hint: 'reconcile the live Zone and Terrain provider before invalidating ground input',
      });
    const snapshot = Object.freeze({
      ...previous,
      generation: ++this.#sceneGeneration,
      dirty: true,
    });
    this.#zoneGround.set(zoneGuid, snapshot);
    this.#zoneGroundQueries.set(zoneGuid, this.makeZoneGroundQuerySnapshot(snapshot));
    this.refreshPendingZoneGroundQuery(zoneGuid);
    return ok(this.copyZoneGroundSnapshot(snapshot, observe));
  }
  /** A consumer may clear dirty only for the Zone input generation it actually read. */
  acceptZoneGround(zoneGuid: string, generation: number): Result<boolean, WaterError> {
    const previous = this.#zoneGround.get(zoneGuid);
    if (!previous || previous.generation !== generation)
      return err({
        code: 'stale-generation',
        expected: 'the current Zone ground input generation',
        hint: 'discard this WaterInfo ground result and recapture the current Terrain provider',
      });
    if (!previous.dirty) return ok(false);
    const snapshot = Object.freeze({ ...previous, dirty: false });
    this.#zoneGround.set(zoneGuid, snapshot);
    this.#zoneGroundQueries.set(zoneGuid, this.makeZoneGroundQuerySnapshot(snapshot));
    this.refreshPendingZoneGroundQuery(zoneGuid);
    return ok(true);
  }
  unobserveZoneGround(zoneGuid: string): void {
    this.#zoneGround.delete(zoneGuid);
    this.#zoneGroundQueries.delete(zoneGuid);
    this.#zoneGroundPending.delete(zoneGuid);
  }
  private resolveBodyZoneBinding(asset: WaterBodyAsset): WaterZoneBinding {
    const requestedGuid = asset.zoneGuid;
    const zone = requestedGuid ? this.resolveZone(requestedGuid) : undefined;
    const binding: WaterZoneBinding = zone
      ? {
          kind: 'bound',
          zoneGuid: requireWaterValue(requestedGuid),
          zoneGeneration: zone.generation,
          worldMatrixM: Object.freeze([...(zone.worldMatrixM ?? IDENTITY_MATRIX)]),
        }
      : {
          kind: 'zone-unbound',
          ...(requestedGuid ? { requestedGuid } : {}),
          retryOnCatalogChange: true,
        };
    return Object.freeze(binding);
  }
  snapshot(guid: string): WaterBodySnapshot | undefined {
    const source = this.#bodies.get(guid);
    if (!source) return undefined;
    return this.snapshotOf(guid, source);
  }
  /** Detached target snapshot for the current staged River transform, if any. */
  sceneCandidateSnapshot(guid: string): WaterBodySnapshot | undefined {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    return candidate?.sceneCandidate === undefined
      ? undefined
      : this.snapshotOf(guid, candidate.sceneCandidate);
  }
  private snapshotOf(guid: string, source: Admitted): WaterBodySnapshot {
    const binding = this.resolveBodyZoneBinding(source.asset);
    const generations = Object.freeze(
      Object.fromEntries(source.outputGenerations),
    ) as WaterBodySnapshot['outputGenerations'];
    return Object.freeze({
      guid,
      sourceAssetGuid: source.sourceAssetGuid,
      ...(source.instanceEntity === undefined ? {} : { instanceEntity: source.instanceEntity }),
      worldMatrixM: source.worldMatrixM,
      sourceVersion: source.version,
      ...(source.sourcePublication ? { sourcePublication: source.sourcePublication } : {}),
      sceneGeneration: source.generation,
      outputGenerations: generations,
      exclusionVolumes: source.exclusionVolumes,
      asset: source.asset,
      binding,
      dependencies: source.dependencies,
      outputs: outputStatuses(
        source.asset,
        binding.kind === 'bound',
        source.dirty,
        source.acceptedOutputs,
        source.outputGenerations,
      ),
      outputReceipts: Object.freeze(Object.fromEntries(source.acceptedOutputs)),
      dirty: readonlySet(source.dirty),
    });
  }
  /** Query one body in this Scene's owner scope; no global body search is performed. */
  queryBody(
    guid: string,
    input: WaterQueryInput,
    observe?: WaterOperationObserver,
  ): Result<WaterQueryResult, WaterError> {
    const source = this.#bodies.get(guid);
    if (!source) return queryWaterBodySnapshot(undefined, input, undefined, 'synchronous', observe);
    const binding = this.resolveBodyZoneBinding(source.asset);
    const snapshot: WaterQueryBodySnapshot = Object.freeze({
      guid,
      sceneGeneration: source.generation,
      asset: source.asset,
      worldMatrixM: source.worldMatrixM,
      binding,
      dependencies: source.dependencies,
      exclusionVolumes: source.exclusionVolumes,
    });
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.positionM) ||
      input.positionM.length !== 3 ||
      !Array.from(input.positionM).every(Number.isFinite)
    )
      return queryWaterBodySnapshot(snapshot, input, undefined, 'synchronous', observe);
    if (input.baked !== undefined)
      return err({
        code: 'query-data-unavailable',
        expected: 'Baked query data published by this WaterSystem for the current Body generation',
        hint: 'publish the accepted Baked grid with publishBakedQueryGrid and omit input.baked',
      });
    const ground =
      binding.kind === 'bound' ? this.#zoneGroundQueries.get(binding.zoneGuid) : undefined;
    const publishedBaked = this.#bakedQueryGrids.get(guid);
    const baked =
      publishedBaked?.bodyGeneration === snapshot.sceneGeneration
        ? publishedBaked.source
        : undefined;
    const effectiveInput = baked !== undefined ? { ...input, baked } : input;
    const preparation = source.wavePreparation;
    const terrainRoutingScope = beginWaterOperation(observe, 'water/query/terrain-routing');
    let needsTerrain: boolean;
    try {
      needsTerrain = preparedWaterQueryNeedsTerrain(snapshot, effectiveInput, preparation);
    } finally {
      endWaterOperation(terrainRoutingScope);
    }
    let terrainSample: WaterTerrainQuerySample | undefined;
    if (needsTerrain) {
      const terrainScope = beginWaterOperation(observe, 'water/query/terrain-sample');
      try {
        terrainSample = this.resolveTerrainQuery(snapshot, ground, input.positionM);
      } finally {
        endWaterOperation(terrainScope);
      }
    }
    const queried = queryPreparedWaterBodySnapshot(
      snapshot,
      effectiveInput,
      terrainSample,
      'synchronous',
      preparation,
      source.splinePreparation,
      observe,
    );
    if (!queried.ok || !this.#oceanPatch) return queried;
    const residualScope = beginWaterOperation(observe, 'water/query/residual-evaluation');
    try {
      return this.#oceanPatch.applyQueryResidual(queried.value, input);
    } finally {
      endWaterOperation(residualScope);
    }
  }
  /** Stage one Bake replacement; River query publication waits for its matching Physics receipt. */
  publishBakedQueryGrid(
    guid: string,
    bodyGeneration: number,
    publication: WaterBakedQueryPublication,
  ): Result<void, WaterError> {
    const active = this.#bodies.get(guid);
    const pendingCandidate = this.#bakedQueryGridCandidates.get(guid);
    const body =
      pendingCandidate?.bodyGeneration === bodyGeneration
        ? (pendingCandidate.sceneCandidate ?? active)
        : active;
    if (!body || body.generation !== bodyGeneration)
      return err({
        code: 'stale-generation',
        expected: 'the current WaterBody generation for its Baked source',
        hint: 'rebuild and publish the grid for the current body snapshot',
        detail: { guid, expectedGeneration: bodyGeneration, actualGeneration: body?.generation },
      });
    const source = publication;
    const grid = source && typeof source === 'object' ? source.grid : undefined;
    const invalidGridShape = (): boolean =>
      !source ||
      typeof source !== 'object' ||
      !grid ||
      typeof grid !== 'object' ||
      Array.isArray(grid) ||
      source.enabled !== true ||
      source.componentValid !== true ||
      source.dataValid !== true;
    const invalidGridData = (): boolean =>
      !grid ||
      !Number.isSafeInteger(grid.width) ||
      !Number.isSafeInteger(grid.height) ||
      grid.width < 3 ||
      grid.height < 3 ||
      !Number.isFinite(grid.originY) ||
      !Array.isArray(grid.originXZ) ||
      grid.originXZ.length !== 2 ||
      !Array.from(grid.originXZ).every(Number.isFinite) ||
      !Array.isArray(grid.spacingXZ) ||
      grid.spacingXZ.length !== 2 ||
      !Array.from(grid.spacingXZ).every((value) => Number.isFinite(value) && value > 0) ||
      !(grid.samples instanceof Float32Array) ||
      grid.samples.length !== grid.width * grid.height * 4 ||
      !grid.samples.every(Number.isFinite);
    if (!grid || invalidGridShape() || invalidGridData())
      return err({
        code: 'query-data-unavailable',
        expected:
          'enabled current-generation Baked grid with finite RGBA samples and positive spacing',
        hint: 'repair the Baked capture before publishing it',
        detail: { guid, bodyGeneration },
      });
    const validatePublicationLane = (): Result<void, WaterError> => {
      const lineage = snapshotWaterBakedQueryLineage(grid.lineage);
      const declaredLineage = grid.lineage as unknown;
      const declaredVersion =
        declaredLineage !== null &&
        typeof declaredLineage === 'object' &&
        !Array.isArray(declaredLineage)
          ? (declaredLineage as { readonly version?: unknown }).version
          : undefined;
      if (declaredVersion === 'water-river-bake/2' && lineage?.version !== 'water-river-bake/2')
        return err({
          code: 'query-data-unavailable',
          expected: 'a complete /2 River Bake lineage with matching capture frame identity',
          hint: 'repair malformed version-2 capture metadata instead of publishing it as legacy data',
          detail: { guid, bodyGeneration, lineageVersion: declaredVersion },
        });
      if (source.kind === 'durable-pack') {
        const validateDurableCapture = (): Result<void, WaterError> => {
          const geometryHash = waterRiverBakeGeometryProjectionHash(body.asset);
          const durableMatches =
            body.asset.type === 'river' &&
            lineage?.version === 'water-river-bake/2' &&
            lineage.textureRevision !== undefined &&
            lineage.normalTextureRevision !== undefined &&
            lineage.sourceBodyGuid.toLowerCase() === body.sourceAssetGuid.toLowerCase() &&
            lineage.sourceFrame.generation === lineage.simulationGeneration &&
            lineage.sourceFrame.sequence === lineage.sequence &&
            lineage.sourceGeometryProjectionHash === geometryHash &&
            sameMatrixF32(lineage.sourceWorldMatrixM, body.worldMatrixM) &&
            geometryHash !== undefined;
          if (!durableMatches)
            return err({
              code: 'query-data-unavailable',
              expected:
                'a durable /2 River Bake decoded from its loaded Pack texture and matching current Body GUID, geometry projection and complete Scene matrix',
              hint: 're-bake from the current River frame; version-1 Pack lineage is retained for decoding but cannot authorize cold publication',
              detail: {
                guid,
                bodyGeneration,
                publication: 'durable-pack',
                lineageVersion: lineage?.version,
              },
            });
          const matchingSimulation = [...this.#advanced.values()].find(
            (simulation) =>
              simulation.body.guid === guid &&
              simulation.body.generation === body.generation &&
              simulation.recipe.guid === lineage.sourceRecipeGuid,
          );
          const validateCurrentLattice = (): Result<void, WaterError> => {
            if (matchingSimulation) {
              const transform = matchingSimulation.inspect().transform;
              const config = matchingSimulation.recipe.asset.riverBakeConfig;
              const resolution = matchingSimulation.recipe.asset.shallowStageConfig?.gridResolution;
              const expectedSpacing =
                config && resolution
                  ? [config.bakeExtentM[0] / resolution[0], config.bakeExtentM[1] / resolution[1]]
                  : undefined;
              const expectedOrigin =
                config && resolution
                  ? [
                      transform.centerXZ[0] -
                        config.bakeExtentM[0] / 2 +
                        requireWaterValue(requireWaterValue(expectedSpacing)[0]) / 2,
                      transform.centerXZ[1] -
                        config.bakeExtentM[1] / 2 +
                        requireWaterValue(requireWaterValue(expectedSpacing)[1]) / 2,
                    ]
                  : undefined;
              if (
                !config ||
                !resolution ||
                transform.yawRadians !== 0 ||
                grid.width !== resolution[0] ||
                grid.height !== resolution[1] ||
                grid.originXZ.some((value, index) => value !== expectedOrigin?.[index]) ||
                grid.originY !== transform.heightOriginM ||
                grid.spacingXZ.some((value, index) => value !== expectedSpacing?.[index])
              )
                return err({
                  code: 'query-data-unavailable',
                  expected:
                    'durable River Bake world lattice matching the current explicit capture domain placement, extent and resolution',
                  hint: 'capture a replacement grid at the current shallow simulation placement before publishing the durable Pack source',
                  detail: { guid, bodyGeneration, sourceRecipeGuid: lineage.sourceRecipeGuid },
                });
            }
            return ok(undefined);
          };
          const lattice = validateCurrentLattice();
          if (!lattice.ok) return lattice;

          return ok(undefined);
        };
        const durable = validateDurableCapture();
        if (!durable.ok) return durable;
      } else if (source.kind !== 'live-capture') {
        return err({
          code: 'invalid-source',
          expected: 'an explicit live-capture or durable-pack River Bake publication lane',
          hint: 'decode durable Pack texture bytes through decodeWaterRiverBake before publication',
          detail: { guid, bodyGeneration },
        });
      } else if (
        lineage?.version === 'water-river-bake/1' &&
        (lineage.sourceBodyGeneration !== bodyGeneration ||
          lineage.sourceBodyGuid.toLowerCase() !== body.sourceAssetGuid.toLowerCase())
      ) {
        return err({
          code: 'query-data-unavailable',
          expected: 'same-generation live /1 River Bake capture with the current Body GUID',
          hint: 'capture a new live Bake after replacing or reloading the WaterBody',
          detail: {
            guid,
            bodyGeneration,
            publication: 'live-capture',
            lineageVersion: lineage.version,
            sourceBodyGeneration: lineage.sourceBodyGeneration,
          },
        });
      } else if (lineage?.version === 'water-river-bake/2') {
        const geometryHash = waterRiverBakeGeometryProjectionHash(body.asset);
        if (
          lineage.sourceBodyGeneration !== bodyGeneration ||
          lineage.sourceBodyGuid.toLowerCase() !== body.sourceAssetGuid.toLowerCase() ||
          lineage.sourceGeometryProjectionHash !== geometryHash ||
          !sameMatrixF32(lineage.sourceWorldMatrixM, body.worldMatrixM)
        )
          return err({
            code: 'query-data-unavailable',
            expected:
              'the same-generation live River Bake capture with its captured Body geometry and Scene matrix',
            hint: 'capture a new Bake after the current River source or full Scene matrix is admitted',
            detail: { guid, bodyGeneration },
          });
      }

      return ok(undefined);
    };
    const lane = validatePublicationLane();
    if (!lane.ok) return lane;
    const candidateSource = Object.freeze({
      enabled: true,
      componentValid: true,
      dataValid: true,
      grid: snapshotWaterBakedQueryGrid(grid),
    });
    const acceptPendingSource = (): Result<void, WaterError> | undefined => {
      const pending = this.#bakedQueryGridCandidates.get(guid);
      if (pending?.bodyGeneration === bodyGeneration) {
        if (pending.source !== null && sameBakedQueryGridFields(pending.source.grid, grid)) {
          if (sameBakedQueryGrid(pending.source.grid, grid)) return ok(undefined);
          // Replace only the paired Bake identity while preserving an in-flight collision candidate.
          this.#bakedQueryGridCandidates.set(
            guid,
            Object.freeze({ ...pending, source: candidateSource }),
          );
          return ok(undefined);
        }
        if (pending.phase) return err(bakedAdmissionPending(guid, pending));
        if (pending.sceneCandidate !== undefined) {
          this.stageBakedQueryGridCandidate(guid, bodyGeneration, candidateSource);
          return ok(undefined);
        }
        return err({
          code: 'query-data-unavailable',
          expected: 'the staged River Bake candidate to finish or be rejected before replacement',
          hint: 'retain the last accepted grid and retry the new Bake after collision reconciliation',
          detail: { guid, bodyGeneration, pendingOutputGeneration: pending.outputGeneration },
        });
      }

      return undefined;
    };
    const pending = this.#bakedQueryGridCandidates.get(guid);
    const pendingResult = acceptPendingSource();
    if (pendingResult !== undefined) return pendingResult;
    const accepted = this.#bakedQueryGrids.get(guid);
    if (
      accepted?.bodyGeneration === bodyGeneration &&
      pending === undefined &&
      sameBakedQueryGridFields(accepted.source.grid, grid)
    ) {
      if (sameBakedQueryGrid(accepted.source.grid, grid)) return ok(undefined);
      this.#bakedQueryGrids.set(guid, Object.freeze({ bodyGeneration, source: candidateSource }));
      this.#bakedQueryRevision += 1;
      return ok(undefined);
    }
    if (body.asset.type === 'river' && body.asset.collision.enabled) {
      this.stageBakedQueryGridCandidate(guid, bodyGeneration, candidateSource);
      return ok(undefined);
    }
    this.#bakedQueryGridCandidates.delete(guid);
    this.#bakedQueryGrids.set(guid, Object.freeze({ bodyGeneration, source: candidateSource }));
    this.#bakedQueryRevision += 1;
    return ok(undefined);
  }
  /** Stage removal; River keeps its accepted query source until native collision catches up. */
  clearBakedQueryGrid(guid: string, bodyGeneration: number): Result<boolean, WaterError> {
    const pendingCandidate = this.#bakedQueryGridCandidates.get(guid);
    const active = this.#bodies.get(guid);
    const body =
      pendingCandidate?.bodyGeneration === bodyGeneration
        ? (pendingCandidate.sceneCandidate ?? active)
        : active;
    if (!body)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted Body instance in this WaterSystem',
        hint: 'mount the Scene WaterBody before clearing its Baked query source',
        detail: { guid, bodyGeneration },
      });
    if (body.generation !== bodyGeneration)
      return err({
        code: 'stale-generation',
        expected: 'the current WaterBody generation for its Baked source',
        hint: 'retry clearing the grid against the current Body snapshot',
        detail: { guid, expectedGeneration: bodyGeneration, actualGeneration: body.generation },
      });
    const pending = this.#bakedQueryGridCandidates.get(guid);
    const published = this.#bakedQueryGrids.get(guid);
    if (pending?.phase) return err(bakedAdmissionPending(guid, pending));
    if (pending?.bodyGeneration === bodyGeneration && pending.sceneCandidate !== undefined) {
      if (pending.explicitBakeClear) return ok(true);
      this.#bakedQueryGridCandidates.set(
        guid,
        Object.freeze({
          ...pending,
          source: null,
          explicitBakeClear: true,
        }),
      );
      return ok(true);
    }
    if (pending?.bodyGeneration === bodyGeneration && pending.source === null) return ok(true);
    if (pending?.bodyGeneration === bodyGeneration)
      return err({
        code: 'query-data-unavailable',
        expected: 'the staged River Bake candidate to finish or be rejected before clearing',
        hint: 'retain the last accepted grid and retry clearing after collision reconciliation',
        detail: { guid, bodyGeneration, pendingOutputGeneration: pending.outputGeneration },
      });
    if (published?.bodyGeneration !== bodyGeneration && pending?.bodyGeneration !== bodyGeneration)
      return ok(false);
    if (body.asset.type === 'river' && body.asset.collision.enabled) {
      this.stageBakedQueryGridCandidate(guid, bodyGeneration, null);
      return ok(true);
    }
    this.#bakedQueryGridCandidates.delete(guid);
    const cleared = this.#bakedQueryGrids.delete(guid);
    if (cleared) this.#bakedQueryRevision += 1;
    return ok(cleared);
  }
  private stageBakedQueryGridCandidate(
    guid: string,
    bodyGeneration: number,
    source: BakedQueryGridSource | null,
  ): void {
    const current = this.#bodies.get(guid);
    const previous = this.#bakedQueryGridCandidates.get(guid);
    const body =
      previous?.bodyGeneration === bodyGeneration ? (previous.sceneCandidate ?? current) : current;
    if (!body || body.generation !== bodyGeneration) return;
    const outputGeneration = ++this.#sceneGeneration;
    const sceneCandidate = previous?.sceneCandidate;
    if (sceneCandidate !== undefined && previous !== undefined) {
      const outputGenerations = new Map(sceneCandidate.outputGenerations);
      outputGenerations.set('collision', outputGeneration);
      const dirty = new Set(sceneCandidate.dirty);
      dirty.add('collision');
      const updated: Admitted = { ...sceneCandidate, outputGenerations, dirty };
      this.#bakedQueryGridCandidates.set(
        guid,
        Object.freeze({
          ...(previous.baseBodyGeneration === undefined
            ? {}
            : { baseBodyGeneration: previous.baseBodyGeneration }),
          bodyGeneration,
          outputGeneration,
          source,
          sceneCandidate: updated,
          ...(previous.deferredInvalidations === undefined
            ? {}
            : { deferredInvalidations: previous.deferredInvalidations }),
          ...(previous.requiresBakeReplacement === true ? { requiresBakeReplacement: true } : {}),
          ...(source === null && previous.explicitBakeClear === true
            ? { explicitBakeClear: true }
            : {}),
        }),
      );
      return;
    }
    this.#bakedQueryGridCandidates.set(
      guid,
      Object.freeze({
        bodyGeneration,
        outputGeneration,
        source,
        ...(previous?.baseBodyGeneration === undefined
          ? {}
          : { baseBodyGeneration: previous.baseBodyGeneration }),
      }),
    );
  }
  /** Availability reads never detach the grid or implicitly enable a material branch. */
  hasBakedQueryGrid(guid: string, bodyGeneration: number): boolean {
    return (
      this.#bodies.get(guid)?.generation === bodyGeneration &&
      this.#bakedQueryGrids.get(guid)?.bodyGeneration === bodyGeneration
    );
  }
  get bakedQueryRevision(): number {
    return this.#bakedQueryRevision;
  }
  /** Returns a detached snapshot so callers cannot mutate the accepted Baked closure. */
  bakedQueryGrid(
    guid: string,
    bodyGeneration: number,
  ): NonNullable<WaterQueryInput['baked']> | undefined {
    const published = this.#bakedQueryGrids.get(guid);
    if (published?.bodyGeneration !== bodyGeneration) return undefined;
    const { grid } = published.source;
    return Object.freeze({
      enabled: true,
      componentValid: true,
      dataValid: true,
      grid: snapshotWaterBakedQueryGrid(grid),
    });
  }
  /** Candidate input for the existing River Physics publisher; accepted query data stays unchanged. */
  bakedQueryGridCandidate(
    guid: string,
    bodyGeneration: number,
  ): WaterBakedQueryGrid | null | undefined {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    if (candidate?.bodyGeneration !== bodyGeneration) return undefined;
    return candidate.source === null ? null : snapshotWaterBakedQueryGrid(candidate.source.grid);
  }
  /** Revision of the current staged Bake output, without changing the accepted collision snapshot. */
  bakedQueryGridCandidateOutputGeneration(
    guid: string,
    bodyGeneration: number,
  ): number | undefined {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    return candidate?.bodyGeneration === bodyGeneration ? candidate.outputGeneration : undefined;
  }
  /** Lock this staged Bake immediately after its matching Physics candidate is queued. */
  markBakedQueryGridCandidateQueued(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
  ): Result<void, WaterError> {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    const active = this.#bodies.get(guid);
    const body =
      candidate?.bodyGeneration === bodyGeneration ? (candidate.sceneCandidate ?? active) : active;
    if (
      !body ||
      body.generation !== bodyGeneration ||
      (candidate?.sceneCandidate !== undefined &&
        body.outputGenerations.get('collision') !== outputGeneration) ||
      candidate?.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration
    )
      return err({
        code: 'stale-generation',
        expected:
          'the current staged River Bake and collision candidate generations after Physics queueing',
        hint: 'cancel the queued Physics candidate and rebuild from the current Body snapshot',
        detail: { guid, bodyGeneration, outputGeneration },
      });
    if (candidate.phase) return err(bakedAdmissionPending(guid, candidate));
    this.#bakedQueryGridCandidates.set(guid, Object.freeze({ ...candidate, phase: 'queued' }));
    return ok(undefined);
  }
  /** Mark the exact queued Bake as entering Physics native admission. */
  markBakedQueryGridCandidateAdmitting(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
  ): Result<void, WaterError> {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    const active = this.#bodies.get(guid);
    const body =
      candidate?.bodyGeneration === bodyGeneration ? (candidate.sceneCandidate ?? active) : active;
    if (
      !body ||
      body.generation !== bodyGeneration ||
      (candidate?.sceneCandidate !== undefined &&
        body.outputGenerations.get('collision') !== outputGeneration) ||
      candidate?.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration ||
      candidate.phase !== 'queued'
    )
      return err({
        code: 'stale-generation',
        expected: 'the current queued River Bake and collision candidate before native admission',
        hint: 'retain the last accepted Bake and rebuild the Physics candidate from the current snapshot',
        detail: { guid, bodyGeneration, outputGeneration },
      });
    this.#bakedQueryGridCandidates.set(guid, Object.freeze({ ...candidate, phase: 'admitting' }));
    return ok(undefined);
  }
  /** Phase for the one current Bake candidate paired with Physics on this Body. */
  bakedQueryGridCandidatePhase(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
  ): 'queued' | 'admitting' | undefined {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    if (
      candidate?.phase === undefined ||
      candidate.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration
    )
      return undefined;
    return candidate.phase;
  }
  /** Unlock a Bake candidate only after its paired queued Physics candidate was cancelled. */
  releaseBakedQueryGridCandidate(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
  ): boolean {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    if (
      candidate?.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration
    )
      return false;
    this.#bakedQueryGridCandidates.set(
      guid,
      Object.freeze({
        bodyGeneration: candidate.bodyGeneration,
        outputGeneration: candidate.outputGeneration,
        source: candidate.source,
        ...(candidate.baseBodyGeneration === undefined
          ? {}
          : { baseBodyGeneration: candidate.baseBodyGeneration }),
        ...(candidate.sceneCandidate === undefined
          ? {}
          : { sceneCandidate: candidate.sceneCandidate }),
        ...(candidate.deferredInvalidations === undefined
          ? {}
          : { deferredInvalidations: candidate.deferredInvalidations }),
        ...(candidate.requiresBakeReplacement === true ? { requiresBakeReplacement: true } : {}),
        ...(candidate.explicitBakeClear === true ? { explicitBakeClear: true } : {}),
      }),
    );
    return true;
  }
  /** Commit a staged River source only after its matching Native receipt publishes. */
  acceptRiverSceneCandidate(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
    consumerReceipt: { readonly generation: number; readonly digest: string },
  ): Result<boolean, WaterError> {
    const active = this.#bodies.get(guid);
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    const body = candidate?.sceneCandidate;
    if (
      !active ||
      !body ||
      body.asset.type !== 'river' ||
      body.generation !== bodyGeneration ||
      candidate.baseBodyGeneration !== active.generation ||
      candidate.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration ||
      body.outputGenerations.get('collision') !== outputGeneration ||
      candidate.phase !== 'admitting'
    )
      return err({
        code: 'stale-generation',
        expected: 'the current staged River source and matching Native collision receipt',
        hint: 'retain the accepted River source until its matching Native candidate publishes',
        detail: { guid, bodyGeneration, outputGeneration },
      });
    if (this.sceneCandidateRequiresBakedGrid(guid, bodyGeneration))
      return err({
        code: 'query-data-unavailable',
        expected: 'a qualified replacement World-lattice River Bake for the staged Scene transform',
        hint: 'retain the last accepted River pose and Bake until the matching collision candidate publishes',
        detail: { guid, bodyGeneration, outputGeneration },
      });
    const invalidReceipt = (): boolean =>
      !consumerReceipt ||
      !Number.isSafeInteger(consumerReceipt.generation) ||
      consumerReceipt.generation < 0 ||
      typeof consumerReceipt.digest !== 'string' ||
      consumerReceipt.digest.length === 0;
    if (invalidReceipt())
      return err({
        code: 'invalid-source',
        expected: 'a detached Native collision publication generation and input digest',
        hint: 'accept the staged River candidate only from its matching Native receipt',
      });
    let activated = body;
    if (!body.asset.collision.enabled) {
      const dirty = new Set(body.dirty);
      dirty.delete('collision');
      const acceptedOutputs = new Map(body.acceptedOutputs);
      acceptedOutputs.delete('collision');
      activated = { ...body, dirty, acceptedOutputs };
    }
    this.#bodies.set(guid, activated);
    if (activated.asset.collision.enabled) {
      const accepted = this.acceptOutput(guid, 'collision', outputGeneration, consumerReceipt);
      if (!accepted.ok) {
        this.#bodies.set(guid, active);
        return accepted;
      }
    }
    this.#zoneSlots.delete(guid);
    this.#oceanPatch?.invalidateQueryBody(guid, bodyGeneration);
    if (candidate.source === null) this.#bakedQueryGrids.delete(guid);
    else
      this.#bakedQueryGrids.set(guid, Object.freeze({ bodyGeneration, source: candidate.source }));
    this.#bakedQueryGridCandidates.delete(guid);
    this.#bakedQueryRevision += 1;
    if (candidate.deferredInvalidations?.length)
      this.invalidateNow(guid, candidate.deferredInvalidations);
    return ok(true);
  }
  /** Commit the staged River grid with the exact collision output receipt in one synchronous turn. */
  acceptBakedQueryGrid(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
    consumerReceipt: { readonly generation: number; readonly digest: string },
  ): Result<boolean, WaterError> {
    const active = this.#bodies.get(guid);
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    const body = candidate?.sceneCandidate ?? active;
    if (
      !active ||
      !body ||
      body.generation !== bodyGeneration ||
      (candidate?.sceneCandidate !== undefined &&
        candidate.baseBodyGeneration !== active.generation) ||
      candidate?.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration ||
      (candidate.sceneCandidate !== undefined &&
        body.outputGenerations.get('collision') !== outputGeneration) ||
      candidate.phase !== 'admitting'
    )
      return err({
        code: 'stale-generation',
        expected: 'the current staged River Bake and collision candidate generations',
        hint: 'retain the last accepted Bake and retry the matching Physics candidate',
        detail: { guid, bodyGeneration, outputGeneration },
      });
    if (
      candidate.sceneCandidate !== undefined &&
      this.sceneCandidateRequiresBakedGrid(guid, bodyGeneration)
    )
      return err({
        code: 'query-data-unavailable',
        expected: 'a qualified replacement World-lattice Bake for the staged Scene transform',
        hint: 'retain the last accepted River transform and grid until its matching Bake is ready',
        detail: { guid, bodyGeneration, outputGeneration },
      });
    const activated =
      candidate.sceneCandidate ??
      (body.outputGenerations.get('collision') === outputGeneration
        ? body
        : {
            ...body,
            outputGenerations: new Map(body.outputGenerations).set('collision', outputGeneration),
            dirty: new Set([...body.dirty, 'collision' as const]),
          });
    this.#bodies.set(guid, activated);
    const accepted = this.acceptOutput(guid, 'collision', outputGeneration, consumerReceipt);
    if (!accepted.ok) {
      this.#bodies.set(guid, active);
      return accepted;
    }
    if (candidate.sceneCandidate !== undefined) {
      this.#zoneSlots.delete(guid);
      this.#oceanPatch?.invalidateQueryBody(guid, bodyGeneration);
    }
    if (candidate.source === null) this.#bakedQueryGrids.delete(guid);
    else
      this.#bakedQueryGrids.set(guid, Object.freeze({ bodyGeneration, source: candidate.source }));
    this.#bakedQueryGridCandidates.delete(guid);
    this.#bakedQueryRevision += 1;
    if (candidate.deferredInvalidations?.length)
      this.invalidateNow(guid, candidate.deferredInvalidations);
    return accepted;
  }
  /** Drop a staged candidate only after Runtime has cancelled its uncommitted Physics candidate. */
  rejectBakedQueryGridCandidate(
    guid: string,
    bodyGeneration: number,
    outputGeneration: number,
  ): boolean {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    if (
      candidate?.bodyGeneration !== bodyGeneration ||
      candidate.outputGeneration !== outputGeneration
    )
      return false;
    this.#bakedQueryGridCandidates.delete(guid);
    if (candidate.deferredInvalidations?.length)
      this.invalidateNow(guid, candidate.deferredInvalidations);
    return true;
  }
  /** Creates one view upload only from current snapshots; the callback fixes time, Zone indices and height sources. */
  buildWaveUploadPlan(
    resolveViewInput: (snapshot: WaterBodySnapshot) => WaterWaveUploadSnapshotContext | undefined,
  ): Result<WaterWaveUploadPlan, WaterError> {
    const bodies: WaterWaveUploadBody[] = [];
    for (const snapshot of this.snapshots()) {
      const context = resolveViewInput(snapshot);
      if (!context) continue;
      const body = buildPreparedWaterWaveUploadBody(
        snapshot,
        context,
        this.#bodies.get(snapshot.guid)?.wavePreparation,
      );
      if (!body.ok) return body;
      bodies.push(body.value);
    }
    return packWaterWaveUploadPlan(bodies);
  }
  /** Capture a fixed, validated CPU payload closure independent of Registry handle mutation. */
  admitSnapshot(guid: string): Result<WaterSnapshotLease, WaterError> {
    const snapshot = this.snapshot(guid);
    if (!snapshot)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted Body snapshot',
        hint: 'mount the Scene WaterBody before admitting its snapshot',
      });
    return ok(this.createSnapshotLease(snapshot));
  }
  /** Give another CPU consumer its own release token for the same fixed generation. */
  retainSnapshot(lease: WaterSnapshotLease): Result<WaterSnapshotLease, WaterError> {
    const state = this.#leases.get(lease);
    if (!state || state.released)
      return err({
        code: 'stale-generation',
        expected: 'a live Water snapshot lease owned by this WaterSystem',
        hint: 'retain the current snapshot before releasing its lease',
      });
    return ok(this.createSnapshotLease(lease.snapshot));
  }
  releaseSnapshot(lease: WaterSnapshotLease): Result<void, WaterError> {
    const state = this.#leases.get(lease);
    if (!state || state.released)
      return err({
        code: 'stale-generation',
        expected: 'a live Water snapshot lease owned by this WaterSystem',
        hint: 'release each retained snapshot lease exactly once',
      });
    state.released = true;
    const remaining = (this.#leaseCounts.get(state.generationKey) ?? 1) - 1;
    if (remaining <= 0) this.#leaseCounts.delete(state.generationKey);
    else this.#leaseCounts.set(state.generationKey, remaining);
    return ok(undefined);
  }
  snapshotLeaseCount(guid: string, sceneGeneration: number, zoneGeneration?: number): number {
    const prefix = `${guid}\u0000${sceneGeneration}\u0000`;
    let count = 0;
    for (const [key, value] of this.#leaseCounts) {
      if (!key.startsWith(prefix)) continue;
      if (zoneGeneration !== undefined && !key.endsWith(`\u0000${zoneGeneration}`)) continue;
      count += value;
    }
    return count;
  }
  clearDirty(guid: string, kinds: readonly WaterDirtyKind[]): void {
    const admitted = this.#bodies.get(guid);
    if (!admitted) return;
    for (const kind of kinds) admitted.dirty.delete(kind);
  }
  invalidate(guid: string, kinds: readonly WaterDirtyKind[]): void {
    const candidate = this.#bakedQueryGridCandidates.get(guid);
    if (candidate?.phase) {
      this.#bakedQueryGridCandidates.set(
        guid,
        Object.freeze({
          ...candidate,
          deferredInvalidations: Object.freeze([
            ...new Set([...(candidate.deferredInvalidations ?? []), ...kinds]),
          ]),
        }),
      );
      return;
    }
    this.invalidateNow(guid, kinds);
  }
  private invalidateNow(guid: string, kinds: readonly WaterDirtyKind[]): void {
    const admitted = this.#bodies.get(guid);
    if (!admitted) return;
    const dirty = new Set(admitted.dirty);
    for (const kind of kinds) dirty.add(kind);
    const generation = ++this.#sceneGeneration;
    this.#bakedQueryGridCandidates.delete(guid);
    const baked = this.#bakedQueryGrids.get(guid);
    if (
      baked?.bodyGeneration === admitted.generation &&
      kinds.every(
        (kind) =>
          kind === 'material' ||
          kind === 'waterMesh' ||
          kind === 'waterInfo' ||
          kind === 'collision',
      )
    )
      this.#bakedQueryGrids.set(guid, Object.freeze({ ...baked, bodyGeneration: generation }));
    this.#oceanPatch?.invalidateQueryBody(guid, generation);
    this.#bodies.set(guid, {
      ...admitted,
      generation,
      outputGenerations: outputGenerations(generation, admitted.outputGenerations, kinds),
      dirty,
    });
  }
  refreshDependencies(guid: string, kinds: readonly WaterDirtyKind[]): Result<boolean, WaterError> {
    const admitted = this.#bodies.get(guid);
    const admitting = this.#bakedQueryGridCandidates.get(guid);
    if (admitting?.phase) return err(bakedAdmissionPending(guid, admitting));
    if (!admitted)
      return err({
        code: 'missing-dependency',
        expected: 'a mounted Body snapshot',
        hint: 'mount the Scene WaterBody before refreshing its dependency closure',
      });
    const candidate = freezeDependencies(this.resolveDependencies(admitted.asset));
    const retainsBakedGrid = kinds.every(
      (kind) => kind === 'material' || kind === 'waterMesh' || kind === 'waterInfo',
    );
    const materialSources = this.validateMaterialBakedSources(
      guid,
      admitted.asset,
      candidate,
      retainsBakedGrid,
    );
    if (materialSources !== undefined) return err(materialSources);
    const priorByIdentity = new Map(
      admitted.dependencies.map((dependency) => [
        `${dependency.field}\u0000${dependency.kind}\u0000${dependency.guid}`,
        dependency,
      ]),
    );
    const dependencies: readonly WaterDependencySnapshot[] = Object.freeze(
      candidate.map((dependency) => {
        if (
          dependency.status !== 'unavailable' &&
          dependency.status !== 'pending' &&
          dependency.status !== 'failed'
        )
          return dependency;
        const previous = priorByIdentity.get(
          `${dependency.field}\u0000${dependency.kind}\u0000${dependency.guid}`,
        );
        return previous?.status === 'valid' ? previous : dependency;
      }),
    );
    const rejected = dependencies.find((dependency) => {
      if (dependency.status === 'valid') return false;
      if (dependency.field === 'zoneGuid' && dependency.status === 'unavailable') return false;
      const previous = priorByIdentity.get(
        `${dependency.field}\u0000${dependency.kind}\u0000${dependency.guid}`,
      );
      return (
        dependency.status === 'invalid-kind' ||
        previous === undefined ||
        previous.status === 'valid'
      );
    });
    if (rejected)
      return err({
        code: 'missing-dependency',
        expected: `a valid ${rejected.kind} dependency ${rejected.guid}`,
        hint: 'keep the last accepted Water closure and retry after the Catalog dependency is available',
        detail: { field: rejected.field, status: rejected.status, actualKind: rejected.actualKind },
      });
    if (canonicalJson(dependencies) === canonicalJson(admitted.dependencies)) return ok(false);
    const dirty = new Set(admitted.dirty);
    for (const kind of kinds) dirty.add(kind);
    this.#zoneSlots.delete(guid);
    const generation = ++this.#sceneGeneration;
    this.#bakedQueryGridCandidates.delete(guid);
    const baked = this.#bakedQueryGrids.get(guid);
    if (baked?.bodyGeneration === admitted.generation && retainsBakedGrid)
      this.#bakedQueryGrids.set(guid, Object.freeze({ ...baked, bodyGeneration: generation }));
    this.#oceanPatch?.invalidateQueryBody(guid, generation);
    this.#bodies.set(guid, {
      ...admitted,
      dependencies,
      wavePreparation: prepareWaterBodyWaves({ asset: admitted.asset, dependencies }),
      generation,
      outputGenerations: outputGenerations(generation, admitted.outputGenerations, kinds),
      dirty,
    });
    return ok(true);
  }
  private validateMaterialBakedSources(
    guid: string,
    asset: WaterBodyAsset,
    dependencies: readonly WaterDependencySnapshot[],
    retainsOwnBakedGrid: boolean,
  ): WaterError | undefined {
    const body = this.#bodies.get(guid);
    if (body === undefined) return undefined;
    for (const dependency of dependencies) {
      const field = dependency.field;
      if (
        dependency.kind !== 'material' ||
        dependency.materialRequiresBakedSource !== true ||
        field === undefined ||
        asset[field as keyof WaterBodyAsset] !== dependency.guid
      )
        continue;
      const previous = body.dependencies.find(
        (entry) =>
          entry.field === field && entry.guid === dependency.guid && entry.kind === 'material',
      );
      if (previous !== undefined && canonicalJson(previous) === canonicalJson(dependency)) continue;
      const sources = this.materialSlotSourceBodies(guid, body.generation, field);
      for (const [bodyGuid, bodyGeneration] of sources) {
        if (
          (bodyGuid !== guid || retainsOwnBakedGrid) &&
          this.hasBakedQueryGrid(bodyGuid, bodyGeneration)
        )
          continue;
        return {
          code: 'query-data-unavailable',
          expected:
            'current-generation Baked data for every Body sampled by the candidate material closure',
          hint: 'retain the accepted material closure, publish the missing Body Baked grid and retry',
          detail: { field, materialGuid: dependency.guid, bodyGuid, bodyGeneration },
        };
      }
    }
    return undefined;
  }
  private materialSlotSourceBodies(
    guid: string,
    generation: number,
    field: string,
  ): ReadonlyMap<string, number> {
    const sources = new Map([[guid, generation]]);
    if (
      field !== 'riverToLakeTransitionMaterialGuid' &&
      field !== 'riverToOceanTransitionMaterialGuid'
    )
      return sources;
    const targetType = field === 'riverToLakeTransitionMaterialGuid' ? 'lake' : 'ocean';
    const add = (publication: WaterZoneMeshPublication) => {
      for (const bucket of publication.receipt.buckets)
        for (const draw of bucket.ownerDraws) {
          if (draw.ownerGuid !== guid || draw.ownerGeneration !== generation) continue;
          for (const instance of draw.instances) {
            const targetGuid = instance.transitionBodyGuid;
            if (instance.transitionRenderIndex === 0 || targetGuid === undefined) continue;
            const target = this.#bodies.get(targetGuid);
            if (
              target?.asset.type === targetType &&
              target.generation === instance.transitionBodyGeneration
            )
              sources.set(targetGuid, target.generation);
          }
        }
    };
    for (const publication of this.#zoneMeshViews.values()) add(publication);
    for (const publication of this.#zoneMeshCandidates.values()) add(publication);
    return sources;
  }
  /** Current sampled Bodies, including nonzero transition targets from real mesh receipts. */
  materialSourceBodies(
    materialGuid: string,
  ): readonly Readonly<{ guid: string; generation: number }>[] {
    const identity = materialGuid.toLowerCase();
    const sources = new Map<string, number>();
    const farZones = new Set(
      this.zoneSnapshots()
        .filter((zone) => zone.asset.farMaterialGuid?.toLowerCase() === identity)
        .map((zone) => zone.guid),
    );
    const fields = [
      'surfaceMaterialGuid',
      'lodMaterialGuid',
      'waterInfoMaterialGuid',
      'riverToLakeTransitionMaterialGuid',
      'riverToOceanTransitionMaterialGuid',
      'underwaterPostProcessMaterialGuid',
    ] as const;
    for (const [guid, body] of this.#bodies) {
      for (const field of fields) {
        if (body.asset[field]?.toLowerCase() !== identity) continue;
        for (const [sampledGuid, generation] of this.materialSlotSourceBodies(
          guid,
          body.generation,
          field,
        ))
          sources.set(sampledGuid, generation);
      }
      const binding = farZones.size === 0 ? undefined : this.snapshot(guid)?.binding;
      if (binding?.kind === 'bound' && farZones.has(binding.zoneGuid))
        sources.set(guid, body.generation);
    }
    return Object.freeze(
      [...sources].map(([guid, generation]) => Object.freeze({ guid, generation })),
    );
  }
  snapshots(): readonly WaterBodySnapshot[] {
    return Object.freeze(
      [...this.#bodies.keys()]
        .map((guid) => requireWaterValue(this.snapshot(guid)))
        .sort((a, b) => a.guid.localeCompare(b.guid)),
    );
  }
  setUnderwaterTraceFilterMask(mask: number): Result<void, WaterViewError> {
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff_ffff)
      return err({
        code: 'water-view-input-invalid',
        expected: 'a packed unsigned 32-bit Physics collision filter',
        hint: 'configure the WaterSystem underwater trace membership and filter groups',
        detail: { field: 'underwaterTraceFilterMask' },
      });
    this.#underwaterTraceFilterMask = mask;
    return ok(undefined);
  }
  underwaterTraceFilterMask(): number {
    return this.#underwaterTraceFilterMask;
  }
  updateViewState(
    view: WaterViewInput,
    physics: Pick<PhysicsWorld, 'sweepSphereAll'> | undefined,
    isBodyRendered?: (body: WaterBodySnapshot) => boolean,
  ): Result<WaterViewState, WaterViewError> {
    const result = selectPreparedWaterView(
      {
        view,
        physics,
        bodies: this.snapshots(),
        sceneGeneration: this.#sceneGeneration,
        collisionFilterMask: this.#underwaterTraceFilterMask,
        ...(isBodyRendered === undefined ? {} : { isBodyRendered }),
        queryBody: (guid, query) => this.queryBody(guid, query),
      },
      (body) => {
        const admitted = this.#bodies.get(body.guid);
        return admitted?.generation === body.sceneGeneration ? admitted.wavePreparation : undefined;
      },
    );
    this.#viewStates.set(view.viewId, result);
    return result;
  }
  /** Simulation consumes the latest selected-view depths on the following Update tick. */
  updateAudioState(): void {
    for (const result of this.#viewStates.values()) {
      if (!result.ok) continue;
      const state = result.value;
      if (
        state.selectedBody !== undefined &&
        this.#bodies.get(state.selectedBody)?.generation !== state.selectedBodyGeneration
      )
        continue;
      const previous = this.#audioStates.get(state.viewId) ?? false;
      this.#audioStates.set(state.viewId, state.audioUnderwater);
      if (previous !== state.audioUnderwater) {
        const transition = Object.freeze({
          viewId: state.viewId,
          traceGeneration: state.traceGeneration,
          underwater: state.audioUnderwater,
          immersionDepthM: state.immersionDepthM,
        });
        for (const listener of this.#audioListeners) listener(transition);
      }
    }
  }
  viewState(viewId: string): Result<WaterViewState, WaterViewError> | undefined {
    return this.#viewStates.get(viewId);
  }
  releaseViewState(viewId: string): void {
    this.#viewStates.delete(viewId);
    this.#audioStates.delete(viewId);
  }
  /** Retire a World/renderer view roster without emitting gameplay enter/exit edges. */
  clearViewStates(): void {
    this.#viewStates.clear();
    this.#audioStates.clear();
  }
  /** Games choose their own audio policy from positive-immersion enter/exit edges. */
  onAudioUnderwaterStateChanged(
    listener: (transition: WaterViewAudioTransition) => void,
  ): () => void {
    this.#audioListeners.add(listener);
    return () => {
      this.#audioListeners.delete(listener);
    };
  }
  materialStatuses(
    guid: string,
    isReferenceValid: WaterMaterialReferenceResolver,
  ): readonly WaterMaterialSlotStatus[] {
    const body = this.#bodies.get(guid);
    if (!body) return Object.freeze([]);
    const slots = [
      ['surface', body.asset.surfaceMaterialGuid],
      ['river-to-lake-transition', body.asset.riverToLakeTransitionMaterialGuid],
      ['river-to-ocean-transition', body.asset.riverToOceanTransitionMaterialGuid],
      ['water-info', body.asset.waterInfoMaterialGuid],
      ['lod', body.asset.lodMaterialGuid],
      ['underwater-post-process', body.asset.underwaterPostProcessMaterialGuid],
    ] as const;
    return Object.freeze(
      slots.flatMap(([slot, materialGuid]) => {
        if (materialGuid === undefined) return [];
        const resolved = isReferenceValid(materialGuid);
        const material =
          resolved.kind === 'valid'
            ? Object.freeze({
                form: resolved.asset.parent === undefined ? ('root' as const) : ('child' as const),
                ...(resolved.asset.surface ? { surfaceModel: resolved.asset.surface.model } : {}),
                passes: Object.freeze(resolved.asset.passes?.map((pass) => pass.name) ?? []),
              })
            : undefined;
        const supported =
          resolved.kind === 'valid' &&
          resolved.publishedPasses?.some((pass) => {
            if (slot === 'underwater-post-process')
              return (
                pass.lightMode === 'PostProcess' && pass.abis.some(isCurrentOutputPostProcessAbi)
              );
            if (slot === 'water-info')
              return (
                pass.lightMode === 'WaterInfo' &&
                pass.abis.some(
                  (abi) =>
                    (abi.bindings === 'group-0' || abi.bindings === 'render-material') &&
                    abi.sceneDepth === undefined &&
                    abi.vertexInputs.length === 2 &&
                    abi.vertexInputs.some(
                      (input) => input.location === 0 && input.format === 'float32x4',
                    ) &&
                    abi.vertexInputs.some(
                      (input) => input.location === 1 && input.format === 'float32x2',
                    ),
                )
              );
            return (
              pass.lightMode === 'Forward' &&
              pass.abis.some(
                (abi) =>
                  abi.surface !== undefined &&
                  isMaterialSurfaceModel(abi.surface.model) &&
                  (abi.surface.deformation === undefined ||
                    isMaterialDeformationProgramAbi(abi.surface.deformation)) &&
                  (abi.systemInputs === undefined ||
                    isMaterialProgramSystemInputs(abi.systemInputs)),
              )
            );
          }) === true;
        return [
          Object.freeze({
            slot,
            guid: materialGuid,
            reference: resolved.kind,
            ...(material
              ? { material, ...(supported ? {} : { missingAbi: WATER_MISSING_MATERIAL_ABI[slot] }) }
              : {}),
            waterAbi: supported ? ('supported' as const) : ('unsupported' as const),
          }),
        ];
      }),
    );
  }
  get sceneGeneration(): number {
    return this.#sceneGeneration;
  }
  private createSnapshotLease(snapshot: WaterBodySnapshot): WaterSnapshotLease {
    const bindingIdentity =
      snapshot.binding.kind === 'bound'
        ? `bound:${snapshot.binding.zoneGuid}\u0000${snapshot.binding.zoneGeneration}`
        : `unbound:${snapshot.binding.requestedGuid ?? '-'}`;
    const generationKey = `${snapshot.guid}\u0000${snapshot.sceneGeneration}\u0000${bindingIdentity}`;
    const lease = Object.freeze({ snapshot });
    this.#leases.set(lease, { generationKey, released: false });
    this.#leaseCounts.set(generationKey, (this.#leaseCounts.get(generationKey) ?? 0) + 1);
    return lease;
  }
}
function validMatrix(value: readonly number[]): boolean {
  return Array.isArray(value) && value.length === 16 && Array.from(value).every(Number.isFinite);
}
function exclusionContainsPoint(
  volume: WaterExclusionVolumeSnapshot,
  worldPositionM: readonly number[],
): boolean {
  const matrix = volume.worldMatrixM;
  const c0: [number, number, number] = [
      requireWaterValue(matrix[0]),
      requireWaterValue(matrix[1]),
      requireWaterValue(matrix[2]),
    ],
    c1: [number, number, number] = [
      requireWaterValue(matrix[4]),
      requireWaterValue(matrix[5]),
      requireWaterValue(matrix[6]),
    ],
    c2: [number, number, number] = [
      requireWaterValue(matrix[8]),
      requireWaterValue(matrix[9]),
      requireWaterValue(matrix[10]),
    ];
  const cross = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
  ): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = dot(c0, cross(c1, c2));
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false;
  const relative: [number, number, number] = [
    requireWaterValue(worldPositionM[0]) - requireWaterValue(matrix[12]),
    requireWaterValue(worldPositionM[1]) - requireWaterValue(matrix[13]),
    requireWaterValue(worldPositionM[2]) - requireWaterValue(matrix[14]),
  ];
  const local: [number, number, number] = [
    dot(relative, cross(c1, c2)) / determinant,
    dot(relative, cross(c2, c0)) / determinant,
    dot(relative, cross(c0, c1)) / determinant,
  ];
  return local.every(
    (value, axis) =>
      Math.abs(value - requireWaterValue(volume.centerM[axis])) <=
      requireWaterValue(volume.halfExtentsM[axis]) + 1e-8,
  );
}
function freezeBody(asset: WaterBodyAsset): WaterBodyAsset {
  const freezeValue = <T>(value: T): T => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Object.freeze(value.map(freezeValue)) as T;
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freezeValue(child)])),
    ) as T;
  };
  const spline = Object.freeze({
    closed: asset.spline.closed,
    ...(asset.spline.interpolationVersion
      ? { interpolationVersion: asset.spline.interpolationVersion }
      : {}),
    ...(asset.spline.metadataDefaults
      ? { metadataDefaults: Object.freeze({ ...asset.spline.metadataDefaults }) }
      : {}),
    points: Object.freeze(
      asset.spline.points.map((point) =>
        Object.freeze({
          ...point,
          positionM: Object.freeze([
            ...point.positionM,
          ]) as WaterBodyAsset['spline']['points'][number]['positionM'],
          arriveTangentM: Object.freeze([
            ...point.arriveTangentM,
          ]) as WaterBodyAsset['spline']['points'][number]['arriveTangentM'],
          leaveTangentM: Object.freeze([
            ...point.leaveTangentM,
          ]) as WaterBodyAsset['spline']['points'][number]['leaveTangentM'],
          ...(point.rotationQuat
            ? { rotationQuat: Object.freeze([...point.rotationQuat]) as typeof point.rotationQuat }
            : {}),
          ...(point.arriveRotationQuat
            ? {
                arriveRotationQuat: Object.freeze([
                  ...point.arriveRotationQuat,
                ]) as typeof point.arriveRotationQuat,
              }
            : {}),
          ...(point.leaveRotationQuat
            ? {
                leaveRotationQuat: Object.freeze([
                  ...point.leaveRotationQuat,
                ]) as typeof point.leaveRotationQuat,
              }
            : {}),
          up: Object.freeze([...point.up]) as WaterBodyAsset['spline']['points'][number]['up'],
        }),
      ),
    ),
  });
  const collision = Object.freeze({
    ...asset.collision,
    ...(asset.collision.points
      ? {
          points: Object.freeze(
            asset.collision.points.map((point) => Object.freeze([...point]) as typeof point),
          ),
        }
      : {}),
    ...(asset.collision.collisionHalfExtentsM
      ? {
          collisionHalfExtentsM: Object.freeze([
            ...asset.collision.collisionHalfExtentsM,
          ]) as typeof asset.collision.collisionHalfExtentsM,
        }
      : {}),
  });
  return Object.freeze({
    ...asset,
    spline,
    collision,
    ...(asset.riverSegmentMeshGuids
      ? { riverSegmentMeshGuids: Object.freeze([...asset.riverSegmentMeshGuids]) }
      : {}),
    ...(asset.oceanCenterM ? { oceanCenterM: Object.freeze<Vec2>([...asset.oceanCenterM]) } : {}),
    flags: Object.freeze({ ...asset.flags }),
    ...(asset.transitionContinuity
      ? { transitionContinuity: Object.freeze({ ...asset.transitionContinuity }) }
      : {}),
    queryFootprint: Object.freeze(
      asset.queryFootprint.map((point) => Object.freeze([...point]) as typeof point),
    ),
    ...(asset.oceanExtentM ? { oceanExtentM: Object.freeze<Vec2>([...asset.oceanExtentM]) } : {}),
    ...(asset.underwaterSettings
      ? { underwaterSettings: Object.freeze({ ...asset.underwaterSettings }) }
      : {}),
    ...(asset.geometryCook ? { geometryCook: Object.freeze({ ...asset.geometryCook }) } : {}),
    ...(asset.renderOptions ? { renderOptions: Object.freeze({ ...asset.renderOptions }) } : {}),
    ...(asset.waveBounds ? { waveBounds: Object.freeze({ ...asset.waveBounds }) } : {}),
    ...(asset.geometrySnapshot ? { geometrySnapshot: freezeValue(asset.geometrySnapshot) } : {}),
  });
}
function freezeDependencies(
  dependencies: readonly WaterDependencySnapshot[],
): readonly WaterDependencySnapshot[] {
  const arrayKind = (value: unknown): WaterDependencyArrayKind | undefined => {
    if (value instanceof Float32Array) return 'float32';
    if (value instanceof Uint16Array) return 'uint16';
    if (value instanceof Uint32Array) return 'uint32';
    if (value instanceof ArrayBuffer) return 'array-buffer';
    if (ArrayBuffer.isView(value)) return 'other';
    return undefined;
  };
  const clone = (value: unknown): unknown => {
    if (ArrayBuffer.isView(value))
      return Object.freeze(Array.from(value as unknown as ArrayLike<number>));
    if (value instanceof ArrayBuffer) return Object.freeze(Array.from(new Uint8Array(value)));
    if (Array.isArray(value)) return Object.freeze(value.map(clone));
    if (value && typeof value === 'object')
      return Object.freeze(
        Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])),
      );
    return value;
  };
  const meshArrayKinds = (payload: unknown): WaterDependencySnapshot['payloadArrayKinds'] => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      (
        payload as {
          kind?: unknown;
        }
      ).kind !== 'mesh'
    )
      return undefined;
    const mesh = payload as {
      vertices?: unknown;
      indices?: unknown;
      attributes?: Record<string, unknown>;
    };
    const attributes = Object.fromEntries(
      Object.entries(mesh.attributes ?? {}).flatMap(([name, value]) => {
        const kind = arrayKind(value);
        return kind === undefined ? [] : [[name, kind]];
      }),
    );
    const vertices = arrayKind(mesh.vertices);
    const indices = arrayKind(mesh.indices);
    return Object.freeze({
      ...(vertices === undefined ? {} : { vertices }),
      ...(indices === undefined ? {} : { indices }),
      attributes: Object.freeze(attributes),
    });
  };
  return Object.freeze(
    dependencies.map((dependency) => {
      const payloadArrayKinds = meshArrayKinds(dependency.payload) ?? dependency.payloadArrayKinds;
      return Object.freeze({
        ...dependency,
        ...(dependency.payload === undefined ? {} : { payload: clone(dependency.payload) }),
        ...(payloadArrayKinds === undefined ? {} : { payloadArrayKinds }),
      });
    }),
  );
}
function freezeTerrainAssetSnapshot(
  asset: NonNullable<WaterZoneTerrainProviderInput['terrainAsset']>,
): NonNullable<WaterZoneTerrainProviderInput['terrainAsset']> {
  const clone = (value: unknown): unknown => {
    if (value instanceof Float32Array) return new Float32Array(value);
    if (Array.isArray(value)) return Object.freeze(value.map(clone));
    if (value && typeof value === 'object')
      return Object.freeze(
        Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])),
      );
    return value;
  };
  return clone(asset) as NonNullable<WaterZoneTerrainProviderInput['terrainAsset']>;
}
function freezeExclusions(
  volumes: readonly WaterExclusionVolumeSnapshot[],
): readonly WaterExclusionVolumeSnapshot[] {
  return Object.freeze(
    volumes.map((volume) =>
      Object.freeze({
        entity: volume.entity,
        centerM: Object.freeze([...volume.centerM]) as WaterExclusionVolumeSnapshot['centerM'],
        halfExtentsM: Object.freeze([
          ...volume.halfExtentsM,
        ]) as WaterExclusionVolumeSnapshot['halfExtentsM'],
        worldMatrixM: Object.freeze([...volume.worldMatrixM]),
      }),
    ),
  );
}
function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  const value = new Set(source);
  let facade: ReadonlySet<T>;
  facade = Object.freeze({
    get size() {
      return value.size;
    },
    has: (entry: T) => value.has(entry),
    entries: () => value.entries(),
    keys: () => value.keys(),
    values: () => value.values(),
    [Symbol.iterator]: () => value[Symbol.iterator](),
    forEach: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      value.forEach((entry) => {
        callback.call(thisArg, entry, entry, facade);
      });
    },
  });
  return facade;
}
