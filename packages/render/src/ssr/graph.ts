import type {
  ComputeGraphPass,
  GraphAccess,
  GraphBuffer,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { RenderGraphError } from '@forgeax/engine-render-graph';
import { err, mipDimension, numMipLevels, ok, type Result } from '@forgeax/engine-types';
import {
  computeBindGroup,
  computePipelineError,
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

interface WaterSsrTracePlan {
  readonly resolution: 'full';
  readonly algorithm: 'furthest-hzb-screen-ray';
  readonly groupSize: 4;
  readonly refinement: 'adjacent-depth-difference';
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
    temporal: GraphTextureView;
    inputParams?: GraphBuffer;
    sceneColorHistory?: GraphTextureView;
  }>;
  readonly admission: SsrSpatialAdmission;
  readonly width: number;
  readonly height: number;
  readonly depth?: GraphTextureView;
  /** Opaque tracing reads closest depth; the independent Water profile reads furthest depth. */
  readonly depthPyramid?: DepthPyramid;
  readonly normal?: GraphTextureView;
  /** Current-view radiance paired with depth; prior radiance belongs to the temporal resolve. */
  readonly scene?: GraphTextureView;
  /** Standard temporal-v1 source metadata, needed by trace even without history. */
  readonly currentTemporal?: GraphTextureView;
  /** Lighting-owned exact material coverage in alpha; RGB stays with composition. */
  readonly fallback?: GraphTextureView;
  /** Shared Standard View UBO used to reconstruct world-space SSR rays. */
  readonly view?: GraphBuffer;
  /** Shared Standard temporal-v1 target plus the SSR-owned history write. */
  readonly temporal?: {
    readonly previousHistory: GraphTextureView;
    readonly outputHistory: GraphTextureView;
    readonly params: GraphBuffer;
  } & (
    | {
        readonly profile: 'opaque';
        readonly previousSurface: GraphTextureView;
        readonly outputSurface: GraphTextureView;
      }
    | { readonly profile: 'single-layer-water' }
  );
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
  stage: 'trace' | 'temporal',
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
  return sources?.[stage];
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
  if (origin !== undefined) {
    const color = origin.sceneColorHistory;
    if (color === undefined)
      return ok({ scene, depthPyramid, opaque: undefined, waterHistory: undefined });
    if (depth === undefined) return missingInput('depth');
    if (currentTemporal === undefined) return missingInput('currentTemporal');
    return ok({
      scene,
      depthPyramid,
      opaque: undefined,
      waterHistory: { color, depth, currentTemporal },
    });
  }
  if (depth === undefined) return missingInput('depth');
  if (normal === undefined) return missingInput('normal');
  if (fallback === undefined) return missingInput('fallback');
  if (currentTemporal === undefined) return missingInput('currentTemporal');
  return ok({
    scene,
    depthPyramid,
    opaque: { depth, normal, fallback, currentTemporal },
    waterHistory: undefined,
  });
}

function admitSsrDescriptorCapacity(input: SsrSpatialGraphInputs) {
  const memory = estimateSsrSpatialMemory(input, {
    temporal: input.temporal !== undefined,
    resolutionScale: input.origin === undefined ? input.quality?.resolutionScale : 1,
    execution: input.execution ?? 'compute',
    forward: input.admission.lane === 'forward' || input.admission.lane === 'cpu-webgl2',
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

function resolvedSsrResources(
  base: SsrSpatialResources,
  resolved: SsrSpatialResources['resolved'],
  radiancePyramid: GraphTextureView | undefined,
  mipLevelCount: number,
): SsrSpatialResources {
  return {
    ...base,
    mipLevelCount,
    ...(resolved === undefined ? {} : { resolved }),
    ...(radiancePyramid === undefined ? {} : { radiancePyramid }),
  };
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
  );
}

/** The temporal surface stays full-size; trace-only reactivity follows the trace descriptor. */
function reactivitySurfaceFor(
  input: SsrSpatialGraphInputs,
  trace: SsrSpatialResources['trace'],
): NonNullable<SsrSpatialGraphProjection['reactivitySurface']> {
  const full = input.temporal?.profile === 'opaque';
  return {
    width: full ? Math.max(1, Math.floor(input.width)) : trace.width,
    height: full ? Math.max(1, Math.floor(input.height)) : trace.height,
    format: full ? 'rgba8unorm' : 'r32float',
  };
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
  const temporal = input.temporal;
  const capacity = admitSsrDescriptorCapacity(input);
  if (!capacity.ok) return capacity;
  const label = input.label ?? 'ssr';
  const origin = input.origin;
  const compactMaterial = input.compactMaterial;
  if (compactMaterial !== undefined && (origin !== undefined || input.gbufferV2 !== true))
    return missingInput('Default GBuffer B with an opaque receiver');
  const gbuffer = origin === undefined ? input : undefined;
  if (depthPyramid.reduction !== (origin === undefined ? 'closest' : 'furthest'))
    return missingInput(
      origin === undefined ? 'closest depthPyramid' : 'furthest depthPyramid',
      depthPyramid.reduction,
    );

  const resources = createTraceResources(graph, input, label);
  if (!resources.ok) return resources;
  const { trace, hitReactivity } = resources.value;
  const reactivity = temporal?.profile === 'opaque' ? temporal.outputSurface : hitReactivity;
  if (
    temporal !== undefined &&
    (temporal.profile === 'single-layer-water') !== (origin !== undefined)
  )
    return missingInput('matching receiver and temporal profile');
  let resolved: SsrSpatialResources['resolved'];
  let radiancePyramid: GraphTextureView | undefined;
  const reflectionLevels: GraphTextureView[] = [];
  const createSsrResolvedSurfaces = () => {
    if (temporal !== undefined) {
      const width = Math.max(1, Math.floor(input.width));
      const height = Math.max(1, Math.floor(input.height));
      const resolvedTexture = graph.createTexture(`${label}-resolved`, {
        format: 'rgba16float',
        size: { width, height },
        domain: 'linear-hdr',
        mipLevelCount: origin === undefined ? numMipLevels({ width, height }) : 1,
      });
      if (!resolvedTexture.ok) return resolvedTexture;
      const resolvedView = graph.view(resolvedTexture.value, {
        label: `${label}-resolved.view`,
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
      });
      if (!resolvedView.ok) return resolvedView;
      reflectionLevels.push(resolvedView.value);
      for (
        let level = 1;
        origin === undefined && level < numMipLevels({ width, height });
        level++
      ) {
        const view = graph.view(resolvedTexture.value, {
          label: `${label}-resolved.mip-${level}.view`,
          dimension: '2d',
          baseMipLevel: level,
          mipLevelCount: 1,
        });
        if (!view.ok) return view;
        reflectionLevels.push(view.value);
      }
      const pyramid = graph.view(resolvedTexture.value, {
        label: `${label}-resolved.pyramid.view`,
        dimension: '2d',
      });
      if (!pyramid.ok) return pyramid;
      radiancePyramid = pyramid.value;
      resolved = {
        texture: resolvedTexture.value,
        view: resolvedView.value,
        width,
        height,
        format: 'rgba16float',
      };
    }
    return undefined;
  };
  const resolvedSurfaceFailure = createSsrResolvedSurfaces();
  if (resolvedSurfaceFailure !== undefined) return resolvedSurfaceFailure;
  const passNames: string[] = [];
  if (input.execution === 'fragment') {
    if (opaque === undefined) return missingInput('compute execution for Water SSR');
    const added = addSsrFragmentStages(
      graph,
      { ...input, ...opaque, scene, depthPyramid },
      resources.value,
      resolved,
      reflectionLevels,
    );
    if (!added.ok) return added;
    return ok({
      enabled: true,
      passNames: added.value,
      resources: resolvedSsrResources(
        resources.value,
        resolved,
        radiancePyramid,
        Math.max(1, reflectionLevels.length),
      ),
      trace: buildSsrTracePlan(input.quality),
      reactivity,
      reactivitySurface: reactivitySurfaceFor(input, trace),
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
  if (waterHistory !== undefined)
    traceTextures.push(
      { binding: 0, view: waterHistory.depth, sampleType: 'depth' },
      { binding: 7, view: waterHistory.currentTemporal, sampleType: 'unfilterable-float' },
      { binding: 13, view: waterHistory.color, sampleType: 'unfilterable-float' },
    );
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
        {
          binding: 8,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
        },
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
      temporal: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'depth', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'uint', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 4,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 5,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        { binding: 6, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 7,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        { binding: 8, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 9,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 10,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
        {
          binding: 11,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
      waterTemporal: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'depth', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 4,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 5,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        { binding: 6, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 7,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        { binding: 8, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
        {
          binding: 12,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 13, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
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
          : shaderSource(frame, 'trace', gbuffer),
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
    const prepareTemporal = createComputeStatePreparation(
      (frame) =>
        input.view === undefined || (origin !== undefined && origin.inputParams === undefined)
          ? undefined
          : shaderSource(frame, 'temporal', gbuffer),
      'ssr_temporal',
      temporal?.profile === 'opaque' ? computeEntries.temporal : computeEntries.waterTemporal,
      origin === undefined ? 'ssr_temporal' : 'ssr_water_temporal',
      gbuffer === undefined ? undefined : ssrGBufferConstants(gbuffer),
    );
    const prepareReflectionMip = createComputeStatePreparation(
      (frame) => shaderSource(frame, 'temporal'),
      'ssr_temporal',
      [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 7,
          visibility: GPU_SHADER_STAGE_COMPUTE,
          storageTexture: {
            access: 'write-only',
            format: 'rgba16float',
            viewDimension: '2d',
          },
        },
      ],
      'ssr_reflection_mip',
    );
    registerScenePipelinePreparation(
      graph as unknown as RenderGraphBuilder<RenderPipelineFrame>,
      (frame) => {
        prepareTrace(frame);
        if (temporal !== undefined) prepareTemporal(frame);
        if (reflectionLevels.length > 1 && resolved !== undefined) prepareReflectionMip(frame);
        return false;
      },
      'utility',
    );
    return { prepareTrace, prepareTemporal, prepareReflectionMip };
  };
  const { prepareTrace, prepareTemporal, prepareReflectionMip } = createSsrProgramPreparations();
  const addSsrTraceProjection = () => {
    const added = addPass(
      graph,
      `${label}-trace`,
      [
        ...traceTextures.map(({ view }) => ({ resource: view, usage: 'sampled-read' as const })),
        { resource: trace.view, usage: 'storage-write' },
        { resource: hitReactivity, usage: 'storage-write' },
        ...(origin?.inputParams === undefined
          ? []
          : [{ resource: origin.inputParams, usage: 'uniform-read' as const }]),
        ...(input.view === undefined
          ? []
          : [{ resource: input.view, usage: 'uniform-read' as const }]),
      ],
      ({ pass, frame, resources: resolver }) => {
        const source = shaderSource(frame, 'trace', gbuffer);
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
            {
              binding: 8,
              resource: { kind: 'textureView', value: resolvedGraphView(resolver, hitReactivity) },
            },
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
  let added = addSsrTraceProjection();
  if (!added.ok) return added;
  passNames.push(`${label}-trace`);
  const addSsrTemporalProjection = () => {
    if (temporal !== undefined) {
      const receiverDepth = origin?.depth ?? opaque?.depth;
      const receiverMotion = origin?.temporal ?? opaque?.currentTemporal;
      if (receiverDepth === undefined || receiverMotion === undefined)
        return missingInput('temporal receiver depth and motion');
      added = addPass(
        graph,
        `${label}-temporal`,
        [
          { resource: trace.view, usage: 'sampled-read' },
          { resource: receiverDepth, usage: 'sampled-read' },
          ...(opaque === undefined
            ? []
            : [{ resource: opaque.normal, usage: 'sampled-read' as const }]),
          { resource: temporal.previousHistory, usage: 'sampled-read' },
          { resource: receiverMotion, usage: 'sampled-read' },
          ...(temporal.profile === 'opaque'
            ? [{ resource: hitReactivity, usage: 'sampled-read' as const }]
            : []),
          ...(origin === undefined
            ? []
            : [{ resource: origin.coverage, usage: 'sampled-read' as const }]),
          { resource: temporal.outputHistory, usage: 'storage-write' },
          ...(temporal.profile === 'opaque'
            ? [
                { resource: temporal.previousSurface, usage: 'sampled-read' as const },
                { resource: temporal.outputSurface, usage: 'storage-write' as const },
              ]
            : []),
          { resource: temporal.params, usage: 'uniform-read' },
          ...(origin?.inputParams === undefined
            ? []
            : [{ resource: origin.inputParams, usage: 'uniform-read' as const }]),
          ...(input.view === undefined
            ? []
            : [{ resource: input.view, usage: 'uniform-read' as const }]),
          ...(resolved === undefined
            ? []
            : [{ resource: resolved.view, usage: 'storage-write' as const }]),
        ],
        ({ pass, frame, resources: resolver }) => {
          const source = shaderSource(frame, 'temporal');
          if (source === undefined || input.view === undefined) return;
          if (origin !== undefined && origin.inputParams === undefined) return;
          const temporalState = prepareTemporal(frame);
          if (temporalState === undefined) return;
          pass.setPipeline(temporalState.pipeline);
          pass.setBindGroup(
            0,
            computeBindGroup(frame, temporalState, [
              ...(origin === undefined
                ? []
                : [
                    {
                      binding: 12,
                      resource: {
                        kind: 'textureView' as const,
                        value: resolvedGraphView(resolver, origin.coverage),
                      },
                    },
                  ]),
              ...(origin?.inputParams === undefined
                ? []
                : [
                    {
                      binding: 13,
                      resource: {
                        kind: 'buffer' as const,
                        value: { buffer: resolvedGraphBuffer(resolver, origin.inputParams) },
                      },
                    },
                  ]),
              ...(temporal.profile === 'opaque'
                ? [
                    {
                      binding: 11,
                      resource: {
                        kind: 'textureView' as const,
                        value: resolvedGraphView(resolver, hitReactivity),
                      },
                    },
                    {
                      binding: 9,
                      resource: {
                        kind: 'textureView' as const,
                        value: resolvedGraphView(resolver, temporal.previousSurface),
                      },
                    },
                    {
                      binding: 10,
                      resource: {
                        kind: 'textureView' as const,
                        value: resolvedGraphView(resolver, temporal.outputSurface),
                      },
                    },
                  ]
                : []),
              {
                binding: 8,
                resource: {
                  kind: 'buffer',
                  value: {
                    buffer: resolvedGraphBuffer(resolver, input.view),
                    size: VIEW_UNIFORM_BYTES,
                  },
                },
              },
              {
                binding: 0,
                resource: { kind: 'textureView', value: resolvedGraphView(resolver, trace.view) },
              },
              {
                binding: 1,
                resource: {
                  kind: 'textureView',
                  value: resolvedGraphView(resolver, receiverDepth),
                },
              },
              ...(opaque === undefined
                ? []
                : [
                    {
                      binding: 2,
                      resource: {
                        kind: 'textureView' as const,
                        value: resolvedGraphView(resolver, opaque.normal),
                      },
                    },
                  ]),
              {
                binding: 3,
                resource: {
                  kind: 'textureView',
                  value: resolvedGraphView(resolver, temporal.previousHistory),
                },
              },
              {
                binding: 4,
                resource: {
                  kind: 'textureView',
                  value: resolvedGraphView(resolver, receiverMotion),
                },
              },
              {
                binding: 5,
                resource: {
                  kind: 'textureView',
                  value: resolvedGraphView(resolver, temporal.outputHistory),
                },
              },
              {
                binding: 6,
                resource: {
                  kind: 'buffer',
                  value: { buffer: resolvedGraphBuffer(resolver, temporal.params) },
                },
              },
              ...(resolved === undefined
                ? []
                : [
                    {
                      binding: 7,
                      resource: {
                        kind: 'textureView' as const,
                        value: resolvedGraphView(resolver, resolved.view),
                      },
                    },
                  ]),
            ]),
          );
          pass.dispatchWorkgroups(
            Math.ceil(Math.max(1, input.width) / 8),
            Math.ceil(Math.max(1, input.height) / 8),
            1,
          );
        },
      );
      if (!added.ok) return added;
      passNames.push(`${label}-temporal`);
    }
    return undefined;
  };
  const temporalProjectionFailure = addSsrTemporalProjection();
  if (temporalProjectionFailure !== undefined) return temporalProjectionFailure;
  const addSsrReflectionMipProjection = () => {
    if (reflectionLevels.length > 1 && resolved !== undefined) {
      const output = resolved;
      const name = `${label}-reflection-mip-chain`;
      const added = addPass(
        graph,
        name,
        reflectionLevels.map((resource, level) => ({
          resource,
          usage:
            level === 0
              ? 'sampled-read'
              : level === reflectionLevels.length - 1
                ? 'storage-write'
                : 'sampled-storage-write',
        })),
        ({ pass, frame, resources: resolver }) => {
          const source = shaderSource(frame, 'temporal');
          if (source === undefined) return;
          const reflectionMipState = prepareReflectionMip(frame);
          if (reflectionMipState === undefined) return;
          pass.setPipeline(reflectionMipState.pipeline);
          for (let level = 1; level < reflectionLevels.length; level++) {
            const previous = reflectionLevels[level - 1];
            const target = reflectionLevels[level];
            if (previous === undefined || target === undefined)
              throw computePipelineError('SSR reflection mip chain');
            pass.setBindGroup(
              0,
              computeBindGroup(frame, reflectionMipState, [
                {
                  binding: 0,
                  resource: {
                    kind: 'textureView',
                    value: resolvedGraphView(resolver, previous),
                  },
                },
                {
                  binding: 7,
                  resource: {
                    kind: 'textureView',
                    value: resolvedGraphView(resolver, target),
                  },
                },
              ]),
            );
            pass.dispatchWorkgroups(
              Math.ceil(mipDimension(output.width, level) / 8),
              Math.ceil(mipDimension(output.height, level) / 8),
              1,
            );
          }
        },
      );
      if (!added.ok) return added;
      passNames.push(name);
    }
    return undefined;
  };
  const reflectionMipFailure = addSsrReflectionMipProjection();
  if (reflectionMipFailure !== undefined) return reflectionMipFailure;
  return ok({
    enabled: true,
    passNames: Object.freeze(passNames),
    resources: resolvedSsrResources(
      resources.value,
      resolved,
      radiancePyramid,
      Math.max(1, reflectionLevels.length),
    ),
    trace:
      origin === undefined
        ? buildSsrTracePlan(input.quality)
        : {
            resolution: 'full',
            algorithm: 'furthest-hzb-screen-ray',
            groupSize: 4,
            refinement: 'adjacent-depth-difference',
            profile: WATER_SSR_DEFAULT_PROFILE,
          },
    reactivity,
    reactivitySurface: reactivitySurfaceFor(input, trace),
  });
}
