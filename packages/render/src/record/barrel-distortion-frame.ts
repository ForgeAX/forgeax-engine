import { type Mat4, mat4 } from '@forgeax/engine-math';
import {
  attachComputedBarrelDistortionCameraFrame,
  type BarrelDistortionMapping,
  createBarrelDistortionMapping,
  ownsBarrelDistortionMapping,
} from '../barrel-distortion';
import type { BarrelDistortionInspection } from '../inspection-types';
import { projectBarrelDistortionInspection } from '../inspection-types';
import type { CameraSnapshot } from '../render-contract';
import type { RenderFrameState } from './frame-snapshot';
import { computeProjectionMatrix, computeViewMatrix } from './helpers';

interface CameraFrameScratch {
  projection: CameraSnapshot['projection'];
  far: number;
  viewMatrix: Mat4;
  projectionMatrix: Mat4;
}

// Retain one free buffer pair; a reentrant operation acquires its own pair.
let freeCameraFrame: CameraFrameScratch | undefined;

/** Compare only owned publications against the current validated private scratch. */
function sameSubmittedMapping(
  previous: BarrelDistortionMapping,
  mapping: BarrelDistortionMapping,
  frame: CameraFrameScratch,
): boolean {
  const camera = previous.camera;
  if (camera === undefined) return false;
  // Camera motion rejects before comparing unchanged lens and viewport facts.
  if (
    !Object.is(camera.viewMatrix[12], frame.viewMatrix[12]) ||
    !Object.is(camera.viewMatrix[13], frame.viewMatrix[13]) ||
    !Object.is(camera.viewMatrix[14], frame.viewMatrix[14])
  )
    return false;
  return (
    sameCameraMatrix(camera.viewMatrix, frame.viewMatrix) &&
    sameCameraMatrix(camera.projectionMatrix, frame.projectionMatrix) &&
    camera.projection === frame.projection &&
    Object.is(camera.far, frame.far) &&
    Object.is(previous.width, mapping.width) &&
    Object.is(previous.height, mapping.height) &&
    Object.is(previous.aspect, mapping.aspect) &&
    Object.is(previous.strength, mapping.strength) &&
    Object.is(previous.centerX, mapping.centerX) &&
    Object.is(previous.centerY, mapping.centerY) &&
    Object.is(previous.radiusSquared, mapping.radiusSquared)
  );
}

function sameCameraMatrix(previous: ArrayLike<number>, current: Mat4): boolean {
  if (previous.length !== current.length) return false;
  for (let index = 0; index < current.length; index++)
    if (!Object.is(previous[index], current[index])) return false;
  return true;
}

function attachSubmittedCameraFrame(
  mapping: BarrelDistortionMapping,
  camera: CameraSnapshot,
  previous: BarrelDistortionMapping | undefined,
): BarrelDistortionMapping {
  const frame: CameraFrameScratch = freeCameraFrame ?? {
    projection: 'perspective',
    far: 0,
    viewMatrix: mat4.create(),
    projectionMatrix: mat4.create(),
  };
  freeCameraFrame = undefined;
  try {
    frame.projection = camera.projection;
    frame.far = camera.far;
    computeViewMatrix(camera, frame.viewMatrix);
    computeProjectionMatrix(camera, frame.projectionMatrix);
    // Compute and validate current camera facts before considering any reuse.
    if (
      previous !== undefined &&
      ownsBarrelDistortionMapping(previous) &&
      sameSubmittedMapping(previous, mapping, frame)
    )
      return previous;
    // Publication detaches both matrices before this synchronous call returns.
    return attachComputedBarrelDistortionCameraFrame(mapping, frame);
  } finally {
    freeCameraFrame ??= frame;
  }
}

function identityBarrelMapping(
  camera: CameraSnapshot,
  width: number,
  height: number,
  previous: BarrelDistortionMapping | undefined,
): BarrelDistortionMapping | undefined {
  const identity = createBarrelDistortionMapping(width, height, undefined);
  return identity.ok ? attachSubmittedCameraFrame(identity.value, camera, previous) : undefined;
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
  return mapping.ok ? attachSubmittedCameraFrame(mapping.value, camera, accepted) : undefined;
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
  if (!hasBarrelPass) return identityBarrelMapping(camera, width, height, accepted);
  const authored = camera.barrelDistortion;
  if (!retained && authored !== undefined && authored.strength > 0) {
    const mapping = createBarrelDistortionMapping(width, height, authored);
    return mapping.ok ? attachSubmittedCameraFrame(mapping.value, camera, accepted) : undefined;
  }
  return accepted === undefined
    ? identityBarrelMapping(camera, width, height, accepted)
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
