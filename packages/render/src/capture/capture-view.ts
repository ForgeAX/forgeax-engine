import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok } from '@forgeax/engine-types';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from '../pipeline/standard-lighting/graph';
import type { CubeCaptureGraphState } from '../record/target-capture-graph';
import { addTargetCaptureGraphPasses } from '../record/target-capture-graph';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipeline } from '../render-pipeline';
import { addTypedShadowPasses } from '../typed-shadow-passes';

/**
 * A capture view's camera: the auxiliary Camera with its display-only stages
 * removed. A capture writes the raw linear scene into its RenderTarget, so
 * temporal, post-processing and composition facts never reach its recording.
 */
export function captureViewCamera(camera: CameraSnapshot): CameraSnapshot {
  const {
    dynamicResolution: _dynamicResolution,
    ambientOcclusion: _ambientOcclusion,
    screenSpaceReflection: _screenSpaceReflection,
    temporal: _temporal,
    depthOfField: _depthOfField,
    depthOfFieldError: _depthOfFieldError,
    motionBlur: _motionBlur,
    barrelDistortion: _barrelDistortion,
    lensEffects: _lensEffects,
    lensFlare: _lensFlare,
    outline: _outline,
    projectedDecals: _projectedDecals,
    ...capture
  } = camera;
  return { ...capture, antialias: 'none', bloom: 'off', transparency: 'sorted' };
}

/** The capture camera named by `entityKey` among a frame's auxiliary cameras. */
export function selectCaptureViewCamera(
  auxiliary: readonly CameraSnapshot[],
  entityKey: number | undefined,
): CameraSnapshot | undefined {
  const camera = auxiliary.find(
    (candidate) =>
      candidate.entityKey === entityKey &&
      candidate.planarReflection === undefined &&
      candidate.target !== undefined,
  );
  return camera === undefined ? undefined : captureViewCamera(camera);
}

/**
 * The recording pipeline of a capture view: clustered light membership, the
 * view's GPU-driven shadow views, then the shared capture face pass writing
 * the target, with the view's own GPU-lane culling and indirect draws.
 * `state.work` is the live target write; the graph re-imports its physical
 * texture on every execution and recompiles when its descriptor changes.
 */
export function createCaptureViewPipeline(state: CubeCaptureGraphState): CaptureViewPipeline {
  const pipeline: CaptureViewPipeline = {
    identity: CAPTURE_VIEW_PIPELINE_ID,
    build(context, topology) {
      const graph = context.graph;
      const work = state.work[0];
      const lighting = context.standardLighting;
      if (work === undefined || lighting === undefined)
        return err(
          new RenderGraphError({
            code: 'resource-descriptor-invalid',
            expected: 'one capture target write and prepared Standard lighting',
            hint: 'record a capture view only while its RenderTarget is resident',
            detail: {
              resourceLabel: CAPTURE_VIEW_PIPELINE_ID,
              field: work === undefined ? 'work' : 'standardLighting',
              expected: 'present',
              actual: 'absent',
            },
          }),
        );
      const buffers = importStandardClusterBuffers(graph, lighting);
      if (!buffers.ok) return buffers;
      if (buffers.value !== null) {
        const membership = addStandardClusterMembershipPass(graph, lighting, buffers.value);
        if (!membership.ok) return membership;
      }
      const shadows = addTypedShadowPasses(graph, topology, {
        projectGpuDrivenShadow: context.projectGpuDrivenShadow,
        staticLayers: context.gpuDrivenShadowDepthLayers,
        depthLayers: context.shadowDepthLayers,
      });
      if (!shadows.ok) return shadows;
      const descriptor = work.physical.descriptor;
      const gpuDriven = context.projectGpuDriven({
        format: descriptor.format,
        sampleCount: descriptor.sampleCount === 4 ? 4 : 1,
        lateOcclusion: false,
      });
      if (!gpuDriven.ok) return gpuDriven;
      const face = addTargetCaptureGraphPasses(
        graph,
        {
          get work() {
            return state.work;
          },
          atmosphere: topology.atmosphere === true,
        },
        {
          shadows: shadows.value,
          accesses: buffers.value === null ? [] : standardClusterReadAccesses(buffers.value),
        },
        { gpuDriven: gpuDriven.value },
      );
      if (!face.ok) return face;
      return ok(undefined);
    },
  };
  return Object.freeze(pipeline);
}

export const CAPTURE_VIEW_PIPELINE_ID = 'forgeax::capture-view';

interface CaptureViewPipeline extends RenderPipeline {
  readonly identity: typeof CAPTURE_VIEW_PIPELINE_ID;
}

/** Stock and capture-view graphs report their actually projected directional views. */
export function isCaptureViewPipeline(pipeline: object): boolean {
  return (pipeline as { readonly identity?: unknown }).identity === CAPTURE_VIEW_PIPELINE_ID;
}
