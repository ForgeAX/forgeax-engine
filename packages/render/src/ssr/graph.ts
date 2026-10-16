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
  type ComputeState,
  computeBindGroup,
  computePipelineError,
  createComputeState,
  resolvedGraphBuffer,
  resolvedGraphView,
} from '../compute-graph-state';
import type { DepthPyramid } from '../depth-pyramid/graph';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { SsrSpatialAdmission } from './admission';
import { createSsrSpatialResources, type SsrSpatialResources } from './resources';

export const SSR_TRACE_COARSE_STEPS = 48 as const;
export const SSR_TRACE_REFINE_STEPS = 5 as const;

export interface SsrTracePlan {
  readonly resolution: 'half';
  readonly coarseSteps: typeof SSR_TRACE_COARSE_STEPS;
  readonly refineSteps: typeof SSR_TRACE_REFINE_STEPS;
}

export function buildSsrTracePlan(): SsrTracePlan {
  return Object.freeze({
    resolution: 'half' as const,
    coarseSteps: SSR_TRACE_COARSE_STEPS,
    refineSteps: SSR_TRACE_REFINE_STEPS,
  });
}

export interface SsrSpatialGraphInputs {
  readonly admission: SsrSpatialAdmission;
  readonly width: number;
  readonly height: number;
  readonly depth?: GraphTextureView;
  /** Shared closest-depth pyramid of the same view; SSR only reads it. */
  readonly depthPyramid?: DepthPyramid;
  readonly normal?: GraphTextureView;
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
    readonly previousSurface: GraphTextureView;
    readonly outputSurface: GraphTextureView;
    readonly params: GraphBuffer;
  };
}

export interface SsrSpatialGraphProjection {
  readonly enabled: boolean;
  readonly passNames: readonly string[];
  readonly resources: SsrSpatialResources | undefined;
  readonly trace: SsrTracePlan | undefined;
  /** SSR source reactivity reconstructed onto the presentation lattice. */
  readonly reactivity: GraphTextureView | undefined;
}

function missingInput(field: string): Result<never, RenderGraphError> {
  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: `admitted SSR spatial graph input '${field}'`,
      hint: `provide the Standard '${field}' graph view before building SSR`,
      detail: {
        resourceLabel: 'forgeax::ssr',
        field,
        expected: 'typed graph view',
        actual: 'missing',
      },
    }),
  );
}

function shaderSource(
  frame: RenderGraphFrame,
  stage: keyof NonNullable<RenderPipelineFrame['ssrShaders']>,
): string | undefined {
  return (frame as RenderPipelineFrame).ssrShaders?.[stage];
}

function addPass(
  graph: RenderGraphBuilder<RenderGraphFrame>,
  name: string,
  accesses: readonly GraphAccess[],
  encode: ComputeGraphPass<RenderGraphFrame>['encode'] = () => undefined,
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
    });
  }
  const depth = input.depth;
  const normal = input.normal;
  const scene = input.scene;
  const fallback = input.fallback;
  const temporal = input.temporal;
  if (depth === undefined) return missingInput('depth');
  if (normal === undefined) return missingInput('normal');
  if (scene === undefined) return missingInput('scene');
  if (fallback === undefined) return missingInput('fallback');
  const currentTemporal = input.currentTemporal;
  if (currentTemporal === undefined) return missingInput('currentTemporal');
  const depthPyramid = input.depthPyramid;
  if (depthPyramid === undefined) return missingInput('depthPyramid');

  const resources = createSsrSpatialResources(graph as RenderGraphBuilder<RenderGraphFrame>, {
    width: input.width,
    height: input.height,
  });
  if (!resources.ok) return resources;
  const { trace, hitReactivity } = resources.value;
  const reactivity = temporal?.outputSurface ?? hitReactivity;
  let resolved: SsrSpatialResources['resolved'];
  let radiancePyramid: GraphTextureView | undefined;
  const reflectionLevels: GraphTextureView[] = [];
  if (temporal !== undefined) {
    const width = Math.max(1, Math.floor(input.width / 2));
    const height = Math.max(1, Math.floor(input.height / 2));
    const resolvedTexture = graph.createTexture('ssr-resolved', {
      format: 'rgba16float',
      size: { width, height },
      domain: 'linear-hdr',
      mipLevelCount: 1 + Math.floor(Math.log2(Math.max(width, height))),
    });
    if (!resolvedTexture.ok) return resolvedTexture;
    const resolvedView = graph.view(resolvedTexture.value, {
      label: 'ssr-resolved.view',
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
    });
    if (!resolvedView.ok) return resolvedView;
    reflectionLevels.push(resolvedView.value);
    for (let level = 1; level <= Math.floor(Math.log2(Math.max(width, height))); level++) {
      const view = graph.view(resolvedTexture.value, {
        label: `ssr-resolved.mip-${level}.view`,
        dimension: '2d',
        baseMipLevel: level,
        mipLevelCount: 1,
      });
      if (!view.ok) return view;
      reflectionLevels.push(view.value);
    }
    const pyramid = graph.view(resolvedTexture.value, {
      label: 'ssr-resolved.pyramid.view',
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
  const passNames: string[] = [];
  let traceState: ComputeState | undefined;
  let temporalState: ComputeState | undefined;
  let reflectionMipState: ComputeState | undefined;
  const computeEntries = {
    trace: [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'depth', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'uint', viewDimension: '2d' },
      },
      {
        binding: 2,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 3,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 4,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 5, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
      {
        binding: 6,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 7,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 8,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
      },
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
  } as const;

  let added = addPass(
    graph,
    'ssr-trace',
    [
      { resource: depth, usage: 'sampled-read' },
      { resource: normal, usage: 'sampled-read' },
      { resource: scene, usage: 'sampled-read' },
      { resource: fallback, usage: 'sampled-read' },
      { resource: depthPyramid.pyramid, usage: 'sampled-read' },
      { resource: trace.view, usage: 'storage-write' },
      { resource: currentTemporal, usage: 'sampled-read' },
      { resource: hitReactivity, usage: 'storage-write' },
      ...(input.view === undefined
        ? []
        : [{ resource: input.view, usage: 'uniform-read' as const }]),
    ],
    ({ pass, frame, resources: resolver }) => {
      const source = shaderSource(frame, 'trace');
      // Structural callers may omit the shared View buffer when they only
      // inspect topology. A real shader execution must bind it because the
      // trace reconstructs world position and reads the validated SSR tail.
      if (source === undefined || input.view === undefined) return;
      traceState ??= createComputeState(
        frame,
        source,
        'ssr_trace',
        computeEntries.trace,
        'ssr_trace',
      );
      pass.setPipeline(traceState.pipeline);
      pass.setBindGroup(
        0,
        computeBindGroup(frame, traceState, [
          {
            binding: 7,
            resource: { kind: 'textureView', value: resolvedGraphView(resolver, currentTemporal) },
          },
          {
            binding: 8,
            resource: { kind: 'textureView', value: resolvedGraphView(resolver, hitReactivity) },
          },
          {
            binding: 6,
            resource: { kind: 'textureView', value: resolvedGraphView(resolver, fallback) },
          },
          {
            binding: 0,
            resource: { kind: 'textureView', value: resolvedGraphView(resolver, depth) },
          },
          {
            binding: 1,
            resource: { kind: 'textureView', value: resolvedGraphView(resolver, normal) },
          },
          {
            binding: 2,
            resource: { kind: 'textureView', value: resolvedGraphView(resolver, scene) },
          },
          {
            binding: 3,
            resource: {
              kind: 'textureView',
              value: resolvedGraphView(resolver, depthPyramid.pyramid),
            },
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
      pass.dispatchWorkgroups(Math.ceil(input.width / 16), Math.ceil(input.height / 16), 1);
    },
  );
  if (!added.ok) return added;
  passNames.push('ssr-trace');
  if (temporal !== undefined) {
    added = addPass(
      graph,
      'ssr-temporal',
      [
        { resource: trace.view, usage: 'sampled-read' },
        { resource: depth, usage: 'sampled-read' },
        { resource: normal, usage: 'sampled-read' },
        { resource: temporal.previousHistory, usage: 'sampled-read' },
        { resource: currentTemporal, usage: 'sampled-read' },
        { resource: hitReactivity, usage: 'sampled-read' },
        { resource: temporal.outputHistory, usage: 'storage-write' },
        { resource: temporal.previousSurface, usage: 'sampled-read' },
        { resource: temporal.outputSurface, usage: 'storage-write' },
        { resource: temporal.params, usage: 'uniform-read' },
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
        temporalState ??= createComputeState(
          frame,
          source,
          'ssr_temporal',
          computeEntries.temporal,
          'ssr_temporal',
        );
        pass.setPipeline(temporalState.pipeline);
        pass.setBindGroup(
          0,
          computeBindGroup(frame, temporalState, [
            {
              binding: 11,
              resource: { kind: 'textureView', value: resolvedGraphView(resolver, hitReactivity) },
            },
            {
              binding: 9,
              resource: {
                kind: 'textureView',
                value: resolvedGraphView(resolver, temporal.previousSurface),
              },
            },
            {
              binding: 10,
              resource: {
                kind: 'textureView',
                value: resolvedGraphView(resolver, temporal.outputSurface),
              },
            },
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
              resource: { kind: 'textureView', value: resolvedGraphView(resolver, depth) },
            },
            {
              binding: 2,
              resource: { kind: 'textureView', value: resolvedGraphView(resolver, normal) },
            },
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
                value: resolvedGraphView(resolver, currentTemporal),
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
          Math.ceil(Math.max(1, input.width / 2) / 8),
          Math.ceil(Math.max(1, input.height / 2) / 8),
          1,
        );
      },
    );
    if (!added.ok) return added;
    passNames.push('ssr-temporal');
  }
  if (reflectionLevels.length > 1 && resolved !== undefined) {
    const output = resolved;
    const name = 'ssr-reflection-mip-chain';
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
        reflectionMipState ??= createComputeState(
          frame,
          source,
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
              storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
            },
          ],
          'ssr_reflection_mip',
        );
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
            Math.ceil(Math.max(1, output.width >> level) / 8),
            Math.ceil(Math.max(1, output.height >> level) / 8),
            1,
          );
        }
      },
    );
    if (!added.ok) return added;
    passNames.push(name);
  }
  return ok({
    enabled: true,
    passNames: Object.freeze(passNames),
    resources: {
      ...resources.value,
      ...(resolved === undefined ? {} : { resolved }),
      ...(radiancePyramid === undefined ? {} : { radiancePyramid }),
    },
    trace: buildSsrTracePlan(),
    reactivity,
  });
}
