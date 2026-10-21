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
 * `pcfKernelSize` selects the Vogel footprint diameter: 3 uses five
 * samples at radius one texel, 5 uses radius two, and 1 uses hardware PCF.
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
  shadowProjection: { type: 'enum', labels: { light: 0, fixed: 1 }, default: 0 },
  shadowPosition: { type: 'array<f32, 3>' },
  shadowCasterChannels: { type: 'f64', default: 0xffffffff },
  shadowAutoUpdate: { type: 'bool', default: true },
  shadowRevision: { type: 'f64', default: 0 },
  mapSize: { type: 'f32', default: 512 },
  depthBias: { type: 'f32', default: 0.08 },
  normalBias: { type: 'f32', default: 0.6 },
  nearPlane: { type: 'f32', default: 0.5 },
  // Finite positive light.range overrides this fallback, as in Three r184.
  farPlane: { type: 'f32', default: 500 },
  pcfKernelSize: { type: 'f32', default: 3 },
  shadowFilter: { type: 'enum', labels: { basic: 1, pcfVogel: 6 }, default: 6 },
  shadowBiasMode: { type: 'enum', labels: { cubeTexel: 0, constant: 1 }, default: 0 },
  shadowIntensity: { type: 'f32', default: 1 },
});
