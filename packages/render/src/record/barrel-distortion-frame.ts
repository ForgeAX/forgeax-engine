import {
  attachBarrelDistortionCameraFrame,
  type BarrelDistortionMapping,
  createBarrelDistortionMapping,
} from '../barrel-distortion';
import type { BarrelDistortionInspection } from '../inspection-types';
import { projectBarrelDistortionInspection } from '../inspection-types';
import type { CameraSnapshot } from '../render-contract';
import type { RenderFrameState } from './frame-snapshot';
import { computeProjectionMatrix, computeViewMatrix } from './helpers';

function submittedCameraFrame(camera: CameraSnapshot) {
  return {
    projection: camera.projection,
    far: camera.far,
    viewMatrix: computeViewMatrix(camera),
    projectionMatrix: computeProjectionMatrix(camera),
  } as const;
}

function identityBarrelMapping(
  camera: CameraSnapshot,
  width: number,
  height: number,
): BarrelDistortionMapping | undefined {
  const identity = createBarrelDistortionMapping(width, height, undefined);
  return identity.ok
    ? attachBarrelDistortionCameraFrame(identity.value, submittedCameraFrame(camera))
    : undefined;
}

export function packBarrelDistortionParams(mapping: BarrelDistortionMapping): Uint8Array {
  const params = new Uint8Array(16);
  const view = new DataView(params.buffer);
  view.setFloat32(0, mapping.strength, true);
  view.setFloat32(4, mapping.centerX, true);
  view.setFloat32(8, mapping.centerY, true);
  view.setFloat32(12, mapping.radiusSquared, true);
  return params;
}

function resolveRetainedBarrelMapping(
  accepted: BarrelDistortionMapping,
  camera: CameraSnapshot,
  width: number,
  height: number,
): BarrelDistortionMapping | undefined {
  const mapping = createBarrelDistortionMapping(width, height, {
    strength: accepted.strength,
    centerX: accepted.centerX,
    centerY: accepted.centerY,
  });
  return mapping.ok
    ? attachBarrelDistortionCameraFrame(mapping.value, submittedCameraFrame(camera))
    : undefined;
}

export function resolveSubmittedBarrelMapping(
  frameState: RenderFrameState,
  graph: { readonly inspect: () => { readonly passes: readonly { readonly name: string }[] } },
  camera: CameraSnapshot,
  width: number,
  height: number,
): BarrelDistortionMapping | undefined {
  const retained = frameState.barrelDistortionGraphResolution === 'retained';
  const accepted = frameState.lastSuccessfulBarrelDistortion;
  if (retained && accepted !== undefined) {
    return resolveRetainedBarrelMapping(accepted, camera, width, height);
  }
  const hasBarrelPass = graph.inspect().passes.some((pass) => pass.name === 'barrel-distortion');
  if (!hasBarrelPass) return identityBarrelMapping(camera, width, height);
  const authored = camera.barrelDistortion;
  if (!retained && authored !== undefined && authored.strength > 0) {
    const mapping = createBarrelDistortionMapping(width, height, authored);
    return mapping.ok
      ? attachBarrelDistortionCameraFrame(mapping.value, submittedCameraFrame(camera))
      : undefined;
  }
  return accepted === undefined
    ? identityBarrelMapping(camera, width, height)
    : resolveRetainedBarrelMapping(accepted, camera, width, height);
}

export function inspectBarrelDistortionState(
  state: RenderFrameState,
  deviceGeneration: number,
): BarrelDistortionInspection {
  const mapping = state.lastSuccessfulBarrelDistortion;
  return projectBarrelDistortionInspection({
    effectiveMapping: mapping,
    frameId: state.frameNumber,
    deviceGeneration,
    graphGeneration: state.graphGeneration,
    lastKnownGood:
      mapping !== undefined &&
      state.compiledFrameGraph !== null &&
      state.barrelDistortionGraphResolution === 'retained',
  });
}
