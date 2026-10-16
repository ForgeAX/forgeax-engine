// @forgeax/engine-runtime - Skylight (ambient environment light).
//
// Schema: 4 fields -- equirect (Handle<EquirectAsset>, u32-stored handle,
// OPTIONAL) + color (array<f32,3>, default [1,1,1] = white) + intensity (f32,
// default 1.0) + rotation (quaternion xyzw, default identity). feat-20260709 M2 collapsed colorR/G/B into one inline
// array<f32,3> column. Naming convention follows the DirectionalLight / PointLight /
// SpotLight family: no Component suffix (AGENTS.md rule #1).
//
// Plan-strategy D-6: Skylight component schema is registered but no
// independent ECS system is created. All Skylight processing happens inside
// RenderSystem's extract/record phases.
//
// AI user minimum spawn (AC-13, charter P4):
//   world.spawn({ component: Skylight, data: {} });  // instant white ambient
//
// A single Skylight activates ambient lighting transparently. The `equirect`
// field is OPTIONAL: omit it for a constant solid-color ambient that needs NO
// async GPU precompute -- the engine binds a 1x1 white irradiance cube, so
// ambient = color * intensity * albedo is live on the very first frame (this
// is the fix for the downstream "scene is black until the async IBL cubemap
// finishes uploading" gap). Supply an equirect to upgrade to full image-based
// lighting (diffuse irradiance + specular prefilter); `color` * `intensity`
// still scales the IBL result, so both are live dynamic dials either way.
//
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w16:
// the field is `equirect: shared<EquirectAsset>` (the retired
// `cubemap: shared<CubeTextureAsset>` is gone). AI users declare the equirect
// source directly; the render-system record arm projects the cubemap + IBL
// chain internally and lazily (no user upload call) -- there is no
// uploadCubemapFromEquirect on the public surface.
//
// Edge cases handled by w18 / w19:
//   - Multi-Skylight: first archetype hit wins, console.warn in dev+prod
//   - intensity=0: ambient term = 0, mathematically valid, no warn
//   - No equirect: solid-color ambient via the white fallback cube (no async)

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Skylight ambient environment light.
 *
 * A single Skylight entity provides ambient lighting for all StandardMaterial
 * surfaces. When Atmosphere is selected and equirect is omitted, the same sky
 * cube supplies diffuse and roughness-filtered specular IBL. Color/intensity
 * still scale the result; without Atmosphere the solid-color behavior applies.
 * Two authored inputs share one component:
 *
 * - **Solid-color ambient (no equirect).** Omit `equirect` for a constant
 *   ambient = `color` * `intensity` applied immediately, with no async GPU
 *   precompute. The engine samples a built-in 1x1 white irradiance cube, so a
 *   freshly-loaded scene is lit on its first frame instead of being black
 *   until an IBL upload finishes.
 * - **Image-based lighting (with equirect).** Supply `equirect` to upgrade to
 *   diffuse irradiance + specular prefilter IBL. The engine runs the full
 *   precompute (equirect->cubemap, irradiance convolution, prefilter mip
 *   chain, BRDF LUT) transparently inside the render-system record arm;
 *   `color` * `intensity` then scale the IBL ambient.
 *
 * `equirect` is an OPTIONAL `Handle<EquirectAsset>` resolved from a vite
 * pack-index GUID via `engine.assets.loadByGuid<EquirectAsset>(guid)`. The
 * cubemap projection is internal and idempotent: the same equirect source
 * always resolves to the same GPU cubemap (no user upload call).
 *
 * `color` is the linear-space ambient tint (default white [1, 1, 1]).
 * `intensity` is a linear multiplier (default 1.0; 0 disables ambient). Both
 * are read every frame, so they are live dynamic dials.
 *
 * `rotation` is an environment-space quaternion in `[x, y, z, w]` order.
 * The default identity quaternion leaves the source orientation unchanged;
 * changing it rotates the IBL at sample time without rebaking the source.
 *
 * @example Instant white ambient (no asset, no async):
 *   world.spawn({ component: Skylight, data: {} });
 *
 * @example Dim warm ambient:
 *   world.spawn({ component: Skylight, data: { color: [1, 0.9, 0.8], intensity: 0.3 } }); // color is [r, g, b]
 *
 * @example Full IBL from an HDR equirect (declarative -- no upload call):
 *   // 1. resolve GUID from vite pack-index (see forgeax-engine-vite-plugin-pack)
 *   import { AssetGuid } from '@forgeax/engine-pack/guid';
 *   const guidRes = AssetGuid.parse('019e4a26-3c29-7420-af5d-20f2724a16b0');
 *   if (!guidRes.ok) throw guidRes.error;
 *   // 2. load the HDR equirect via the GUID-addressed pack route
 *   const hdrRes = await engine.assets.loadByGuid<EquirectAsset>(guidRes.value);
 *   if (!hdrRes.ok) throw hdrRes.error;
 *   // 3. spawn the Skylight — the equirect handle activates the full IBL path;
 *   //    the cubemap + IBL precompute happen lazily inside the record arm.
 *   world.spawn({ component: Skylight, data: { equirect: hdrRes.value } });
 */
export const Skylight = defineComponent('Skylight', {
  // The GPU equirect-to-cubemap projection is render-owned presentation
  // state. Record/restore preserves the portable lighting controls while the
  // render owner resolves this asset again on the target world.
  equirect: { type: 'shared<EquirectAsset>', simulationTransient: true },
  // color carries an explicit layer-2 default [1,1,1] (white); the array
  // layer-3 fallback is all-zero, so the default MUST be explicit (D-5).
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1.0 },
  rotation: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
});
