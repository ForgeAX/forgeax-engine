import { selectEnvironment } from '../environment/frame';
import {
  type AtmosphereLease,
  retainAtmosphere,
  settleAtmospherePublish,
} from '../environment/storage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { resetHdrpBuffers } from '../hdrp-buffers';
import { resetSsaoResources } from '../ssao-buffers';
import type { ViewLights } from '../world/render-lights';
import { preparedPointsLinesSlots } from '../world/view-points-lines';
import { prepareFrameLighting, writeHdrpClusterAndSsaoBuffers } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import { createPointsLinesViewBuffer } from './points-lines-view-buffer';
import type { PipelineState, RenderSystemInternals } from './render-context';
import { CaptureScenePasses } from './scene-pass-work';
import type { CubeCaptureGraphState } from './target-capture-graph';
import { VIEW_UNIFORM_BUFFER_SIZE } from './view-ubo';

interface CaptureLightingView {
  readonly runtime: RenderSystemInternals;
  readonly scenePasses: CaptureScenePasses;
  state: RenderFrameState;
  generation?: number;
  atmosphere?: AtmosphereLease;
  readonly viewBuffer: import('@forgeax/engine-rhi').Buffer;
  readonly pointsLinesView: ReturnType<typeof createPointsLinesViewBuffer>;
}
// Every writer simultaneously submitted to one target needs a distinct uniform.
// The complete capture batch assigns ordinals in encoding order and trims its tail.
export type CaptureLightingViews = Map<object, { writers: CaptureLightingView[]; used: number }>;

function retireView(view: CaptureLightingView): void {
  view.atmosphere?.release();
  resetHdrpBuffers(view.runtime);
  resetSsaoResources(view.runtime);
  const device = view.runtime.device;
  view.pointsLinesView.dispose();
  const release = () => {
    device.destroyBuffer(view.viewBuffer);
  };
  void device.queue.onSubmittedWorkDone().then(release, release);
}

export function finishTargetCaptureLighting(owner: CubeCaptureGraphState): void {
  const targets = owner.lightingViews;
  if (targets === undefined) return;
  for (const [target, group] of targets) {
    while (group.writers.length > group.used)
      retireView(group.writers.pop() as CaptureLightingView);
    if (group.used === 0) targets.delete(target);
    group.used = 0;
  }
  if (targets.size === 0) delete owner.lightingViews;
}

export function disposeTargetCaptureLighting(owner: CubeCaptureGraphState): void {
  const targets = owner.lightingViews;
  if (targets === undefined) return;
  delete owner.lightingViews;
  for (const group of targets.values()) for (const view of group.writers) retireView(view);
  targets.clear();
}

/** Recovery and final disposal retire the complete capture generation together. */
export function disposeTargetCaptures(owner: CubeCaptureGraphState): void {
  disposeTargetCaptureLighting(owner);
  owner.planar?.dispose();
  delete owner.planar;
  owner.planarTarget?.release();
  delete owner.planarTarget;
  owner.work = [];
}

/** Capture-local lighting must reserve its own packed atmosphere region. */
function prepareCaptureClusterExtent(view: CaptureLightingView): void {
  const selected = view.state.environmentFrame?.source;
  view.state.standardClusterTextureExtent =
    !view.runtime.device.caps.storageBuffer &&
    selected?.kind === 'atmosphere' &&
    !selected.atmosphere.backgroundOnly
      ? { atmosphere: true }
      : undefined;
}

/** Cluster bounds, uniforms, membership and bindings belong to the captured camera. */
interface CaptureLightingInput {
  readonly target: object;
  readonly faceCamera: import('../render-contract').CameraSnapshot;
  readonly candidateGeneration?: number;
  readonly sceneInput?: true;
  readonly atmosphere?: import('../environment/storage').AtmosphereStorage | undefined;
}
export function prepareTargetCaptureLighting<T extends CaptureLightingInput>(
  owner: CubeCaptureGraphState,
  work: T,
  runtime: RenderSystemInternals,
  frameState: RenderFrameState,
  pipeline: PipelineState,
  /** The face's cascades, fitted in RenderPrepare by `render-capture-fit`. */
  captureLights: ViewLights,
) {
  owner.lightingViews ??= new Map();
  const targets = owner.lightingViews;
  let group = targets.get(work.target);
  if (group === undefined) {
    group = { writers: [], used: 0 };
    targets.set(work.target, group);
  }
  if (group.writers.length > 0 && group.writers[0]?.runtime.device !== runtime.device) {
    for (const view of group.writers) retireView(view);
    group.writers.length = 0;
    group.used = 0;
  }
  let view = group.writers[group.used];
  if (view === undefined) {
    const device = runtime.device;
    const buffer = device.createBuffer({
      label: 'capture-view',
      size: VIEW_UNIFORM_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!buffer.ok) throw buffer.error;
    let pointsLines: ReturnType<typeof createPointsLinesViewBuffer>;
    try {
      pointsLines = createPointsLinesViewBuffer(device);
    } catch (error) {
      device.destroyBuffer(buffer.value);
      throw error;
    }
    view = {
      // Resource caches and their retirement keep the creation device even
      // when the parent renderer installs a replacement during recovery.
      runtime: Object.create(runtime, {
        device: { value: device },
        encodeFramebufferSnapshots: { value: undefined },
      }) as RenderSystemInternals,
      scenePasses: new CaptureScenePasses(work.faceCamera),
      state: { ...frameState },
      viewBuffer: buffer.value,
      pointsLinesView: pointsLines,
    };
    group.writers.push(view);
  }
  group.used++;
  if (work.candidateGeneration === undefined || view.generation !== work.candidateGeneration) {
    view.atmosphere?.release();
    delete view.atmosphere;
    if (work.candidateGeneration === undefined) delete view.generation;
    else view.generation = work.candidateGeneration;
    const environment = work.atmosphere?.environment ?? frameState.environmentFrame;
    if (environment?.source.kind === 'atmosphere' && work.sceneInput !== true) {
      view.atmosphere = work.atmosphere?.retain() ?? retainAtmosphere(runtime, environment);
    }
  }
  view.state = {
    ...frameState,
    hdrpClusterMembership: view.state.hdrpClusterMembership,
  };
  settleAtmospherePublish(view.state, false);
  if (view.atmosphere !== undefined) {
    const frozen = view.atmosphere.storage.environment;
    const current = frameState.environmentFrame ?? frozen;
    // The retained generation pins physical atmosphere and Sun, not independent Fog.
    view.state.environmentFrame = selectEnvironment({
      environments: frozen.source.kind === 'none' ? [] : [frozen.source],
      suns: frozen.sun === undefined ? [] : [frozen.sun],
      fogs: current.fog === undefined ? [] : [current.fog],
    }).unwrap();
  }
  view.scenePasses.camera = work.faceCamera;
  const cascades = captureLights.cascades;
  // This frame's capture views grow to the slots `view-points-lines` prepared.
  view.pointsLinesView.ensureCapacity(preparedPointsLinesSlots(runtime));
  const capturePipeline = {
    ...pipeline,
    perPassResources: {
      ...pipeline.perPassResources,
      shadowCascadeCount: cascades?.cascadeCount ?? 0,
    },
    viewUniformBuffer: view.viewBuffer,
    get pointsLinesViewBuffer() {
      return view.pointsLinesView.buffer;
    },
  };
  prepareCaptureClusterExtent(view);
  const prepared = prepareFrameLighting(
    view.runtime,
    view.state,
    captureLights,
    work.faceCamera,
    capturePipeline,
  );
  if (!prepared.ok) throw prepared.error;
  const lighting = prepared.value.standard;
  if (lighting.kind === 'clustered') {
    const uploaded = writeHdrpClusterAndSsaoBuffers(
      view.runtime,
      view.state,
      work.faceCamera,
      lighting.prepared,
      lighting.transport,
      undefined,
      pipeline.hdrpClusterMembershipPipeline !== null,
      pipeline.hdrpClusterMembershipBindGroupLayout,
      undefined,
      pipeline,
    );
    if (!uploaded.ok) throw uploaded.error;
  }
  return {
    runtime: view.runtime,
    scenePasses: view.scenePasses,
    capturedAtmosphere: view.atmosphere?.storage,
    frameState: view.state,
    lighting,
    lights: captureLights,
    pipeline: capturePipeline,
    work,
  };
}
