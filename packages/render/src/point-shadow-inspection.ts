import {
  type MaterialShaderManifestEntry,
  materialShaderPreparedSourceRows,
  materialShaderSourceMatches,
  materialShaderTemplateOffersPointShadows,
} from '@forgeax/engine-shader';
import type { SubmittedFrameInspection } from './record/frame-snapshot';
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
 * `unavailable` means there is no material that can sample the cube-array
 * atlas and the submitted Forward receiver did not project point shadows.
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
const laneByEntry = new WeakMap<
  MaterialShaderManifestEntry,
  { readonly count: number; readonly lane: boolean }
>();

/**
 * Read prepared material WGSL for a point-shadow atlas sampling lane.
 * The Forward projection is a separate utility program whose receipt comes
 * from the submitted receiver.
 */
export function materialShadersSamplePointShadows(
  entries: Iterable<MaterialShaderManifestEntry>,
): boolean {
  for (const entry of entries) {
    if (entry.identifier === 'forgeax::engine-forward-directional-shadow') continue;
    if (materialShaderTemplateOffersPointShadows(entry)) return true;
    const rows = materialShaderPreparedSourceRows(entry);
    let cached = laneByEntry.get(entry);
    if (cached === undefined || cached.count !== rows.length) {
      cached = {
        count: rows.length,
        lane: rows.some((row) => materialShaderSourceMatches(row, POINT_SHADOW_LANE)),
      };
      laneByEntry.set(entry, cached);
    }
    const lane = cached.lane;
    if (lane) return true;
  }
  return false;
}

/**
 * Publish the recorded point-shadow facts when a material samples the atlas
 * or the submitted Forward receiver projects it. Preserve the request count
 * when neither sampling path is available.
 */
export function projectPointShadowInspection(
  submitted: Pick<SubmittedFrameInspection, 'forwardShadow' | 'pointShadow'> | undefined,
  entries: Iterable<MaterialShaderManifestEntry>,
): PointShadowInspection | undefined {
  const forwardShadow = submitted?.forwardShadow;
  const recorded = submitted?.pointShadow;
  if (
    (forwardShadow?.mode === 'screen' && forwardShadow.punctual?.point === true) ||
    materialShadersSamplePointShadows(entries)
  )
    return recorded;
  return Object.freeze({
    status: 'unavailable',
    requested: recorded?.requested ?? 0,
    admitted: 0,
    shadowed: 0,
    shadowAtlasOccupancy: 0,
    shadowAtlasCapacity: recorded?.shadowAtlasCapacity ?? SHADOW_ATLAS_DEFAULT_LAYERS,
  });
}
