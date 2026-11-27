// Cube-target and reflection-probe capture views recorded beside the display
// view. Prepare each writer's recording, upload its View UBO and issue its
// physical passes on the shared frame encoder.

import { err, ok, type Result } from '@forgeax/engine-rhi';
import type { CloudShadowProjection } from '../cloud/lighting/shadow';
import { stageAtmospherePublish } from '../environment/storage';
import { RendererOperationError } from '../errors/render';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { DirectionalLightSnapshot } from '../render-system-extract';
import { markPipelinePreparationPending } from '../render-system-presentation';
import type { TerrainShadowReceiver } from '../terrain/shadow-family';
import type { ResolvedShadowTargets, SharedShadowSource } from '../typed-shadow-passes';
import type { ViewLights } from '../world/render-lights';
import type { CubeCaptureFrameInput } from './frame';
import { buildPerFrameBindGroups } from './frame-lighting';
import type { BindGroupCounts, RenderFrameState } from './frame-snapshot';
import {
  createRenderGraphPassInstrumentation,
  renderGraphPassInstrumentationActive,
} from './frame-targets';
import { flushMeshDrawUploads } from './mesh-ssbo';
import {
  type CaptureRecording,
  NativeCaptureRecording,
  NativeProbeCapture,
} from './native-target-capture';
import type {
  _InternalRenderPipelineContext,
  PipelineState,
  RenderSystemInternals,
} from './render-context';
import { shadowViewPlanesByView } from './shadow-culling';
import type { CubeCaptureGraphWork } from './target-capture-graph';
import {
  finishTargetCaptureLighting,
  prepareTargetCaptureLighting,
} from './target-capture-lighting';
import { prepareTargetCaptureRecording } from './typed-frame-graph';
import { indirectSpecularMode, writeViewUbo } from './view-ubo';

interface CaptureViewRecording {
  viewport: { readonly width: number; readonly height: number };
  recording: CaptureRecording;
}

export type CubeCaptureFrame = ReturnType<
  typeof prepareTargetCaptureLighting<CubeCaptureGraphWork>
> &
  CaptureViewRecording;
export type ProbeCaptureFrame = ReturnType<typeof prepareTargetCaptureLighting> &
  CaptureViewRecording;
/** The planar mirror records inside the display graph, on the display view's shadows. */
export type PlanarCaptureFrame = CubeCaptureFrame & { readonly shadows: SharedShadowSource };

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

function prepareCubeCaptureFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  cubeCapture: CubeCaptureFrameInput,
  work: CubeCaptureGraphWork,
  graphShadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
  sharedShadows?: SharedShadowSource,
): CubeCaptureFrame {
  const lighting = prepareTargetCaptureLighting(
    cubeCapture.state,
    work,
    internals,
    frameState,
    pipelineState,
    fitOf(cubeCapture, work),
  );
  const viewport = {
    width: Math.max(1, work.physical.descriptor.width >> (work.mipLevel ?? 0)),
    height: Math.max(1, work.physical.descriptor.height >> (work.mipLevel ?? 0)),
  };
  const recording = prepareTargetCaptureRecording(
    lighting.runtime,
    lighting.frameState,
    viewport,
    lighting.lights,
    graphShadowMapSize,
    { work: [work], atmosphere: lighting.capturedAtmosphere !== undefined },
    lighting.lighting,
    undefined,
    terrainReceivers,
    sharedShadows,
    lighting.scenePasses,
  );
  return {
    ...lighting,
    recording,
    viewport,
  };
}

function prepareProbeCaptureFrame(
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
  const viewport = { width: probe.rawSize, height: probe.rawSize };
  const recording = prepareTargetCaptureRecording(
    lighting.runtime,
    lighting.frameState,
    viewport,
    lighting.lights,
    graphShadowMapSize,
    { work: [], atmosphere: lighting.capturedAtmosphere !== undefined },
    lighting.lighting,
    { ...probe, viewBindGroupDynamicOffset: 0, step: undefined },
    terrainReceivers,
    undefined,
    lighting.scenePasses,
  );
  return { ...lighting, recording, viewport };
}

interface RecordingCaptureBatch {
  cube: CubeCaptureFrame[];
  probes: ProbeCaptureFrame[];
  planar?: PlanarCaptureFrame;
}

/**
 * Cube-target faces first, then raw reflection-probe faces, in capture order.
 * The planar mirror records separately: the display graph records it after its
 * own shadows, which the mirror samples instead of rasterising its own.
 */
function compileCaptureFrames(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  cubeCapture: CubeCaptureFrameInput | undefined,
  cubeCaptureWork: readonly CubeCaptureGraphWork[],
  graphShadowMapSize: number | undefined,
  terrainReceivers: readonly TerrainShadowReceiver[],
  batch: RecordingCaptureBatch,
): void {
  if (cubeCapture === undefined) return;
  for (const work of cubeCaptureWork) {
    if (work.faceCamera.planarReflection !== undefined) {
      const shadows: SharedShadowSource = { current: undefined };
      const next = {
        ...prepareCubeCaptureFrame(
          internals,
          frameState,
          pipelineState,
          cubeCapture,
          work,
          graphShadowMapSize,
          terrainReceivers,
          shadows,
        ),
        shadows,
      };
      if (batch.planar !== undefined && !(batch.planar.recording instanceof NativeCaptureRecording))
        void batch.planar.recording.retire();
      batch.planar = next;
      continue;
    }
    batch.cube.push(
      prepareCubeCaptureFrame(
        internals,
        frameState,
        pipelineState,
        cubeCapture,
        work,
        graphShadowMapSize,
        terrainReceivers,
      ),
    );
  }
  for (const probe of cubeCapture.reflectionProbes?.graph.work ?? []) {
    const frame = prepareProbeCaptureFrame(
      internals,
      frameState,
      pipelineState,
      cubeCapture,
      probe,
      graphShadowMapSize,
      terrainReceivers,
    );
    if (frame !== undefined) batch.probes.push(frame);
  }
}

/** The capture compiler's explicit input; production resolves it from current view components. */
export interface CaptureGraphCompileInput {
  readonly internals: RenderSystemInternals;
  /** Immutable resolved camera identity for the producer that admits this pass vocabulary. */
  readonly cameraEntityKey?: number | undefined;
  readonly frameState: RenderFrameState;
  readonly pipelineState: PipelineState;
  readonly capture: CubeCaptureFrameInput | undefined;
  readonly work: readonly CubeCaptureGraphWork[];
  readonly shadowMapSize: number | undefined;
  readonly terrainReceivers: readonly TerrainShadowReceiver[];
}

/** Recordings owned by one view attempt through its submission. */
export interface CaptureGraphBatch {
  readonly cube: readonly CubeCaptureFrame[];
  readonly probes: readonly ProbeCaptureFrame[];
  readonly planar?: PlanarCaptureFrame | undefined;
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
  for (const { recording } of captureGraphFrames(batch))
    if (!(recording instanceof NativeCaptureRecording)) void recording.retire();
}

/** Every capture recording in the batch, the planar mirror last. */
export function captureGraphFrames(
  batch: CaptureGraphBatch,
): readonly (CubeCaptureFrame | ProbeCaptureFrame)[] {
  if (batch.planar !== undefined) return [...batch.cube, ...batch.probes, batch.planar];
  if (batch.cube.length === 0) return batch.probes;
  if (batch.probes.length === 0) return batch.cube;
  return [...batch.cube, ...batch.probes];
}

/** Compile through the same owner for a Render World view and a direct recorder. */
export function compileCaptureGraphBatch(input: CaptureGraphCompileInput): CaptureGraphOutcome {
  const batch: RecordingCaptureBatch = {
    cube: [],
    probes: [],
  };
  try {
    compileCaptureFrames(
      input.internals,
      input.frameState,
      input.pipelineState,
      input.capture,
      input.work,
      input.shadowMapSize,
      input.terrainReceivers,
      batch,
    );
    return ok(batch);
  } catch (cause) {
    retireCaptureGraphBatch(batch);
    return err(captureGraphFailure(cause));
  } finally {
    if (input.capture !== undefined) finishTargetCaptureLighting(input.capture.state);
  }
}

function captureGraphInstrumentation(capture: CubeCaptureFrame | ProbeCaptureFrame) {
  const captureInternals = capture.runtime;
  if (!renderGraphPassInstrumentationActive(captureInternals)) return undefined;
  const viewId = capture.work.faceCamera.entityKey;
  return createRenderGraphPassInstrumentation<RenderPipelineFrame>({
    internals: captureInternals,
    owner: 'capture',
    ...(viewId === undefined ? {} : { viewId }),
    ...(capture.recording instanceof NativeCaptureRecording
      ? { generation: capture.recording.generation }
      : { graph: capture.recording }),
  });
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
  lightTextureResamples: import('../prepare/extended-lighting/light-texture-resample').ScheduledLightTextureResample[],
): void {
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
    undefined,
    0,
    undefined,
    indirectSpecularMode(frameState.cameraStandardProfile ?? internals.standardProfile, false),
  );
  const groups = buildPerFrameBindGroups(
    capture.runtime,
    capture.frameState,
    capture.pipeline,
    hasValidated || capture.recording instanceof NativeProbeCapture,
    bindGroupCounts,
    capture.recording instanceof NativeCaptureRecording
      ? capture.recording.shadowTargets(capture.frameState)
      : undefined,
    true,
    capture.lighting,
  );
  const context = {
    ...passCtx,
    nativePassNames: internals.framePassNames,
    ...groups,
    runtime: capture.runtime,
    capturedAtmosphere: capture.capturedAtmosphere,
    pipelineState: capture.pipeline,
    camera: capture.work.faceCamera,
    // The face records only its own Feature plans, never the display view's.
    featureExecutions: (capture.work as CubeCaptureGraphWork).feature?.executions ?? [],
    shadowViewPlanesByView: shadowViewPlanesByView(capture.lights.shadowViews),
    frameState: capture.frameState,
    // Raw capture views have no display GI inputs.
    bakedField: undefined,
    standardLighting: capture.lighting,
    // Auxiliary capture graphs keep mesh cascades until they request their own
    // capsule surface/transport; display-view admission cannot suppress them.
    capsuleShadowDirectional: false,
  };
  delete context.capsuleShadowLight;
  delete context.planarReflectionCapture;
  delete context.gpuDrivenShadowViews;
  delete context.shadowDirectRequired;
  delete context.directionalShadowCascadeMiss;
  delete context.gpuDrivenShadowBatchProjections;
  const pendingResamples = capture.frameState.pendingLightTextureResamples;
  if (pendingResamples !== undefined) {
    for (const pending of pendingResamples) {
      const encoded = pending.work.execute(passCtx.encoder, internals.framePassNames);
      if (!encoded.ok) {
        pending.work.discard((error) => capture.runtime.errorRegistry.fire(error));
        for (const remaining of pendingResamples) {
          if (remaining !== pending) remaining.work.discard();
        }
        delete capture.frameState.pendingLightTextureResamples;
        throw encoded.error;
      }
    }
    lightTextureResamples.push(...pendingResamples);
    delete capture.frameState.pendingLightTextureResamples;
  }
  const instrumentation = captureGraphInstrumentation(capture);
  const execute = () => {
    if (capture.recording instanceof NativeCaptureRecording)
      return capture.recording.encode(context, instrumentation);
    const executed = capture.recording.execute(context, undefined, instrumentation);
    if (!executed.ok) throw executed.error;
  };
  // Only the program owner can distinguish a pending native compile from a
  // valid fallback or an unsupported request. Never infer it from a null draw.
  let encoded = true;
  const pending = () => {
    encoded = false;
    markPipelinePreparationPending(frameState, { code: 'scene-pipeline-preparation' });
  };
  const names = context.nativePassNames;
  const namesStart = names?.length ?? 0;
  let passSequenceCompleted = false;
  try {
    if (capture.runtime.withPipelinePreparationErrors === undefined) execute();
    else capture.runtime.withPipelinePreparationErrors(execute, pending);
    passSequenceCompleted = encoded && !capture.frameState.pipelinePreparationPending;
  } finally {
    if (!passSequenceCompleted && names !== undefined) names.length = namesStart;
  }
  if (capture.frameState.pipelinePreparationPending)
    markPipelinePreparationPending(
      frameState,
      capture.frameState.pipelinePreparationPendingReason ?? { code: 'scene-pipeline-preparation' },
    );
  if (
    encoded &&
    !capture.frameState.pipelinePreparationPending &&
    'candidateGeneration' in capture.work &&
    typeof capture.work.candidateGeneration === 'number'
  )
    (internals.viewContext?.root ?? internals).rendererCaptureOwner?.recordEncoded(
      capture.work.target,
      capture.work.candidateGeneration,
    );
  flushMeshDrawUploads(internals.device.queue, capture.pipeline.meshStorageBuffer);
  const publishCapture = capture.frameState.pendingAtmospherePublish;
  if (publishCapture !== undefined) stageAtmospherePublish(frameState, publishCapture);
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
  lightTextureResamples: import('../prepare/extended-lighting/light-texture-resample').ScheduledLightTextureResample[],
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
      lightTextureResamples,
    );
}

/**
 * Record the planar mirror from inside the display graph, once the display
 * view's shadows are written: the mirror's View UBO already carries the
 * display view's light matrices, so it samples those same layers.
 */
export function planarCaptureRecorder(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  passCtx: _InternalRenderPipelineContext,
  planar: PlanarCaptureFrame,
  light: DirectionalLightSnapshot,
  projectorSpotIndex: number | undefined,
  cloudShadowProjection: CaptureCloudShadow,
  elapsedSeconds: number | undefined,
  hasValidated: boolean,
  bindGroupCounts: BindGroupCounts,
  lightTextureResamples: import('../prepare/extended-lighting/light-texture-resample').ScheduledLightTextureResample[],
): (shadows: ResolvedShadowTargets) => void {
  return (shadows) => {
    planar.shadows.current = shadows;
    try {
      executeCaptureFrame(
        internals,
        frameState,
        passCtx,
        planar,
        light,
        projectorSpotIndex,
        cloudShadowProjection,
        elapsedSeconds,
        hasValidated,
        bindGroupCounts,
        lightTextureResamples,
      );
    } finally {
      planar.shadows.current = undefined;
    }
  };
}
