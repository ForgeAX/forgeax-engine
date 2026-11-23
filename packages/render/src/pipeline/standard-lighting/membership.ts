import { ok, type Result } from '@forgeax/engine-types';
import {
  type ClusterBinScratch,
  createClusterBinScratch,
  encodeProducerBounds,
  PRODUCER_RESERVATION_END_WORD,
  producerBoundsInt32Length,
  projectClusterLightBounds,
  reserveProjectedClusterGrid,
  writeClusterMembershipFromGrid,
} from '../../cluster-binner';
import type { RenderError } from '../../errors/render';
import type { StandardClusterLayout } from './layout';
import type { StandardLightFrame, StandardLocalLightInput } from './light-frame';

import {
  type ClusterMembershipPublication,
  SubmittedClusterBounds,
} from './membership-publication';

export interface StandardClusterMembership {
  readonly publication?: ClusterMembershipPublication | undefined;
  readonly boundsColumn?: SubmittedClusterBounds | undefined;
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
  readonly occupiedClusterCount: number;
  /** Per-cluster entry cap applied when the index list overflowed, else `undefined`. */
  readonly clusterEntryCapK: number | undefined;
  /** Cluster entries dropped under `clusterEntryCapK`. */
  readonly droppedClusterEntries: number;
  readonly scratch: ClusterBinScratch;
}

export function standardLightBoundsBytes(
  prepared: Pick<StandardClusterMembership, 'boundsColumn' | 'lightBounds'>,
): number {
  return prepared.boundsColumn === undefined
    ? prepared.lightBounds.byteLength
    : prepared.boundsColumn.length * 4;
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

/** The ordered boxes and cluster offsets of one physical membership publication. */
export class StandardClusterRuns {
  readonly clusterGrid: Uint32Array;
  readonly cellBounds: Int32Array;
  readonly membershipEntryCount: number;
  readonly occupiedClusterCount: number;
  readonly clusterEntryCapK: number | undefined;
  readonly droppedClusterEntries: number;
  private readonly grid: StandardClusterLayout['grid'];
  private readonly capacity: number;
  private indices: Uint32Array | undefined;

  constructor(
    layout: StandardClusterLayout,
    readonly lightCount: number,
    scratch: ClusterBinScratch,
  ) {
    this.grid = { x: layout.grid.x, y: layout.grid.y, z: layout.grid.z };
    this.capacity = layout.lightIndexListCapacity;
    this.cellBounds = scratch.lightBounds.slice(0, lightCount * 6);
    this.clusterGrid = new Uint32Array(layout.clusterGridU32Length);
    this.membershipEntryCount = reserveProjectedClusterGrid(
      lightCount,
      this.grid,
      this.clusterGrid,
      this.capacity,
      scratch,
    );
    this.occupiedClusterCount = scratch.occupiedClusterCount;
    this.clusterEntryCapK = scratch.clusterEntryCapK;
    this.droppedClusterEntries = scratch.droppedClusterEntries;
  }

  contains(layout: StandardClusterLayout, count: number, boxes: Int32Array): boolean {
    if (
      this.lightCount !== count ||
      this.capacity !== layout.lightIndexListCapacity ||
      this.grid.x !== layout.grid.x ||
      this.grid.y !== layout.grid.y ||
      this.grid.z !== layout.grid.z ||
      this.clusterGrid.length !== layout.clusterGridU32Length
    )
      return false;
    for (let i = 0; i < this.cellBounds.length; i++)
      if (this.cellBounds[i] !== boxes[i]) return false;
    return true;
  }

  lightIndexList(scratch: ClusterBinScratch): Uint32Array {
    if (this.membershipEntryCount === 0) return NO_LIGHT_INDICES;
    if (this.indices === undefined) {
      const indices = new Uint32Array(this.membershipEntryCount);
      writeClusterMembershipFromGrid(
        this.lightCount,
        this.cellBounds,
        this.grid,
        this.clusterGrid,
        indices,
        this.clusterEntryCapK !== undefined,
        scratch,
      );
      this.indices = indices;
    }
    return this.indices;
  }
}

export function projectStandardLightCells(
  frame: StandardLightFrame,
  layout: StandardClusterLayout,
  scratch: ClusterBinScratch,
): number {
  const count = standardClusterBinnedLightCount(frame.local);
  projectClusterLightBounds(
    frame.local,
    count,
    frame.view,
    frame.projection,
    layout.grid,
    frame.near,
    frame.far,
    scratch,
  );
  return count;
}

export function publishStandardMembership(
  runs: StandardClusterRuns,
  lightBounds: Int32Array | SubmittedClusterBounds,
  scratch: ClusterBinScratch,
  publication?: ClusterMembershipPublication,
): Result<StandardClusterMembership, RenderError> {
  return ok({
    publication,
    clusterGrid: runs.clusterGrid,
    get lightIndexList() {
      return runs.lightIndexList(scratch);
    },
    boundsColumn: lightBounds instanceof SubmittedClusterBounds ? lightBounds : undefined,
    get lightBounds() {
      return lightBounds instanceof SubmittedClusterBounds
        ? lightBounds.materialize()
        : lightBounds;
    },
    membershipLightCount: runs.lightCount,
    membershipEntryCount: runs.membershipEntryCount,
    occupiedClusterCount: runs.occupiedClusterCount,
    clusterEntryCapK: runs.clusterEntryCapK,
    droppedClusterEntries: runs.droppedClusterEntries,
    scratch,
  });
}

export function deriveStandardMembership(
  frame: StandardLightFrame,
  layout: StandardClusterLayout,
  scratch = createClusterBinScratch(),
): Result<StandardClusterMembership, RenderError> {
  const count = projectStandardLightCells(frame, layout, scratch);
  const runs = new StandardClusterRuns(layout, count, scratch);
  const bounds = new Int32Array(producerBoundsInt32Length(count));
  encodeProducerBounds(frame.local, runs.cellBounds, frame.view, frame.projection, bounds, count);
  bounds[PRODUCER_RESERVATION_END_WORD] = runs.membershipEntryCount;
  return publishStandardMembership(runs, bounds, scratch);
}
