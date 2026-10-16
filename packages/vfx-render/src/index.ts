// @forgeax/engine-vfx-render - GPU particle execution and rendering.

export type { ParticleRenderCamera, ParticleRenderCameraSource } from './feature/camera.js';
export {
  encodeEventBuffer,
  encodeEventInputs,
  eventCapacity,
  eventCounterData,
  eventInputCapacity,
  VFX_EVENT_BYTES,
  VFX_EVENT_COUNTER_BYTES,
  VFX_EVENT_INPUT_BYTES,
} from './feature/event-resources.js';
export type { VfxRenderObservation } from './feature/gpu-particle-feature.js';
export {
  createVfxRenderInspectSnapshot,
  gpuParticleRenderFeature,
  resolveBillboardAdvancedState,
  topologyRecoveryHint,
} from './feature/gpu-particle-feature.js';
export type {
  ParticleMaterialInputPreparationError,
  PreparedParticleMaterialInputs,
} from './feature/particle-resources.js';
export {
  createTopologyResourcePlan,
  PARTICLE_INPUT_SHADER_IDENTIFIERS,
  PARTICLE_SHADER_IDENTIFIERS,
  prepareParticleMaterialInputs,
  topologyCapacitySnapshot,
} from './feature/particle-resources.js';
export type {
  VfxStagePlanError,
  VfxStagePlanObservation,
  VfxStageReadiness,
  VfxStageRecovery,
  VfxValidatedStagePlan,
} from './feature/stage-plan.js';
export {
  observeStagePlan,
  stageDispatches,
  stageRecoveryReadiness,
  validatedStagePlan,
} from './feature/stage-plan.js';
export type {
  VfxDataInterfaceAvailabilitySource,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRegistry,
} from './host/data-interface-providers.js';
export {
  createCameraProvider,
  createNoiseProvider,
  createSceneDepthProvider,
  createVfxDataInterfaceRegistry,
} from './host/data-interface-providers.js';
export type {
  VfxAuthoringAssetRegistry,
  VfxRuntimeHost,
  VfxRuntimeHostControl,
  VfxRuntimeHostControlError,
  VfxRuntimeHostError,
  VfxRuntimeHostInspectSnapshot,
  VfxRuntimeHostOptions,
} from './host/vfx-runtime-host.js';
export { createVfxRuntimeHost, installVfxRuntimeDecoder } from './host/vfx-runtime-host.js';
