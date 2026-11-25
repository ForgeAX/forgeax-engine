import type {
  ComputeGraphPass,
  GraphAccess,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  computeBindGroup,
  createComputeStatePreparation,
  resolvedGraphBuffer,
  resolvedGraphView,
} from '../compute-graph-state';
import type { DepthPyramid } from '../depth-pyramid/graph';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import { registerScenePipelinePreparation } from '../record/scene-pipeline-preparation';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { SsrSpatialAdmission } from './admission';
import { addSsrFragmentStages } from './raster';
import {
  createSsrSpatialResources,
  estimateSsrSpatialMemory,
  type SsrSpatialResources,
} from './resources';
import {
  type SsrGBufferInput,
  ssrGBufferConstants,
  ssrShaderGBufferMismatch,
} from './shader-layout';
import { WATER_SSR_DEFAULT_PROFILE } from './water-profile';

interface SsrTracePlan {
  readonly resolution: 'full' | 'half';
  readonly hizIterations: number;
  readonly linearIterations: number;
  readonly refineSteps: number;
}

interface WaterSsrTracePlan extends SsrTracePlan {
  readonly resolution: 'full';
  readonly algorithm: 'furthest-hzb-fixed-steps';
  readonly refinement: 'depth-crossing';
  readonly profile: typeof WATER_SSR_DEFAULT_PROFILE;
}

export function buildSsrTracePlan(
  budget?: import('../quality').RenderQualityBudgets['ssr'],
): SsrTracePlan {
  return Object.freeze({
    resolution: budget?.resolutionScale === 0.5 ? 'half' : 'full',
    hizIterations: budget?.hizIterations ?? 64,
    linearIterations: budget?.linearIterations ?? 1024,
    refineSteps: budget?.refineSteps ?? 5,
  });
}

export interface SsrSpatialGraphInputs extends SsrGBufferInput {
  readonly quality?: import('../quality').RenderQualityBudgets['ssr'] | undefined;
  readonly execution?: 'compute' | 'fragment';
  readonly label?: string;
  /** Independent displaced receiver; hit admission still reads the opaque scene. */
  readonly origin?: Readonly<{
    depth: GraphTextureView;
    normal: GraphTextureView;
    coverage: GraphTextureView;
    inputParams?: GraphBuffer;
    sceneColorHistory?: GraphTextureView;
  }>;
  readonly admission: SsrSpatialAdmission;
  readonly width: number;
  readonly height: number;
  readonly depth?: GraphTextureView;
  /** Both receiver types trace the furthest bound of opaque scene depth. */
  readonly depthPyramid?: DepthPyramid;
  readonly normal?: GraphTextureView;
  /** Current radiance is the fallback when temporal scene color is unavailable. */
  readonly scene?: GraphTextureView;
  readonly sceneColorHistory?: GraphTextureView;
  readonly forwardSampleCount?: 1 | 4 | undefined;
  /** Standard temporal-v1 source metadata, needed by trace even without history. */
  readonly currentTemporal?: GraphTextureView;
  /** Lighting-owned exact material coverage in alpha; RGB stays with composition. */
  readonly fallback?: GraphTextureView;
  /** Shared Standard View UBO used to reconstruct world-space SSR rays. */
  readonly view?: GraphBuffer;
}

export interface SsrSpatialGraphProjection {
  readonly enabled: boolean;
  readonly passNames: readonly string[];
  readonly resources: SsrSpatialResources | undefined;
  readonly trace: SsrTracePlan | WaterSsrTracePlan | undefined;
  /** SSR source reactivity reconstructed onto the presentation lattice. */
  readonly reactivity: GraphTextureView | undefined;
  /** Lattice and storage of `reactivity`; consumers size derived copies from it. */
  readonly reactivitySurface:
    | {
        readonly width: number;
        readonly height: number;
        readonly format: 'rgba8unorm' | 'r32float';
      }
    | undefined;
}

function missingInput(field: string, actual = 'missing'): Result<never, RenderGraphError> {
  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `admitted SSR spatial graph input '${field}'`,
      hint: `provide the Standard '${field}' graph view before building SSR`,
      detail: {
        resourceLabel: 'forgeax::ssr',
        field,
        expected: 'typed graph view',
        actual,
      },
    }),
  );
}

function shaderSource(
  frame: RenderGraphFrame,
  input: SsrGBufferInput = {},
): string | import('@forgeax/engine-types').ShaderSource | undefined {
  const sources = (frame as RenderPipelineFrame).ssrShaders;
  const mismatch = ssrShaderGBufferMismatch(sources, input);
  if (mismatch !== undefined)
    throw new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `${mismatch.expected} SSR readers`,
      hint: 'Rebuild the Engine shader manifest.',
      detail: {
        resourceLabel: 'ssr',
        field: 'gbuffer',
        ...mismatch,
      },
    });
  return sources?.trace;
}

function addPass<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  name: string,
  accesses: readonly GraphAccess[],
  encode: ComputeGraphPass<FrameCtx>['encode'] = () => undefined,
): Result<void, RenderGraphError> {
  return graph.addComputePass(name, { accesses, encode });
}

/**
 * Project the M1 spatial chain into the caller's typed graph.
 *
 * A non-admitted result exits before resource creation. The graph owns all
 * transient views and dependencies; this module never creates an encoder,
 * queue submission, public handle, or second renderer.
 */
function requiredSsrInputs(input: SsrSpatialGraphInputs) {
  const { depth, normal, scene, fallback, currentTemporal, depthPyramid, origin } = input;
  if (scene === undefined) return missingInput('scene');
  if (depthPyramid === undefined) return missingInput('depthPyramid');
  if (depth === undefined) return missingInput('depth');
  if (normal === undefined) return missingInput('normal');
  if (fallback === undefined) return missingInput('fallback');
  if (currentTemporal === undefined) return missingInput('currentTemporal');
  return ok({
    scene,
    depthPyramid,
    opaque: { depth, normal, fallback, currentTemporal },
    waterHistory:
      origin?.sceneColorHistory === undefined
        ? undefined
        : { color: origin.sceneColorHistory, depth, currentTemporal },
  });
}

function admitSsrDescriptorCapacity(input: SsrSpatialGraphInputs) {
  const memory = estimateSsrSpatialMemory(input, {
    resolutionScale: input.origin === undefined ? input.quality?.resolutionScale : 1,
    water: input.origin !== undefined,
    execution: input.execution ?? 'compute',
    depthPyramidBytes: input.depthPyramid?.plan.levels.reduce(
      (bytes, level) => bytes + level.width * level.height * Float32Array.BYTES_PER_ELEMENT,
      0,
    ),
    forward: input.admission.lane === 'forward' || input.admission.lane === 'cpu-webgl2',
    ...(input.forwardSampleCount === undefined
      ? {}
      : { forwardSampleCount: input.forwardSampleCount }),
  });
  if (!memory.withinBudget)
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'SSR descriptors fit the 320 MiB per-view budget',
        hint: 'reduce the internal render extent before requesting SSR',
        detail: {
          resourceLabel: 'forgeax::ssr',
          field: 'descriptorBytes',
          expected: `<=${memory.budgetBytes}`,
          actual: String(memory.ssrOwnedBytes),
        },
      }),
    );
  return ok(undefined);
}

/** Water keeps its own full-density receiver; opaque SSR uses its declared trace lattice. */
function createTraceResources<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  input: SsrSpatialGraphInputs,
  label: string,
): Result<SsrSpatialResources, RenderGraphError> {
  return createSsrSpatialResources(
    graph,
    { width: input.width, height: input.height },
    label,
    input.origin === undefined ? input.quality?.resolutionScale : 1,
    input.origin !== undefined,
  );
}

export function addSsrSpatialPasses<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  input: SsrSpatialGraphInputs,
): Result<SsrSpatialGraphProjection, RenderGraphError> {
  if (input.admission.status !== 'admitted') {
    return ok({
      enabled: false,
      passNames: Object.freeze([]),
      resources: undefined,
      trace: undefined,
      reactivity: undefined,
      reactivitySurface: undefined,
    });
  }
  const required = requiredSsrInputs(input);
  if (!required.ok) return required;
  const { scene, depthPyramid, opaque, waterHistory } = required.value;
  const capacity = admitSsrDescriptorCapacity(input);
  if (!capacity.ok) return capacity;
  const label = input.label ?? 'ssr';
  const origin = input.origin;
  const compactMaterial = input.compactMaterial;
  if (compactMaterial !== undefined && input.gbufferV2 !== true)
    return missingInput('Default GBuffer B with its matching normal layout');
  const gbuffer = input;
  if (depthPyramid.reduction !== 'furthest')
    return missingInput('furthest depthPyramid', depthPyramid.reduction);

  const resources = createTraceResources(graph, input, label);
  if (!resources.ok) return resources;
  const { trace, hitReactivity } = resources.value;
  const passNames: string[] = [];
  if (input.execution === 'fragment') {
    if (hitReactivity === undefined) return missingInput('compute execution for Water SSR');
    const added = addSsrFragmentStages(
      graph,
      { ...input, ...opaque, scene, depthPyramid },
      { trace, hitReactivity },
    );
    if (!added.ok) return added;
    return ok({
      enabled: true,
      passNames: added.value,
      resources: resources.value,
      trace: buildSsrTracePlan(input.quality),
      reactivity: hitReactivity,
      reactivitySurface: { width: trace.width, height: trace.height, format: 'r32float' },
    });
  }
  const traceTextures: {
    binding: number;
    view: GraphTextureView;
    sampleType: 'depth' | 'uint' | 'unfilterable-float';
  }[] = [
    { binding: 2, view: scene, sampleType: 'unfilterable-float' },
    { binding: 3, view: depthPyramid.pyramid, sampleType: 'unfilterable-float' },
  ];
  if (opaque !== undefined)
    traceTextures.push(
      { binding: 0, view: opaque.depth, sampleType: 'depth' },
      { binding: 1, view: opaque.normal, sampleType: 'uint' },
      { binding: 6, view: opaque.fallback, sampleType: 'unfilterable-float' },
      { binding: 7, view: opaque.currentTemporal, sampleType: 'unfilterable-float' },
    );
  if (compactMaterial !== undefined)
    traceTextures.push({ binding: 14, view: compactMaterial, sampleType: 'uint' });
  if (origin !== undefined)
    traceTextures.push(
      { binding: 9, view: origin.depth, sampleType: 'depth' },
      { binding: 10, view: origin.normal, sampleType: 'uint' },
      { binding: 11, view: origin.coverage, sampleType: 'unfilterable-float' },
    );
  traceTextures.push({
    binding: 13,
    view: waterHistory?.color ?? input.sceneColorHistory ?? scene,
    sampleType: 'unfilterable-float',
  });
  const createSsrComputeEntries = () => {
    const computeEntries = {
      trace: [
        ...traceTextures.map(({ binding, sampleType }) => ({
          binding,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType, viewDimension: '2d' as const },
        })),
        {
          binding: 4,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        { binding: 5, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        ...(hitReactivity === undefined
          ? []
          : [
              {
                binding: 8,
                visibility: GPU_SHADER_STAGE_COMPUTE,
                storageTexture: {
                  access: 'write-only' as const,
                  format: 'r32float' as const,
                  viewDimension: '2d' as const,
                },
              },
            ]),
        ...(origin === undefined
          ? []
          : [
              {
                binding: 12,
                visibility: GPU_SHADER_STAGE_COMPUTE,
                buffer: { type: 'uniform' as const },
              },
            ]),
      ],
    } as const;

    return computeEntries;
  };
  const computeEntries = createSsrComputeEntries();
  const createSsrProgramPreparations = () => {
    const prepareTrace = createComputeStatePreparation(
      (frame) =>
        input.view === undefined || (origin !== undefined && origin.inputParams === undefined)
          ? undefined
          : shaderSource(frame, gbuffer),
      'ssr_trace',
      computeEntries.trace,
      origin === undefined
        ? compactMaterial === undefined
          ? 'ssr_trace'
          : 'ssr_trace_compact'
        : origin.sceneColorHistory === undefined
          ? 'ssr_water_trace'
          : 'ssr_water_trace_history',
      gbuffer === undefined ? undefined : ssrGBufferConstants(gbuffer),
    );
    registerScenePipelinePreparation(
      graph as unknown as RenderGraphBuilder<RenderPipelineFrame>,
      (frame) => {
        prepareTrace(frame);
        return false;
      },
      'utility',
    );
    return prepareTrace;
  };
  const prepareTrace = createSsrProgramPreparations();
  const addSsrTraceProjection = () => {
    const added = addPass(
      graph,
      `${label}-trace`,
      [
        ...traceTextures.map(({ view }) => ({ resource: view, usage: 'sampled-read' as const })),
        { resource: trace.view, usage: 'storage-write' },
        ...(hitReactivity === undefined
          ? []
          : [{ resource: hitReactivity, usage: 'storage-write' as const }]),
        ...(origin?.inputParams === undefined
          ? []
          : [{ resource: origin.inputParams, usage: 'uniform-read' as const }]),
        ...(input.view === undefined
          ? []
          : [{ resource: input.view, usage: 'uniform-read' as const }]),
      ],
      ({ pass, frame, resources: resolver }) => {
        const source = shaderSource(frame, gbuffer);
        // Structural callers may omit the shared View buffer when they only
        // inspect topology. A real shader execution must bind it because the
        // trace reconstructs world position and reads the validated SSR tail.
        if (source === undefined || input.view === undefined) return;
        if (origin !== undefined && origin.inputParams === undefined) return;
        const traceState = prepareTrace(frame);
        if (traceState === undefined) return;
        pass.setPipeline(traceState.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, traceState, [
            ...traceTextures.map(({ binding, view }) => ({
              binding,
              resource: { kind: 'textureView' as const, value: resolvedGraphView(resolver, view) },
            })),
            ...(origin?.inputParams === undefined
              ? []
              : [
                  {
                    binding: 12,
                    resource: {
                      kind: 'buffer' as const,
                      value: { buffer: resolvedGraphBuffer(resolver, origin.inputParams) },
                    },
                  },
                ]),
            ...(hitReactivity === undefined
              ? []
              : [
                  {
                    binding: 8,
                    resource: {
                      kind: 'textureView' as const,
                      value: resolvedGraphView(resolver, hitReactivity),
                    },
                  },
                ]),
            {
              binding: 4,
              resource: { kind: 'textureView', value: resolvedGraphView(resolver, trace.view) },
            },
            {
              binding: 5,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: resolvedGraphBuffer(resolver, input.view),
                  size: VIEW_UNIFORM_BYTES,
                },
              },
            },
          ]),
        );
        pass.dispatchWorkgroups(Math.ceil(trace.width / 8), Math.ceil(trace.height / 8), 1);
      },
    );
    return added;
  };
  const added = addSsrTraceProjection();
  if (!added.ok) return added;
  passNames.push(`${label}-trace`);
  return ok({
    enabled: true,
    passNames: Object.freeze(passNames),
    resources: resources.value,
    trace:
      origin === undefined
        ? buildSsrTracePlan(input.quality)
        : {
            ...buildSsrTracePlan(input.quality),
            resolution: 'full',
            algorithm: 'furthest-hzb-fixed-steps',
            refinement: 'depth-crossing',
            profile: WATER_SSR_DEFAULT_PROFILE,
          },
    reactivity: hitReactivity,
    reactivitySurface:
      hitReactivity === undefined
        ? undefined
        : { width: trace.width, height: trace.height, format: 'r32float' },
  });
}
