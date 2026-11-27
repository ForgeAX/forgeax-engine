import type {
  GraphBuffer,
  GraphPassPreparation,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
  RenderGraphNativePass,
} from '@forgeax/engine-render-graph';
import { RenderGraphError as DepthGraphError } from '@forgeax/engine-render-graph';
import type { BindGroup, Buffer, RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type ComputeState,
  computePipelineError,
  resolvedGraphBuffer,
  resolvedGraphView,
} from '../compute-graph-state';
import type { GpuDrivenView } from '../gpu-driven/view-gpu';
import { GPU_SHADER_STAGE_COMPUTE } from '../gpu-stage';
import type { BindGroupCounts } from '../record/frame-snapshot';
import {
  bindGroupChainLeaf3,
  findFromChain,
  getOrCreateFromChain,
  rememberBindGroup,
} from '../record/mesh-ssbo';
import type { NativeGraphInputs } from '../record/native-graph-inputs';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { viewTargetTextures } from '../record/view-target-textures';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import { CurrentOcclusionDepth } from './current-occlusion';
import {
  buildDepthPyramidPlan,
  DEPTH_PYRAMID_FORMAT,
  type DepthPyramidExtent,
  type DepthPyramidPlan,
} from './plan';
import { createDepthPyramidProgramResolver, prepareDepthPyramidProgram } from './programs';
import { addFragmentDepthPyramidPasses } from './raster';

/**
 * Which positive view-distance bound each texel keeps. Consumers must select
 * traversal inequalities for this reduction, including its empty sentinel.
 */
export type DepthPyramidReduction = 'closest' | 'furthest';

/** Graph resource/pass prefix and shader entry suffix per reduction. */
const REDUCTION_NAMES: Readonly<
  Record<DepthPyramidReduction, { readonly graph: string; readonly entry: string }>
> = {
  closest: { graph: 'hzb-closest', entry: '' },
  furthest: { graph: 'hzb', entry: '_furthest' },
};

/** Both preparation and encoding issue bindings through this original program cache. */
function reductionNativeBinding(
  device: RhiDevice,
  counts: BindGroupCounts,
  state: ComputeState,
  views: readonly TextureView[],
  current?: () => boolean,
): BindGroup {
  if (current?.() === false) throw computePipelineError('current depth pyramid reduction binding');
  return getOrCreateFromChain(
    state.bindGroups,
    views,
    state.label,
    () => {
      const group = device
        .createBindGroup({
          layout: state.layout,
          entries: views.map((value, binding) => ({
            binding,
            resource: { kind: 'textureView' as const, value },
          })),
        })
        .unwrap();
      if (current?.() === false)
        throw computePipelineError('current depth pyramid reduction binding');
      return group;
    },
    counts,
  );
}

function seedNativeBinding(
  device: RhiDevice,
  counts: BindGroupCounts,
  state: ComputeState,
  sourceView: TextureView,
  targetView: TextureView,
  buffer: Buffer,
  multisampled: boolean,
  current?: () => boolean,
): BindGroup {
  if (current?.() === false) throw computePipelineError('current depth pyramid seed binding');
  const leaf = bindGroupChainLeaf3(state.bindGroups, sourceView, targetView, buffer);
  const cached = leaf.get(state.label);
  if (cached !== undefined) return cached;
  const group = device
    .createBindGroup({
      layout: state.layout,
      entries: [
        {
          binding: multisampled ? SEED_MULTISAMPLED_BINDING : 0,
          resource: { kind: 'textureView', value: sourceView },
        },
        { binding: 1, resource: { kind: 'textureView', value: targetView } },
        { binding: 2, resource: { kind: 'buffer', value: { buffer, size: VIEW_UNIFORM_BYTES } } },
      ],
    })
    .unwrap();
  if (current?.() === false) throw computePipelineError('current depth pyramid seed binding');
  return rememberBindGroup(leaf, state.label, group, counts);
}
function seedBindGroup(
  frame: RenderGraphFrame,
  state: ComputeState,
  resources: GraphResourceResolver,
  depth: GraphTextureView,
  target: GraphTextureView,
  view: GraphBuffer,
  multisampled: boolean,
): BindGroup {
  const context = frame as _InternalRenderPipelineContext;
  return seedNativeBinding(
    context.runtime.device,
    context.bindGroupCounts,
    state,
    resolvedGraphView(resources, depth),
    resolvedGraphView(resources, target),
    resolvedGraphBuffer(resources, view),
    multisampled,
  );
}

/** One view's hierarchy and the bound its producer actually reduced. */
export interface DepthPyramid {
  readonly reduction: DepthPyramidReduction;
  readonly plan: DepthPyramidPlan;
  readonly texture: GraphTexture;
  /** Single-mip storage views, one per level, used by the producer chain. */
  readonly levels: readonly GraphTextureView[];
  /** All-mip sampled view that consumers bind. */
  readonly pyramid: GraphTextureView;
}

interface DepthPyramidGraphInputBase {
  /** Distinct consumers may build the same reduction from different scene stages. */
  readonly label?: string;
  readonly nativeInputs?: NativeGraphInputs | undefined;
  /** Full-resolution scene depth of the view. */
  readonly depth: GraphTextureView;
  /** Finite physical plan; compute remains the default for existing callers. */
  readonly execution?: 'compute' | 'fragment';
  /** Shared View UBO; its projection range linearizes depth. */
  readonly view?: GraphBuffer;
  readonly mipLevelLimit?: number;
  /** Pad a Standard screen hierarchy to fixed two-pixel cells in viewport space. */
  readonly paddedView?: true;
  readonly width: number;
  readonly height: number;
}

/**
 * Furthest screen depth can resolve each MSAA pixel inline. Occlusion reads every sample.
 */
export type DepthPyramidGraphInputs = DepthPyramidGraphInputBase &
  (
    | { readonly reduction: 'closest' }
    | { readonly reduction?: 'furthest'; readonly multisampled?: boolean | 'nearest' }
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

const BATCHED_REDUCE_ENTRIES = [
  ...REDUCE_ENTRIES,
  { ...REDUCE_ENTRIES[1], binding: 2 },
  { ...REDUCE_ENTRIES[1], binding: 3 },
] as const;

/** This module owns the complete plain-data layout trees. */
function freezeDepthLayout<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) freezeDepthLayout(child);
  return Object.freeze(value);
}

const PROGRAM_LAYOUTS = new Map<readonly unknown[], string>();
for (const entries of [
  SEED_ENTRIES,
  SEED_MULTISAMPLED_ENTRIES,
  REDUCE_ENTRIES,
  BATCHED_REDUCE_ENTRIES,
]) {
  freezeDepthLayout(entries);
  PROGRAM_LAYOUTS.set(entries, JSON.stringify(entries));
}

function shaderSource(
  frame: RenderGraphFrame,
  stage: keyof NonNullable<RenderPipelineFrame['depthPyramidShaders']>,
): string | import('@forgeax/engine-types').ShaderSource | undefined {
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

/** UE screen HZB rounds each viewport axis up independently before halving. */
export function planPaddedViewDepthPyramid(extent: DepthPyramidExtent): DepthPyramidPlan {
  const mip0 = (size: number) => 2 ** Math.max(0, Math.ceil(Math.log2(size)) - 1);
  return buildDepthPyramidPlan({ width: mip0(extent.width), height: mip0(extent.height) });
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

function createDepthPyramid<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  plan: DepthPyramidPlan,
  name: string,
  reduction: DepthPyramidReduction,
): Result<DepthPyramid, RenderGraphError> {
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
    reduction,
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
function seedVariant(input: DepthPyramidGraphInputs) {
  if (input.reduction === 'closest') return 'seed';
  if (input.multisampled === 'nearest') return 'seed_furthest_resolve_msaa';
  return input.multisampled ? 'seed_furthest_multisampled' : 'seed_furthest';
}

function seedPreparation(
  input: DepthPyramidGraphInputs,
  target: GraphTextureView,
  multisampled: boolean,
): GraphPassPreparation {
  const native = input.nativeInputs;
  if (native === undefined) return {};
  let prepared: (() => boolean) | undefined;
  return {
    preparedResourcesCurrent: () => prepared?.() === true,
    *prepareResources(resources, current) {
      prepared = undefined;
      const source = native.depthPyramidShaders?.seed;
      if (source === undefined) throw computePipelineError('published depth pyramid seed source');
      const entries = multisampled ? SEED_MULTISAMPLED_ENTRIES : SEED_ENTRIES;
      const program = yield* prepareDepthPyramidProgram(
        native,
        source,
        entries,
        seedVariant(input),
        current,
        PROGRAM_LAYOUTS.get(entries),
      );
      const depth = resources.createdTextureView(input.depth),
        output = resources.createdTextureView(target);
      if (depth === undefined || output === undefined)
        throw computePipelineError('actual created depth pyramid seed views');
      const buffer = native.viewUniformBuffer;
      const inputsCurrent = () =>
        program.isCurrent() &&
        native.depthPyramidShaders?.seed === source &&
        native.viewUniformBuffer === buffer &&
        resources.createdTextureView(input.depth) === depth &&
        resources.createdTextureView(target) === output;
      const group = seedNativeBinding(
        native.device,
        native.counts,
        program.state,
        depth,
        output,
        buffer,
        multisampled,
        () => current() && inputsCurrent(),
      );
      const handles = [depth, output, buffer];
      prepared = () =>
        inputsCurrent() &&
        findFromChain(program.state.bindGroups, handles, program.state.label) === group;
      if (!current() || !prepared())
        throw computePipelineError('current prepared depth pyramid seed');
      yield;
    },
  };
}

interface ReductionStep {
  readonly firstOutput: number;
  readonly views: readonly GraphTextureView[];
  readonly variant: 'reduce' | 'reduce_furthest' | 'reduce_furthest_batch';
  readonly entries: typeof REDUCE_ENTRIES | typeof BATCHED_REDUCE_ENTRIES;
}

function reductionSteps(
  input: DepthPyramidGraphInputs,
  levels: readonly GraphTextureView[],
): ReductionStep[] {
  const steps: ReductionStep[] = [];
  const furthest = input.reduction !== 'closest';
  for (let level = 1; level < levels.length; ) {
    const batch = furthest && input.paddedView && level + 2 < levels.length;
    const count = batch ? 3 : 1;
    steps.push({
      firstOutput: level,
      views: levels.slice(level - 1, level + count),
      variant: batch ? 'reduce_furthest_batch' : furthest ? 'reduce_furthest' : 'reduce',
      entries: batch ? BATCHED_REDUCE_ENTRIES : REDUCE_ENTRIES,
    });
    level += count;
  }
  return steps;
}

function reductionPreparation(
  input: DepthPyramidGraphInputs,
  steps: readonly ReductionStep[],
): GraphPassPreparation {
  const native = input.nativeInputs;
  if (native === undefined) return {};
  let prepared: (() => boolean) | undefined;
  return {
    preparedResourcesCurrent: () => prepared?.() === true,
    *prepareResources(resources, current) {
      prepared = undefined;
      const source = native.depthPyramidShaders?.reduce;
      if (source === undefined)
        throw computePipelineError('published depth pyramid reduction source');
      const bindings: (() => boolean)[] = [];
      const programs = new Map<
        ReductionStep['variant'],
        { state: ComputeState; isCurrent: () => boolean }
      >();
      for (const { views, variant, entries } of steps) {
        let prepared = programs.get(variant);
        if (prepared === undefined) {
          prepared = yield* prepareDepthPyramidProgram(
            native,
            source,
            entries,
            variant,
            current,
            PROGRAM_LAYOUTS.get(entries),
          );
          programs.set(variant, prepared);
        }
        const program = prepared;
        const handles = views.map((view) => {
          const texture = resources.createdTextureView(view);
          if (texture === undefined)
            throw computePipelineError('actual created depth pyramid reduction views');
          return texture;
        });
        const inputsCurrent = () =>
          program.isCurrent() &&
          native.depthPyramidShaders?.reduce === source &&
          views.every((view, index) => resources.createdTextureView(view) === handles[index]);
        const group = reductionNativeBinding(
          native.device,
          native.counts,
          program.state,
          handles,
          () => current() && inputsCurrent(),
        );
        bindings.push(
          () =>
            inputsCurrent() &&
            findFromChain(program.state.bindGroups, handles, program.state.label) === group,
        );
        yield;
      }
      prepared = () => bindings.every((binding) => binding());
      if (!current() || !prepared())
        throw computePipelineError('current prepared depth pyramid reduction');
    },
  };
}

export function addDepthPyramidPasses<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  input: DepthPyramidGraphInputs,
): Result<DepthPyramidProjection, RenderGraphError> {
  if (input.execution === 'fragment' && input.reduction !== 'closest' && input.multisampled)
    return err(
      new DepthGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'single-sampled depth for the portable pyramid',
        hint: 'retain the conservative compute seed for multisampled occlusion depth',
        detail: {
          resourceLabel: 'occlusion-hzb',
          field: 'multisampled',
          expected: 'false',
          actual: 'true',
        },
      }),
    );
  const reduction = input.reduction ?? 'furthest';
  const names = REDUCTION_NAMES[reduction];
  const label = input.label ?? names.graph;
  const multisampled = input.reduction !== 'closest' && Boolean(input.multisampled);
  const seedPass = `${label}-seed`;
  const reducePass = `${label}-reduce-chain`;
  const fullPlan = input.paddedView
    ? planPaddedViewDepthPyramid(input)
    : planViewDepthPyramid(input);
  const mipLevelCount = Math.min(
    fullPlan.mipLevelCount,
    input.mipLevelLimit ?? fullPlan.mipLevelCount,
  );
  const plan =
    mipLevelCount === fullPlan.mipLevelCount
      ? fullPlan
      : {
          ...fullPlan,
          mipLevelCount,
          levels: fullPlan.levels.slice(0, mipLevelCount),
        };
  const created = createDepthPyramid(graph, plan, label, reduction);
  if (!created.ok) return created;
  const pyramid = created.value;
  if (input.execution === 'fragment')
    return addFragmentDepthPyramidPasses(graph, input, pyramid, label);
  const { depth, view } = input;
  const mip0 = pyramid.levels[0] as GraphTextureView;
  const passNames: string[] = [];
  const program = createDepthPyramidProgramResolver(PROGRAM_LAYOUTS);

  const seeded = graph.addComputePass(seedPass, {
    ...seedPreparation(input, mip0, multisampled),
    accesses: [
      { resource: depth, usage: 'sampled-read' },
      { resource: mip0, usage: 'storage-write' },
      ...(view === undefined ? [] : [{ resource: view, usage: 'uniform-read' as const }]),
    ],
    encodeDirect: (pass, frame, resources) => {
      const source = shaderSource(frame, 'seed');
      // A structural graph may intentionally omit the shared View buffer. A
      // real seed must bind it because depth linearization uses the active
      // projection range; keep the structural path encode-free instead of
      // manufacturing a second near/far source.
      if (source === undefined || view === undefined) return;
      const seedState = program(
        frame,
        source,
        multisampled ? SEED_MULTISAMPLED_ENTRIES : SEED_ENTRIES,
        seedVariant(input),
      );
      pass.setPipeline(seedState.pipeline);
      pass.setBindGroup(
        0,
        seedBindGroup(frame, seedState, resources, depth, mip0, view, multisampled),
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
    const steps = reductionSteps(input, levels);
    const reduced = graph.addComputePass(reducePass, {
      ...reductionPreparation(input, steps),
      accesses: levels.map((resource, level) => ({
        resource,
        usage:
          level === 0
            ? 'sampled-read'
            : level === levels.length - 1
              ? 'storage-write'
              : 'sampled-storage-write',
      })),
      encodeDirect: (pass, frame, resources) => {
        const source = shaderSource(frame, 'reduce');
        if (source === undefined) return;
        const context = frame as RenderGraphFrame as _InternalRenderPipelineContext;
        const programs = new Map<ReductionStep['variant'], ComputeState>();
        for (const { firstOutput, views, variant, entries } of steps) {
          const extent = pyramid.plan.levels[firstOutput];
          if (extent === undefined) throw computePipelineError('depth pyramid mip chain');
          let state = programs.get(variant);
          if (state === undefined) {
            state = program(frame, source, entries, variant);
            programs.set(variant, state);
          }
          const handles = views.map((view) => resolvedGraphView(resources, view));
          pass.setPipeline(state.pipeline);
          pass.setBindGroup(
            0,
            reductionNativeBinding(context.runtime.device, context.bindGroupCounts, state, handles),
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

/** A stock camera's late kernels consume its early depth on the same physical encoder. */
export function addCurrentCameraOcclusion(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: {
    readonly depth: GraphTextureView;
    readonly view: GraphBuffer;
    readonly width: number;
    readonly height: number;
    readonly multisampled: boolean;
  },
  currentView: () => GpuDrivenView | undefined,
  readback: RenderGraphNativePass,
): Result<void, RenderGraphError> {
  const plan = planViewDepthPyramid(input);
  const program = createDepthPyramidProgramResolver(PROGRAM_LAYOUTS);
  let active: _InternalRenderPipelineContext | undefined;
  let view: GpuDrivenView | undefined;
  let depth: TextureView | undefined;
  let uniform: Buffer | undefined;
  let image: ReturnType<CurrentOcclusionDepth['write']> | undefined;
  const seed: RenderGraphNativePass = {
    kind: 'compute',
    name: 'occlusion-hzb-seed',
    encode(pass) {
      const source = active?.depthPyramidShaders?.seed;
      const target = image?.levels[0];
      if (
        active === undefined ||
        source === undefined ||
        target === undefined ||
        depth === undefined ||
        uniform === undefined
      )
        throw computePipelineError('current camera depth pyramid seed');
      const state = program(
        active,
        source,
        input.multisampled ? SEED_MULTISAMPLED_ENTRIES : SEED_ENTRIES,
        input.multisampled ? 'seed_furthest_multisampled' : 'seed_furthest',
      );
      pass.setPipeline(state.pipeline);
      pass.setBindGroup(
        0,
        seedNativeBinding(
          active.runtime.device,
          active.bindGroupCounts,
          state,
          depth,
          target,
          uniform,
          input.multisampled,
        ),
      );
      pass.dispatchWorkgroups(Math.ceil(plan.extent.width / 8), Math.ceil(plan.extent.height / 8));
    },
  };
  const reduce: RenderGraphNativePass = {
    kind: 'compute',
    name: 'occlusion-hzb-reduce-chain',
    encode(pass) {
      const source = active?.depthPyramidShaders?.reduce;
      if (active === undefined || source === undefined || image === undefined)
        throw computePipelineError('current camera depth pyramid reduction');
      const state = program(active, source, REDUCE_ENTRIES, 'reduce_furthest');
      pass.setPipeline(state.pipeline);
      for (let level = 1; level < plan.mipLevelCount; level++) {
        const from = image.levels[level - 1],
          to = image.levels[level],
          extent = plan.levels[level];
        if (from === undefined || to === undefined || extent === undefined)
          throw computePipelineError('current camera depth mips');
        pass.setBindGroup(
          0,
          reductionNativeBinding(active.runtime.device, active.bindGroupCounts, state, [from, to]),
        );
        pass.dispatchWorkgroups(Math.ceil(extent.width / 8), Math.ceil(extent.height / 8));
      }
    },
  };
  const cull: RenderGraphNativePass = {
    kind: 'compute',
    name: 'gpu-driven.occlusion-cull',
    encode(pass) {
      if (view === undefined || image === undefined)
        throw computePipelineError('current camera occlusion cull');
      view.recordCameraLateCull(pass, image.sampled);
    },
  };
  const finalize: RenderGraphNativePass = {
    kind: 'compute',
    name: 'gpu-driven.occlusion-finalize-indirect',
    encode(pass) {
      if (view === undefined) throw computePipelineError('current camera indirect finalization');
      view.recordCameraLateFinalize(pass);
    },
  };
  return graph.addSubgraphPass('camera-late-selection', {
    profilePasses: () => [seed, reduce, cull, finalize, readback],
    accesses: [
      { resource: input.depth, usage: 'sampled-read' },
      { resource: input.view, usage: 'uniform-read' },
    ],
    executeIf: () => currentView() !== undefined,
    commandsDirect(frame, resources, issue, recording) {
      active = frame as _InternalRenderPipelineContext;
      try {
        view = currentView();
        const state = active.frameState;
        state.currentOcclusionDepth ??= new CurrentOcclusionDepth(viewTargetTextures(active));
        image = state.currentOcclusionDepth.write(plan);
        depth = resources.textureView(input.depth).unwrap();
        uniform = resources.buffer(input.view).unwrap();
        issue(recording, seed);
        if (plan.mipLevelCount > 1) issue(recording, reduce);
        issue(recording, cull);
        issue(recording, finalize);
        issue(recording, readback);
      } finally {
        active = view = depth = uniform = image = undefined;
      }
    },
  });
}
