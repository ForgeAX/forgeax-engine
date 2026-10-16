// @forgeax/engine-runtime — PointLightShadow (omnidirectional point-light
// shadow mapping parameters; cube-array atlas variant).
//
// Schema: 6 f32 columns — mapSize (u32, stored as f32), depthBias, normalBias,
// nearPlane, farPlane, pcfKernelSize (u32, stored as f32). No fixed-extent
// field — cube map uses fov=90 perspective, not ortho.
//
// Atlas capacity is a renderer policy; ECS does not enforce a component
// cardinality bound.
// Co-located with DirectionalLight in components/ (research L1.2).
//
// Naming convention: bare entity name (AGENTS.md §Component naming), no
// Component suffix. Same defineComponent pattern and ShadowInvalidConfigError
// surface as the shadow fields merged into DirectionalLight (feat-20260621 M1).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Omnidirectional point-light shadow mapping parameters.
 *
 * The renderer may batch this component into a bounded atlas, but the ECS
 * component remains a plain storage schema and carries no cardinality policy.
 *
 * Receiver bias follows Bevy's point-light convention and is scale-invariant:
 * `depthBias` moves the receiver toward the light in world units, and
 * `normalBias` offsets it along its normal by that many cube texels at the
 * receiver's distance. Defaults match Bevy (0.08 / 0.6).
 *
 * @example Spawn a point light with default shadow config:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 4, 0] } },
 *     { component: PointLight, data: { range: 25 } },
 *     { component: PointLightShadow, data: {} }, // 6 fields filled from defaults
 *   );
 *
 * @example Spawn with explicit map size and bias:
 *   world.spawn(
 *     { component: PointLightShadow, data: { mapSize: 1024, depthBias: 0.01 } },
 *   );
 */
export const PointLightShadow = defineComponent('PointLightShadow', {
  mapSize: { type: 'f32', default: 512 },
  depthBias: { type: 'f32', default: 0.08 },
  normalBias: { type: 'f32', default: 0.6 },
  nearPlane: { type: 'f32', default: 0.1 },
  farPlane: { type: 'f32', default: 25 },
  pcfKernelSize: { type: 'f32', default: 3 },
});
