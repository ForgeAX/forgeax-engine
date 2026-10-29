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
  ParticleEffectSourceV3,
  ParticleEmitterSourceV3,
  ParticleRendererSemantic,
  ParticleRendererSemanticMap,
  ParticleRendererSortingV3,
  ParticleRendererSourceV3,
  ParticleTopologyRendererSourceV3,
} from './code-source-v3.js';
export {
  defaultParticleRendererAttributes,
  defineParticleEffectSourceV3,
  isParticleRendererSortingV3,
  isParticleTopologyRenderer,
  PARTICLE_RENDERER_SEMANTICS,
  parseParticleEffectSourceV3,
} from './code-source-v3.js';
export type {
  VfxDataInterfaceBindingType,
  VfxDataInterfaceError,
  VfxDataInterfaceErrorDetail,
  VfxDataInterfaceKind,
  VfxDataInterfaceLifetime,
  VfxDataInterfaceProvider,
  VfxDataInterfaceRequirement,
  VfxDataInterfaceResolution,
  VfxDataInterfaceResource,
  VfxDataInterfaceToken,
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
export { createVfxEffectContract } from './effect-contract.js';
export type { VfxForceField, VfxForceFieldError } from './force-fields.js';
export {
  isVfxFieldTransform,
  VFX_FORCE_FIELD_BYTES_LIMIT,
  VFX_FORCE_FIELD_LIMIT,
  VFX_VECTOR_FIELD_RESOLUTION_LIMIT,
  validateVfxForceFields,
  vfxForceFieldFailure,
} from './force-fields.js';
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
export type {
  VfxGpuEmitterInspectSnapshot,
  VfxGpuEmitterSource,
  VfxGpuPlayerInspectSnapshot,
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
export { ParticleEffectPlayer } from './player.js';
