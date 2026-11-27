// @forgeax/engine-vfx - runtime-safe code-first GPU VFX contract.

export type {
  ParticleEffectAsset,
  ParticleEffectAssetV3,
  ParticleEffectProgramV3,
  ParticleEmitterDefinition,
} from '@forgeax/engine-types';
export type {
  VfxAuthoringCapabilityDescriptor,
  VfxAuthoringDependencyDescriptor,
  VfxAuthoringDescriptor,
  VfxAuthoringEmitterDescriptor,
  VfxAuthoringFieldDescriptor,
  VfxAuthoringNodeDescriptor,
  VfxAuthoringNodeRole,
  VfxAuthoringTimelineDescriptor,
  VfxAuthoringValue,
} from './authoring-descriptor.js';
export { describeVfxGpuEffect, isVfxGpuEffectAsset } from './authoring-descriptor.js';
export type {
  ParticleBoundsSource,
  ParticleChannelOverflowPolicy,
  ParticleChannelSource,
  ParticleCodeSourceError,
  ParticleCodeSourceInvalidDetail,
  ParticleEventSource,
  ParticleRendererOverflowPolicy,
  ParticleStageDomain,
  ParticleStageResourceAccess,
  ParticleStageResourceSource,
  ParticleStageSource,
} from './code-source.js';
export {
  PARTICLE_CODE_DEFAULT_MODULE_ID,
  PARTICLE_MANAGED_STAGE_IDS,
  PARTICLE_STAGE_RESOURCE_NAMES,
  parseVfxStageDeclarations,
} from './code-source.js';
export type {
  ParticleAttributeRef,
  ParticleEffectParameterSourceV3,
  ParticleEffectSourceV3,
  ParticleEmitterSourceV3,
  ParticleRendererSemantic,
  ParticleRendererSemanticMap,
  ParticleRendererSortingV3,
  ParticleRendererSourceV3,
  ParticleTopologyRendererSourceV3,
  ParticleWaterGridCriterionSource,
  ParticleWaterGridEmissionSource,
} from './code-source-v3.js';
export {
  defaultParticleRendererAttributes,
  defineParticleEffectSourceV3,
  isParticleRendererSortingV3,
  isParticleTopologyRenderer,
  PARTICLE_RENDERER_SEMANTICS,
  parseParticleEffectSourceV3,
  VFX_PARAMETER_MAX,
  VFX_PARAMETER_NAME,
} from './code-source-v3.js';
export type {
  VfxDataInterfaceBindingType,
  VfxDataInterfaceCaptureContext,
  VfxDataInterfaceError,
  VfxDataInterfaceErrorDetail,
  VfxDataInterfaceKind,
  VfxDataInterfaceLifetime,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRecoveryLease,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
  VfxDataInterfaceResource,
  VfxDataInterfaceTextureView,
  VfxDataInterfaceToken,
  VfxWaterSurfaceIdentity,
} from './data-interface.js';
export { resolveVfxDataInterfaces } from './data-interface.js';
export type {
  VfxEffectContract,
  VfxEffectContractError,
  VfxEffectContractErrorDetail,
  VfxEffectReflection,
  VfxReflectedField,
  VfxReflectedStruct,
  VfxValue,
  VfxValueMap,
  VfxValueType,
} from './effect-contract.js';
export { createVfxEffectContract, vfxValueMatches } from './effect-contract.js';
export type { VfxForceField, VfxForceFieldError } from './force-fields.js';
export {
  isVfxFieldTransform,
  VFX_FORCE_FIELD_BYTES_LIMIT,
  VFX_FORCE_FIELD_LIMIT,
  VFX_VECTOR_FIELD_RESOLUTION_LIMIT,
  validateVfxForceFields,
  vfxForceFieldFailure,
} from './force-fields.js';
export {
  acquireVfxGpuEventChannel,
  createVfxGpuEventOutput,
  VFX_GPU_EVENT_OUTPUT,
  VFX_GPU_OUTPUT_CHANNELS,
  VFX_GPU_OUTPUT_HEADER_BYTES,
  type VfxGpuEventOutput,
  type VfxGpuOutputChannel,
  type VfxGpuOutputEvent,
} from './gpu-event-output';
export type { VfxGpuAssetError } from './gpu-loader.js';
export {
  loadVfxGpuEffect,
  particleEffectContribution,
  prepareVfxGpuEffect,
} from './gpu-loader.js';
export type {
  VfxGpuEffectAsset,
  VfxGpuEmitterProgram,
  VfxGpuInstanceComputeProgram,
  VfxGpuProgram,
  VfxGpuProgramReflection,
  VfxGpuRendererReflection,
  VfxGpuStageReflection,
} from './gpu-program.js';
export {
  VFX_GPU_PROGRAM_ARTIFACT_KEY,
  VFX_GPU_PROGRAM_FORMAT,
} from './gpu-program.js';
export { VfxGpuUpdate } from './gpu-runtime';
export type {
  VfxGpuEmitterInspectSnapshot,
  VfxGpuEmitterSource,
  VfxGpuPlayerInspectSnapshot,
  VfxGpuRecoveryContext,
  VfxGpuRuntimeDiagnostic,
  VfxGpuRuntimeOptions,
  VfxGpuTickIntent,
} from './gpu-runtime.js';
export {
  buildVfxRecoveryIntents,
  createVfxInspectSnapshot,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from './gpu-runtime.js';
export {
  type GpuSlotAllocatorSource,
  type GpuSlotAllocatorSourceError,
  parseGpuSlotAllocatorSource,
} from './gpu-slot-allocator-source';
export type {
  VfxChannelCounters,
  VfxChannelInput,
  VfxChannelPayload,
  VfxInstanceCommit,
  VfxInstanceCommitOptions,
  VfxInstanceError,
  VfxInstanceOptions,
  VfxInstanceParent,
  VfxReplayInput,
} from './instance.js';
export {
  createParticleEffectInstance,
  ParticleEffectInstance,
} from './instance.js';
export type {
  VfxCustomLayout,
  VfxParticleCoreAttribute,
  VfxParticleCoreField,
  VfxParticleCoreLayout,
} from './particle-layout.js';
export {
  deriveVfxCustomLayout,
  VFX_PARTICLE_CORE_LAYOUT,
  VFX_PARTICLE_CORE_STRIDE,
  vfxParticleCoreField,
} from './particle-layout.js';
export type { ParticleEffectPlayerData } from './player.js';
export { ParticleEffectPlayer, ParticleEffectWorldBounds, vfxPlayerParameters } from './player.js';
export type { VfxPlayerParametersError } from './player-parameters.js';
export { validateVfxPlayerParameters } from './player-parameters.js';
export {
  exactVfxRecoveryInputs,
  requiresExactVfxRecovery,
  type VfxGpuRecoveryError,
} from './recovery-input-history.js';
export type { VfxStructuredInputBank } from './structured-input.js';
export {
  createVfxStructuredInputBank,
  isVfxStructuredInputData,
  VFX_STRUCTURED_INPUT_BYTES_LIMIT,
} from './structured-input.js';
