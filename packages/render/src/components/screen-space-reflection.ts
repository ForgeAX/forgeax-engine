// @forgeax/engine-render - ScreenSpaceReflection authoring component.
//
// The component is an opt-in camera effect. It carries only the three
// bounded authoring values; all graph, resource, history, and backend state
// remains renderer-owned.

import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/**
 * Schema-derived ScreenSpaceReflection authoring data.
 *
 * The defaults are conservative and are validated against the active camera
 * view range before a spatial candidate is admitted.
 */
export const ScreenSpaceReflection = defineComponent('ScreenSpaceReflection', {
  maxDistance: { type: 'f32', default: 40 },
  thickness: { type: 'f32', default: 0.2 },
  maxRoughness: { type: 'f32', default: 0.6 },
});

export type ScreenSpaceReflectionData = ShapeOf<SchemaOf<typeof ScreenSpaceReflection>>;
