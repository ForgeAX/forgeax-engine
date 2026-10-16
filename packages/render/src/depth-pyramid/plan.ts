import type { GraphExtent } from '@forgeax/engine-render-graph';

/** The one format of the shared closest-depth pyramid (linear view distance). */
export const DEPTH_PYRAMID_FORMAT = 'r32float' as const;

export interface DepthPyramidExtent {
  readonly width: number;
  readonly height: number;
}

export interface DepthPyramidLevelPlan extends DepthPyramidExtent {
  readonly level: number;
}

export interface DepthPyramidPlan {
  readonly extent: DepthPyramidExtent;
  readonly format: typeof DEPTH_PYRAMID_FORMAT;
  readonly mipLevelCount: number;
  readonly levels: readonly DepthPyramidLevelPlan[];
  readonly graphSize: GraphExtent;
}

function validExtent(extent: DepthPyramidExtent): boolean {
  return (
    Number.isInteger(extent.width) &&
    Number.isInteger(extent.height) &&
    extent.width > 0 &&
    extent.height > 0
  );
}

function requireExtent(extent: DepthPyramidExtent): void {
  if (!validExtent(extent)) {
    throw new RangeError('Depth pyramid extent must contain positive integer width and height');
  }
}

/** Derive the physical WebGPU floor-halved mip extent, clamped to one texel. */
export function nextDepthPyramidMipExtent(extent: DepthPyramidExtent): DepthPyramidExtent {
  requireExtent(extent);
  return {
    width: Math.max(1, Math.floor(extent.width / 2)),
    height: Math.max(1, Math.floor(extent.height / 2)),
  };
}

/** Derive the complete current-view depth pyramid descriptor without allocating a resource. */
export function buildDepthPyramidPlan(extent: DepthPyramidExtent): DepthPyramidPlan {
  requireExtent(extent);
  const levels: DepthPyramidLevelPlan[] = [];
  let current = { width: extent.width, height: extent.height };
  let level = 0;
  while (true) {
    levels.push({ level, ...current });
    if (current.width === 1 && current.height === 1) break;
    current = nextDepthPyramidMipExtent(current);
    level += 1;
  }
  return Object.freeze({
    extent: Object.freeze({ width: extent.width, height: extent.height }),
    format: DEPTH_PYRAMID_FORMAT,
    mipLevelCount: levels.length,
    levels: Object.freeze(levels.map((entry) => Object.freeze(entry))),
    graphSize: Object.freeze({ width: extent.width, height: extent.height }),
  });
}

/** Map an invalid or empty depth sample to the depth pyramid empty-pixel sentinel. */
export function normalizeDepthPyramidDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}
