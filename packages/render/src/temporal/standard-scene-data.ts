import type {
  GraphAccess,
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { isTemporalAntialias } from '../components/camera';
import { SceneDataUnavailableError } from '../errors/render';
import { motionBlurTemporalDemand } from '../features/motion-blur/motion-blur-params';
import type { RenderExtent } from '../pipeline/render-extent';
import { renderExtentSize } from '../pipeline/render-extent';
import type { WaterInfoGraphTargets } from '../pipeline/standard-build-context';
import { PREDEPTH_FRAGMENT_ENTRY } from '../predepth-coverage';
import { selectMainPassMaterials } from '../record/main-pass';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { scenePassContext } from '../record/scene-pass-work';
import type { CameraSnapshot } from '../render-contract';
import type {
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineTarget,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import { STANDARD_TEMPORAL_FORMAT } from '../standard-attachments';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
} from '../systems/pass-selector';
import { addTypedScenePass } from '../typed-render-graph-primitives';
import {
  type SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR,
  type SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
  type SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  type SCENE_DATA_TEMPORAL_V1_SCHEMA,
} from './scene-data';

export function bindStandardSceneDataTarget(
  target: RenderPipelineTarget,
  topology: import('../render-pipeline').RenderPipelineTopology,
  schema:
    | typeof SCENE_DATA_TEMPORAL_V1_SCHEMA
    | typeof SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA
    | typeof SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA
    | typeof SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_SCHEMA,
): RenderPipelineTarget {
  const owners = (topology.sceneDataBindings ?? [])
    .filter((binding) => binding.schema === schema)
    .flatMap((binding) => binding.owners);
  if (owners.length === 0) return target;
  const unique = new Map(
    owners.map((owner) => [
      `${owner.featureIdentity}:${owner.viewIdentity}:${owner.planIdentity}:${owner.generation}:${owner.deviceGeneration}:${owner.surfaceAdmissionIdentity ?? ''}:${owner.surfaceAdmissionRevision ?? ''}`,
      owner,
    ]),
  );
  return {
    ...target,
    sceneDataBindings: [{ schema, owners: Object.freeze([...unique.values()]) }],
  };
}

/** Scene history and the motion producer must agree on every temporal consumer. */
export function standardSceneTemporalDemand(
  camera: Pick<CameraSnapshot, 'antialias' | 'motionBlur'> | undefined,
  sceneConsumer = false,
): boolean {
  if (camera === undefined) return false;
  const motionBlur = camera.motionBlur;
  return (
    sceneConsumer ||
    isTemporalAntialias(camera.antialias) ||
    (motionBlur !== undefined &&
      motionBlurTemporalDemand({
        ...motionBlur,
        targetFps: motionBlur.targetFps ?? 60,
      }))
  );
}

export interface StandardTemporalDemandInput {
  readonly taa: boolean;
  readonly motionBlur: boolean;
  readonly ssr?: boolean;
  readonly gtao?: boolean;
  readonly visibleSurface?: boolean;
  /** Diffuse GI reprojects its history through the shared motion target. */
  readonly diffuseGi?: boolean;
}

export interface StandardTemporalDemand {
  readonly consumerIds: readonly (
    | 'taa'
    | 'motion-blur'
    | 'ssr'
    | 'gtao'
    | 'visible-surface'
    | 'diffuse-gi'
  )[];
  readonly targetCount: 0 | 1;
  readonly producerPassCount: 0 | 1;
  readonly historyCount: 0 | 1;
}

export interface StandardTemporalDemandDescription {
  readonly consumerCount: number;
  readonly targetCount: 0 | 1;
  readonly producerPassCount: 0 | 1;
  readonly historyCount: 0 | 1;
  readonly byteLength: 0 | 1;
}

/** Aggregate all temporal consumers before any graph resource is allocated. */
export function aggregateTemporalDemand(
  input: StandardTemporalDemandInput,
): StandardTemporalDemand {
  const consumerIds = [
    ...(input.taa ? (['taa'] as const) : []),
    ...(input.motionBlur ? (['motion-blur'] as const) : []),
    ...(input.ssr ? (['ssr'] as const) : []),
    ...(input.gtao ? (['gtao'] as const) : []),
    ...(input.visibleSurface ? (['visible-surface'] as const) : []),
    ...(input.diffuseGi ? (['diffuse-gi'] as const) : []),
  ];
  const requested = consumerIds.length > 0;
  return Object.freeze({
    consumerIds: Object.freeze(consumerIds),
    targetCount: requested ? 1 : 0,
    producerPassCount: requested ? 1 : 0,
    historyCount: input.taa ? 1 : 0,
  });
}

export function describeTemporalDemand(
  demand: StandardTemporalDemand,
): StandardTemporalDemandDescription {
  return {
    consumerCount: demand.consumerIds.length,
    targetCount: demand.targetCount,
    producerPassCount: demand.producerPassCount,
    historyCount: demand.historyCount,
    byteLength: demand.targetCount,
  };
}

export type StandardTemporalLane = 'direct' | 'clustered' | 'cpu-webgl2' | 'rhi-null';

export type StandardTemporalLaneAdmission =
  | {
      readonly status: 'available';
      readonly schema: typeof import('./scene-data').SCENE_DATA_TEMPORAL_V1_SCHEMA;
      readonly producerId: 'forgeax::standard::scene-data';
      readonly structuralOnly: boolean;
      readonly format: 'rgba16float';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'capability-missing' | 'producer-missing' | 'no-demand';
      readonly format?: never;
    };

export function standardTemporalLaneAdmission(input: {
  readonly lane: StandardTemporalLane;
  readonly demand: StandardTemporalDemand;
  readonly capabilities: {
    readonly compute: boolean;
    readonly storageBuffer: boolean;
    readonly rgba16floatRenderable: boolean;
    readonly filterable?: boolean;
    readonly copy?: boolean;
    readonly readback?: boolean;
    readonly producerPresent?: boolean;
  };
}): StandardTemporalLaneAdmission {
  if (input.demand.targetCount === 0) return { status: 'unavailable', reason: 'no-demand' };
  if (input.capabilities.producerPresent === false)
    return { status: 'unavailable', reason: 'producer-missing' };
  if (
    !input.capabilities.rgba16floatRenderable ||
    input.capabilities.filterable === false ||
    input.capabilities.copy === false ||
    input.capabilities.readback === false
  ) {
    return { status: 'unavailable', reason: 'capability-missing' };
  }
  return {
    status: 'available',
    schema: 'forgeax::scene-data::temporal-v1',
    producerId: 'forgeax::standard::scene-data',
    structuralOnly: input.lane === 'rhi-null',
    format: 'rgba16float',
  };
}

/**
 * Standard lanes fail the build when a temporal consumer demands scene data
 * the lane cannot produce. Capability probes are the sole authority: a
 * surface/storage format is not evidence that rgba16float targets render.
 */
export function requireStandardTemporalLane(input: {
  readonly demand: StandardTemporalDemand;
  readonly compute: boolean;
  readonly storageBuffer: boolean;
  readonly rgba16floatRenderable: boolean;
}): Result<void, SceneDataUnavailableError> {
  const lane = input.compute ? 'clustered' : 'cpu-webgl2';
  const admission = standardTemporalLaneAdmission({
    lane,
    demand: input.demand,
    capabilities: {
      compute: input.compute,
      storageBuffer: input.storageBuffer,
      rgba16floatRenderable: input.rgba16floatRenderable,
    },
  });
  if (admission.status === 'available' || admission.reason === 'no-demand') return ok(undefined);
  return err(
    new SceneDataUnavailableError({
      featureIdentity: 'forgeax::standard',
      schema: 'forgeax::scene-data::temporal-v1',
      lane,
      reason: admission.reason,
      missingContributorIds: [],
      omittedMissingContributorCount: 0,
      recovery: 'enable-capability',
    }),
  );
}

export function standardTemporalPostOrder(input: {
  readonly taa: boolean;
  readonly motionBlur: boolean;
  readonly bloom: boolean;
}): readonly string[] {
  const order = ['scene'];
  if (input.taa || input.motionBlur) order.push('standard-scene-data');
  if (input.taa) order.push('taa-resolve');
  if (input.motionBlur) order.push('motion-blur');
  if (input.bloom) order.push('bloom', 'tone');
  order.push('output');
  return Object.freeze(order);
}

export interface StandardSceneDataTargets {
  readonly temporal: RenderPipelineTarget;
}

const TEMPORAL_TARGET: GraphTextureDescriptor = {
  format: STANDARD_TEMPORAL_FORMAT,
  size: 'surface',
  sampleCount: 1,
};

/** The single Standard TAA current-frame producer target. */
export function createStandardSceneDataTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  extent?: RenderExtent,
): Result<StandardSceneDataTargets, RenderGraphError> {
  const temporal = createRenderPipelineTarget(graph, 'standard-scene-temporal', {
    ...TEMPORAL_TARGET,
    size: extent === undefined ? TEMPORAL_TARGET.size : renderExtentSize(extent, 'internal'),
  });
  return temporal.ok ? ok({ temporal: temporal.value }) : temporal;
}

/** The current-view surface depth alone, for a depth-only Forward prepass. */
export function createStandardSceneSurfaceDepthTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  size: GraphTextureDescriptor['size'],
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, 'standard-scene-surface-depth', {
    format: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.format,
    size,
    sampleCount: SCENE_DATA_STANDARD_SURFACE_DEPTH_V1_DESCRIPTOR.sampleCount,
  });
}

export function addStandardSceneDataPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  depth: RenderPipelineTarget,
  gpuDriven?: RenderPipelineGpuDrivenProjection,
  surfaces: 'opaque' | 'forward-only-opaque' = 'opaque',
  waterInfoTargets?: WaterInfoGraphTargets,
  extraAccesses?: readonly GraphAccess[],
  writeDepth = false,
): Result<void, RenderGraphError> {
  const selector = COLOR_PASS_SELECTOR;
  const excludeSelector = surfaces === 'forward-only-opaque' ? DEFERRED_PASS_SELECTOR : undefined;
  return addTypedScenePass(graph, {
    name: writeDepth ? 'standard-depth-velocity' : 'standard-scene-data',
    extraAccesses,
    // GBuffer already wrote this loaded target. An empty CPU supplement has
    // no work. The GPU owner derives live eligibility from its encoder predicate.
    executeIf:
      surfaces === 'opaque'
        ? undefined
        : (frame, request) =>
            selectMainPassMaterials(
              scenePassContext(frame as _InternalRenderPipelineContext, request),
              selector,
              'opaque',
              excludeSelector,
            )?.size !== 0 || gpuDriven?.hasWork(surfaces, 'fs_temporal') === true,
    gpuDrivenFilter: surfaces,
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
    ...(waterInfoTargets === undefined || waterInfoTargets.size === 0 ? {} : { waterInfoTargets }),
    color: target,
    depth,
    selector,
    ...(excludeSelector === undefined ? {} : { excludeSelector }),
    // The temporal producer runs before the Surface raw-depth/nearest-layer
    // pair. Keep it on the ordinary opaque Standard lane rather than asking
    // a medium material to assemble a bind group from resources that this
    // pass cannot own yet.
    recordMode: writeDepth ? 'opaque-depth' : 'opaque',
    ...(writeDepth ? { fragmentEntryPoint: 'fs_temporal_depth' } : {}),
    passKind: 'temporal',
    // Match the scene's raster coverage. The prepass owns depth, while the
    // late producer retains the depth already written by the color pass.
    clearColor: [0, 0, -1, 1],
    colorLoadOp: surfaces === 'opaque' ? 'clear' : 'load',
    depthLoadOp: writeDepth ? 'clear' : 'load',
  });
}

/**
 * Produce depth for Forward scene consumers. Alpha Mask draws retain
 * a colorless fragment entry to evaluate coverage.
 */
export function addStandardSceneSurfaceDataPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  depth: RenderPipelineTarget,
  gpuDriven?: RenderPipelineGpuDrivenProjection,
  name = 'standard-scene-surface-data',
  forwardDisplayDepth?: 'prepass',
): Result<void, RenderGraphError> {
  return addTypedScenePass(graph, {
    name,
    ...(gpuDriven === undefined ? {} : { gpuDriven }),
    gpuDrivenFilter: 'opaque',
    standardOpaqueRows: true,
    ...(forwardDisplayDepth === undefined ? {} : { forwardDisplayDepth }),
    colorTargets: [],
    depth,
    selector: FORWARD_PASS_SELECTOR,
    recordMode: 'opaque',
    passKind: 'forward',
    fragmentEntryPoint: PREDEPTH_FRAGMENT_ENTRY,
    colorLoadOp: 'clear',
    depthLoadOp: 'clear',
  });
}
