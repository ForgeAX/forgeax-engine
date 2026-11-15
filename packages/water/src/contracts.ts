export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

import type {
  TerrainAsset,
  WaterBodyAsset as WaterBodyRuntimeAsset,
  WaterBodySource as WaterBodySourceAsset,
  WaterBrushRecipeSource,
  WaterBrushRecipeAsset as WaterBrushRuntimeAsset,
  WaterSimulationRecipeSource,
  WaterSimulationRecipeAsset as WaterSimulationRuntimeAsset,
  WaterWaveSetAsset as WaterWaveSetRuntimeAsset,
  WaterWaveSetSource,
  WaterZoneAsset as WaterZoneRuntimeAsset,
  WaterZoneSource as WaterZoneSourceAsset,
} from '@forgeax/engine-types';

export type {
  WaterBodySource as WaterBodySourceAsset,
  WaterBrushRecipeSource as WaterBrushRecipeSourceAsset,
  WaterSimulationRecipeSource as WaterSimulationRecipeSourceAsset,
  WaterWaveSetSource as WaterWaveSetSourceAsset,
  WaterWaveSource,
  WaterZoneSource as WaterZoneSourceAsset,
} from '@forgeax/engine-types';

export type WaterBodyType = 'river' | 'lake' | 'ocean' | 'custom';
export type WaterBodyAsset = WaterBodyRuntimeAsset;
export type WaterZoneAsset = WaterZoneRuntimeAsset;
export type WaterWaveSetAsset = WaterWaveSetRuntimeAsset;
export type WaterBrushRecipeAsset = WaterBrushRuntimeAsset;
export type WaterSimulationRecipeAsset = WaterSimulationRuntimeAsset;
export type WaterAsset =
  | WaterBodySourceAsset
  | WaterZoneSourceAsset
  | WaterWaveSetSource
  | WaterBrushRecipeSource
  | WaterSimulationRecipeSource;

export type WaterErrorCode =
  | 'invalid-source'
  | 'missing-dependency'
  | 'stale-generation'
  | 'zone-unbound'
  | 'wave-upload-capacity-exceeded'
  | 'body-unregistered'
  | 'null-spline-metadata'
  | 'invalid-query-flags'
  | 'query-data-unavailable';
export type WaterError = {
  readonly code: WaterErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
};
export type WaterDirtyKind =
  | 'geometry'
  | 'waterInfo'
  | 'waterMesh'
  | 'terrainBrush'
  | 'collision'
  | 'query'
  | 'material';
export type WaterOutputAvailability =
  | 'unsupported'
  | 'not-requested'
  | 'zone-unbound'
  | 'ready'
  | 'stale';
export type WaterOutputStatus = Readonly<Record<WaterDirtyKind, WaterOutputAvailability>>;
export type WaterOutputReceipt = Readonly<{
  sourceVersion: string;
  sceneGeneration: number;
  outputGeneration: number;
  consumerGeneration: number;
  digest: string;
}>;
export type WaterDependencyArrayKind = 'array-buffer' | 'float32' | 'uint16' | 'uint32' | 'other';
export type WaterDependencyLoadFailure = Readonly<{
  code: string;
  expected: string;
  hint: string;
  detail?: unknown;
}>;
export type WaterDependencySnapshot = Readonly<{
  guid: string;
  kind: string;
  field?: string;
  actualKind?: string;
  payload?: unknown;
  /** Derived from the selected cooked material's actual entry-point resource reads. */
  materialRequiresBakedSource?: boolean;
  /** Original mesh storage kinds retained while the immutable payload stores frozen number arrays. */
  payloadArrayKinds?: Readonly<{
    vertices?: WaterDependencyArrayKind;
    indices?: WaterDependencyArrayKind;
    attributes?: Readonly<Record<string, WaterDependencyArrayKind>>;
  }>;
}> &
  (
    | Readonly<{ status: 'valid' | 'pending' | 'unavailable' | 'invalid-kind'; failure?: never }>
    | Readonly<{ status: 'failed'; failure: WaterDependencyLoadFailure }>
  );
export type WaterZoneBinding =
  | {
      readonly kind: 'bound';
      readonly zoneGuid: string;
      readonly zoneGeneration: number;
      readonly worldMatrixM: readonly number[];
    }
  | {
      readonly kind: 'zone-unbound';
      readonly requestedGuid?: string;
      readonly retryOnCatalogChange: true;
    };
export type WaterZoneTerrainProviderInput = Readonly<{
  readonly entity: number;
  readonly terrainGuid: string;
  readonly terrainVersion: number;
  readonly worldMatrixM: readonly number[];
  readonly boundsXZ: Readonly<{ minM: readonly [number, number]; maxM: readonly [number, number] }>;
  readonly terrainAsset?: TerrainAsset;
}>;
/** Zone-owned, intersecting Landscape inputs consumed by WaterInfo ground capture. */
export type WaterZoneGroundSnapshot = Readonly<{
  readonly zoneGuid: string;
  readonly zoneGeneration: number;
  readonly generation: number;
  readonly providers: readonly WaterZoneTerrainProviderInput[];
  readonly dirty: boolean;
}>;
/** Metadata-only view used by the internal high-frequency terrain query resolver. */
export type WaterZoneGroundQuerySnapshot = Readonly<{
  readonly zoneGuid: string;
  readonly zoneGeneration: number;
  readonly generation: number;
  /** True while a live provider row has an unreadable candidate revision. */
  readonly pending: boolean;
  readonly providers: readonly Readonly<
    Pick<
      WaterZoneTerrainProviderInput,
      'entity' | 'terrainGuid' | 'terrainVersion' | 'worldMatrixM' | 'boundsXZ'
    >
  >[];
  readonly dirty: boolean;
}>;
export type WaterBodySnapshot = {
  /** WaterSystem identity for one Scene actor instance. */
  readonly guid: string;
  /** Source Body asset identity shared by one or more Scene instances. */
  readonly sourceAssetGuid: string;
  /** Scene actor identity supplied by the Scene lifecycle owner. */
  readonly instanceEntity?: number;
  /** Column-major Scene world matrix; spline data stays in actor-local m. */
  readonly worldMatrixM: readonly number[];
  readonly sourceVersion: string;
  /** Publication provenance for the adopted Registry closure, when source-loaded. */
  readonly sourcePublication?: Readonly<{
    sourceRevision: string;
    generation: number;
    digest: string;
    outputSetDigest: string;
  }>;
  readonly sceneGeneration: number;
  /** Scene-local exclusions keep their oriented box transform for query and collision consumers. */
  readonly exclusionVolumes: readonly WaterExclusionVolumeSnapshot[];
  readonly asset: WaterBodyAsset;
  readonly binding: WaterZoneBinding;
  readonly dependencies: readonly WaterDependencySnapshot[];
  /** Generation support is reported separately from source-change dirtiness. */
  readonly outputs: WaterOutputStatus;
  readonly outputGenerations: Readonly<Record<WaterDirtyKind, number>>;
  readonly outputReceipts: Readonly<Partial<Record<WaterDirtyKind, WaterOutputReceipt>>>;
  readonly dirty: ReadonlySet<WaterDirtyKind>;
};
export type WaterExclusionVolumeSnapshot = Readonly<{
  readonly entity: number;
  readonly centerM: Vec3;
  readonly halfExtentsM: Vec3;
  readonly worldMatrixM: readonly number[];
}>;
export type WaterSnapshotLease = Readonly<{ snapshot: WaterBodySnapshot }>;

/** UE EWaterBodyQueryFlags values; these are independent of render and WaterInfo flags. */
export const WaterQueryFlags = Object.freeze({
  None: 0,
  ComputeLocation: 1 << 0,
  ComputeNormal: 1 << 1,
  ComputeVelocity: 1 << 2,
  ComputeDepth: 1 << 3,
  ComputeImmersionDepth: 1 << 4,
  IncludeWaves: 1 << 5,
  SimpleWaves: 1 << 6,
  IgnoreExclusionVolumes: 1 << 7,
} as const);
export type WaterQueryFlagsValue = number;
export type WaterQueryField = 'location' | 'normal' | 'depth' | 'immersion' | 'velocity' | 'waves';
export type WaterQuerySource = 'plane' | 'terrain' | 'spline' | 'baked' | 'exclusion';
type WaterBakedQueryLineageBase = Readonly<{
  readonly textureGuid: string;
  /** Loaded AssetRegistry revision; never the source recipe content-version digest. */
  readonly textureRevision?: number;
  readonly sourceRecipeGuid: string;
  /** Content-version digest of the recipe which produced this Bake. */
  readonly sourceRecipeVersion: string;
  readonly sourceBodyGuid: string;
  readonly sourceBodyGeneration: number;
  readonly simulationGeneration: number;
  readonly sequence: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
}>;
export type WaterBakedQueryLineageV1 = WaterBakedQueryLineageBase &
  Readonly<{ readonly version: 'water-river-bake/1' }>;
export type WaterBakedQueryLineageV2 = WaterBakedQueryLineageBase &
  Readonly<{
    readonly version: 'water-river-bake/2';
    readonly normalTextureGuid: string;
    /** Runtime AssetRegistry revision of the required paired solver-normal texture. */
    readonly normalTextureRevision: number;
    /** Actual accepted Pack texture format, checked against the recipe's normalRtFormat. */
    readonly normalTextureFormat: 'rgba16float' | 'rgba32float';
    readonly normalBasis: 'lattice-axis0-axis1-up/1';
    readonly sourceWorldMatrixM: readonly number[];
    readonly sourceGeometryProjectionHash: string;
    readonly sourceFrame: Readonly<{
      readonly generation: number;
      readonly sequence: number;
      readonly step: number;
      readonly timeSeconds: number;
    }>;
  }>;
/** Captured source provenance. v2 adds cold-load equivalence facts. */
export type WaterBakedQueryLineage = WaterBakedQueryLineageV1 | WaterBakedQueryLineageV2;
export type WaterBakedQueryGrid = Readonly<{
  /** Position of sample (0, 0) in world XZ, measured at sample centers. */
  originXZ: Vec2;
  /** World Y of the baked height origin; channel 0 stores the height offset. */
  originY: number;
  spacingXZ: Vec2;
  width: number;
  height: number;
  /** X-fast rows, four floats per cell: height offset, depth, world X velocity, world Z velocity. */
  samples: Float32Array;
  /** Optional detached source identity; old identity-less grids remain valid query/render data. */
  lineage?: WaterBakedQueryLineage;
}>;

/** CPU-only source identity/domain; renderer handles stay in Render and host owners. */
export type WaterSurfaceSourceDescriptor = Readonly<{
  readonly bodyGuid: string;
  /** Current mounted Body generation, distinct from captured lineage. */
  readonly bodyBindingGeneration: number;
  readonly sourceBodyGeneration: number;
  readonly source: 'live' | 'baked';
  /** Exact advanced-simulation recipe owner for Live; captured recipe lineage for Baked. */
  readonly sourceRecipeGuid: string;
  readonly simulationGeneration: number;
  readonly sequence: number;
  readonly sourceFrame: Readonly<{
    readonly generation: number;
    readonly sequence: number;
    readonly step: number;
    readonly timeSeconds: number;
  }>;
  readonly domain: Readonly<{
    readonly originXZ: Vec2;
    readonly originY: number;
    readonly spacingXZ: Vec2;
    readonly resolution: readonly [number, number];
    readonly yawRadians: number;
    readonly basis: 'lattice-axis0-axis1-up/1';
  }>;
  readonly textures:
    | Readonly<{
        readonly kind: 'render-feature-output-pair';
        readonly gridTarget: string;
        readonly solverNormalTarget: string;
      }>
    | Readonly<{
        readonly kind: 'pack-texture-pair';
        readonly gridGuid: string;
        readonly gridRevision: number;
        readonly gridFormat: 'rgba16float';
        readonly solverNormalGuid: string;
        readonly solverNormalRevision: number;
        readonly solverNormalFormat: 'rgba16float' | 'rgba32float';
      }>;
}>;

/** Copy only the closed River Bake identity fields when the optional identity is complete. */
export function snapshotWaterBakedQueryLineage(value: unknown): WaterBakedQueryLineage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const lineage = value as WaterBakedQueryLineage;
  const validBase =
    [
      lineage.textureGuid,
      lineage.sourceRecipeGuid,
      lineage.sourceRecipeVersion,
      lineage.sourceBodyGuid,
    ].every((value) => typeof value === 'string' && value.length > 0) &&
    [
      lineage.sourceBodyGeneration,
      lineage.simulationGeneration,
      lineage.sequence,
      lineage.frameId,
      lineage.deviceGeneration,
      lineage.graphGeneration,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    (lineage.textureRevision === undefined ||
      (Number.isSafeInteger(lineage.textureRevision) && lineage.textureRevision >= 0));
  if (!validBase) return undefined;
  if (lineage.version === 'water-river-bake/1')
    return Object.freeze({
      version: lineage.version,
      textureGuid: lineage.textureGuid,
      ...(lineage.textureRevision === undefined
        ? {}
        : { textureRevision: lineage.textureRevision }),
      sourceRecipeGuid: lineage.sourceRecipeGuid,
      sourceRecipeVersion: lineage.sourceRecipeVersion,
      sourceBodyGuid: lineage.sourceBodyGuid,
      sourceBodyGeneration: lineage.sourceBodyGeneration,
      simulationGeneration: lineage.simulationGeneration,
      sequence: lineage.sequence,
      frameId: lineage.frameId,
      deviceGeneration: lineage.deviceGeneration,
      graphGeneration: lineage.graphGeneration,
    });
  if (lineage.version !== 'water-river-bake/2') return undefined;
  const sourceFrame = lineage.sourceFrame;
  if (!validWaterBakedNormalLineage(lineage) || !validWaterBakedSourceFrame(lineage, sourceFrame))
    return undefined;
  return Object.freeze({
    version: lineage.version,
    textureGuid: lineage.textureGuid,
    ...(lineage.textureRevision === undefined ? {} : { textureRevision: lineage.textureRevision }),
    sourceRecipeGuid: lineage.sourceRecipeGuid,
    sourceRecipeVersion: lineage.sourceRecipeVersion,
    sourceBodyGuid: lineage.sourceBodyGuid,
    sourceBodyGeneration: lineage.sourceBodyGeneration,
    simulationGeneration: lineage.simulationGeneration,
    sequence: lineage.sequence,
    frameId: lineage.frameId,
    deviceGeneration: lineage.deviceGeneration,
    graphGeneration: lineage.graphGeneration,
    normalTextureGuid: lineage.normalTextureGuid,
    normalTextureRevision: lineage.normalTextureRevision,
    normalTextureFormat: lineage.normalTextureFormat,
    normalBasis: lineage.normalBasis,
    sourceWorldMatrixM: Object.freeze([...lineage.sourceWorldMatrixM]),
    sourceGeometryProjectionHash: lineage.sourceGeometryProjectionHash,
    sourceFrame: Object.freeze({
      generation: sourceFrame.generation,
      sequence: sourceFrame.sequence,
      step: sourceFrame.step,
      timeSeconds: sourceFrame.timeSeconds,
    }),
  });
}

/** Deep snapshot the authored grid while retaining only complete, valid source lineage. */
export function snapshotWaterBakedQueryGrid(grid: WaterBakedQueryGrid): WaterBakedQueryGrid {
  const lineage = snapshotWaterBakedQueryLineage(grid.lineage);
  return Object.freeze({
    originXZ: Object.freeze<Vec2>([...grid.originXZ]),
    originY: grid.originY,
    spacingXZ: Object.freeze<Vec2>([...grid.spacingXZ]),
    width: grid.width,
    height: grid.height,
    samples: new Float32Array(grid.samples),
    ...(lineage === undefined ? {} : { lineage }),
  });
}
export type WaterQueryInput = Readonly<{
  positionM: Vec3;
  flags: WaterQueryFlagsValue;
  timeSeconds: number;
  /** Local GPU fields use the native completed clock, independently of Gerstner scene time. */
  nativePhysics?: Readonly<{ completedStep: number; timeSeconds: number }>;
  /** Select the local field excluding this native source; unqualified queries read the full field. */
  receiver?: import('./query-residual.js').WaterResidualQueryReceiver;
  splineKey?: number;
  expectedBodyGeneration?: number;
  oceanFallbackDepthM?: number;
  /** Standalone pure snapshot queries only. WaterSystem.queryBody rejects caller-supplied baked data and uses its published current-generation grid. */
  baked?: Readonly<{
    enabled: boolean;
    componentValid: boolean;
    dataValid: boolean;
    grid: WaterBakedQueryGrid;
  }>;
}>;

/** Optional synchronous observer supplied by a host for actual Water work boundaries. */
export interface WaterOperationObserver {
  begin(operation: string): { end(): void } | undefined;
}

export type WaterBakedQuerySource = NonNullable<WaterQueryInput['baked']>;
/** The source lane is explicit because a durable Pack decode is not a live capture. */
export type WaterBakedQueryPublication =
  | (WaterBakedQuerySource & Readonly<{ kind: 'live-capture' }>)
  | (WaterBakedQuerySource & Readonly<{ kind: 'durable-pack' }>);
export type WaterTerrainQuerySample = Readonly<{
  heightM: number;
  providerGuid: string;
  providerVersion: number;
  zoneGeneration: number;
  groundGeneration: number;
}>;
export type WaterWaveQueryInfo = Readonly<{
  timeSeconds: number;
  heightM: number;
  maxHeightM: number;
  attenuation: number;
  normalYUp: Vec3;
}>;
export type WaterQueryResult = Readonly<{
  bodyGuid: string;
  bodyGeneration: number;
  adjustedFlags: WaterQueryFlagsValue;
  valid: ReadonlySet<WaterQueryField>;
  locationM?: Vec3;
  surfaceM?: Vec3;
  normalYUp?: Vec3;
  /** Accepted water plane normal before wave surface-normal perturbation. */
  planeNormalYUp?: Vec3;
  depthM?: number;
  immersionM?: number;
  velocityMPerSec?: Vec3;
  splineKey?: number;
  excluded: boolean;
  source: WaterQuerySource;
  terrainSample?: WaterTerrainQuerySample;
  waveInfo?: WaterWaveQueryInfo;
  /** Optional local source status; unavailable local data preserves every valid base-water field. */
  localResidual?: import('./query-residual.js').WaterResidualQueryResult;
}>;

export type WaterMaterialSlotName =
  | 'surface'
  | 'river-to-lake-transition'
  | 'river-to-ocean-transition'
  | 'water-info'
  | 'lod'
  | 'underwater-post-process';
export type WaterMaterialSlotStatus = {
  readonly slot: WaterMaterialSlotName;
  readonly guid: string;
  readonly reference: 'valid' | 'unavailable' | 'invalid-kind';
  readonly material?: {
    readonly form: 'root' | 'child';
    readonly surfaceModel?: string;
    readonly passes: readonly string[];
  };
  readonly waterAbi: 'supported' | 'unsupported';
  readonly missingAbi?: readonly string[];
};
export const WATER_MISSING_MATERIAL_ABI = Object.freeze({
  surface: Object.freeze(['surface'] as const),
  'river-to-lake-transition': Object.freeze(['transition'] as const),
  'river-to-ocean-transition': Object.freeze(['transition'] as const),
  'water-info': Object.freeze(['WaterInfo'] as const),
  lod: Object.freeze(['LOD'] as const),
  'underwater-post-process': Object.freeze(['PostProcess'] as const),
});

type WaterBakedLineageV2 = Extract<WaterBakedQueryLineage, { version: 'water-river-bake/2' }>;
function validWaterBakedNormalLineage(lineage: WaterBakedLineageV2): boolean {
  return !(
    typeof lineage.normalTextureGuid !== 'string' ||
    lineage.normalTextureGuid.length === 0 ||
    !Number.isSafeInteger(lineage.normalTextureRevision) ||
    lineage.normalTextureRevision < 0 ||
    (lineage.normalTextureFormat !== 'rgba16float' &&
      lineage.normalTextureFormat !== 'rgba32float') ||
    lineage.normalBasis !== 'lattice-axis0-axis1-up/1' ||
    !Array.isArray(lineage.sourceWorldMatrixM) ||
    lineage.sourceWorldMatrixM.length !== 16 ||
    !lineage.sourceWorldMatrixM.every(Number.isFinite) ||
    typeof lineage.sourceGeometryProjectionHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(lineage.sourceGeometryProjectionHash)
  );
}
function validWaterBakedSourceFrame(
  lineage: WaterBakedLineageV2,
  sourceFrame: WaterBakedLineageV2['sourceFrame'],
): boolean {
  return !(
    sourceFrame === null ||
    typeof sourceFrame !== 'object' ||
    Array.isArray(sourceFrame) ||
    ![sourceFrame.generation, sourceFrame.sequence, sourceFrame.step].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    sourceFrame.step <= 0 ||
    sourceFrame.generation !== lineage.simulationGeneration ||
    sourceFrame.sequence !== lineage.sequence ||
    !Number.isFinite(sourceFrame.timeSeconds) ||
    sourceFrame.timeSeconds < 0
  );
}
