// Cube-target and reflection-probe capture views recorded beside the display
// view: compile their graphs before the display graph, then upload their View
// UBOs and execute them into the shared frame encoder.

import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import type { CloudShadowProjection } from '../cloud/shadow';
import { stageAtmospherePublish } from '../environment/storage';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { DirectionalLightSnapshot } from '../render-system-extract';
import type { TerrainShadowReceiver } from '../terrain/shadow-family';
import type { ViewLights } from '../world/render-lights';
import type { CubeCaptureFrameInput } from './frame';
import { buildPerFrameBindGroups } from './frame-lighting';
import type { BindGroupCounts, RenderFrameState } from './frame-snapshot';
import { createPassTimingInstrumentation } from './gpu-pass-timing/instrumentation';
import { flushMeshDrawUploads } from './mesh-ssbo';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RenderSystemInternals,
} from './render-context';
import { shadowViewPlanesByView } from './shadow-culling';
import type { CubeCaptureGraphWork } from './target-capture-graph';
import { prepareTargetCaptureLighting } from './target-capture-lighting';
import { compileTargetCaptureFrameGraph } from './typed-frame-graph';
import { writeViewUbo } from './view-ubo';

interface CompiledCaptureView {
  viewport: { readonly width: number; readonly height: number };
  graph: CompiledRenderGraph<RenderPipelineFrame>;
}

export type CubeCaptureFrame = ReturnType<
  typeof prepareTargetCaptureLighting<CubeCaptureGraphWork>
> &
  CompiledCaptureView;
export type ProbeCaptureFrame = ReturnType<typeof prepareTargetCaptureLighting> &
  CompiledCaptureView;

type CaptureCloudShadow =
  | (CloudShadowProjection & { readonly baseHeight: number; readonly thickness: number })
  | undefined;

function compileCubeCaptureFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  lights: ViewLights,
  cubeCapture: CubeCaptureFrameInput,
  work: CubeCaptureGraphWork,
  graphShadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
): CubeCaptureFrame {
  const lighting = prepareTargetCaptureLighting(
    cubeCapture.state,
    work,
    internals,
    frameState,
    pipelineState,
    lights,
  );
  const graph = compileTargetCaptureFrameGraph(
    lighting.runtime,
    lighting.frameState,
    lighting.pipeline,
    work.faceCamera,
    lighting.lights,
    graphShadowMapSize,
    { work: [work], atmosphere: lighting.capturedAtmosphere !== undefined },
    lighting.lighting,
    undefined,
    terrainReceivers,
  );
  return { ...lighting, graph, viewport: work.physical.descriptor };
}

function compileProbeCaptureFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  lights: ViewLights,
  cubeCapture: CubeCaptureFrameInput,
  probe: NonNullable<CubeCaptureFrameInput['reflectionProbes']>['graph']['work'][number],
  graphShadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
): ProbeCaptureFrame | undefined {
  if (probe.rawCaptureFace === undefined || probe.faceCamera === undefined) return undefined;
  const work = {
    ...probe,
    target: probe.rawTexture,
    faceCamera: probe.faceCamera,
    candidateGeneration: probe.captureGeneration ?? 0,
  };
  const lighting = prepareTargetCaptureLighting(
    cubeCapture.state,
    work,
    internals,
    frameState,
    pipelineState,
    lights,
  );
  const graph = compileTargetCaptureFrameGraph(
    lighting.runtime,
    lighting.frameState,
    lighting.pipeline,
    work.faceCamera,
    lighting.lights,
    graphShadowMapSize,
    { work: [], atmosphere: lighting.capturedAtmosphere !== undefined },
    lighting.lighting,
    { ...probe, viewBindGroupDynamicOffset: 0, step: undefined },
    terrainReceivers,
  );
  return { ...lighting, graph, viewport: { width: probe.rawSize, height: probe.rawSize } };
}

/** Cube-target faces first, then raw reflection-probe faces, in capture order. */
export function compileCaptureFrames(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  lights: ViewLights,
  cubeCapture: CubeCaptureFrameInput | undefined,
  cubeCaptureWork: readonly CubeCaptureGraphWork[],
  graphShadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
  captureFrames: CubeCaptureFrame[],
  probeCaptureFrames: ProbeCaptureFrame[],
): void {
  if (cubeCapture === undefined) return;
  for (const work of cubeCaptureWork)
    captureFrames.push(
      compileCubeCaptureFrame(
        internals,
        frameState,
        pipelineState,
        lights,
        cubeCapture,
        work,
        graphShadowMapSize,
        terrainReceivers,
      ),
    );
  for (const probe of cubeCapture.reflectionProbes?.graph.work ?? []) {
    const frame = compileProbeCaptureFrame(
      internals,
      frameState,
      pipelineState,
      lights,
      cubeCapture,
      probe,
      graphShadowMapSize,
      terrainReceivers,
    );
    if (frame !== undefined) probeCaptureFrames.push(frame);
  }
}

function executeCaptureFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  passCtx: _InternalRenderPipelineContext,
  capture: CubeCaptureFrame | ProbeCaptureFrame,
  light: DirectionalLightSnapshot,
  projectorSpotIndex: number | undefined,
  cloudShadowProjection: CaptureCloudShadow,
  elapsedSeconds: number | undefined,
  hasValidated: boolean,
  bindGroupCounts: BindGroupCounts,
): void {
  const timing = internals.gpuPassTimingCapture;
  writeViewUbo(
    internals.device.queue,
    capture.pipeline.viewUniformBuffer,
    capture.work.faceCamera,
    capture.lights.directional ?? light,
    capture.lights,
    frameState.spotShadowSnapshots,
    0,
    projectorSpotIndex,
    cloudShadowProjection,
    capture.frameState.environmentFrame?.fog,
    capture.capturedAtmosphere?.environment.source.kind === 'atmosphere'
      ? capture.capturedAtmosphere.environment.source.atmosphere
      : undefined,
    capture.work.sceneInput !== true,
    elapsedSeconds,
    capture.viewport,
    capture.frameState.environmentFrame?.sky,
  );
  const groups = buildPerFrameBindGroups(
    capture.runtime,
    capture.frameState,
    capture.pipeline,
    hasValidated,
    bindGroupCounts,
    undefined,
    true,
    capture.lighting,
  );
  const context = {
    ...passCtx,
    ...groups,
    runtime: capture.runtime,
    capturedAtmosphere: capture.capturedAtmosphere,
    pipelineState: capture.pipeline,
    camera: capture.work.faceCamera,
    shadowViewPlanesByView: shadowViewPlanesByView(capture.lights.shadowViews),
    frameState: capture.frameState,
    standardLighting: capture.lighting,
  };
  delete context.gpuDrivenShadowViews;
  delete context.shadowDirectRequired;
  delete context.directionalShadowCascadeMiss;
  delete context.gpuDrivenShadowBatchProjections;
  const executed = capture.graph.execute(
    context,
    undefined,
    timing === undefined ? undefined : createPassTimingInstrumentation(timing),
  );
  if (!executed.ok) throw executed.error;
  flushMeshDrawUploads(internals.device.queue, capture.pipeline.meshStorageBuffer);
  const publishCapture = capture.frameState.pendingAtmospherePublish;
  if (publishCapture !== undefined) stageAtmospherePublish(frameState, publishCapture);
  internals.framePassNames?.push(...capture.graph.inspect().passes.map((pass) => pass.name));
}

/** Capture views share the display pass context minus its GPU-owned shadow state. */
export function executeCaptureFrames(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  passCtx: _InternalRenderPipelineContext,
  captures: readonly (CubeCaptureFrame | ProbeCaptureFrame)[],
  light: DirectionalLightSnapshot,
  projectorSpotIndex: number | undefined,
  cloudShadowProjection: CaptureCloudShadow,
  elapsedSeconds: number | undefined,
  hasValidated: boolean,
  bindGroupCounts: BindGroupCounts,
): void {
  for (const capture of captures)
    executeCaptureFrame(
      internals,
      frameState,
      passCtx,
      capture,
      light,
      projectorSpotIndex,
      cloudShadowProjection,
      elapsedSeconds,
      hasValidated,
      bindGroupCounts,
    );
}
