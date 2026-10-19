import {
  type GraphAccess,
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import {
  SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL,
  SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL,
  SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL,
} from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  RenderPipelineFrame,
  RenderPipelineGpuDrivenProjection,
  RenderPipelineSurfaceMediumPair,
  RenderPipelineTarget,
} from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';
import type { RenderSystem } from '../render-system';
import { FORWARD_PASS_SELECTOR } from '../systems/pass-selector';
import { addTypedFullscreenPass, addTypedScenePass } from '../typed-render-graph-primitives';

/** Stable renderer-owned post-process identity for the independent depth copy. */
export const SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID =
  'forgeax.single-layer-medium-raw-depth' as const;
export const SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID =
  'forgeax.single-layer-medium-msaa-paired-color' as const;
export const SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID =
  'forgeax.single-layer-medium-msaa-raw-depth' as const;

interface SingleLayerMediumMsaaPair {
  readonly color: RenderPipelineTarget;
  readonly depth: RenderPipelineTarget;
}

interface SingleLayerMediumRawDepthProducerInput {
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  /** Resource/pass prefix; defaults to the opaque scene producer identity. */
  readonly label?: string | undefined;
  /** The already-resolved opaque color keeps the fullscreen primitive's input ABI complete. */
  readonly sourceColor: RenderPipelineTarget;
  /** The opaque depth pass output. It is sampled only by the copy producer. */
  readonly sourceDepth: RenderPipelineTarget;
  /** Must match the Standard scene depth extent (surface or internal resolution). */
  readonly size: GraphTextureDescriptor['size'];
}

/**
 * Produce an independent, single-sample raw-depth texture for Surface media.
 *
 * The graph source is the completed opaque depth pass and the destination is
 * an r32float color target. This intermediate is the only place that samples
 * the hardware depth view; medium materials bind the independent result while
 * writing the scene depth attachment. MSAA is rejected at the producer seam
 * until the backend has an explicit depth resolve policy.
 */
export function addSingleLayerMediumRawDepthProducer(
  input: SingleLayerMediumRawDepthProducerInput,
): Result<RenderPipelineTarget, RenderGraphError> {
  const label = input.label ?? 'single-layer-medium-raw-depth';
  if (input.sourceDepth.sampleCount !== 1) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'single-layer medium raw-depth producer has a single-sample source depth',
        hint: 'select a resolved 1x depth producer; MSAA depth resolve is not admitted yet',
        detail: {
          resourceLabel: label,
          field: 'sourceDepth.sampleCount',
          expected: '1',
          actual: String(input.sourceDepth.sampleCount),
        },
      }),
    );
  }

  const rawDepth = createRenderPipelineTarget(input.graph, label, {
    format: 'r32float',
    size: input.size,
    sampleCount: 1,
  });
  if (!rawDepth.ok) return rawDepth;

  const producer = addTypedFullscreenPass(input.graph, {
    name: `${label}-producer`,
    shader: SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID,
    input: input.sourceColor,
    outputs: [rawDepth.value],
    depth: input.sourceDepth,
  });
  if (!producer.ok) return producer;
  return ok(rawDepth.value);
}

/**
 * Resolve a four-sample color/depth pair by selecting the nearest depth sample
 * and the color at that exact sample index. This is deliberately separate
 * from WebGPU's averaging color resolve, which cannot preserve the opaque or
 * nearest-water sample associated with the selected depth.
 */
export function addSingleLayerMediumMsaaPairProducer(input: {
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  readonly label: string;
  readonly sourceColor: RenderPipelineTarget;
  readonly sourceDepth: RenderPipelineTarget;
  readonly size: GraphTextureDescriptor['size'];
}): Result<SingleLayerMediumMsaaPair, RenderGraphError> {
  if (input.sourceColor.sampleCount !== 4 || input.sourceDepth.sampleCount !== 4) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'single-layer medium paired MSAA producer has 4x color and depth inputs',
        hint: 'route 1x inputs through the single-sample raw-depth producer',
        detail: {
          resourceLabel: input.label,
          field: 'source.sampleCount',
          expected: 'color=4,depth=4',
          actual: `color=${input.sourceColor.sampleCount},depth=${input.sourceDepth.sampleCount}`,
        },
      }),
    );
  }
  const color = createRenderPipelineTarget(input.graph, `${input.label}-color`, {
    format: input.sourceColor.format,
    size: input.size,
    sampleCount: 1,
    ...(input.sourceColor.domain === undefined ? {} : { domain: input.sourceColor.domain }),
  });
  if (!color.ok) return color;
  const depth = createRenderPipelineTarget(input.graph, `${input.label}-depth`, {
    format: 'r32float',
    size: input.size,
    sampleCount: 1,
  });
  if (!depth.ok) return depth;
  const colorProducer = addTypedFullscreenPass(input.graph, {
    name: `${input.label}-color-producer`,
    shader: SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID,
    input: input.sourceColor,
    outputs: [color.value],
    depth: input.sourceDepth,
  });
  if (!colorProducer.ok) return colorProducer;
  const depthProducer = addTypedFullscreenPass(input.graph, {
    name: `${input.label}-depth-producer`,
    shader: SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID,
    input: input.sourceColor,
    outputs: [depth.value],
    depth: input.sourceDepth,
  });
  if (!depthProducer.ok) return depthProducer;
  return ok({ color: color.value, depth: depth.value });
}

/** Inputs shared by the two graph passes owned by the Surface model. */
interface SingleLayerMediumNearestTargets {
  readonly nearestLayer: RenderPipelineTarget;
  readonly nearestDepth: RenderPipelineTarget;
}

/**
 * A lane that admits the medium must already own its nearest targets and the
 * shared opaque backdrop copy; either missing is a graph construction bug.
 */
export function requireSingleLayerMediumInputs(
  nearestTargets: SingleLayerMediumNearestTargets | undefined,
  backdrop: GraphTextureView | undefined,
): Result<
  { readonly nearestTargets: SingleLayerMediumNearestTargets; readonly backdrop: GraphTextureView },
  RenderGraphError
> {
  if (nearestTargets === undefined || backdrop === undefined) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'single-layer medium graph has nearest targets and an opaque backdrop',
        hint: 'keep the shared transmission backdrop copy ahead of the Surface passes',
        detail: {
          resourceLabel: 'single-layer-medium',
          field: 'backdrop',
          expected: 'resolved graph texture view',
          actual: 'missing',
        },
      }),
    );
  }
  return ok({ nearestTargets, backdrop });
}

export interface SingleLayerMediumPassInput {
  readonly graph: RenderGraphBuilder<RenderPipelineFrame>;
  readonly size: GraphTextureDescriptor['size'];
  readonly nearestLayer: RenderPipelineTarget;
  readonly nearestDepth: RenderPipelineTarget;
  readonly color: RenderPipelineTarget;
  readonly colorResolve?: RenderPipelineTarget | undefined;
  readonly depth: RenderPipelineTarget;
  readonly sampled?: readonly RenderPipelineTarget[] | undefined;
  readonly directionalShadow?: RenderPipelineTarget | undefined;
  readonly spotShadow?: RenderPipelineTarget | undefined;
  /** Optional producer-owned cloud shadow bound through the Standard frame group. */
  readonly cloudShadow?: RenderPipelineTarget | undefined;
  readonly ssao?: RenderPipelineTarget | undefined;
  readonly extraAccesses?: readonly GraphAccess[] | undefined;
  /** Producer-owned pair of opaque color and sampled raw-depth facts. */
  readonly surfacePair: RenderPipelineSurfaceMediumPair;
  readonly gpuDriven?: RenderPipelineGpuDrivenProjection | undefined;
}

/**
 * Admit the nearest-layer and color Surface submissions to the existing
 * Standard graph only when the producer supplied a paired sampled raw depth.
 * The pair is deliberately an input: this helper does not invent a backdrop,
 * copy depth, or turn an unavailable fact into a graph resource.
 */
export function addSingleLayerMediumPasses(
  input: SingleLayerMediumPassInput,
): Result<void, RenderGraphError> {
  const pair = input.surfacePair;
  if (pair.rawDepth.status === 'unavailable') {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'single-layer medium consumes a graph-paired sampled raw depth',
        hint: 'enable an owner-approved depth-copy producer before admitting the Surface passes',
        detail: {
          resourceLabel: 'single-layer-medium',
          field: 'surfacePair.rawDepth',
          expected: 'available sampled depth view',
          actual: pair.rawDepth.reason,
        },
      }),
    );
  }
  const sampled = input.sampled ?? [];
  const nearest = addTypedScenePass(input.graph, {
    name: 'single-layer-medium-nearest-layer',
    color: input.nearestLayer,
    depth: input.nearestDepth,
    sampled,
    ...(input.directionalShadow === undefined
      ? {}
      : { directionalShadow: input.directionalShadow }),
    ...(input.spotShadow === undefined ? {} : { spotShadow: input.spotShadow }),
    ...(input.cloudShadow === undefined ? {} : { cloudShadow: input.cloudShadow }),
    ...(input.ssao === undefined ? {} : { ssao: input.ssao }),
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'clear',
    depthLoadOp: 'clear',
    recordMode: 'single-layer-medium-nearest-layer',
    transmissionBackdrop: pair.opaqueColor,
    surfacePair: pair,
    gpuDrivenFilter: 'single-layer-medium',
    ...(input.extraAccesses === undefined ? {} : { extraAccesses: input.extraAccesses }),
    ...(input.gpuDriven === undefined ? {} : { gpuDriven: input.gpuDriven }),
  });
  if (!nearest.ok) return nearest;

  const nearestPair =
    input.nearestLayer.sampleCount === 4
      ? addSingleLayerMediumMsaaPairProducer({
          graph: input.graph,
          label: 'single-layer-medium-nearest-resolve',
          sourceColor: input.nearestLayer,
          sourceDepth: input.nearestDepth,
          size: input.size,
        })
      : (() => {
          const depth = addSingleLayerMediumRawDepthProducer({
            graph: input.graph,
            label: 'single-layer-medium-nearest-depth-sampled',
            sourceColor: input.nearestLayer,
            sourceDepth: input.nearestDepth,
            size: input.size,
          });
          return depth.ok ? ok({ color: input.nearestLayer, depth: depth.value }) : depth;
        })();
  if (!nearestPair.ok) return nearestPair;

  const colorSampled = [...sampled, nearestPair.value.color];
  const color = addTypedScenePass(input.graph, {
    name: 'single-layer-medium-color',
    color: input.color,
    ...(input.colorResolve === undefined ? {} : { resolve: input.colorResolve }),
    depth: input.depth,
    sampled: colorSampled,
    ...(input.directionalShadow === undefined
      ? {}
      : { directionalShadow: input.directionalShadow }),
    ...(input.spotShadow === undefined ? {} : { spotShadow: input.spotShadow }),
    ...(input.cloudShadow === undefined ? {} : { cloudShadow: input.cloudShadow }),
    ...(input.ssao === undefined ? {} : { ssao: input.ssao }),
    selector: FORWARD_PASS_SELECTOR,
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    recordMode: 'single-layer-medium-color',
    transmissionBackdrop: pair.opaqueColor,
    surfacePair: pair,
    surfaceNearestLayer: nearestPair.value.color.view,
    surfaceNearestDepth: nearestPair.value.depth.view,
    gpuDrivenFilter: 'single-layer-medium',
    ...(input.extraAccesses === undefined ? {} : { extraAccesses: input.extraAccesses }),
    ...(input.gpuDriven === undefined ? {} : { gpuDriven: input.gpuDriven }),
  });
  if (!color.ok) return color;
  return ok(undefined);
}

/** Register the built-ins alongside their graph identities and binding contracts. */
export function registerSingleLayerMediumBuiltins(
  renderSystem: Pick<RenderSystem, 'registerBuiltinPostProcess'>,
): void {
  renderSystem.registerBuiltinPostProcess(SINGLE_LAYER_MEDIUM_RAW_DEPTH_POST_PROCESS_ID, {
    source: SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL,
    reads: ['input', { key: 'scene-depth', sampleType: 'depth' }],
  });
  const pairedMsaaReads = [
    { key: 'input', sampleType: 'multisampled-float' as const },
    { key: 'scene-depth', sampleType: 'depth' as const },
  ];
  renderSystem.registerBuiltinPostProcess(SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_POST_PROCESS_ID, {
    source: SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL,
    reads: pairedMsaaReads,
  });
  renderSystem.registerBuiltinPostProcess(SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_POST_PROCESS_ID, {
    source: SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL,
    reads: pairedMsaaReads,
  });
}
