import type {
  GraphTexture,
  GraphTextureView,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { estimateDepthPyramidMemory, planViewDepthPyramid } from '../depth-pyramid/graph';
import type { DepthPyramidExtent } from '../depth-pyramid/plan';

export const SSR_TRACE_FORMAT = 'rgba16float' as const;
export const SSR_R32FLOAT_BYTES_PER_PIXEL = 4 as const;
export const SSR_RGBA16FLOAT_BYTES_PER_PIXEL = 8 as const;
export const SSR_TEMPORAL_PARAMS_BYTES = 32 as const;
export const SSR_SPATIAL_MEMORY_BUDGET_BYTES = 45_088_768 as const;

export interface SsrSpatialTexture {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: typeof SSR_TRACE_FORMAT;
}

export interface SsrSpatialResources {
  readonly trace: SsrSpatialTexture;
  /** Half-resolution reactivity of the admitted reflection source taps. */
  readonly hitReactivity: GraphTextureView;
  /** Half-resolution resolved radiance/confidence when temporal resolve is active. */
  readonly resolved?: SsrSpatialTexture;
  /** Sampled view of all resolved reflection levels; mip 0 remains sharp. */
  readonly radiancePyramid?: GraphTextureView;
}

export interface SsrSpatialMemoryEstimate {
  readonly width: number;
  readonly height: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** The view's shared depth pyramid, counted in SSR admission while SSR is its only closest-depth reader. */
  readonly depthPyramidBytes: number;
  readonly traceBytes: number;
  readonly hitReactivityBytes: number;
  readonly resolvedBytes: number;
  readonly historyBytes: number;
  readonly temporalParamsBytes: number;
  /** Full-resolution fallback output allocated only for SSR; included in the total. */
  readonly fallbackInputBytes: number;
  /** Total additional descriptor bytes, including the lighting-owned fallback, before aliasing. */
  readonly ssrOwnedBytes: number;
  readonly budgetBytes: typeof SSR_SPATIAL_MEMORY_BUDGET_BYTES;
  readonly withinBudget: boolean;
}

function halfExtent(extent: DepthPyramidExtent): DepthPyramidExtent {
  return {
    width: Math.max(1, Math.floor(extent.width / 2)),
    height: Math.max(1, Math.floor(extent.height / 2)),
  };
}

function byteCount(width: number, height: number, bytesPerPixel: number): number {
  const bytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(bytes)) {
    throw new RangeError('SSR spatial descriptor byte count exceeds safe integer range');
  }
  return bytes;
}

/** Derive descriptor bytes for one admitted half-resolution SSR frame. */
export function estimateSsrSpatialMemory(
  extent: DepthPyramidExtent,
  options: { readonly temporal?: boolean } = {},
): SsrSpatialMemoryEstimate {
  const half = halfExtent(extent);
  const plan = planViewDepthPyramid(extent);
  const temporal = options.temporal !== false;
  const depthPyramidBytes = estimateDepthPyramidMemory(extent);
  const traceBytes = byteCount(half.width, half.height, SSR_RGBA16FLOAT_BYTES_PER_PIXEL);
  const hitReactivityBytes = byteCount(half.width, half.height, SSR_R32FLOAT_BYTES_PER_PIXEL);
  const resolvedBytes = temporal
    ? plan.levels.reduce(
        (sum, level) => sum + byteCount(level.width, level.height, SSR_RGBA16FLOAT_BYTES_PER_PIXEL),
        0,
      )
    : 0;
  const historyBytes = temporal ? half.width * half.height * 12 * 2 : 0;
  const temporalParamsBytes = temporal ? SSR_TEMPORAL_PARAMS_BYTES : 0;
  const fallbackInputBytes = byteCount(
    extent.width,
    extent.height,
    SSR_RGBA16FLOAT_BYTES_PER_PIXEL,
  );
  const ssrOwnedBytes =
    depthPyramidBytes +
    traceBytes +
    hitReactivityBytes +
    resolvedBytes +
    historyBytes +
    temporalParamsBytes +
    fallbackInputBytes;
  return Object.freeze({
    width: extent.width,
    height: extent.height,
    halfWidth: half.width,
    halfHeight: half.height,
    depthPyramidBytes,
    traceBytes,
    hitReactivityBytes,
    resolvedBytes,
    historyBytes,
    temporalParamsBytes,
    fallbackInputBytes,
    ssrOwnedBytes,
    budgetBytes: SSR_SPATIAL_MEMORY_BUDGET_BYTES,
    withinBudget: ssrOwnedBytes <= SSR_SPATIAL_MEMORY_BUDGET_BYTES,
  });
}

function texture(
  graph: RenderGraphBuilder<RenderGraphFrame>,
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
export function createSsrSpatialResources(
  graph: RenderGraphBuilder<RenderGraphFrame>,
  extent: DepthPyramidExtent,
): Result<SsrSpatialResources, RenderGraphError> {
  const traceExtent = halfExtent(extent);
  const trace = texture(graph, 'ssr-trace', SSR_TRACE_FORMAT, traceExtent);
  if (!trace.ok) return trace;
  const hitTexture = graph.createTexture('ssr-hit-reactivity', {
    format: 'r32float',
    size: traceExtent,
  });
  if (!hitTexture.ok) return hitTexture;
  const hitReactivity = graph.view(hitTexture.value, {
    label: 'ssr-hit-reactivity.view',
    dimension: '2d',
  });
  if (!hitReactivity.ok) return hitReactivity;
  return ok({ trace: trace.value, hitReactivity: hitReactivity.value });
}
