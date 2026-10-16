import { cameraLensProjection } from '../camera-projection';
import type { RenderResourceScope } from '../publication/resource-scope';
// @forgeax/engine-runtime - RenderSystem record stage: helpers.
// Extracted from render-system-record.ts (feat-20260704 M3/w17, pure move).

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { EquirectAsset } from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { EquirectProjectionFailedError } from '../errors/render';
import { isStandardPbrMaterialShader } from '../pbr-pipeline';
import type { CameraSnapshot } from '../render-contract';
import type { MaterialSnapshot, SkyboxSnapshot, SkylightSnapshot } from '../render-system-extract';
import type { RenderFrameState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

/** Convert pass-owned shader definitions into the manifest's canonical variant key. */
export function variantSetFromDefines(
  defines: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (defines === undefined) return undefined;
  const entries = Object.entries(defines);
  if (entries.length === 0) return undefined;
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('+');
}

/**
 * Select the equirect source for the shared lazy projection.
 *
 * Skylight uses handle 0 as a real "solid-color ambient" sentinel, so nullish
 * coalescing cannot distinguish "no equirect" from a valid snapshot. Prefer a
 * non-zero Skylight handle and fall back to SkyboxBackground otherwise.
 */
export function selectLazyEquirectHandle(
  skylight: Pick<SkylightSnapshot, 'equirectHandle'> | undefined,
  skybox: Pick<SkyboxSnapshot, 'equirectHandle'> | undefined,
): number {
  const skylightHandle = skylight?.equirectHandle ?? 0;
  return skylightHandle !== 0 ? skylightHandle : (skybox?.equirectHandle ?? 0);
}

/**
 * feat-20260608-multi-light-warn-once M3: warn-once latch for directional
 * N>1 overrun. Fires console.warn at most once per RenderSystem lifetime.
 * Extracted as a pure helper so the warn-once logic is directly testable
 * without a full recordFrame argument list (AC-05 (c)).
 */
export function warnMultiLightDirectional(
  frameState: Pick<RenderFrameState, 'warnedMultiLightDirectional'>,
  directionalCount: number,
  envOverride?: { env?: { NODE_ENV?: string } },
): void {
  if (!frameState.warnedMultiLightDirectional && directionalCount > 1) {
    frameState.warnedMultiLightDirectional = true;
    const env =
      envOverride ?? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
    if (env?.env?.NODE_ENV !== 'production') {
      console.warn(
        '[forgeax] render-system-multi-light directional: at most 1 entity (got N=' +
          directionalCount +
          '). First entity used; rest dropped.',
        {
          code: 'render-system-multi-light',
          expected: 'at most 1 directional',
          detail: { type: 'directional', got: directionalCount },
        },
      );
    }
  }
}

/**
 * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
 * once-warn for >1 Skylight entity (first archetype hit wins). Fires at most
 * once per RenderSystem lifetime and names the WINNING entity handle so the
 * scene author can tell which Skylight is used and that the rest are ignored
 * (F-8: warn carries conflicting entity info; charter P3 explicit failure with
 * a warn-once signal floor, no per-frame flooding).
 */
export function warnMultiSkylight(
  frameState: Pick<RenderFrameState, 'warnedMultiSkylight'>,
  skylightCount: number,
  winningEntityHandle: number,
): void {
  if (!frameState.warnedMultiSkylight && skylightCount > 1) {
    frameState.warnedMultiSkylight = true;
    console.warn(
      `[forgeax] Skylight: ${skylightCount} Skylight entities found; using entity ` +
        `${winningEntityHandle} (first by archetype order) for IBL ambient. The other ` +
        `${skylightCount - 1} Skylight ${skylightCount - 1 === 1 ? 'entity is' : 'entities are'} ignored. ` +
        `Keep a single Skylight per scene, or reorder so the intended one is first.`,
    );
  }
}

/**
 * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w19:
 * once-warn for >1 SkyboxBackground entity (mirrors warnMultiSkylight). Names
 * the winning entity handle; fires once per RenderSystem lifetime.
 */
export function warnMultiSkybox(
  frameState: Pick<RenderFrameState, 'warnedMultiSkybox'>,
  skyboxCount: number,
  winningEntityHandle: number,
): void {
  if (!frameState.warnedMultiSkybox && skyboxCount > 1) {
    frameState.warnedMultiSkybox = true;
    console.warn(
      `[forgeax] SkyboxBackground: ${skyboxCount} SkyboxBackground entities found; using ` +
        `entity ${winningEntityHandle} (first by archetype order). The other ` +
        `${skyboxCount - 1} ${skyboxCount - 1 === 1 ? 'entity is' : 'entities are'} ignored. ` +
        `Keep a single SkyboxBackground per scene.`,
    );
  }
}

/**
 * feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M3 / w18:
 * lazy equirect-to-cubemap projection trigger. Driven once per frame from
 * `recordFrame` for the active equirect handle (Skylight's, or the
 * SkyboxBackground's when no Skylight cubemap is present -- both reuse one
 * handle). Implements the plan-strategy D-4 state machine:
 *
 *   undefined (no entry) -> resolve POD + fire-and-forget projection; the
 *                                    store selects rgba8 output on WebGL2
 *                                     (the store writes status:'pending'
 *                                     synchronously, so this launches once)
 *   pending                        -> in flight; bind white fallback (no fire)
 *   ready                          -> bound by recordMainPass's IBL cache check
 *   failed                         -> fire EquirectProjectionFailedError ONCE
 *                                     per handle (R-2/AC-09 no retry)
 * Fire-and-forget: `_uploadCubemapFromEquirect` is invoked WITHOUT await so the
 * record stay synchronous; the store mutates its own status map and (on
 * success) the per-device IblPipelineCache, which recordMainPass reads on a
 * later frame. The structured error from a fire-and-forget failure is reported
 * via the explicit `status === 'failed'` arm here (read on the next frame), not
 * by awaiting the promise (which would block record).
 */
export function driveLazyEquirectProjection(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  frameState: Pick<RenderFrameState, 'firedEquirectProjectionFailedHandles'>,
  equirectHandle: number,
): void {
  const store = internals.gpuStore;
  const handle = toShared<'EquirectAsset'>(equirectHandle);
  const failure = store.getCubemapFailure(handle);
  if (failure !== undefined) {
    // Fire the structured error exactly once per failed source (the store
    // records failed permanently and never retries; R-2 / AC-09).
    if (!frameState.firedEquirectProjectionFailedHandles.has(equirectHandle)) {
      frameState.firedEquirectProjectionFailedHandles.add(equirectHandle);
      internals.errorRegistry.fire(new EquirectProjectionFailedError(equirectHandle, failure));
    }
    return;
  }

  // 'pending' and 'ready' are both handled downstream (white fallback while
  // pending; real IBL once ready). Only the first sight ('undefined') launches.
  if (store.getCubemapStatus(handle) !== undefined) return;

  // First sight: resolve the equirect POD and fire-and-forget the projection.
  const podRes = resolveAssetHandle<EquirectAsset>(world, handle);
  if (!podRes.ok || podRes.value.kind !== 'equirect') {
    // The handle does not resolve to a live equirect POD (stale / wrong kind).
    // Launch nothing; the store stays empty and the white fallback holds. The
    // skybox / IBL degradation paths surface the missing resource per their own
    // gates -- this trigger only drives a valid equirect source.
    return;
  }
  // Fire-and-forget: do NOT await. The store writes status:'pending'
  // synchronously (before its first await), so a re-entry next frame
  // short-circuits and this launches exactly once.
  void store._uploadCubemapFromEquirect(world, handle, podRes.value);
}

/**
 * Returns true when a MaterialSnapshot uses a builtin standard/PBR shader
 * that will render black with zero lights.
 *
 * The default mid-grey fallback (materialShaderId === undefined) is excluded
 * — it routes through defaultMaterialSnapshot and never triggers the
 * zero-light warning. Custom shaders are also excluded: their lighting
 * contract is authored by the shader and cannot be inferred from this
 * generic diagnostic.
 *
 * @internal — exported so AC-02 zero-light-warning test can anchor to
 * the production implementation rather than a test-local copy.
 */
export function isLitMaterialSnapshot(material: MaterialSnapshot): boolean {
  return isStandardPbrMaterialShader(material.materialShaderId);
}

export function computeViewMatrix(camera: CameraSnapshot): Mat4 {
  // feat-20260601 D-3: view = invert(camera world mat4). The camera's resolved
  // world mat4 (propagateTransforms output) is read straight off the snapshot;
  // no recompose from decomposed TRS.
  const cameraFromWorld = mat4.create();
  mat4.invert(cameraFromWorld, camera.world);
  return cameraFromWorld;
}

export function computeProjectionMatrix(camera: CameraSnapshot): Mat4 {
  if (camera.captureProjection !== undefined) {
    const projection = mat4.create();
    projection.set(camera.captureProjection);
    return projection;
  }
  return cameraLensProjection(camera);
}
