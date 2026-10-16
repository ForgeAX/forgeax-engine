import type {
  GraphBuffer,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import {
  type ComputeState,
  computeBindGroup,
  computePipelineError,
  createComputeState,
  resolvedGraphBuffer,
  resolvedGraphView,
} from '../compute-graph-state';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import {
  buildDepthPyramidPlan,
  DEPTH_PYRAMID_FORMAT,
  type DepthPyramidExtent,
  type DepthPyramidPlan,
} from './plan';

/**
 * Which depth bound each texel keeps. `closest` feeds screen-space tracers
 * (SSR); `furthest` feeds occlusion culling, where a texel may only hide
 * geometry that lies behind every sample it covers.
 */
export type DepthPyramidReduction = 'closest' | 'furthest';

/** Graph resource/pass prefix and shader entry suffix per reduction. */
const REDUCTION_NAMES: Readonly<
  Record<DepthPyramidReduction, { readonly graph: string; readonly entry: string }>
> = {
  closest: { graph: 'depth-pyramid', entry: '' },
  furthest: { graph: 'occlusion-depth-pyramid', entry: '_furthest' },
};

/** One view's closest-depth hierarchy, built once and read by every consumer. */
export interface DepthPyramid {
  readonly plan: DepthPyramidPlan;
  readonly texture: GraphTexture;
  /** Single-mip storage views, one per level, used by the producer chain. */
  readonly levels: readonly GraphTextureView[];
  /** All-mip sampled view that consumers bind. */
  readonly pyramid: GraphTextureView;
}

interface DepthPyramidGraphInputBase {
  /** Full-resolution scene depth of the view. */
  readonly depth: GraphTextureView;
  /** Shared View UBO; its projection range linearizes depth. */
  readonly view?: GraphBuffer;
  readonly width: number;
  readonly height: number;
}

/**
 * Only the furthest reduction seeds from multisampled depth: occlusion needs
 * every sample, while screen-space tracers read the resolved depth.
 */
export type DepthPyramidGraphInputs = DepthPyramidGraphInputBase &
  (
    | { readonly reduction?: 'closest' }
    | { readonly reduction: 'furthest'; readonly multisampled?: boolean }
  );

export interface DepthPyramidProjection {
  readonly pyramid: DepthPyramid;
  readonly passNames: readonly string[];
}

const SEED_ENTRIES = [
  {
    binding: 0,
    visibility: GPU_SHADER_STAGE_COMPUTE,
    texture: { sampleType: 'depth', viewDimension: '2d' },
  },
  {
    binding: 1,
    visibility: GPU_SHADER_STAGE_COMPUTE,
    storageTexture: { access: 'write-only', format: DEPTH_PYRAMID_FORMAT, viewDimension: '2d' },
  },
  { binding: 2, visibility: GPU_SHADER_STAGE_COMPUTE, buffer: { type: 'uniform' } },
] as const;

// Its own binding keeps each module binding single-typed for reflection.
const SEED_MULTISAMPLED_BINDING = 3;

const SEED_MULTISAMPLED_ENTRIES = [
  {
    binding: SEED_MULTISAMPLED_BINDING,
    visibility: GPU_SHADER_STAGE_COMPUTE,
    texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true },
  },
  SEED_ENTRIES[1],
  SEED_ENTRIES[2],
] as const;

const REDUCE_ENTRIES = [
  {
    binding: 0,
    visibility: GPU_SHADER_STAGE_COMPUTE,
    texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
  },
  {
    binding: 1,
    visibility: GPU_SHADER_STAGE_COMPUTE,
    storageTexture: { access: 'write-only', format: DEPTH_PYRAMID_FORMAT, viewDimension: '2d' },
  },
] as const;

function shaderSource(
  frame: RenderGraphFrame,
  stage: keyof NonNullable<RenderPipelineFrame['depthPyramidShaders']>,
): string | undefined {
  return (frame as RenderPipelineFrame).depthPyramidShaders?.[stage];
}

function halfExtent(extent: DepthPyramidExtent): DepthPyramidExtent {
  return {
    width: Math.max(1, Math.floor(extent.width / 2)),
    height: Math.max(1, Math.floor(extent.height / 2)),
  };
}

/** Derive the pyramid descriptor for a full-resolution view extent. */
export function planViewDepthPyramid(extent: DepthPyramidExtent): DepthPyramidPlan {
  // Full-resolution depth already exists. Store only its reduced hierarchy.
  return buildDepthPyramidPlan(halfExtent(extent));
}

/** Descriptor bytes of one view pyramid, derived from the same plan as allocation. */
export function estimateDepthPyramidMemory(extent: DepthPyramidExtent): number {
  return planViewDepthPyramid(extent).levels.reduce((sum, level) => {
    const bytes = sum + level.width * level.height * 4;
    if (!Number.isSafeInteger(bytes)) {
      throw new RangeError('depth pyramid descriptor byte count exceeds safe integer range');
    }
    return bytes;
  }, 0);
}

function createDepthPyramid(
  graph: RenderGraphBuilder<RenderGraphFrame>,
  extent: DepthPyramidExtent,
  name: string,
): Result<DepthPyramid, RenderGraphError> {
  const plan = planViewDepthPyramid(extent);
  const created = graph.createTexture(name, {
    format: DEPTH_PYRAMID_FORMAT,
    size: plan.graphSize,
    mipLevelCount: plan.mipLevelCount,
  });
  if (!created.ok) return created;
  const levels: GraphTextureView[] = [];
  for (const entry of plan.levels) {
    const view = graph.view(created.value, {
      label: `${name}.mip-${entry.level}.view`,
      dimension: '2d',
      baseMipLevel: entry.level,
      mipLevelCount: 1,
    });
    if (!view.ok) return view;
    levels.push(view.value);
  }
  const pyramid = graph.view(created.value, { label: `${name}.view`, dimension: '2d' });
  if (!pyramid.ok) return pyramid;
  return ok({
    plan,
    texture: created.value,
    levels: Object.freeze(levels),
    pyramid: pyramid.value,
  });
}

/**
 * Project one per-view depth pyramid into the caller's graph.
 *
 * The caller adds it only when an admitted consumer reads it, so a frame with
 * no consumer allocates nothing and records no pass.
 */
export function addDepthPyramidPasses<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  input: DepthPyramidGraphInputs,
): Result<DepthPyramidProjection, RenderGraphError> {
  const reduction = input.reduction ?? 'closest';
  const names = REDUCTION_NAMES[reduction];
  const multisampled = input.reduction === 'furthest' && input.multisampled === true;
  const seedPass = `${names.graph}-seed`;
  const reducePass = `${names.graph}-reduce-chain`;
  const created = createDepthPyramid(
    graph as RenderGraphBuilder<RenderGraphFrame>,
    { width: input.width, height: input.height },
    names.graph,
  );
  if (!created.ok) return created;
  const pyramid = created.value;
  const { depth, view } = input;
  const mip0 = pyramid.levels[0] as GraphTextureView;
  const passNames: string[] = [];
  let seedState: ComputeState | undefined;
  let reduceState: ComputeState | undefined;

  const seeded = graph.addComputePass(seedPass, {
    accesses: [
      { resource: depth, usage: 'sampled-read' },
      { resource: mip0, usage: 'storage-write' },
      ...(view === undefined ? [] : [{ resource: view, usage: 'uniform-read' as const }]),
    ],
    encode: ({ pass, frame, resources }) => {
      const source = shaderSource(frame, 'seed');
      // A structural graph may intentionally omit the shared View buffer. A
      // real seed must bind it because depth linearization uses the active
      // projection range; keep the structural path encode-free instead of
      // manufacturing a second near/far source.
      if (source === undefined || view === undefined) return;
      seedState ??= createComputeState(
        frame,
        source,
        'depth_pyramid_seed',
        multisampled ? SEED_MULTISAMPLED_ENTRIES : SEED_ENTRIES,
        `depth_pyramid_seed${names.entry}${multisampled ? '_multisampled' : ''}`,
      );
      pass.setPipeline(seedState.pipeline);
      pass.setBindGroup(
        0,
        computeBindGroup(frame, seedState, [
          {
            binding: multisampled ? SEED_MULTISAMPLED_BINDING : 0,
            resource: { kind: 'textureView', value: resolvedGraphView(resources, depth) },
          },
          {
            binding: 1,
            resource: { kind: 'textureView', value: resolvedGraphView(resources, mip0) },
          },
          {
            binding: 2,
            resource: {
              kind: 'buffer',
              value: { buffer: resolvedGraphBuffer(resources, view), size: VIEW_UNIFORM_BYTES },
            },
          },
        ]),
      );
      pass.dispatchWorkgroups(
        Math.ceil(pyramid.plan.extent.width / 8),
        Math.ceil(pyramid.plan.extent.height / 8),
        1,
      );
    },
  });
  if (!seeded.ok) return seeded;
  passNames.push(seedPass);

  const levels = pyramid.levels;
  if (levels.length > 1) {
    const reduced = graph.addComputePass(reducePass, {
      accesses: levels.map((resource, level) => ({
        resource,
        usage:
          level === 0
            ? 'sampled-read'
            : level === levels.length - 1
              ? 'storage-write'
              : 'sampled-storage-write',
      })),
      encode: ({ pass, frame, resources }) => {
        const source = shaderSource(frame, 'reduce');
        if (source === undefined) return;
        reduceState ??= createComputeState(
          frame,
          source,
          'depth_pyramid_reduce',
          REDUCE_ENTRIES,
          `depth_pyramid_reduce${names.entry}`,
        );
        pass.setPipeline(reduceState.pipeline);
        // Compute dispatches are ordered usage scopes. Each dispatch reads
        // only the completed preceding mip and writes a disjoint next mip.
        for (let level = 1; level < levels.length; level++) {
          const sourceLevel = levels[level - 1];
          const target = levels[level];
          const extent = pyramid.plan.levels[level];
          if (sourceLevel === undefined || target === undefined || extent === undefined)
            throw computePipelineError('depth pyramid mip chain');
          pass.setBindGroup(
            0,
            computeBindGroup(frame, reduceState, [
              {
                binding: 0,
                resource: { kind: 'textureView', value: resolvedGraphView(resources, sourceLevel) },
              },
              {
                binding: 1,
                resource: { kind: 'textureView', value: resolvedGraphView(resources, target) },
              },
            ]),
          );
          pass.dispatchWorkgroups(Math.ceil(extent.width / 8), Math.ceil(extent.height / 8), 1);
        }
      },
    });
    if (!reduced.ok) return reduced;
    passNames.push(reducePass);
  }
  return ok({ pyramid, passNames: Object.freeze(passNames) });
}
