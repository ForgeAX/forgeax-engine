export type WaterVec2 = readonly [number, number];
export type WaterVec3 = readonly [number, number, number];
export type WaterQuat = readonly [number, number, number, number];

/** Synchronous water buoyancy defaults in SI units. */
export const WATER_BUOYANCY_DEFAULTS = Object.freeze({
  buoyancyCoefficientNPerM3: 1000,
  dampingNPerMps: 1000,
  dampingNPerMpsSquared: 100,
  rampMinSpeedMps: 20 / 3.6,
  rampMaxSpeedMps: 50 / 3.6,
  rampMax: 1,
  maxBuoyantForceN: 50000,
  centerPontoonsOnCOM: true,
  riverVelocityStrength: 0.01,
  riverShoreFactor: 0.3,
  maxRiverAccelerationMps2: 100,
  riverTraversalPathWidthM: 3,
  maxLateralAccelerationMps2: 3,
  allowFastUpstream: false,
  alwaysAllowLateralPush: false,
  velocityPontoonIndex: 0,
  applyRiverForces: true,
  applyDrag: false,
  linearDragCoefficient: 20,
  quadraticDragCoefficient: 0.01,
  maxDragSpeedMps: 15 / 3.6,
  angularDragPerSecond: 1,
});

export type WaterSplineSourcePoint = {
  readonly inputKey: number;
  readonly interpolationMode?: 'linear' | 'curve' | 'curve-clamped' | 'curve-custom-tangent';
  /** Engine-basis (x,y,z,w) rotation authority after source conversion; v1 requires normalized keys and a matching `up`. */
  readonly rotationQuat?: WaterQuat;
  readonly arriveRotationQuat?: WaterQuat;
  readonly leaveRotationQuat?: WaterQuat;
  readonly positionM: WaterVec3;
  readonly arriveTangentM: WaterVec3;
  readonly leaveTangentM: WaterVec3;
  readonly up: WaterVec3;
  readonly rollAngle: number;
  readonly angleUnit: 'degrees';
  readonly widthM: number;
  readonly depthM: number;
  readonly velocityMPerSec: number;
  readonly audioIntensity: number;
};

export type WaterSplineMetadataDefaults = Readonly<
  Pick<WaterSplineSourcePoint, 'widthM' | 'depthM' | 'velocityMPerSec' | 'audioIntensity'>
>;
export type WaterSplineInterpolationVersion = 'water-spline/2';

export type WaterFlags = {
  readonly affectsWaterInfo: boolean;
  readonly affectsWaterMesh: boolean;
  readonly affectsLandscape: boolean;
};

export const WATER_BODY_DEFAULT_SHAPE_DILATION_M = 40.96;
export const WATER_BODY_DEFAULT_FIXED_WATER_DEPTH_M = 5.12;
export const WATER_UNDERWATER_POST_PROCESS_DEFAULTS = Object.freeze({
  enabled: true,
  priority: 0,
  blendRadiusM: 1,
  blendWeight: 1,
});

export type WaterCollisionSource = {
  readonly type: 'none' | 'river-prism' | 'polygon' | 'custom-mesh';
  readonly enabled: boolean;
  /** Packed membership/filter groups used by general scene queries. */
  readonly collisionGroups?: number;
  readonly points?: readonly WaterVec2[];
  readonly meshGuid?: string;
  /** Lake box full vertical depth in meters; half-height is channelDepthM / 2. */
  readonly channelDepthM?: number;
  /** Ocean box vertical half-height in meters, corresponding to CollisionExtents.Z. */
  readonly collisionHalfHeightM?: number;
  /** Ocean collision box X/Z world half extents in meters, independent of OceanExtents and actor scale. */
  readonly collisionHalfExtentsM?: WaterVec2;
  /** Full vertical offset in meters; collision center uses half this offset. */
  readonly collisionHeightOffsetM?: number;
};

export type WaterBodySource = {
  readonly kind: 'water-body';
  readonly type: 'river' | 'lake' | 'ocean' | 'custom';
  readonly spline: {
    readonly closed: boolean;
    readonly points: readonly WaterSplineSourcePoint[];
    readonly metadataDefaults?: WaterSplineMetadataDefaults;
    readonly interpolationVersion?: WaterSplineInterpolationVersion;
  };
  readonly baseHeightM: number;
  /** GPU fixed depth when spline key zero has no nonzero depth; defaults to 5.12 m. */
  readonly fixedWaterDepthM?: number;
  readonly overlapPriority: number;
  /** Total conservative world-Y wave envelope, including any authored bound offset. */
  readonly maxWaveHeightM: number;
  /** River/Lake component-bound upper expansion in local meters; already included in maxWaveHeightM. Defaults to 0. */
  readonly maxWaveHeightOffsetM?: number;
  /** Curve channel depth for component bounds in local meters, independent of collision depth. Defaults to 0. */
  readonly channelDepthM?: number;
  /** WaterInfo footprint dilation in meters; defaults to 40.96 m. */
  readonly shapeDilationM?: number;
  readonly surfaceMaterialGuid: string;
  readonly flags: WaterFlags;
  readonly collision: WaterCollisionSource;
  /** Debug footprint; Ocean query and collision areas use their cooked geometry products. */
  readonly queryFootprint: readonly WaterVec2[];
  readonly zoneGuid?: string;
  /** Ocean body surface/collision extent in meters; independent of Zone span and transform. */
  readonly oceanExtentM?: WaterVec2;
  /** Defaults to true; the visible Ocean center is resolved from the saved Zone world position during Pack cook. */
  readonly centerOnWaterZone?: boolean;
  /** Persisted world-space XZ fallback used when the WaterZone is not loaded. */
  readonly savedZoneLocationWorldXZ?: WaterVec2;
  readonly waveSetGuid?: string;
  readonly heightOffsetM?: number;
  readonly customMeshOverrideGuid?: string;
  readonly riverToLakeTransitionMaterialGuid?: string;
  readonly riverToOceanTransitionMaterialGuid?: string;
  /** Optional rendered terminal join; native query height/depth/flow are unchanged. */
  readonly transitionContinuity?: Readonly<{
    target: 'ocean';
    endpoint: 'end';
    reachM: number;
    blendWidthM: number;
  }>;
  readonly waterInfoMaterialGuid?: string;
  /** Material for generated River/Lake/Ocean static meshes; omission uses surfaceMaterialGuid. */
  readonly lodMaterialGuid?: string;
  readonly underwaterPostProcessMaterialGuid?: string;
  readonly underwaterSettings?: {
    readonly enabled: boolean;
    readonly priority: number;
    readonly blendRadiusM?: number;
    readonly blendWeight?: number;
    readonly maxDepthM: number;
  };
  readonly geometryCook?: {
    readonly splineToleranceM: number;
    readonly collisionToleranceM: number;
  };
  readonly renderOptions?: {
    readonly castShadow: boolean;
    readonly receiveShadow: boolean;
    readonly visible: boolean;
  };
  readonly waveBounds?: {
    readonly minimumM: number;
    readonly maximumM: number;
    readonly edgeBlendWidthM: number;
  };
};

export type WaterBodyCollisionDescriptorV1 = Readonly<{
  version: 1;
  digest: string;
  footprint: Readonly<{ outer: readonly WaterVec2[]; holes: readonly (readonly WaterVec2[])[] }>;
  minimumYM: number;
  maximumYM: number;
  riverSegmentConvexes?: readonly (readonly (readonly WaterVec3[])[])[];
  /** Version 1 never carries cooker-owned River cap roles. */
  riverSegmentConvexTopCapVertexIndices?: never;
  customMesh?: Readonly<{
    meshGuid: string;
    vertices: readonly number[];
    indices: readonly number[];
  }>;
}>;

export type WaterBodyCollisionDescriptorV2 = Readonly<{
  version: 2;
  digest: string;
  footprint: Readonly<{ outer: readonly WaterVec2[]; holes: readonly (readonly WaterVec2[])[] }>;
  minimumYM: number;
  maximumYM: number;
  riverSegmentConvexes: readonly (readonly (readonly WaterVec3[])[])[];
  /** Cook-owned top-cap roles for each convex in the deterministic River hull set. */
  riverSegmentConvexTopCapVertexIndices: readonly (readonly (readonly number[])[])[];
}>;

export type WaterBodyGeometrySnapshot = Readonly<{
  queryFootprint: Readonly<{
    version: 1;
    digest: string;
    outer: readonly WaterVec2[];
    holes: readonly (readonly WaterVec2[])[];
  }>;
  queryVolume: Readonly<{ version: 1; digest: string; minimumYM: number; maximumYM: number }>;
  /** Projected XZ union of resolved Custom override triangles for WaterMesh participation. */
  waterMeshFootprint?: Readonly<{
    version: 1;
    digest: string;
    rings: readonly (readonly WaterVec2[])[];
  }>;
  collisionDescriptor: WaterBodyCollisionDescriptorV1 | WaterBodyCollisionDescriptorV2 | null;
}>;

/** Cooked output references and authoritative geometry facts owned by Pack. */
export type WaterBodyAsset = WaterBodySource & {
  /** Pack-published mesh outputs, one for each authored River spline segment. */
  readonly riverSegmentMeshGuids?: readonly string[];
  readonly visibleMeshGuid?: string;
  readonly waterInfoMeshGuid?: string;
  /** WaterInfo dilation mesh: River fringe/caps, or Lake/Ocean full offset polygon. */
  readonly dilatedWaterInfoMeshGuid?: string;
  readonly brushShapeMeshGuid?: string;
  readonly collisionMeshGuid?: string;
  /** Pack output contract v2; absent on legacy bodies that predate separate WaterInfo dilation. */
  readonly waterGeometryVersion?: 2;
  /** Cooked actor-local visible Ocean center in meters. Pack derives it; sources do not author it. */
  readonly oceanCenterM?: WaterVec2;
  /** Frozen Pack transform used by world-dependent geometry and spline-metric sampling. */
  readonly geometryAuthoringWorldMatrixM?: readonly number[];
  readonly geometrySnapshot?: WaterBodyGeometrySnapshot;
};

export type WaterZoneSource = {
  readonly kind: 'water-zone';
  readonly extentM: { readonly spanXM: number; readonly spanZM: number };
  readonly tileSizeM: number;
  readonly tessellationFactor: number;
  readonly lodScale: number;
  /** Presence selects the genuine static-mesh raster/GPU traversal path. */
  readonly gpuMesh?: {
    readonly supersampling: number;
    readonly msaaSamples: 1 | 4;
    readonly occlusion: 'disabled' | 'hzb' | 'precise' | 'hzb-precise';
  };
  readonly waterInfo: {
    readonly resolution: { readonly widthPx: number; readonly heightPx: number };
    readonly format: 'rgba16f' | 'rgba32f';
    readonly blurRadius: number;
    readonly localTessellation: boolean;
    /** Local-space XYZ diameter of the sliding window; defaults to [512,100,512] meters. */
    readonly localExtentM?: WaterVec3;
  };
  readonly farExtentM?: { readonly spanXM: number; readonly spanZM: number };
  readonly farMaterialGuid?: string;
  /** Zone is the fixed default; view-window follows an Ocean's local tessellation window. */
  readonly farMeshBoundary?: 'zone' | 'view-window';
  /** Zone-local fixed Y for far mesh when the Zone has no Ocean owner. */
  readonly farWaterLevelM?: number;
  /** WaterBody source asset GUID that supplies the draw owner when no Ocean exists. */
  readonly farOwnerBodyGuid?: string;
  readonly priority?: number;
};
export type WaterZoneAsset = WaterZoneSource;

export type WaterWaveSource = {
  readonly directionXZ: WaterVec2;
  readonly wavelengthM: number;
  readonly amplitudeM: number;
  readonly steepness: number;
};
export type WaterWaveSetSource = {
  readonly kind: 'water-wave-set';
  readonly waveSource:
    | {
        readonly kind: 'generated';
        readonly seed: number;
        readonly generatorId: string;
        readonly generatorVersion: string;
        readonly generatorConfig: Readonly<Record<string, number | boolean>>;
      }
    | { readonly kind: 'predefined'; readonly waves: readonly WaterWaveSource[] };
  readonly depthMaskM: number;
  readonly maxWaveHeightM: number;
  readonly timeSource: 'fixed-step' | 'scene-clock';
};
export type WaterWaveSetAsset = {
  readonly kind: 'water-wave-set';
  readonly sourceMode: 'generated' | 'predefined';
  readonly sourceSeed?: number;
  readonly generatorId?: string;
  readonly generatorVersion?: string;
  readonly generatorConfig?: Readonly<Record<string, number | boolean>>;
  readonly inputDigest: string;
  readonly waves: readonly WaterWaveSource[];
  readonly depthMaskM: number;
  readonly maxWaveHeightM: number;
  readonly timeSource: 'fixed-step' | 'scene-clock';
};

export type WaterBrushRulesSource = {
  /** V0 migration input. Typed v1 records retain only the neutral sentinel values. */
  readonly falloff: { readonly type: string; readonly widthM: number; readonly strength: number };
  readonly blend: { readonly type: string; readonly alpha: number };
  readonly heightRules: {
    readonly mode: string;
    readonly offsetM: number;
    readonly velocityMPerSec: number;
  };
  readonly weightRules: { readonly layer: string; readonly value: number; readonly blend: string };
};
export type WaterBrushFalloffType = 'width' | 'angle';
export type WaterBrushBlendType = 'alpha' | 'min' | 'max' | 'additive';
export type WaterBrushActorRules = Readonly<{
  falloff: Readonly<{
    mode: WaterBrushFalloffType;
    widthM: number;
    angleDegrees: number;
    edgeOffsetM: number;
    zOffsetM: number;
  }>;
  blend: Readonly<{ type: WaterBrushBlendType }>;
  blurring: Readonly<{ enabled: boolean; radiusPx: number }>;
  curlNoise: Readonly<{
    firstAmount: number;
    firstTiling: number;
    secondAmount: number;
    secondTiling: number;
  }>;
  curves: Readonly<{
    useCurveChannel: boolean;
    elevationCurveGuid?: string;
    channelEdgeOffsetM: number;
    channelDepthM: number;
    curveRampWidthM: number;
  }>;
  displacement: Readonly<{
    enabled: boolean;
    heightM: number;
    textureTiling: number;
    textureGuid?: string;
    midpoint: number;
    channel: 0 | 1 | 2 | 3;
    weightmapInfluence: number;
  }>;
  smoothBlending: Readonly<{ innerDistanceM: number; outerDistanceM: number }>;
  terracing: Readonly<{
    alpha: number;
    spacingM: number;
    smoothness: number;
    maskLengthM: number;
    maskStartOffsetM: number;
  }>;
  weightSettings: readonly Readonly<{
    layerName: string;
    falloffWidthM: number;
    edgeOffsetM: number;
    modulationTextureGuid?: string;
    textureTiling: number;
    textureInfluence: number;
    midpoint: number;
    finalOpacity: number;
  }>[];
}>;
export type WaterBrushTerrainCapture = Readonly<{
  /** Finite, invertible affine Terrain-local-to-world transform; pixel bounds stay in Terrain-local XZ. */
  worldMatrixM: readonly number[];
  /** RT edge bounds in Terrain-local meters. Pixel centers are min + (pixel + 0.5) * extent / resolution; world pixel steps are derived through worldMatrixM. */
  boundsXZ: Readonly<{ minM: WaterVec2; maxM: WaterVec2 }>;
  resolutionPx: readonly [number, number];
  layerNameToIndex: Readonly<Record<string, number>>;
}>;
export type WaterBrushBodyActor = Readonly<{
  kind: 'body';
  /** Defaults to bodyGuid when omitted. */
  actorId?: string;
  fullName: string;
  /** Body sorting kind; `custom` uses transition priority (3). */
  bodyType: 'ocean' | 'lake' | 'river' | 'custom';
  bodyGuid: string;
  rules: WaterBrushActorRules;
}>;
export type WaterBrushIslandActor = {
  readonly kind: 'island';
  readonly actorId?: string;
  readonly fullName: string;
  readonly sourceKey: string;
  readonly heightOffsetM: number;
  readonly spline: {
    readonly closed: boolean;
    readonly points: readonly WaterSplineSourcePoint[];
    readonly metadataDefaults?: WaterSplineMetadataDefaults;
    readonly interpolationVersion?: WaterSplineInterpolationVersion;
  };
  readonly rules: WaterBrushActorRules;
};
/** Legacy source-key actor accepted only by the v0 migration path. */
export type WaterBrushLegacyIslandActor = Omit<
  WaterBrushIslandActor,
  'actorId' | 'fullName' | 'heightOffsetM' | 'rules'
> & {
  readonly actorId?: string;
  readonly fullName?: string;
  readonly heightOffsetM?: number;
  readonly rules?: WaterBrushActorRules;
  readonly terrainRules: {
    readonly falloffWidthM: number;
    readonly heightOffsetM: number;
    readonly weightLayer: string;
    readonly weightValue: number;
  };
};
export type WaterBrushLegacyActor = string | WaterBrushLegacyIslandActor;
export type WaterBrushActor = WaterBrushBodyActor | WaterBrushIslandActor | WaterBrushLegacyActor;
export type WaterBrushRecipeSource = {
  readonly kind: 'water-brush-recipe';
  /** 0 is the string/source-key actor format; 1 uses stable typed actor records. */
  readonly actorVersion?: 0 | 1;
  readonly baseTerrainGuid: string;
  readonly sourceBodyGuids: readonly string[];
  readonly orderedActors: readonly WaterBrushActor[];
  readonly curves: readonly string[];
  readonly textures: readonly string[];
  readonly outputTerrainSourceKey: string;
  readonly rules: WaterBrushRulesSource;
  readonly terrainCapture: WaterBrushTerrainCapture;
};
export type WaterBrushRecipeAsset = WaterBrushRecipeSource;

export type WaterFluidSimulationSource = {
  readonly system: 'fluid-simulation';
  readonly configurationVersion: 1;
  readonly solverMode: 'ripple' | 'shallow';
  readonly terrainMode: 'none' | 'constant-depth' | 'water-info';
  readonly resolution: readonly [number, number];
  readonly virtualFps: number;
  readonly maxStepsPerFrame: number;
  readonly gridExtentM: WaterVec2;
  /** Independent scalar WaveFoam capture domain; its live center belongs to the Scene instance. */
  readonly waveFoam: Readonly<{ resolution: number; gridExtentM: number }>;
  readonly targets: Readonly<Record<WaterFluidTarget, WaterFluidTargetSource>>;
  readonly injectionLimits: Readonly<{
    heightDeltaM: { readonly encodedRange: WaterVec2; readonly unit: 'm' };
    foamStrength: { readonly encodedRange: WaterVec2; readonly unit: 'unitless' };
  }>;
  /** Accepted queued/active impulses count toward capacity and survive disable or recipe edits. */
  readonly maxImpulses: number;
  /** Default impulse parent noise, resolved through the ordinary recipe asset closure. */
  readonly impulseNoiseGuid: string;
  readonly parameters: Readonly<{
    travelSpeed: number;
    rippleDamping: number;
    rippleFoamDamping: number;
    rippleFoamErasure: number;
    fluidDampingPerSecond: number;
    gravityMPerSecSquared: number;
    shallowEdgeLengthM: number;
    shallowFadingBackPerSecond: number;
    terrainUseWaterDepthOnly: number;
    shallowFoamFadePerSecond: number;
    shallowFoamInjection: number;
    shallowVelocityForFoamMPerSecond: number;
    shallowFoamSlopeMinimum: number;
    shallowFoamSlopeRange: number;
    shallowNormalHeightScale: number;
    constantWaterDepthM: number;
    evaporationMPerSecond: number;
    maskThreshold: number;
    /** Shallow output-normal parameters; Ripple uses its selected R-only material kernel. */
    normalHeightScale: number;
    normalDefaultDepthM: number;
    normalFoamAmount: number;
    normalFoamHeightScale: number;
    normalEdgeFalloff: number;
    waveNormalAmount: number;
    waveNormalBias: number;
    waveMinimumHeightM: number;
    waveHeightDivisorM: number;
    waveEdgeFalloff: number;
    waveTimeBiasSeconds: number;
    /** Applied once per outer frame, independently of fixed solver callback count. */
    foamFadePerFrame: number;
    foamDiffusion: number;
    foamEdgeFalloff: number;
    foamWetPerMeter: number;
    foamWetFadePerFrame: number;
    foamToneMapDensity: number;
  }>;
  readonly shallowFoamEnabled: boolean;
  readonly foamEnabled: boolean;
  /** Version 1 selects the built-in kernels; material overrides are unsupported. */
  readonly materialGuids: readonly [];
  /** Additional texture overrides are unsupported; impulseNoiseGuid is the consumed input. */
  readonly textureGuids: readonly [];
};
export type WaterFluidTarget =
  | 'height'
  | 'velocity'
  | 'normalHeight'
  | 'forces'
  | 'velocityForces'
  | 'wave'
  | 'foam';
export type WaterFluidTargetChannels =
  | 'ripple-height-m'
  /** R=depth m, G=bed m. After Divergence, B is the dimensionless source alias (100/m)*G, not world height. */
  | 'shallow-depth-bed-m'
  | 'velocity-xz-m/s'
  /** RG=tangent normal XZ. B=Ripple positive-X height m, or Shallow depth minus default depth m. */
  | 'normal-xz-height-m'
  /** R=height delta m, G=source numeric foam (cm-domain strength), B=0, A=1. */
  | 'height-foam-mask'
  | 'wave-foam'
  | 'foam';
export interface WaterFluidTargetSource {
  readonly format: 'rgba16float' | 'rgba32float' | 'rg32float' | 'rg16float';
  readonly filter: 'nearest' | 'linear';
  readonly address: 'clamp-to-edge' | 'repeat';
  readonly origin: 'top-left';
  readonly channels: WaterFluidTargetChannels;
  readonly clear: readonly [number, number, number, number];
}
export type WaterAdvancedStageProfile = 'water-body-shallow/2' | 'river-shallow/2';
export const WATER_ADVANCED_DEBUG_WRITER_ORDER = {
  'water-body-shallow/2': ['height-collider-speed', 'normal', 'cell-speed'],
  'river-shallow/2': ['depth-collider', 'water-info-speed', 'bottom-contour'],
} as const;
export type WaterAdvancedDebugWriter =
  | { readonly kind: 'height-collider-speed'; readonly speedMultiplier: number }
  | {
      readonly kind:
        | 'normal'
        | 'cell-speed'
        | 'depth-collider'
        | 'water-info-speed'
        | 'bottom-contour';
    };
export type WaterAdvancedTextureFormat = 'rgba16float' | 'rgba32float';
export type WaterDispersiveOceanConfig = {
  readonly algorithm: 'mode-projected-gravity/1';
  readonly fftResolution: number;
  readonly domainLengthM: number;
  readonly centerXZ: WaterVec2;
  readonly baseHeightM: number;
  /** Uniform linear-wave reference depth, not a varying Terrain depth. */
  readonly referenceDepthM: number;
  readonly gravityMPerSec2: number;
  /** Increasing surface-relative slab boundaries, from -referenceDepthM to zero. */
  readonly sourceSlabBoundariesM: readonly number[];
  readonly collisions: {
    readonly kind: 'simple' | 'distance-field';
    readonly collisionGroups: number;
    readonly maxElements: number;
    readonly fieldStepM: number;
    readonly maximumFieldSamplesPerColumn: number;
  };
  readonly maximumIntervalSeconds: number;
  /** Artistic gain for full-displacement entry waves and their buoyancy feedback. Default 1; surface transport is unchanged. */
  readonly entryWaveMultiplier?: number;
  /** Artistic gain for conservative surface-transport waves and their external buoyancy feedback. Finite nonnegative; default 1. */
  readonly surfaceTransportMultiplier?: number;
  /** Positive free-wave amplitude decay rate; exp(-rate * seconds), preserving mean displaced water. Default 0.35/s. */
  readonly waveDampingPerSecond?: number;
  readonly boundary:
    | { readonly kind: 'periodic' }
    | { readonly kind: 'absorbing'; readonly widthM: number; readonly dampingPerSecond: number };
  readonly foam: {
    readonly slopeThreshold: number;
    readonly emissionPerSecond: number;
    readonly decayPerSecond: number;
  };
  readonly normalRtFormat: WaterAdvancedTextureFormat;
  readonly gridMesh: null;
};
/** Authored input for the independent River material normal/height detail producer. */
export type WaterVisualNormalDetailFftConfig = Readonly<{
  readonly noiseTextureGuid: string;
  readonly fftResolution: number;
  readonly domainLengthM: number;
  readonly normalDomainSizeM: number;
  readonly gravityMPerSec2: number;
  readonly phillipsAmplitude: number;
  readonly windAngleDegrees: number;
  readonly windSpeedMPerSec: number;
  readonly windAlignment: number;
  readonly timeScale: number;
  readonly slosh: number;
  readonly normalRtFormat: WaterAdvancedTextureFormat;
}>;
export type WaterDispersiveOceanVisualConfig = WaterDispersiveOceanConfig &
  Readonly<{ readonly visualNormalDetailFft: WaterVisualNormalDetailFftConfig }>;
export type WaterAdvancedShallowStage =
  | 'Create Vertices'
  | 'Create Triangles'
  | 'Init'
  | 'Init Foam'
  | 'Pre Sim'
  | 'River Source and Sink'
  | 'Distribute Overlap Volume'
  | 'Extrapolate Velocities'
  | 'Advect Water'
  | 'Extrapolate Height'
  | 'Update Velocity'
  | 'Update Depth'
  | 'Post Sim'
  | 'Compute Normals'
  | 'Prep Debug'
  | 'Prep Debug Beauty'
  | 'Foam'
  | 'Live Sim - Blur Normals';

type WaterRiverBakeGridMetadataBase = Readonly<{
  readonly textureGuid: string;
  readonly sourceRecipeGuid: string;
  readonly sourceRecipeVersion: string;
  readonly sourceBodyGuid: string;
  readonly sourceBodyGeneration: number;
  readonly simulationGeneration: number;
  readonly sequence: number;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration: number;
  readonly width: number;
  readonly height: number;
  readonly originXZ: WaterVec2;
  readonly originYM: number;
  readonly spacingXZ: WaterVec2;
}>;

/** Original Bake lineage and lattice. It carries no cold-equivalence proof. */
export type WaterRiverBakeGridMetadataV1 = WaterRiverBakeGridMetadataBase &
  Readonly<{ readonly version: 'water-river-bake/1' }>;

/** Cold-load qualifications kept separate from the existing world-lattice mapping. */
export type WaterRiverBakeGridMetadataV2 = WaterRiverBakeGridMetadataBase &
  Readonly<{
    readonly version: 'water-river-bake/2';
    /** Required paired direct solver-normal texture in the Bake lattice. */
    readonly normalTextureGuid: string;
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

export type WaterRiverBakeGridMetadata =
  | WaterRiverBakeGridMetadataV1
  | WaterRiverBakeGridMetadataV2;

type WaterAdvancedSimulationBase = {
  readonly system: 'water-advanced';
  /** shallowFoam is an explicit Engine extension to the WaterBody source stage profile. */
  readonly enabledFeatures: readonly ('shallow' | 'shallowFoam' | 'riverBake' | 'oceanPatch')[];
  readonly shallowStageConfig?: {
    readonly stageProfile: WaterAdvancedStageProfile;
    readonly gridResolution: readonly [number, number];
    readonly extentM: WaterVec2;
    readonly baseHeightM: number;
    readonly initialDepthM: number;
    readonly gravityMPerSec2: number;
    readonly frictionPerSecond: number;
    readonly maximumVelocityMPerSec: number;
    readonly dryDepthM: number;
    readonly maximumDepthM: number;
    readonly keepWaterDepthInsideColliders: boolean;
    readonly distributeOverlapVolume: boolean;
    readonly advection: 'bilinear' | 'cubic';
    readonly advectionVelocityMultiplier: number;
    readonly velocityDissipationPerSecond: number;
    readonly complexUpwind: boolean;
    readonly upwind: boolean;
    readonly depthLimiter: boolean;
    /** SI m/s in integrationDepthMax * cellSizeM / (gravityMPerSec2 * deltaSeconds). */
    readonly integrationDepthMax: number;
    readonly thinFilmDepthM: number;
    readonly thinFilmDampingPerSecond: number;
    readonly edgeDissipationEnabled: boolean;
    readonly overlapRadiusCells: number;
    readonly overlapVolumeMultiplier: number;
    readonly collisionFalloff: number;
    /** Selects the native collision geometry capture path. */
    readonly rigidMeshCollisions:
      | { readonly kind: 'disabled' }
      | {
          readonly kind: 'simple' | 'distance-field';
          readonly accurate: boolean;
          readonly useWaterHeightForCollision: boolean;
          readonly collisionGroups: number;
          readonly collisionOffsetCells: number;
          readonly overlapThicknessCells: number;
          readonly softCollisionFalloffM: number;
          readonly maxElements: number;
        };
    readonly postSimVelocityBlurRadiusCells: number;
    readonly normalSmoothingRadiusCells: number;
    /** Authored minimum and maximum of the normal/foam output range. */
    readonly normalFoamRange: WaterVec2;
    /** Remaining lifetime, in seconds, over which depth-following height fades to its origin. */
    readonly startFadeSeconds: number;
    readonly runLiveSimulation: boolean;
    readonly followPawn: boolean;
    readonly waterInfoRequired: boolean;
    readonly foam: {
      readonly advectionVelocityMultiplier: number;
      readonly dissipationRatePerSecond: number;
      readonly dissipationSubtractionPerSecond: number;
      readonly minimum: number;
      readonly maximum: number;
      readonly emission: {
        readonly vorticity: { readonly range: WaterVec2; readonly multiplier: number };
        readonly curvature: { readonly range: WaterVec2; readonly multiplier: number };
        readonly speed: { readonly range: WaterVec2; readonly multiplier: number };
        readonly depthDifference: { readonly range: WaterVec2; readonly multiplier: number };
        readonly multiplier: number;
        readonly maximum: number;
        readonly depthRestrictionRangeM: WaterVec2;
        readonly speedRestrictionRangeMPerSec: WaterVec2;
      };
    };
    readonly debug: {
      readonly enabled: boolean;
      readonly writers: readonly WaterAdvancedDebugWriter[];
      /** Independent River Foam writer gate; does not use Prep Debug's enabled gate. */
      readonly foamEmission: boolean;
    };
    readonly beautyEnabled: boolean;
    readonly materialGuids: readonly string[];
    readonly normalRtFormat: WaterAdvancedTextureFormat;
  };
  readonly substepConfig?: {
    readonly numSteps: number;
    readonly simSpeed: number;
    readonly timeStepSource: 'frame-delta';
    /** Running shallow simulations require a positive authored application cap. */
    readonly deltaLimit:
      | { readonly kind: 'source-default' }
      | { readonly kind: 'application-cap'; readonly maximumDeltaSeconds: number };
  };
  readonly riverBakeConfig?: {
    readonly sourceBodyGuid: string;
    readonly outputSourceKey: string;
    readonly bakeExtentM: WaterVec2;
    readonly queryFootprint: readonly WaterVec2[];
    readonly bakedGrid?: WaterRiverBakeGridMetadata;
  };
  readonly materialGuids: readonly string[];
  readonly textureGuids: readonly string[];
};
type WaterSpectrumOceanConfig = Readonly<{
  readonly algorithm: 'ocean-spectrum-fft/2';
  readonly windAngleDegrees: number;
  readonly windSpeedMPerSec: number;
  readonly noiseTextureGuid: string;
  readonly fftResolution: number;
  readonly domainLengthM: number;
  readonly normalDomainSizeM: number;
  readonly gravityMPerSec2: number;
  /** Spectral amplitude in m squared; the source kernel's cm convention is internal. */
  readonly phillipsAmplitude: number;
  readonly windAlignment: number;
  readonly timeScale: number;
  readonly slosh: number;
  readonly chopHack: number;
  readonly twiddle: 'positive';
  readonly normalization: 'none';
  readonly normalRtFormat: WaterAdvancedTextureFormat;
  /** Flat centered grid producer only; the source vertex graph has no FFT height input. */
  readonly gridMesh: { readonly extentM: WaterVec2 } | null;
}>;
/** Version 1 supports mode-projected residual waves and standalone spectral FFT. */
export type WaterAdvancedSimulationV1Source = WaterAdvancedSimulationBase &
  Readonly<{
    readonly configurationVersion: 1;
    readonly oceanPatchConfig?: WaterDispersiveOceanConfig | WaterSpectrumOceanConfig;
  }>;
/** Version 2 opts the mode-projected World owner into its independent visual FFT child. */
export type WaterAdvancedSimulationV2Source = WaterAdvancedSimulationBase &
  Readonly<{
    readonly configurationVersion: 2;
    readonly oceanPatchConfig: WaterDispersiveOceanVisualConfig;
  }>;
export type WaterAdvancedSimulationSource =
  | WaterAdvancedSimulationV1Source
  | WaterAdvancedSimulationV2Source;
export type WaterSimulationRecipeSource = { readonly kind: 'water-simulation-recipe' } & (
  | WaterFluidSimulationSource
  | WaterAdvancedSimulationSource
);
export type WaterSimulationRecipeAsset = WaterSimulationRecipeSource;
