import type { CameraSnapshot } from '../render-contract';
import type { ViewportOutputTopologyBucket } from '../viewport-output-contract';
import type { RenderFrameState } from './frame-snapshot';

/** Resolve the active viewport output bucket and suspend camera AA when inspecting raw surfaces. */
export function resolveViewportOutputState(
  frameState: RenderFrameState,
  camera: CameraSnapshot,
): {
  readonly vpBucket: ViewportOutputTopologyBucket | undefined;
  readonly effectiveCamera: CameraSnapshot;
} {
  const vpResolution = frameState.viewportOutputResolution;
  if (vpResolution?.activePath !== 'gbuffer-visualizer') {
    return { vpBucket: undefined, effectiveCamera: camera };
  }
  const effectiveCamera =
    vpResolution.suspendMsaa || vpResolution.suspendTemporalAa
      ? { ...camera, antialias: 'none' as const }
      : camera;
  return { vpBucket: vpResolution.topologyBucket, effectiveCamera };
}

/** Project graph camera overrides for Depth-of-Field and viewport visualization AA suspension. */
export function graphCameraWithViewportOutput(
  camera: CameraSnapshot,
  frameDepthOfField: CameraSnapshot['depthOfField'] | undefined,
  frameState: RenderFrameState,
): CameraSnapshot {
  const vpRes = frameState.viewportOutputResolution;
  const suspendAa =
    vpRes !== undefined &&
    vpRes.activePath === 'gbuffer-visualizer' &&
    (vpRes.suspendMsaa || vpRes.suspendTemporalAa) &&
    camera.antialias !== 'none';
  if (
    (frameDepthOfField === undefined || frameDepthOfField === camera.depthOfField) &&
    !suspendAa
  ) {
    return camera;
  }
  return {
    ...camera,
    ...(frameDepthOfField === undefined || frameDepthOfField === camera.depthOfField
      ? {}
      : { depthOfField: frameDepthOfField }),
    ...(suspendAa ? { antialias: 'none' as const } : {}),
  };
}

/** Ordered display bypasses the full post chain only when viewport debug output is inactive. */
export function admitsOrderedViewportStages<T>(
  topology: { readonly viewportOutput?: unknown },
  postStages: T | undefined,
): postStages is T {
  return topology.viewportOutput === undefined && postStages !== undefined;
}
