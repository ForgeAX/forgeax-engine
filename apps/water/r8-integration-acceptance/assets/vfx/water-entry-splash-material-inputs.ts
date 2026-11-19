import type { MaterialParticleInput } from '@forgeax/engine-types';

/** One source-owned declaration shared by the material and its Program cook. */
export const WATER_ENTRY_SPLASH_MATERIAL_PARTICLE_INPUTS = Object.freeze([
  { name: 'subsurfaceGainOpacity', type: 'vec4<f32>', visibility: 'fragment', lane: 0 },
  { name: 'waterSphereShading', type: 'vec4<f32>', visibility: 'fragment', lane: 1 },
  { name: 'waterSphereFlattenSphere', type: 'vec4<f32>', visibility: 'fragment', lane: 2 },
  { name: 'waterSphereProjection', type: 'vec4<f32>', visibility: 'fragment', lane: 3 },
] satisfies readonly MaterialParticleInput[]);
