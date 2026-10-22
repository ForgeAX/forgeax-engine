// @forgeax/engine-render - DirectionalLight (directional light parameters
// with merged shadow config).
//
// Schema: direction array<f32,3> + color array<f32,3> + intensity f32 + 1 bool
// castShadow + 8 f32 shadow columns (feat-20260709 M2: direction/color collapsed
// from 6 per-axis scalar columns to two inline array<f32,3> columns).
//
// Direction (xyz, outgoing) + color (rgb, linear space) + intensity in lux.
// No Transform dependency (directional lights have no position).
// The public world-unit convention is 1 world unit = 1 meter. Exposure is a
// camera output concern and is not folded into this light's intensity.
//
// 0 DirectionalLight + standard material -> physically correct black render
// (charter v2 P3/P4); details: AGENTS.md section Breaking changes 2026-05-18.
//
// Naming convention: bare entity name aligned with Bevy ECS conventions
// (feat-20260513-component-naming-bevy-align). Camera / Transform / etc.
// follow the same single-semantic-entity rule (charter proposition 5).
//
// charter mapping: proposition 1 (single import) + proposition 3 (silent
// failure -> explicit warning; first-frame warn) + proposition 5 (consistent
// abstraction: lighting parameters mirror GPU-side pbr.wgsl @group(0) view
// BG light fields).
//
// feat-20260621-merge-directionallightshadow-into-directionallight M1:
// DirectionalLightShadow's 9 shadow fields are merged into DirectionalLight
// to collapse the dual-component spawn into a single component (D-6 primary
// decision). castShadow defaults to false; set castShadow=true to request shadows. D-6 directional stays
// first-hit-wins -- no ECS cardinality cap. Renderer allocation policy stays
// with the shadow atlas owner.

import { defineComponent } from '@forgeax/engine-ecs';
import { DirectionalShadowFilterValue } from './directional-shadow-filter';
import { LIGHTING_CHANNELS_DEFAULT } from './lighting-channels';

export {
  type DirectionalShadowFilterLabel,
  DirectionalShadowFilterValue,
  type DirectionalShadowQuality,
  directionalShadowQualityFromF32,
} from './directional-shadow-filter';

/**
 * Directional light (sun-like infinite light source) with merged shadow
 * parameters.
 *
 * `direction` @semantics outgoing — points FROM light source TO surface
 * (opposite of Three.js convention; the shader internally negates this
 * vector to obtain the L vector for BRDF evaluation). `color` is
 * linear-space rgb in [0, 1] per channel and `intensity` is lux. Exposure is
 * applied after lighting by the camera output stage; no hidden light
 * multiplier is applied here.
 *
 * castShadow defaults to false. Set castShadow: true to request cascaded shadow
 * maps (shadow fields are still stored when disabled but their
 * validation is skipped).
 *
 * Shadow fields (migrated from DirectionalLightShadow, feat-20260621 M1):
 *   cascadeCount   ∈ {1,2,3,4}  — number of cascades (default 3)
 *   splitLambda    ∈ [0,1]      — PSSM split weight (default 0.5)
 *   cascadeBlend   ∈ [0,0.5]    — blend width between cascades (default 0.2)
 *   mapSize        >= 1         — shadow map resolution (default 2048)
 *   depthBias                    — normalized receiver depth floor (default 0.00001),
 *                                  plus automatic texel/filter/slope coverage
 *   normalBias                   — world-space receiver normal offset (default 0.05)
 *   shadowDistance > 0           — how far shadows reach in front of the camera,
 *                                  in world units (default 200, capped by camera far). This is the sole
 *                                  coverage knob: the CSM cascades are PSSM-split
 *                                  across [camera near, min(camera far, shadowDistance)] and each
 *                                  cascade's orthographic bounds are fit to the
 *                                  camera frustum slice automatically, with
 *                                  the same distance of caster reach toward
 *                                  the light beyond each slice. The near
 *                                  end is derived from the active camera's near
 *                                  plane (no separate near knob — any value other
 *                                  than the camera near either drops near shadows
 *                                  or wastes cascade-0 resolution).
 *   shadowFilter   ∈ {pcf1, pcf3, pcf5, pcssMedium, pcssHigh, pcfVogel} — closed filter profile (default pcfVogel)
 *   shadowAngularRadius ∈ [0.0001, 0.05] radians — PCSS angular light radius (default 0.00465)
 *   maxPenumbraTexels ∈ [1, 64], finite integer — PCSS search/filter cap (default 32)
 *
 * staggerCascades (bool, default false) opts into CPU shadow cadence: cascade 0
 * refreshes on every content miss, cascade c > 0 every 2^c submitted frames.
 * An unchanged far projection may retain dynamic casters for at most 2^c - 1
 * frames. Projection or source/resource invalidation refreshes immediately;
 * settled stale layers flush on the next clean frame. GPU view pools and
 * unproven lease-less recording keep their existing cache policy.
 *
 * staticShadowCache (bool, default true) retains settled casters in a cached
 * static layer per cascade. Disable for scenes whose static casters change
 * constantly (heavy destruction), where the extra per-view pass costs more
 * than it saves: each cascade then rasters every caster in one pass.
 *
 * contactShadowLength (meters, finite, >= 0, default 0 = off) enables
 * screen-space contact shadows for this light: a short depth-buffer ray march
 * toward the light that darkens small-scale occlusion the shadow map cannot
 * resolve (grass blades, pebbles, feet on the ground). It is independent of
 * castShadow, so geometry excluded from shadow maps still self-shadows.
 * Deferred-path only; forward-lit surfaces ignore it. Typical values: 0.1-0.5.
 *
 * @example Spawn a single directional light without shadow maps:
 *   world.spawn({ component: DirectionalLight, data: {
 *     direction: [-0.5, -1, -0.3], // [x, y, z]
 *     color: [1, 1, 1], // [r, g, b]
 *     intensity: 1,
 *   } });
 *
 * @example Opt out of shadows:
 *   world.spawn({ component: DirectionalLight, data: {
 *     direction: [0, -1, 0], // [x, y, z]
 *     castShadow: false,
 *   } });
 *
 * @example Explicit shadow config (single-component spawn):
 *   world.spawn({ component: DirectionalLight, data: {
 *     direction: [0.2, -0.98, 0], // [x, y, z]
 *     color: [1, 1, 1], intensity: 1, // color is [r, g, b]
 *     cascadeCount: 3, splitLambda: 0.5, cascadeBlend: 0.2,
 *     castShadow: true, mapSize: 1024, shadowDistance: 200,
 *     shadowFilter: DirectionalShadowFilterValue.pcssHigh,
 *     shadowAngularRadius: 0.00465, maxPenumbraTexels: 32,
 *   } });
 *   // shadowFilter uses the numeric DirectionalShadowFilterValue constant,
 *   // not the serialized label string 'pcssHigh'.
 *
 * @example 0-light scene must use an unlit shader (standard 0 light = physically correct black):
 *   const world = new World();
 *   // ... spawn cube + camera, no light ...
 *   await renderer.ready;
 *   renderer.draw(world); // standard material renders black; switch to an unlit shader (Materials.unlit(...)) for an unlit display
 */
export const DirectionalLight = defineComponent('DirectionalLight', {
  // f64 preserves invalid author inputs until render validation (no u32 wrapping).
  lightingChannels: { type: 'f64', default: LIGHTING_CHANNELS_DEFAULT },
  // direction is the ONLY field with no default (D-5): omitting it lands the
  // array layer-3 all-zero [0,0,0], which the renderer owner rejects -- there is no
  // universal default direction, so "default is illegal" forces an explicit
  // non-zero value. color carries an explicit layer-2 default [1,1,1] (white);
  // the array layer-3 fallback is all-zero, so the default MUST be explicit.
  direction: { type: 'array<f32, 3>' },
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
  // Shadow opt-in gate; the game template enables its sun explicitly.
  castShadow: { type: 'bool', default: false },
  // 9 shadow fields migrated from DirectionalLightShadow (feat-20260621 M1).
  cascadeCount: { type: 'f32', default: 3 },
  splitLambda: { type: 'f32', default: 0.5 },
  cascadeBlend: { type: 'f32', default: 0.2 },
  shadowMapAspect: { type: 'f32', default: 1 },
  shadowCasterChannels: { type: 'f64', default: 0xffffffff },
  shadowAutoUpdate: { type: 'bool', default: true },
  shadowRevision: { type: 'f64', default: 0 },
  mapSize: { type: 'f32', default: 2048 },
  depthBias: { type: 'f32', default: 0.00001 },
  normalBias: { type: 'f32', default: 0.05 },
  // Sole shadow coverage knob (feat replaces nearPlane/farPlane). The PSSM
  // near end derives from the active camera near; shadowDistance is the far
  // cap. The effective distance is min(camera far, shadowDistance), matching
  // Three.js CSM maxFar. The default cap preserves nearby detail independently
  // of the display camera's longer visibility range.
  shadowDistance: { type: 'f32', default: 200 },
  shadowFilter: {
    type: 'enum',
    default: DirectionalShadowFilterValue.pcfVogel,
    labels: DirectionalShadowFilterValue,
  },
  shadowAngularRadius: { type: 'f32', default: 0.00465 },
  maxPenumbraTexels: { type: 'f32', default: 32 },
  // Camera-fitted cascades remain the native default. An explicit reverse-Z
  // world-to-clip matrix provides an independent authored shadow camera.
  shadowProjection: { type: 'enum', labels: { cascaded: 0, matrix: 1 }, default: 0 },
  shadowViewProjection: { type: 'array<f32, 16>' },
  shadowBiasMode: { type: 'enum', labels: { receiverPlane: 0, constant: 1 }, default: 0 },
  shadowRadius: { type: 'f32', default: 1 },
  shadowIntensity: { type: 'f32', default: 1 },
  shadowBlurSamples: { type: 'f32', default: 8 },
  staggerCascades: { type: 'bool', default: false },
  // Retained static cascade layer for GPU-driven casters (see doc above).
  staticShadowCache: { type: 'bool', default: true },
  contactShadowLength: { type: 'f32', default: 0 },
});
