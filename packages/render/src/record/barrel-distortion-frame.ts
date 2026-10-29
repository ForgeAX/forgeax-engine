import { type Mat4, mat4 } from '@forgeax/engine-math';
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

interface CameraFrameScratch {
  projection: CameraSnapshot['projection'];
  far: number;
  viewMatrix: Mat4;
  projectionMatrix: Mat4;
}

// Retain one free buffer pair; a reentrant operation acquires its own pair.
let freeCameraFrame: CameraFrameScratch | undefined;

function attachSubmittedCameraFrame(
  mapping: BarrelDistortionMapping,
  camera: CameraSnapshot,
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
    // Publication detaches both matrices before this synchronous call returns.
    return attachBarrelDistortionCameraFrame(mapping, frame);
  } finally {
    freeCameraFrame ??= frame;
  }
}

function identityBarrelMapping(
  camera: CameraSnapshot,
  width: number,
  height: number,
): BarrelDistortionMapping | undefined {
  const identity = createBarrelDistortionMapping(width, height, undefined);
  return identity.ok ? attachSubmittedCameraFrame(identity.value, camera) : undefined;
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
  return mapping.ok ? attachSubmittedCameraFrame(mapping.value, camera) : undefined;
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
    return mapping.ok ? attachSubmittedCameraFrame(mapping.value, camera) : undefined;
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
