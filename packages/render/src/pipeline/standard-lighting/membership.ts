import { err, ok, type Result } from '@forgeax/engine-types';
import {
  bin,
  type ClusterBinScratch,
  createClusterBinScratch,
  encodeProducerBounds,
  producerBoundsInt32Length,
  writeClusterMembershipFromGrid,
} from '../../cluster-binner';
import type { RenderError } from '../../errors/render';
import { fromClusterBinError } from './errors';
import type { StandardClusterLayout } from './layout';
import type { StandardLightFrame } from './light-frame';

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
  readonly membershipEntryCount: number;
  readonly scratch: ClusterBinScratch;
}

const NO_LIGHT_INDICES = new Uint32Array(0);

export function deriveStandardMembership(
  frame: StandardLightFrame,
  layout: StandardClusterLayout,
  scratch = createClusterBinScratch(),
): Result<StandardClusterMembership, RenderError> {
  const clusterGrid = new Uint32Array(layout.clusterGridU32Length);
  // Occupancy and run reservation only; the ordered list is written on demand.
  const result = bin(
    frame.local,
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
  if (!result.ok) return err(fromClusterBinError(result.error));
  const lightCount = frame.local.length;
  const lightBounds = new Int32Array(producerBoundsInt32Length(lightCount));
  encodeProducerBounds(frame.local, scratch.lightBounds, frame.view, frame.projection, lightBounds);
  // Detached copy of the cell boxes: `scratch` may serve the next derivation before a lazy read.
  const cellBounds = scratch.lightBounds.slice(0, lightCount * 6);
  const membershipEntryCount = result.value;
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
      writeClusterMembershipFromGrid(lightCount, cellBounds, grid, clusterGrid, lightIndexList);
    }
    return lightIndexList;
  };
  return ok({
    clusterGrid,
    get lightIndexList() {
      return materialize();
    },
    lightBounds,
    membershipEntryCount,
    scratch,
  });
}
