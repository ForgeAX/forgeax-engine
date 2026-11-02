// Cube-target and reflection-probe capture views recorded beside the display
// view: compile their graphs before the display graph, then upload their View
// UBOs and execute them into the shared frame encoder.

import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import type { CloudShadowProjection } from '../cloud/shadow';
import { stageAtmospherePublish } from '../environment/storage';
import { RendererOperationError } from '../errors/render';
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

/** The cascade fit `render-capture-fit` prepared for a face; a face it did not fit cannot record. */
function fitOf(cubeCapture: CubeCaptureFrameInput, work: object): ViewLights {
  const fit = cubeCapture.fits.get(work);
  if (fit === undefined)
    throw new Error('A capture face records only the fit render-capture-fit prepared');
  return fit;
}

function compileCubeCaptureFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
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
    fitOf(cubeCapture, work),
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
    fitOf(cubeCapture, probe),
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
function compileCaptureFrames(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
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
      cubeCapture,
      probe,
      graphShadowMapSize,
      terrainReceivers,
    );
    if (frame !== undefined) probeCaptureFrames.push(frame);
  }
}

/** The capture compiler's explicit input; production resolves it from current view components. */
export interface CaptureGraphCompileInput {
  readonly internals: RenderSystemInternals;
  readonly frameState: RenderFrameState;
  readonly pipelineState: PipelineState;
  readonly capture: CubeCaptureFrameInput | undefined;
  readonly work: readonly CubeCaptureGraphWork[];
  readonly shadowMapSize: number | undefined;
  readonly terrainReceivers: readonly TerrainShadowReceiver[];
}

/** Graphs compiled for one view attempt, owned until its actual submission completes. */
export interface CaptureGraphBatch {
  readonly cube: readonly CubeCaptureFrame[];
  readonly probes: readonly ProbeCaptureFrame[];
}

export type CaptureGraphOutcome = Result<
  CaptureGraphBatch,
  RendererOperationError<'graph-build-failed'>
>;

export function captureGraphFailure(cause: unknown): RendererOperationError<'graph-build-failed'> {
  return new RendererOperationError('graph-build-failed', {
    operation: 'draw',
    cause: {
      code: 'capture-graph-unavailable',
      expected: 'render-capture-graph-compile compiles the current capture faces and fitted lights',
      hint: 'keep the capture preparation and RenderRecord systems registered and retry',
      detail: cause,
    },
  });
}

/** Release every successfully compiled graph, including a partially failed batch. */
export function retireCaptureGraphBatch(batch: CaptureGraphBatch): void {
  for (const capture of [...batch.cube, ...batch.probes]) void capture.graph.retire();
}

/** Compile through the same owner for a Render World view and a direct recorder. */
export function compileCaptureGraphBatch(input: CaptureGraphCompileInput): CaptureGraphOutcome {
  const cube: CubeCaptureFrame[] = [];
  const probes: ProbeCaptureFrame[] = [];
  try {
    compileCaptureFrames(
      input.internals,
      input.frameState,
      input.pipelineState,
      input.capture,
      input.work,
      input.shadowMapSize,
      input.terrainReceivers,
      cube,
      probes,
    );
    return ok({ cube, probes });
  } catch (cause) {
    retireCaptureGraphBatch({ cube, probes });
    return err(captureGraphFailure(cause));
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
