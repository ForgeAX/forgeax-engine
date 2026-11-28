import { vec3 } from '@forgeax/engine-math';
import {
  type ClusterBinScratch,
  createClusterBinScratch,
  encodeProducerBounds,
  PRODUCER_RESERVATION_END_WORD,
  producerBoundsInt32Length,
} from '../../cluster-binner';
import { GpuTableWrites } from '../../gpu-table-writes';
import {
  createStandardClusterLayout,
  DEFAULT_CLUSTER_GRID,
  type StandardClusterLayout,
} from './layout';
import type { StandardLightFrame } from './light-frame';
import {
  projectStandardLightCells,
  publishStandardMembership,
  StandardClusterRuns,
} from './membership';

import {
  type ClusterMembershipPublication,
  describeClusterWords,
  SubmittedClusterBounds,
} from './membership-publication';

/** A view projects every current light. Its CPU runs and GPU producer bytes have
 * independent lifetimes: cone motion can change GPU intersections inside the same cell box. */
export class StandardClusterMembershipOwner {
  private stockLayout: StandardClusterLayout | undefined;
  private defaultScratch: ClusterBinScratch | undefined;
  private runScratch: ClusterBinScratch | undefined;
  private runs: StandardClusterRuns | undefined;
  private readonly centre = vec3.create();
  private staging: Int32Array | undefined;
  private words: Float32Array | undefined;
  private readonly editedPages = new GpuTableWrites();
  private published: SubmittedClusterBounds | undefined;
  private publication: ClusterMembershipPublication | undefined;

  layout(slots: number, grid: StandardClusterLayout['grid']): StandardClusterLayout {
    if (grid !== DEFAULT_CLUSTER_GRID) return createStandardClusterLayout(slots, grid);
    if (this.stockLayout?.lightDataSlotCount !== slots)
      this.stockLayout = createStandardClusterLayout(slots, grid);
    return this.stockLayout;
  }

  derive(frame: StandardLightFrame, layout: StandardClusterLayout, scratch?: ClusterBinScratch) {
    scratch ??= this.defaultScratch ??= createClusterBinScratch();
    const count = projectStandardLightCells(frame, layout, scratch);
    const previousRuns = this.runs;
    if (this.runScratch !== scratch || !this.runs?.contains(layout, count, scratch.lightBounds)) {
      this.runs = new StandardClusterRuns(layout, count, scratch);
      this.runScratch = scratch;
    }
    const size = producerBoundsInt32Length(count);
    if (
      !this.staging ||
      this.staging.length < size ||
      this.staging.length > Math.max(128, 4 * size)
    ) {
      this.staging = new Int32Array(size);
      this.words = new Float32Array(this.staging.buffer);
    }
    this.published?.releaseRecording();
    encodeProducerBounds(
      frame.local,
      this.runs.cellBounds,
      frame.view,
      frame.projection,
      this.staging,
      count,
      this.words,
      this.centre,
    );
    this.staging[PRODUCER_RESERVATION_END_WORD] = this.runs.membershipEntryCount;
    const previous = this.publication;
    this.published = SubmittedClusterBounds.capture(
      this.staging,
      size,
      this.editedPages,
      this.published,
    );
    const bounds = this.published.change;
    if (previous === undefined || bounds !== previous.bounds || previousRuns !== this.runs) {
      const grid =
        previous !== undefined && previousRuns === this.runs
          ? previous.grid
          : describeClusterWords(
              this.runs.clusterGrid,
              this.runs.clusterGrid.length,
              previousRuns?.clusterGrid,
              previous?.grid,
            );
      this.publication = {
        bounds,
        grid,
        indices: previous !== undefined && previousRuns === this.runs ? previous.indices : Symbol(),
      };
    }
    return publishStandardMembership(this.runs, this.published, scratch, this.publication);
  }

  clear(): void {
    this.stockLayout = undefined;
    this.editedPages.release();
    this.runs = this.runScratch = this.defaultScratch = undefined;
    this.publication = undefined;
    this.published?.releaseRecording();
    this.published = undefined;
    this.words = this.staging = undefined;
  }
}
