// @forgeax/engine-runtime - SkyboxBackground (environment cubemap render background).
//
// Schema: 3 fields -- equirect (Handle<EquirectAsset>, u32-stored handle)
// + mode (f32 enum column, discriminator) + rotation (quaternion xyzw,
// default identity). Naming convention follows the
// single-semantic component rule: no Component suffix (AGENTS.md rule #1).
//
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w16:
// the field is `equirect: shared<EquirectAsset>` (the retired
// `cubemap: shared<CubeTextureAsset>` is gone). The skybox reuses the same
// equirect handle as the Skylight; the cubemap projection is internal and
// driven by the render-system record arm (no user upload call).
//
// Plan-strategy D-5: mode is a f32 enum column (ECS columns are POD, no
// string unions in archetype storage). Consumer-facing type safety is
// provided by the `SkyboxMode` literal union + `skyboxModeFromF32` mapper
// (same pattern as cameraProjectionFromF32 in camera.ts:51,105,145,221-237).
//
// OOS-1: `mode: 'atmosphere'` implementation is deferred -- the union
// shape leaves room for additive growth without breaking the f32 enum
// encoding.
//
// AI user minimum spawn (charter P4):
//   world.spawn({ component: SkyboxBackground, data: { equirect, mode: 0 } });
//
// Single component activates the skybox render pass transparently when a
// Skylight + tonemap active camera is present (skybox reuses the same
// equirect handle as Skylight).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Skybox mode literal union (AC-02 narrowing surface).
 * Currently only 'cubemap' -- future 'atmosphere' deferred per OOS-1.
 */
export type SkyboxMode = 'cubemap';

/** Numeric encoding of cubemap skybox mode (schema value for `mode`). */
export const SKYBOX_MODE_CUBEMAP = 0;

/**
 * Map a `SkyboxBackground.mode` numeric value to the closed `SkyboxMode`
 * string-literal union. Only member currently is 'cubemap'; the exhaustive
 * switch is ready for future mode additions (e.g. 'atmosphere', OOS-1).
 */
export function skyboxModeFromF32(value: number): SkyboxMode {
  switch (value) {
    case SKYBOX_MODE_CUBEMAP:
      return 'cubemap';
    // Future: case SKYBOX_MODE_ATMOSPHERE: return 'atmosphere';
  }
  // Unrecognised value: fall back to 'cubemap' (charter P3 -- no silent
  // exception; the fallback preserves rendering on stale numerics while
  // the exhaustive switch shape ensures AI users catch new members at
  // compile time when a mode is added).
  return 'cubemap';
}

/**
 * SkyboxBackground: full-screen environment cubemap background.
 *
 * Renders a fullscreen triangle that reconstructs world-space view
 * direction from the camera's inverseViewProj matrix (View UBO),
 * samples a cubemap with the view direction, and writes an HDR color
 * to the hdrColor render target (before the main geometry pass).
 *
 * The skybox pass is automatically activated when a SkyboxBackground
 * entity exists, a Skylight entity provides the equirect source, and the
 * active Camera has tonemap active. The skybox reuses the same equirect
 * handle as the Skylight entity -- two independent components sharing the
 * same GPU resource (the internally-projected cubemap).
 *
 * `equirect` is a `Handle<EquirectAsset>` resolved from a vite pack-index
 * GUID via `engine.assets.loadByGuid<EquirectAsset>(guid)`. The cubemap
 * projection is internal and driven by the render-system record arm; there
 * is no user upload call.
 *
 * `mode` is a numeric discriminator column (`'f32'`). Use
 * `SKYBOX_MODE_CUBEMAP` for the cubemap render path.
 *
 * `rotation` is an environment-space quaternion in `[x, y, z, w]` order.
 * It rotates the sampled cubemap without changing the camera or rebaking the
 * source equirectangular asset.
 *
 * @example Minimum spawn (defaults mode=0):
 *   // equirectHandle resolved from loadByGuid<EquirectAsset> (same handle as
 *   // the Skylight).
 *   world.spawn({ component: SkyboxBackground, data: { equirect: equirectHandle } });
 *
 * @example Single handle shared between Skylight (IBL) and SkyboxBackground:
 *   const hdrRes = await engine.assets.loadByGuid<EquirectAsset>(guid);
 *   if (!hdrRes.ok) throw hdrRes.error;
 *   world.spawn({ component: Skylight,     data: { equirect: hdrRes.value } });
 *   world.spawn({ component: SkyboxBackground, data: { equirect: hdrRes.value } });
 */
export const SkyboxBackground = defineComponent('SkyboxBackground', {
  // The GPU skybox projection is render-owned presentation state; restore
  // keeps the portable mode/rotation controls and lets the owner re-resolve
  // the environment asset on the target world.
  equirect: { type: 'shared<EquirectAsset>', simulationTransient: true },
  mode: { type: 'f32', default: SKYBOX_MODE_CUBEMAP },
  rotation: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
});
