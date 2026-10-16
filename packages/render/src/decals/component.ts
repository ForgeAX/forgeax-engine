import { defineComponent } from '@forgeax/engine-ecs';

/** Transform maps the unit projection box to world space; +Z faces the receiver normal. */
export const ProjectedDecal = defineComponent('ProjectedDecal', {
  material: { type: 'shared<MaterialAsset>' },
  order: { type: 'i32', default: 0 },
  opacity: { type: 'f32', default: 1 },
  normalThreshold: { type: 'f32', default: 0 },
  colorOpacity: { type: 'f32', default: 1 },
  normalOpacity: { type: 'f32', default: 1 },
  roughnessOpacity: { type: 'f32', default: 1 },
});

export class ProjectedDecalInvalidError extends Error {
  readonly code = 'projected-decal-invalid' as const;
  readonly hint =
    'repair the named ProjectedDecal input; use Standard Deferred with single-sample depth';
  readonly detail: { readonly field: string };
  constructor(
    field: string,
    readonly expected: string,
  ) {
    super(`Invalid ProjectedDecal ${field}: expected ${expected}`);
    this.name = 'ProjectedDecalInvalidError';
    this.detail = { field };
  }
}
