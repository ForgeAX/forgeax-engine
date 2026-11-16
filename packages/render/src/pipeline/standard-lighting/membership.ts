import { ok, type Result } from '@forgeax/engine-types';
import {
  bin,
  type ClusterBinScratch,
  createClusterBinScratch,
  encodeProducerBounds,
  producerBoundsInt32Length,
  writeClusterMembershipFromGrid,
} from '../../cluster-binner';
import type { RenderError } from '../../errors/render';
import type { StandardClusterLayout } from './layout';
import type { StandardLightFrame, StandardLocalLightInput } from './light-frame';

export interface StandardClusterMembership {
  readonly clusterGrid: Uint32Array;
  /**
   * Cluster-major light indices, `membershipEntryCount` long. Materialized on
   * first read: a GPU membership producer rebuilds the list on the device and
   * never reads it, so its frames skip the host list entirely.
   */
  readonly lightIndexList: Uint32Array;
  /** GPU producer payload (`encodeProducerBounds`): cell boxes plus view-space froxel test inputs. */
  readonly lightBounds: Int32Array;
  /** Lights binned into the grid (`grid.w`); the directional tail follows them. */
  readonly membershipLightCount: number;
  readonly membershipEntryCount: number;
  /** Per-cluster entry cap applied when the index list overflowed, else `undefined`. */
  readonly clusterEntryCapK: number | undefined;
  /** Cluster entries dropped under `clusterEntryCapK`. */
  readonly droppedClusterEntries: number;
  readonly scratch: ClusterBinScratch;
}

const NO_LIGHT_INDICES = new Uint32Array(0);

/**
 * Lights the Cluster bins: the point/spot/rect prefix of `local`. Additional
 * DirectionalLights sit after it in slots `[N, N + D)` and are shaded by their
 * own loop with their own count, outside the light grid.
 */
export function standardClusterBinnedLightCount(local: readonly StandardLocalLightInput[]): number {
  let count = local.length;
  while (count > 0 && local[count - 1]?.kind === 'directional') count -= 1;
  return count;
}

export function deriveStandardMembership(
  frame: StandardLightFrame,
  layout: StandardClusterLayout,
  scratch = createClusterBinScratch(),
): Result<StandardClusterMembership, RenderError> {
  const binnedCount = standardClusterBinnedLightCount(frame.local);
  const binned =
    binnedCount === frame.local.length ? frame.local : frame.local.slice(0, binnedCount);
  const clusterGrid = new Uint32Array(layout.clusterGridU32Length);
  // Occupancy and run reservation only; the ordered list is written on demand.
  const result = bin(
    binned,
    frame.view,
    frame.projection,
    layout.grid,
    frame.near,
    frame.far,
    clusterGrid,
    NO_LIGHT_INDICES,
    layout.lightIndexListCapacity,
    scratch,
    undefined,
    { writeMembership: false },
  );
  const lightCount = binned.length;
  const lightBounds = new Int32Array(producerBoundsInt32Length(lightCount));
  encodeProducerBounds(binned, scratch.lightBounds, frame.view, frame.projection, lightBounds);
  // Detached copy of the cell boxes: `scratch` may serve the next derivation before a lazy read.
  const cellBounds = scratch.lightBounds.slice(0, lightCount * 6);
  // `bin` caps an overflowing list to K entries per cluster and never fails.
  const membershipEntryCount = result.ok ? result.value : 0;
  const clusterEntryCapK = scratch.clusterEntryCapK;
  const grid = layout.grid;
  let lightIndexList: Uint32Array | undefined;
  const materialize = (): Uint32Array => {
    if (lightIndexList !== undefined) return lightIndexList;
    // Each local light appears at most once per cluster, so the reserved runs
    // sum to exactly membershipEntryCount entries.
    if (membershipEntryCount === 0) {
      lightIndexList = NO_LIGHT_INDICES;
    } else {
      lightIndexList = new Uint32Array(membershipEntryCount);
      writeClusterMembershipFromGrid(
        lightCount,
        cellBounds,
        grid,
        clusterGrid,
        lightIndexList,
        clusterEntryCapK !== undefined,
      );
    }
    return lightIndexList;
  };
  return ok({
    clusterGrid,
    get lightIndexList() {
      return materialize();
    },
    lightBounds,
    membershipLightCount: binnedCount,
    membershipEntryCount,
    clusterEntryCapK,
    droppedClusterEntries: scratch.droppedClusterEntries,
    scratch,
  });
}
