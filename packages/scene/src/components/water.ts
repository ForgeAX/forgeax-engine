import { defineComponent } from '@forgeax/engine-ecs';
import { WATER_BUOYANCY_DEFAULTS as B } from '@forgeax/engine-types';

/** Scene bindings keep stable asset identity; all vector fields use m/Y-up. */
export const WaterBodyInstance = defineComponent('WaterBodyInstance', {
  body: 'asset<water-body>',
});

export const WaterZoneInstance = defineComponent('WaterZoneInstance', {
  zone: 'asset<water-zone>',
});

/** The entity transform supplies the axis-aligned moving world-space grid center. */
export const WaterFluidSimulation = defineComponent('WaterFluidSimulation', {
  recipe: 'asset<water-simulation-recipe>',
  body: 'entity',
  /** Explicit world-space WaveFoam center, independent of the solver entity transform. */
  waveFoamCenterM: { type: 'array<f32, 3>' },
  enabled: { type: 'bool', default: true },
  /** Bump to discard submitted visual history and accepted active impulses. */
  resetRevision: { type: 'u32', default: 0 },
});

export const WaterTerrainProvider = defineComponent('WaterTerrainProvider', {
  terrain: 'asset<terrain>',
});

/** Visual-only sphere contacts, independent of force-producing buoyancy pontoons. */
export const WaterContactProbeSet = defineComponent('WaterContactProbeSet', {
  body: 'entity',
  enabled: { type: 'bool', default: true },
  centersM: { type: 'array<f32>' },
  /** World-metre radii; the entity's affine transform applies only to centers. */
  radiiM: { type: 'array<f32>' },
  /** Coverage at a confirmed intersection, including a stationary waterline. */
  contactCoverage: { type: 'f32', default: 0.45 },
});

/** Explicit participation in authored shallow rigid-mesh fields. */
export const WaterDispersiveMotion = { fullDisplacement: 0, surfaceTransport: 1 } as const;

export const WaterShallowCollider = defineComponent('WaterShallowCollider', {
  enabled: { type: 'bool', default: true },
  /** The gravity-wave source uses full entry displacement or facing-boundary transport flux. */
  dispersiveMotion: {
    type: 'enum',
    default: WaterDispersiveMotion.fullDisplacement,
    labels: WaterDispersiveMotion,
  },
});

export type WaterExclusionModeName =
  | 'addListedBodiesToExclusion'
  | 'removeListedBodiesFromExclusion';
export const WaterExclusionMode = {
  addListedBodiesToExclusion: 0,
  removeListedBodiesFromExclusion: 1,
} as const satisfies Record<WaterExclusionModeName, number>;

export const WaterExclusionVolume = defineComponent('WaterExclusionVolume', {
  mode: {
    type: 'enum',
    default: WaterExclusionMode.removeListedBodiesFromExclusion,
    labels: WaterExclusionMode,
  },
  /** `array<entity>` binds SceneEntity keys / sceneEntity references at instance creation. */
  waterBodies: 'array<entity>',
  centerM: { type: 'array<f32, 3>' },
  halfExtentsM: { type: 'array<f32, 3>' },
});

export const WaterPontoonSet = defineComponent('WaterPontoonSet', {
  configurationVersion: { type: 'u32', default: 1 },
  enabled: { type: 'bool', default: true },
  useAsyncPath: { type: 'bool', default: false },
  /** One authority per set: relative centers, or socket entities plus world offsets. */
  anchorMode: { type: 'enum', default: 0, labels: { relative: 0, socket: 1 } },
  anchorsM: { type: 'array<f32>' },
  socketEntities: { type: 'array<entity>' },
  radiiM: { type: 'array<f32>' },
  enabledPontoons: { type: 'array<u8>' },
  overlapFilterMask: { type: 'u32', default: 0xffffffff },
  buoyancyCoefficientNPerM3: { type: 'f32', default: B.buoyancyCoefficientNPerM3 },
  dampingNPerMps: { type: 'f32', default: B.dampingNPerMps },
  dampingNPerMpsSquared: { type: 'f32', default: B.dampingNPerMpsSquared },
  rampMinSpeedMps: { type: 'f32', default: B.rampMinSpeedMps },
  rampMaxSpeedMps: { type: 'f32', default: B.rampMaxSpeedMps },
  rampMax: { type: 'f32', default: B.rampMax },
  maxBuoyantForceN: { type: 'f32', default: B.maxBuoyantForceN },
  centerPontoonsOnCOM: { type: 'bool', default: B.centerPontoonsOnCOM },
  riverVelocityStrength: { type: 'f32', default: B.riverVelocityStrength },
  riverShoreFactor: { type: 'f32', default: B.riverShoreFactor },
  maxRiverAccelerationMps2: { type: 'f32', default: B.maxRiverAccelerationMps2 },
  riverTraversalPathWidthM: { type: 'f32', default: B.riverTraversalPathWidthM },
  maxLateralAccelerationMps2: { type: 'f32', default: B.maxLateralAccelerationMps2 },
  allowFastUpstream: { type: 'bool', default: B.allowFastUpstream },
  alwaysAllowLateralPush: { type: 'bool', default: B.alwaysAllowLateralPush },
  velocityPontoonIndex: { type: 'u32', default: B.velocityPontoonIndex },
  applyRiverForces: { type: 'bool', default: B.applyRiverForces },
  applyDrag: { type: 'bool', default: B.applyDrag },
  linearDragCoefficient: { type: 'f32', default: B.linearDragCoefficient },
  quadraticDragCoefficient: { type: 'f32', default: B.quadraticDragCoefficient },
  maxDragSpeedMps: { type: 'f32', default: B.maxDragSpeedMps },
  angularDragPerSecond: { type: 'f32', default: B.angularDragPerSecond },
});
