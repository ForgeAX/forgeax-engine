import {
  type MaterialShaderManifestEntry,
  materialShaderSourceMatches,
} from '@forgeax/engine-shader';
import type { PointShadowSnapshot } from './render-system-extract';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from './shadow-atlas';

/**
 * Detached point-shadow budget facts from one completed extract/record frame.
 *
 * `requested` is the number of PointLight + PointLightShadow pairs. The
 * renderer owns the bounded cube-array atlas, so `admitted`, `shadowed`, and
 * `shadowAtlasOccupancy` are all derived from the layer sentinel emitted by
 * the same extract owner. No consumer needs to maintain a second budget
 * ledger.
 *
 * `unavailable` means the loaded Standard shaders were compiled without the
 * cube-array sampling lane (`forgeaxShader({ engineEntries: { pointShadows:
 * true } })`), so no point light can cast a visible shadow in this renderer.
 */
export interface PointShadowInspection {
  readonly status: 'unavailable' | 'inactive' | 'ready' | 'over-budget';
  readonly requested: number;
  readonly admitted: number;
  readonly shadowed: number;
  readonly shadowAtlasOccupancy: number;
  readonly shadowAtlasCapacity: number;
}

/** Project point-shadow snapshots to the public, JSON-safe inspection shape. */
export function inspectPointShadow(
  snapshots: readonly PointShadowSnapshot[],
  shadowAtlasCapacity: number,
): PointShadowInspection {
  const requested = snapshots.length;
  const admitted = snapshots.reduce(
    (count, snapshot) =>
      snapshot.shadowAtlasLayer >= 0 && snapshot.shadowAtlasLayer < shadowAtlasCapacity
        ? count + 1
        : count,
    0,
  );
  // Never publish a misleading `ready` state when any requested shadow owns
  // no atlas layer. The extract sentinel is the single admission projection;
  // a partial or all-sentinel frame is therefore a failed/over-budget
  // admission, not an active shadow path with incomplete output.
  const status =
    requested === 0
      ? ('inactive' as const)
      : requested > shadowAtlasCapacity || admitted !== requested
        ? ('over-budget' as const)
        : ('ready' as const);
  return Object.freeze({
    status,
    requested,
    admitted,
    // A point shadow only samples an atlas after it owns an atlas layer. Keep
    // these names explicit for AI diagnostics while deriving both from the
    // one layer projection above.
    shadowed: admitted,
    shadowAtlasOccupancy: admitted,
    shadowAtlasCapacity,
  });
}

const POINT_SHADOW_LANE =
  /@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*5\s*\)\s*var\s+\w+\s*:\s*texture_depth_cube_array\b/u;
const laneByEntry = new WeakMap<MaterialShaderManifestEntry, boolean>();

/**
 * Derive whether any loaded material program samples the point-shadow atlas.
 * The composed WGSL is the only authority: the view BGL always declares
 * binding 5, but only an opted-in build compiles a shader that reads it.
 */
export function materialShadersSamplePointShadows(
  entries: Iterable<MaterialShaderManifestEntry>,
): boolean {
  for (const entry of entries) {
    let lane = laneByEntry.get(entry);
    if (lane === undefined) {
      lane =
        materialShaderSourceMatches(entry, POINT_SHADOW_LANE) ||
        entry.variants.some((variant) => materialShaderSourceMatches(variant, POINT_SHADOW_LANE));
      laneByEntry.set(entry, lane);
    }
    if (lane) return true;
  }
  return false;
}

/**
 * Publish the recorded point-shadow facts, or the `unavailable` projection
 * when no loaded shader can sample the atlas. The request count is kept so a
 * caller sees which lights asked for shadows that cannot be displayed.
 */
export function projectPointShadowInspection(
  recorded: PointShadowInspection | undefined,
  shaderLane: boolean,
): PointShadowInspection | undefined {
  if (shaderLane) return recorded;
  return Object.freeze({
    status: 'unavailable',
    requested: recorded?.requested ?? 0,
    admitted: 0,
    shadowed: 0,
    shadowAtlasOccupancy: 0,
    shadowAtlasCapacity: recorded?.shadowAtlasCapacity ?? SHADOW_ATLAS_DEFAULT_LAYERS,
  });
}
