import type { Buffer, RhiError, RhiQueue } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { ClusterWordChange } from './membership-publication';
import type { PreparedStandardLighting } from './prepare';

const written = ok(undefined);

/** The physical destination remembers only the last accepted source token. Interrupted
 * updates and interleaved views recover directly from the next complete publication. */
class ClusterWordDestination {
  private accepted: symbol | undefined;

  forget(): void {
    this.accepted = undefined;
  }

  write(
    queue: RhiQueue,
    buffer: Buffer,
    source: Int32Array | Uint32Array,
    length: number,
    change: ClusterWordChange | undefined,
  ) {
    if (change !== undefined && change.id === this.accepted) return written;
    const relative = this.accepted !== undefined && this.accepted === change?.base;
    const first = relative ? change.first : 0;
    const end = relative ? change.end : length;
    this.accepted = undefined;
    const runs = relative ? change.runs : undefined;
    if (runs !== undefined) {
      for (let i = 0; i < runs.length; i += 2) {
        const start = runs[i] as number,
          after = runs[i + 1] as number;
        const upload = queue.writeBuffer(buffer, start * 4, source, start, after - start);
        if (!upload.ok) return upload;
      }
    } else if (end > first) {
      const upload = queue.writeBuffer(buffer, first * 4, source, first, end - first);
      if (!upload.ok) return upload;
    }
    this.accepted = change?.id;
    return written;
  }
}

interface ClusterStorageBuffers {
  readonly lightBoundsBuffer: Buffer;
  readonly clusterGridBuffer: Buffer;
  readonly lightIndexListBuffer: Buffer;
}

/** Input starts survive compute dispatch; counts and output indices belong to the
 * active producer. Switching to the CPU restores precisely those GPU-written products. */
export class StandardClusterStorage {
  private readonly bounds = new ClusterWordDestination();
  private readonly grid = new ClusterWordDestination();
  private cpuIndices: symbol | undefined;
  private gpuCounts = false;

  write(
    queue: RhiQueue,
    buffers: ClusterStorageBuffers,
    prepared: PreparedStandardLighting,
    gpu: boolean,
  ): Result<
    void,
    {
      readonly product: 'light-bounds' | 'cluster-grid' | 'light-index-list';
      readonly error: RhiError;
    }
  > {
    const publication = prepared.publication;
    if (gpu) {
      this.cpuIndices = undefined;
      const issued = prepared.boundsColumn;
      const values = issued?.uploadWords() ?? prepared.lightBounds;
      const bounds = this.bounds.write(
        queue,
        buffers.lightBoundsBuffer,
        values,
        issued?.length ?? values.length,
        publication?.bounds,
      );
      if (!bounds.ok) return err({ product: 'light-bounds', error: bounds.error });
    } else if (this.gpuCounts) this.grid.forget();
    this.gpuCounts = gpu;
    const grid = this.grid.write(
      queue,
      buffers.clusterGridBuffer,
      prepared.clusterGrid,
      prepared.layout.clusterGridU32Length,
      publication?.grid,
    );
    if (!grid.ok) return err({ product: 'cluster-grid', error: grid.error });
    if (!gpu && (publication === undefined || this.cpuIndices !== publication.indices)) {
      this.cpuIndices = undefined;
      if (prepared.membershipEntryCount > 0) {
        const indices = queue.writeBuffer(
          buffers.lightIndexListBuffer,
          0,
          prepared.lightIndexList,
          0,
          prepared.membershipEntryCount,
        );
        if (!indices.ok) return err({ product: 'light-index-list', error: indices.error });
      }
      this.cpuIndices = publication?.indices;
    }
    return written;
  }
}
