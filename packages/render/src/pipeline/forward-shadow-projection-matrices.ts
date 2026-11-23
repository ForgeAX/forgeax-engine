import { type Mat4, mat4 } from '@forgeax/engine-math';
import { jitterCameraProjection } from '../camera-projection';
import { computeProjectionMatrix, computeViewMatrix } from '../record/helpers';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { forwardPunctualShadowPlan } from './forward-punctual-shadow-plan';
import type { ForwardShadowAdmission } from './forward-shadow-admission';

const CASCADE_COUNT = 4;
const SPOT_COUNT = 4;
const MATRIX_FLOATS = (CASCADE_COUNT + SPOT_COUNT * 2) * 16;
export const FORWARD_SHADOW_MATRIX_BYTES = (MATRIX_FLOATS + 24) * 4;

function mapClipToUv(matrix: Mat4): void {
  for (let i = 0; i < 16; i += 4) {
    const w = matrix[i + 3] ?? 0;
    matrix[i] = ((matrix[i] ?? 0) + w) * 0.5;
    matrix[i + 1] = (w - (matrix[i + 1] ?? 0)) * 0.5;
  }
}

/** Precompose the shadow projection from the same jittered clip space as View. */
export function prepareForwardShadowMatrices(
  admission: Extract<ForwardShadowAdmission, { mode: 'screen' }>,
  sunSize: number,
  spotSize: number,
) {
  const payload = new Float32Array(FORWARD_SHADOW_MATRIX_BYTES / 4);
  const transition = payload.subarray(MATRIX_FLOATS, MATRIX_FLOATS + 4);
  const clipSplits = payload.subarray(MATRIX_FLOATS + 4, MATRIX_FLOATS + 8);
  const clipBlendStarts = payload.subarray(MATRIX_FLOATS + 8, MATRIX_FLOATS + 12);
  const atlas = payload.subarray(MATRIX_FLOATS + 12, MATRIX_FLOATS + 16);
  const spotFade = payload.subarray(MATRIX_FLOATS + 16, MATRIX_FLOATS + 20);
  const pointFade = payload.subarray(MATRIX_FLOATS + 20, MATRIX_FLOATS + 24);
  const projection = mat4.create();
  const worldToClip = mat4.create();
  const clipToWorld = mat4.create();
  const cascades = Array.from({ length: CASCADE_COUNT }, (_, index) => mat4.view(payload, index));
  const spots = Array.from({ length: SPOT_COUNT }, (_, index) =>
    mat4.view(payload, CASCADE_COUNT + index),
  );
  const spotVolumes = Array.from({ length: SPOT_COUNT }, (_, index) =>
    mat4.view(payload, CASCADE_COUNT + SPOT_COUNT + index),
  );
  const shadowToWorld = mat4.create();
  const clipDepth = (distance: number): number => {
    const z = (projection[14] ?? 0) - distance * (projection[10] ?? 0);
    const w = (projection[15] ?? 0) - distance * (projection[11] ?? 0);
    return w > 0 ? Math.max(0, Math.min(1, z / w)) : 0;
  };
  function packCascades(frame: _InternalRenderPipelineContext) {
    const info = frame.forwardShadowCascades;
    if (info === undefined) return;
    const axialDepth =
      projection[2] === 0 && projection[3] === 0 && projection[6] === 0 && projection[7] === 0;
    const blend = info.cascadeBlend;
    for (const [index, matrix] of (info.lightViewProj ?? []).entries()) {
      const destination = cascades[index];
      if (destination === undefined) continue;
      mat4.multiply(destination, matrix, clipToWorld);
      mapClipToUv(destination);
      const offset = index * 4;
      const distance = info.splitPlanes[offset] ?? 0;
      const texelWorld = info.splitPlanes[offset + 1] ?? 0;
      const depthSpan = info.splitPlanes[offset + 2] ?? 0;
      // The PCF transition follows the shared half-texel constant caster bias.
      transition[index] = 1 / Math.max(0.00001, (0.5 * texelWorld) / Math.max(depthSpan, 0.00001));
      if (!axialDepth) continue;
      clipSplits[index] = clipDepth(distance);
      clipBlendStarts[index] = clipDepth(distance * (1 - blend));
    }
  }
  function packFade(frame: _InternalRenderPipelineContext, receiver: typeof admission) {
    if (!receiver.viewFade || frame.standardLighting === undefined) return;
    const prepared = frame.standardLighting.prepared;
    const plan = forwardPunctualShadowPlan(prepared, receiver.directional !== false, receiver);
    if (plan.kind !== 'projected') return;
    for (const { slot, fade } of plan.lights) {
      if (fade === undefined) continue;
      const light = prepared.local[slot]?.source;
      if (light?.kind === 'spot') spotFade[light.shadowAtlasTile] = fade;
      if (light?.kind === 'point' && light.shadowAtlasLayer !== undefined)
        pointFade[light.shadowAtlasLayer] = fade;
    }
  }
  const update = (frame: _InternalRenderPipelineContext, receiver = admission): Float32Array => {
    const { camera, frameState } = frame;
    computeProjectionMatrix(camera, projection);
    jitterCameraProjection(projection, projection, camera.temporal?.currentJitterUv);
    computeViewMatrix(camera, worldToClip);
    mat4.multiply(worldToClip, projection, worldToClip);
    mat4.invert(clipToWorld, worldToClip);
    payload.fill(0);
    clipSplits.fill(-1);
    clipBlendStarts.fill(-1);
    spotFade.fill(1);
    pointFade.fill(1);
    const currentSunSize = frame.directionalDepthSize || sunSize;
    atlas[0] = currentSunSize;
    atlas[1] = 1 / currentSunSize;
    atlas[2] = spotSize;
    atlas[3] = 1 / spotSize;
    packCascades(frame);
    packFade(frame, receiver);
    for (const spot of frameState.spotShadowSnapshots) {
      const destination = spots[spot.shadowAtlasTile];
      const volume = spotVolumes[spot.shadowAtlasTile];
      if (destination === undefined || volume === undefined || spot.lightViewProj === undefined)
        continue;
      mat4.multiply(destination, spot.lightViewProj, clipToWorld);
      mapClipToUv(destination);
      if (spot.authoredShadowMatrix !== true)
        mat4.multiply(volume, worldToClip, mat4.invert(shadowToWorld, spot.lightViewProj));
    }
    return payload;
  };
  const farDepth = (frame: _InternalRenderPipelineContext): number => {
    const count = frame.forwardShadowCascades?.cascadeCount ?? 0;
    return Math.max(0, (clipSplits[count - 1] ?? 0) - 1e-5);
  };
  return { update, worldToClip, spotVolumes, farDepth };
}
