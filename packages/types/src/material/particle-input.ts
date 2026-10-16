/**
 * Material-side particle input metadata.
 *
 * The shader/compiler boundary owns the authored declaration and the VFX
 * compiler only matches names against it. Keeping this POD in types avoids a
 * second copy between the cooked artifact and build-time reflection.
 */
export type MaterialParticleInputType = 'f32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>';

export type MaterialParticleInputVisibility = 'vertex' | 'fragment' | 'vertex-fragment';

export interface MaterialParticleInput {
  readonly name: string;
  readonly type: MaterialParticleInputType;
  readonly visibility: MaterialParticleInputVisibility;
  /** One vec4-equivalent lane in the renderer/material bridge. */
  readonly lane: number;
}
