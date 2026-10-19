// @forgeax/engine-render - ScreenSpaceReflection authoring component.
//
// The component is an opt-in camera effect. It carries only the three
// bounded authoring values; all graph, resource, history, and backend state
// remains renderer-owned.

import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';

/**
 * Schema-derived ScreenSpaceReflection authoring data.
 *
 * Distances follow Three r184 SSRNode (metres). Values are validated against the active camera
 * view range before a spatial candidate is admitted.
 */
export const ScreenSpaceReflection = defineComponent('ScreenSpaceReflection', {
  maxDistance: { type: 'f32', default: 1 },
  thickness: { type: 'f32', default: 0.1 },
  maxRoughness: { type: 'f32', default: 1 },
});

export type ScreenSpaceReflectionData = ShapeOf<SchemaOf<typeof ScreenSpaceReflection>>;
