// @forgeax/engine-vfx-compiler - build-time code-first VFX compiler.

export type {
  ParticleAttributeRef,
  ParticleEffectSourceV3,
  ParticleEmitterSourceV3,
  ParticleRendererSemantic,
  ParticleRendererSemanticMap,
  ParticleRendererSortingV3,
  ParticleRendererSourceV3,
} from '@forgeax/engine-vfx';
export type {
  ParticleCodeCompileError,
  ParticleCodeCookError,
  ParticleCodeCookProduct,
  ParticleCodeCookSource,
  ParticleCodeEffectPayload,
  ParticleCodeModuleSet,
  ParticleCodeNativeCookInput,
  ParticleCodeProgram,
  ParticleCodeProgramArtifact,
  ParticleMaterialInputCatalog,
} from './code-program.js';
export {
  cookParticleCodeEffect,
  cookParticleCodeProgram,
  createParticleCodeNativeCooker,
  createParticleCodeNativeCookerFromRoots,
  PARTICLE_CODE_DEFAULT_MODULE,
  PARTICLE_CODE_PRELUDE,
  PARTICLE_CODE_PRELUDE_MODULE_ID,
  PARTICLE_CODE_PROGRAM_ARTIFACT_KEY,
  PARTICLE_CODE_PROGRAM_FORMAT,
  PARTICLE_MANAGED_RUNTIME_V3,
} from './code-program.js';
export { createVfxVectorFieldTexture } from './force-fields.js';
export type {
  ParticleManagedStagePlan,
  ParticleStagePlanError,
} from './managed-program.js';
export {
  buildParticleStagePlan,
  createParticleStageManagedRuntime,
  PARTICLE_EVENT_MANAGED_RUNTIME,
} from './managed-program.js';
export type {
  ParticleRendererReflection,
  VfxReflectionError,
  VfxReflectionErrorDetail,
  VfxReflectionInput,
} from './reflection.js';
export {
  reflectVfxLayout,
  reflectVfxRenderer,
  reflectVfxRendererV3,
} from './reflection.js';
