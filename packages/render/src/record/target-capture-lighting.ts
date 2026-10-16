import { vec3 } from '@forgeax/engine-math';
import { selectEnvironment } from '../environment/frame';
import {
  type AtmosphereLease,
  retainAtmosphere,
  settleAtmospherePublish,
} from '../environment/storage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { resetHdrpBuffers } from '../hdrp-buffers';
import { computeDirectionalCsm, type ExtractedLights } from '../render-system-extract';
import { resetSsaoResources } from '../ssao-buffers';
import { prepareFrameLighting, writeHdrpClusterAndSsaoBuffers } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import { computeViewMatrix } from './helpers';
import type { PipelineState, RenderSystemInternals } from './render-context';
import type { CubeCaptureGraphState } from './target-capture-graph';
import { POINTS_LINES_VIEW_BUFFER_SIZE, VIEW_UNIFORM_BUFFER_SIZE } from './view-ubo';

interface CaptureLightingView {
  readonly runtime: RenderSystemInternals;
  state: RenderFrameState;
  generation?: number;
  atmosphere?: AtmosphereLease;
  frozenLights?: ExtractedLights;
  readonly viewBuffer: import('@forgeax/engine-rhi').Buffer;
  readonly pointsLinesViewBuffer: import('@forgeax/engine-rhi').Buffer;
}
// Keyed by a writer's ordinal among this frame's writers of its target: each
// needs its own view uniform because queue writes all land before submission,
// while a cube writing one face per frame keeps reusing ordinal 0.
const views = new WeakMap<CubeCaptureGraphState, Map<object, Map<number, CaptureLightingView>>>();

function retireView(view: CaptureLightingView): void {
  view.atmosphere?.release();
  resetHdrpBuffers(view.runtime);
  resetSsaoResources(view.runtime);
  const device = view.runtime.device;
  const release = () => {
    device.destroyBuffer(view.viewBuffer);
    device.destroyBuffer(view.pointsLinesViewBuffer);
  };
  void device.queue.onSubmittedWorkDone().then(release, release);
}

export function disposeTargetCaptureLighting(owner: CubeCaptureGraphState): void {
  for (const layers of views.get(owner)?.values() ?? [])
    for (const view of layers.values()) retireView(view);
  views.delete(owner);
}

/** Recovery and final disposal retire the complete capture generation together. */
export function disposeTargetCaptures(owner: CubeCaptureGraphState): void {
  disposeTargetCaptureLighting(owner);
  owner.planar?.dispose();
  delete owner.planar;
  owner.work = [];
}

/** Cluster bounds, uniforms, membership and bindings belong to the captured camera. */
export interface CaptureLightingInput {
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
  lights: ExtractedLights,
) {
  let retained = views.get(owner);
  if (retained === undefined) {
    retained = new Map();
    views.set(owner, retained);
  }
  for (const [target, layers] of retained) {
    const writers =
      owner.work.filter((item) => item.target === target).length +
      (owner.reflectionProbes?.work.filter((item) => item.rawTexture === target).length ?? 0);
    for (const [ordinal, view] of layers) {
      if (view.runtime.device === runtime.device && ordinal < writers) continue;
      retireView(view);
      layers.delete(ordinal);
    }
    if (layers.size === 0) retained.delete(target);
  }
  let layers = retained.get(work.target);
  if (layers === undefined) {
    layers = new Map();
    retained.set(work.target, layers);
  }
  // Reflection-probe work writes one face per frame, so it is absent here and keeps ordinal 0.
  const peers: readonly CaptureLightingInput[] = owner.work;
  const ordinal = Math.max(0, peers.filter((item) => item.target === work.target).indexOf(work));
  let view = layers.get(ordinal);
  if (view === undefined) {
    const device = runtime.device;
    const buffer = device.createBuffer({
      label: 'capture-view',
      size: VIEW_UNIFORM_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!buffer.ok) throw buffer.error;
    const pointsLines = device.createBuffer({
      label: 'capture-points-lines',
      size: POINTS_LINES_VIEW_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!pointsLines.ok) {
      device.destroyBuffer(buffer.value);
      throw pointsLines.error;
    }
    view = {
      // Resource caches and their retirement keep the creation device even
      // when the parent renderer installs a replacement during recovery.
      runtime: Object.create(runtime, {
        device: { value: device },
        encodeFramebufferSnapshots: { value: undefined },
      }) as RenderSystemInternals,
      state: { ...frameState },
      viewBuffer: buffer.value,
      pointsLinesViewBuffer: pointsLines.value,
    };
    layers.set(ordinal, view);
  }
  if (work.candidateGeneration === undefined || view.generation !== work.candidateGeneration) {
    view.atmosphere?.release();
    delete view.atmosphere;
    if (work.candidateGeneration === undefined) delete view.generation;
    else view.generation = work.candidateGeneration;
    const environment = work.atmosphere?.environment ?? frameState.environmentFrame;
    if (environment?.source.kind === 'atmosphere' && work.sceneInput !== true) {
      view.atmosphere = work.atmosphere?.retain() ?? retainAtmosphere(runtime, environment);
      const sun = environment.sun;
      view.frozenLights =
        sun === undefined || lights.directional === undefined
          ? lights
          : {
              ...lights,
              directional: {
                ...lights.directional,
                direction: vec3.create(-sun.direction[0], -sun.direction[1], -sun.direction[2]),
                color: vec3.create(
                  sun.color[0] * sun.intensity,
                  sun.color[1] * sun.intensity,
                  sun.color[2] * sun.intensity,
                ),
                intensity: sun.intensity,
              },
              directionalCsmDirection: vec3.create(
                -sun.direction[0],
                -sun.direction[1],
                -sun.direction[2],
              ),
            };
    } else delete view.frozenLights;
  }
  lights = view.frozenLights ?? lights;
  view.state = { ...frameState, hdrpClusterMembership: view.state.hdrpClusterMembership };
  settleAtmospherePublish(view.state, false);
  if (view.atmosphere !== undefined) {
    const frozen = view.atmosphere.storage.environment;
    const current = frameState.environmentFrame ?? frozen;
    // The retained generation pins physical atmosphere and Sun, not independent Fog.
    view.state.environmentFrame = selectEnvironment({
      environments: frozen.source.kind === 'none' ? [] : [frozen.source],
      suns: frozen.sun === undefined ? [] : [frozen.sun],
      fogs: current.fog === undefined ? [] : [current.fog],
      lane: current.lane,
    }).unwrap();
  }
  const csm =
    lights.directionalCsmConfig === undefined || lights.directionalCsmDirection === undefined
      ? null
      : computeDirectionalCsm(
          lights.directionalCsmDirection,
          lights.directionalCsmConfig,
          work.faceCamera,
        );
  const captureLights = csm === null ? lights : { ...lights, ...csm };
  const matrices = new Float32Array(64);
  for (let i = 0; i < 4; i++) {
    const matrix = captureLights.lightViewProj?.[i];
    if (matrix !== undefined) matrices.set(matrix, i * 16);
  }
  const capturePipeline = {
    ...pipeline,
    perPassResources: {
      ...pipeline.perPassResources,
      shadowCascadeCount: captureLights.cascadeCount ?? 0,
      shadowCsmLightViewProj: captureLights.lightViewProj === undefined ? null : matrices,
      shadowCsmSelection:
        captureLights.splitPlanes === undefined
          ? null
          : {
              viewMatrix: new Float32Array(computeViewMatrix(work.faceCamera)),
              splitPlanes: new Float32Array(captureLights.splitPlanes),
            },
    },
    viewUniformBuffer: view.viewBuffer,
    pointsLinesViewBuffer: view.pointsLinesViewBuffer,
  };
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
    capturedAtmosphere: view.atmosphere?.storage,
    frameState: view.state,
    lighting,
    lights: captureLights,
    pipeline: capturePipeline,
    work,
  };
}
