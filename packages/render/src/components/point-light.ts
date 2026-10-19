// @forgeax/engine-render - PointLight (omnidirectional point-light parameters).
//
// Schema: color array<f32,3> + intensity f32 + range f32 (feat-20260709 M2:
// color collapsed from 3 per-axis scalar columns to one inline array<f32,3>).
// `position` comes from the Transform component; PointLight requires a
// companion Transform on the same entity (ECS query: `[Transform, PointLight]`).
// `range` units are meters; defaults to `Number.POSITIVE_INFINITY` (no cutoff). Runtime finite-range
// attenuation is the Three r184 squared window; the KHR unsquared curve is an
// import/reference boundary only. See `light-helpers.ts` for the host-side
// range projection.
//
// 0 light + standard material -> physically correct black render
// (feat-20260518-pbr-direct-lighting-mvp). The runtime once-warn channel
// (M5 / w25) collapses to "directionalCount + pointCount + spotCount === 0";
// see packages/runtime/README.md section Common pitfalls for the AI-user
// guidance after the M5 docs land.
//
// Naming convention: bare entity name aligned with Bevy ECS conventions
// (feat-20260513-component-naming-bevy-align). DirectionalLight / SpotLight
// follow the same single-semantic-entity rule (charter proposition 5).
//
// charter mapping: proposition 1 (single import + IDE autocomplete on
// payload.range) + proposition 3 (silent failure -> explicit failure;
// spawn-time fail-fast on range<0 / NaN with structured EcsError) +
// proposition 5 (consistent abstraction: shared payload shape with
// SpotLight; `range` semantics aligned with KHR_lights_punctual).

import { defineComponent } from '@forgeax/engine-ecs';
import { ResourceInvalidValueError } from '../errors/ecs-validation';
import { LIGHTING_CHANNELS_DEFAULT } from './lighting-channels';

/** Point distance exponent; validation precedes the f32 GPU projection. */
export function validatePointLightDecay(value: number): ResourceInvalidValueError | null {
  if (Number.isFinite(value) && value >= 0 && Number.isFinite(Math.fround(value))) return null;
  return new ResourceInvalidValueError(
    'PointLight.decay is a finite non-negative f32',
    'use 2 for inverse-square attenuation or 0 for range-only falloff',
    { receivedKey: 'decay', receivedMode: value },
  );
}

/**
 * Omnidirectional point light (KHR_lights_punctual `point` type).
 *
 * `position` source: the companion `Transform` component on the same entity.
 * Spawn via `world.spawn({ component: Transform, data: ... }, { component: PointLight, data: ... })`
 * so the render system extract path can join the two via the
 * `[Transform, PointLight]` ECS query.
 *
 * `color` is linear-space rgb in `[0, 1]` per channel; `intensity` is candela;
 * `range` is in meters and defaults to `Number.POSITIVE_INFINITY` (no cutoff)
 * (KHR convention; `+Infinity` is the KHR no-truncation value, retained
 * for KHR_lights_punctual `range: 0` bridging via `light-helpers.ts`).
 * The runtime window is `clamp(1 - (d / range)^4, 0, 1)^2`; its no-cutoff
 * boundary uses `1 / d^decay`; `decay` defaults to 2 and accepts finite
 * non-negative f32 values. Zero keeps only the range window. Surface and volume
 * retain their existing near-light safety floors. Exposure is
 * applied after lighting and never multiplied into intensity.
 *
 * @example Spawn a single point light at (5, 3, 5):
 *   world.spawn(
 *     { component: Transform, data: { pos: [5, 3, 5] } },
 *     { component: PointLight, data: { intensity: 8, range: 25 } },
 *   );
 *
 * @example Minimal spawn -- defaults give neutral white at full strength, no distance cutoff:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 1, 0] } },
 *     { component: PointLight, data: {} },
 *   );
 *   // resolves to color=[1, 1, 1], intensity=1, range=Infinity.
 */
export const PointLight = defineComponent('PointLight', {
  // f64 preserves invalid author inputs until render validation (no u32 wrapping).
  lightingChannels: { type: 'f64', default: LIGHTING_CHANNELS_DEFAULT },
  // color carries an explicit layer-2 default [1,1,1] (white); the array
  // layer-3 fallback is all-zero, so the default MUST be explicit (D-5).
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
  range: { type: 'f32', default: Number.POSITIVE_INFINITY },
  /** Distance exponent; zero leaves only the finite-range window. */
  decay: { type: 'f64', default: 2 },
  // Transform rotates the full-sphere profile: polar +Z, azimuth +X toward +Y.
  iesProfile: { type: 'shared<IesProfileAsset>' },
});
