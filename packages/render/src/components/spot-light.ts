// @forgeax/engine-render - SpotLight (cone-restricted spot-light parameters).
//
// Schema: direction array<f32,3> + color array<f32,3> + intensity + range +
// innerConeDeg + outerConeDeg (feat-20260709 M2: direction/color collapsed from
// 6 per-axis scalar columns to two inline array<f32,3> columns). `position`
// comes from the
// Transform component; SpotLight requires a companion Transform on the same
// entity (ECS query: `[Transform, SpotLight]`). Cone units are degrees on
// the Component API surface (charter F1 prior-knowledge alignment with
// Three.js); the host-side extract step pre-converts to `cosInner` /
// `cosOuter` before GPU upload (plan-strategy section 8.2 naming convention
// + D-3 host-side cone conversion).
//
// `range` units are meters; defaults to `Number.POSITIVE_INFINITY` (no cutoff). Runtime finite-range
// attenuation is the Three r184 squared window; the KHR unsquared curve is an
// import/reference boundary only. Equal cone angles produce a hard edge;
// an authored penumbra uses smoothstep between the cone cosines.
//
// 0 light + standard material -> physically correct black render. The
// once-warn channel collapses to "directionalCount + pointCount +
// spotCount === 0" (M5 / w25).
//
// feat-20260625-spot-light-shadow-mapping M1 w4: embedded castShadow (default false)
// + 7 shadow fields (mapSize / depthBias / normalBias / nearPlane / farPlane /
// pcfKernelSize / shadowIntensity) aligned with DirectionalLight vocabulary (plan-strategy D-6;
// charter P4 consistent abstraction). Set castShadow:true to request spot shadows;
// light range and cone validation also apply without shadow maps.
// Shadow atlas cap of 4 is enforced at extract stage, not component layer (OOS-5).
//
// charter mapping: proposition 1 (single import + IDE autocomplete on
// payload.outerConeDeg with no `as` cast) + proposition 3 (silent failure
// -> explicit failure; spawn-time fail-fast on three bound violations) +
// proposition 5 (consistent abstraction: outgoing direction semantics
// shared with DirectionalLight; cone deg API + cos shader uniform
// pre-conversion mirrors directional path's host-side `lightDir x intensity`
// pre-multiplication).

import { defineComponent } from '@forgeax/engine-ecs';
import { LIGHTING_CHANNELS_DEFAULT } from './lighting-channels';

/**
 * Cone-restricted spot light (KHR_lights_punctual `spot` type).  Shadow maps
 * are opt-in (castShadow defaults to false); enabled lights project PCF
 * shadows through an independent spot depth atlas.
 *
 * `direction` @semantics outgoing -- points FROM light source TO the
 * scene (consistent with `DirectionalLight`; the shader internally negates
 * this vector to obtain the L vector for BRDF evaluation:
 * `let l = normalize(-light.direction)`). Extract owns the single
 * normalization step for the snapshot; URP and HDRP consume that normalized
 * value without re-normalizing. `position` source: the companion
 * `Transform` component on the same entity.
 *
 * `innerConeDeg` is the half-angle of the saturated bright region (cone
 * fully bright at the axis); `outerConeDeg` is the half-angle of the
 * falloff edge (cone fully dark beyond). Unit is **degrees**;
 * `outerConeDeg in [innerConeDeg, 90]` (KHR upper bound; spawn-time
 * validation rejects `outer > 90` and `outer < inner`). The host-side
 * extract step converts both to `cos*` before GPU upload so the shader
 * only sees pre-computed cosines (plan-strategy D-S2 byte freeze; charter
 * P4 host pre-multiplication parity).
 *
 * `color` is linear-space rgb in `[0, 1]` per channel; `intensity` is candela;
 * `range` is in meters and defaults to `Number.POSITIVE_INFINITY` (no cutoff). Exposure is a camera output
 * operation and does not change the stored intensity.
 *
 * Shadow fields (embedded, aligned with DirectionalLight):
 *   castShadow    ∈ {true, false}    — shadow opt-in gate (default false)
 *   mapSize       >= 1               — shadow map resolution per tile (default 1024)
 *   depthBias                        — normalized reverse-Z receiver bias (default 0.00001)
 *   normalBias                       — world-space normal offset (default 0.05)
 *   nearPlane                        — shadow-camera near (default 0.5)
 *   farPlane                         — unlimited-light shadow far fallback (default 500)
 *   pcfKernelSize finite >= 1           — Vogel footprint diameter (1: hardware PCF, 3: radius 1)
 *   shadowIntensity in [0,1]         — residual light in shadow (default 1)
 *
 * Atlas capacity is capped at 4 castShadow spot lights by the extract stage;
 * the 5th light onward keeps direct illumination but shadowAtlasTile = -1
 * (AC-05: clip is programmatically detectable, light stays visible).
 *
 * @example Spawn a single spot light without shadow maps:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 5, 0] } },
 *     { component: SpotLight, data: { direction: [0, -1, 0] } }, // [x, y, z]
 *   );
 *
 * @example Opt out of shadows:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 5, 0] } },
 *     { component: SpotLight, data: { direction: [0, -1, 0], castShadow: false } },
 *   );
 *
 * @example Explicit shadow config:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 5, 0] } },
 *     { component: SpotLight, data: { direction: [0, -1, 0], castShadow: true, depthBias: 0.01, normalBias: 0.08, mapSize: 1024 } },
 *   );
 *
 * @example Minimal spawn -- defaults give neutral white at full strength, no distance cutoff, 60-degree cone whose falloff spans the whole cone:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 5, 0] } },
 *     { component: SpotLight, data: { direction: [0, -1, 0] } }, // [x, y, z]
 *   );
 *   // resolves to color=[1,1,1], intensity=1, range=Infinity,
 *   // innerConeDeg=0, outerConeDeg=60 (Three r184 angle=pi/3, penumbra=1).
 */
export const SpotLight = defineComponent('SpotLight', {
  // f64 preserves invalid author inputs until render validation (no u32 wrapping).
  lightingChannels: { type: 'f64', default: LIGHTING_CHANNELS_DEFAULT },
  // direction has no default (D-5): omitting it lands the array layer-3
  // all-zero, which validate() rejects. color carries an explicit layer-2
  // default [1,1,1] (white); the array layer-3 fallback is all-zero.
  direction: { type: 'array<f32, 3>' },
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
  range: { type: 'f32', default: Number.POSITIVE_INFINITY },
  // KHR_lights_punctual innerConeAngle default: falloff spans the whole cone,
  // so authoring only outerConeDeg is always valid. Equal angles give Three's
  // penumbra-0 hard edge.
  innerConeDeg: { type: 'f32', default: 0 },
  outerConeDeg: { type: 'f32', default: 60 },
  iesProfile: { type: 'asset<ies-profile>' },
  cookie: { type: 'asset<texture>' },
  rollDeg: { type: 'f32', default: 0 },
  // Shadow opt-in gate: default lights allocate no shadow tile.
  castShadow: { type: 'bool', default: false },
  // 7 shadow fields aligned with the shared light shadow vocabulary.
  shadowMapAspect: { type: 'f32', default: 1 },
  shadowCasterChannels: { type: 'f64', default: 0xffffffff },
  shadowAutoUpdate: { type: 'bool', default: true },
  shadowRevision: { type: 'f64', default: 0 },
  mapSize: { type: 'f32', default: 1024 },
  depthBias: { type: 'f32', default: 0.00001 },
  normalBias: { type: 'f32', default: 0.05 },
  nearPlane: { type: 'f32', default: 0.5 },
  // Finite positive light.range overrides this fallback, as in Three r184.
  farPlane: { type: 'f32', default: 500 },
  pcfKernelSize: { type: 'f32', default: 3 },
  shadowFilter: {
    type: 'enum',
    labels: { basic: 1, pcfVogel: 6, pcfSoft: 7, variance: 8 },
    default: 6,
  },
  shadowBiasMode: { type: 'enum', labels: { facingNormal: 0, constant: 1 }, default: 0 },
  shadowProjection: { type: 'enum', labels: { cone: 0, matrix: 1 }, default: 0 },
  shadowViewProjection: { type: 'array<f32, 16>' },
  // Three's SpotLight.shadow.intensity is the fraction of visibility applied
  // to a shadowed contribution. Keep it in the author-facing [0,1] domain;
  // extract/record transport this one fact to surface and volume consumers.
  shadowIntensity: { type: 'f32', default: 1 },
  shadowBlurSamples: { type: 'f32', default: 8 },
  // Optional shared TextureAsset identity; absent keeps the normal spot path.
  // Publication and residency remain owned by the asset and GPU resource owners.
  projector: { type: 'asset<texture>', simulationTransient: true },
});
