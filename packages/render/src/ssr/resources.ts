import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { estimateDepthPyramidMemory } from '../depth-pyramid/graph';
import type { DepthPyramidExtent } from '../depth-pyramid/plan';
import { ssrColorExtent } from './scene-color-input';

export const SSR_TRACE_FORMAT = 'rgba16float' as const;
export const SSR_R32FLOAT_BYTES_PER_PIXEL = 4 as const;
export const SSR_RGBA16FLOAT_BYTES_PER_PIXEL = 8 as const;
export const SSR_SPATIAL_MEMORY_BUDGET_BYTES = 335_544_320 as const;

export interface SsrSpatialTexture {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: typeof SSR_TRACE_FORMAT;
}

export interface SsrSpatialResources {
  readonly trace: SsrSpatialTexture;
  /** Full-resolution reactivity of the admitted reflection source taps. */
  readonly hitReactivity?: GraphTextureView;
}

export interface SsrSpatialMemoryEstimate {
  readonly width: number;
  readonly height: number;
  readonly traceWidth: number;
  readonly traceHeight: number;
  /** The complete view HZB, included conservatively in SSR admission. */
  readonly depthPyramidBytes: number;
  readonly fragmentScratchBytes: number;
  readonly sceneColorBytes: number;
  readonly forwardInputsBytes: number;
  readonly traceBytes: number;
  readonly hitReactivityBytes: number;
  /** Full-resolution fallback output allocated only for SSR; included in the total. */
  readonly fallbackInputBytes: number;
  /** Total additional descriptor bytes, including the lighting-owned fallback, before aliasing. */
  readonly ssrOwnedBytes: number;
  readonly budgetBytes: typeof SSR_SPATIAL_MEMORY_BUDGET_BYTES;
  readonly withinBudget: boolean;
}

export function ssrTraceExtent(
  extent: DepthPyramidExtent,
  resolutionScale = 1,
): DepthPyramidExtent {
  return {
    width: Math.max(1, Math.floor(extent.width * resolutionScale)),
    height: Math.max(1, Math.floor(extent.height * resolutionScale)),
  };
}

function byteCount(width: number, height: number, bytesPerPixel: number): number {
  const bytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError('SSR spatial descriptor byte count exceeds safe integer range');
  }
  return bytes;
}

/** Derive descriptor bytes for one admitted full-resolution SSR frame. */
export function estimateSsrSpatialMemory(
  extent: DepthPyramidExtent,
  options: {
    readonly execution?: 'compute' | 'fragment';
    readonly forward?: boolean;
    readonly water?: boolean;
    readonly forwardSampleCount?: 1 | 4;
    readonly depthPyramidBytes?: number | undefined;
    readonly resolutionScale?: number | undefined;
  } = {},
): SsrSpatialMemoryEstimate {
  const trace = ssrTraceExtent(extent, options.resolutionScale);
  const depthPyramidBytes = options.depthPyramidBytes ?? estimateDepthPyramidMemory(extent);
  const traceBytes = byteCount(trace.width, trace.height, SSR_RGBA16FLOAT_BYTES_PER_PIXEL);
  const hitReactivityBytes =
    options.water === true ? 0 : byteCount(trace.width, trace.height, SSR_R32FLOAT_BYTES_PER_PIXEL);
  const fallbackInputBytes = byteCount(
    extent.width,
    extent.height,
    SSR_RGBA16FLOAT_BYTES_PER_PIXEL,
  );
  const colorExtent = ssrColorExtent(extent);
  const sceneColorBytes = byteCount(
    colorExtent.width,
    colorExtent.height,
    SSR_RGBA16FLOAT_BYTES_PER_PIXEL,
  );
  const fragmentScratchBytes = options.execution === 'fragment' ? depthPyramidBytes + 16 : 0;
  // Conservative incremental Forward demand: center depth (8), packed
  // normal/roughness (4), temporal-v1 (8), BRDF response (8), and Base Pass
  // surface attributes (8). MSAA retains all three source attachments until resolve.
  // Count all inputs even when another consumer already demanded them.
  const forwardInputsBytes =
    options.forward === true
      ? byteCount(extent.width, extent.height, 36 + (options.forwardSampleCount === 4 ? 96 : 0))
      : 0;
  const ssrOwnedBytes =
    fragmentScratchBytes +
    sceneColorBytes +
    forwardInputsBytes +
    depthPyramidBytes +
    traceBytes +
    hitReactivityBytes +
    fallbackInputBytes;
  return Object.freeze({
    width: extent.width,
    height: extent.height,
    traceWidth: trace.width,
    traceHeight: trace.height,
    depthPyramidBytes,
    traceBytes,
    fragmentScratchBytes,
    sceneColorBytes,
    forwardInputsBytes,
    hitReactivityBytes,
    fallbackInputBytes,
    ssrOwnedBytes,
    budgetBytes: SSR_SPATIAL_MEMORY_BUDGET_BYTES,
    withinBudget: ssrOwnedBytes <= SSR_SPATIAL_MEMORY_BUDGET_BYTES,
  });
}

function texture<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  label: string,
  format: typeof SSR_TRACE_FORMAT,
  extent: DepthPyramidExtent,
): Result<SsrSpatialTexture, RenderGraphError> {
  const created = graph.createTexture(label, {
    format,
    size: { width: extent.width, height: extent.height },
    domain: 'linear-hdr',
  });
  if (!created.ok) return created;
  const view = graph.view(created.value, { label: `${label}.view`, dimension: '2d' });
  if (!view.ok) return view;
  return ok({
    texture: created.value,
    view: view.value,
    width: extent.width,
    height: extent.height,
    format,
  });
}

/** Allocate only the transient resources required by an admitted spatial path. */
export function createSsrSpatialResources<FrameCtx extends RenderGraphFrame>(
  graph: RenderGraphBuilder<FrameCtx>,
  extent: DepthPyramidExtent,
  label = 'ssr',
  resolutionScale = 1,
  water = false,
): Result<SsrSpatialResources, RenderGraphError> {
  const traceExtent = ssrTraceExtent(extent, resolutionScale);
  const trace = texture(graph, `${label}-trace`, SSR_TRACE_FORMAT, traceExtent);
  if (!trace.ok) return trace;
  if (water) return ok({ trace: trace.value });
  const hitTexture = graph.createTexture(`${label}-hit-reactivity`, {
    format: 'r32float',
    size: traceExtent,
  });
  if (!hitTexture.ok) return hitTexture;
  const hitReactivity = graph.view(hitTexture.value, {
    label: `${label}-hit-reactivity.view`,
    dimension: '2d',
  });
  if (!hitReactivity.ok) return hitReactivity;
  return ok({ trace: trace.value, hitReactivity: hitReactivity.value });
}
