import { err, ok, type Result } from '@forgeax/engine-types';
import type { GpuResidencyCache } from '../device/gpu-residency';
import { type DynamicGeometryRecordStageLane, MeshResidencyError } from '../dynamic-geometry';
import {
  type PreparedPublishedMeshResidency,
  type PublishedMeshPreparation,
  RenderPublicationError,
} from '../publication/contract';
import type { RenderPublicationReceiver } from '../publication/receiver';
import type { PublishedRenderResources } from '../publication/resource-scope';
import type { FrameReceipt } from '../render-contract';

/** Physical preparation only; the source owns its candidate and fixed-step admission. */
export function createPublishedMeshResidencyHost(options: {
  readonly receiver: RenderPublicationReceiver | undefined;
  readonly getGpuStore: () => GpuResidencyCache;
  readonly currentGeneration: () => number;
  readonly completeUploads: () => Promise<void>;
  readonly isCurrentFrame: (frame: FrameReceipt) => boolean;
  readonly recordStageLane: (
    resources: PublishedRenderResources,
    entity: number,
    meshHandle: number,
  ) => DynamicGeometryRecordStageLane | undefined;
}) {
  return async (
    input: PublishedMeshPreparation,
    inputOwnership?: 'received',
  ): Promise<
    Result<PreparedPublishedMeshResidency, RenderPublicationError | MeshResidencyError>
  > => {
    const receiver = options.receiver;
    if (receiver === undefined)
      return err(
        new RenderPublicationError({
          reason: 'identity',
          subject: 'Renderer has no publication source',
        }),
      );
    let retire = () => {};
    let published = () => {};
    const prepared = receiver.prepareMesh(
      input,
      () => retire(),
      () => published(),
      inputOwnership,
    );
    if (!prepared.ok) return prepared;
    const source = prepared.value;
    const generation = options.currentGeneration();
    const store = options.getGpuStore();
    const resident = store.ensureResident(input.meshHandle, source.mesh, source.resources);
    if (!resident.ok) {
      source.release();
      return err(
        new MeshResidencyError(
          'mesh-residency-gpu-failed',
          'the published MeshAsset has GPU residency',
          'repair the reported MeshAsset or RHI failure',
          resident.error,
        ),
      );
    }
    const lease = store.retainMeshResidency(input.meshHandle, source.resources);
    if (lease === undefined) {
      source.release();
      throw new Error('published mesh upload has no owned residency lease');
    }
    let released = false;
    let physicalReleased = false;
    let completion: Promise<void> | undefined;
    let transfer: { resolve(): void; reject(cause: unknown): void } | undefined;
    const isCurrent = () =>
      !released &&
      source.isCurrent() &&
      options.currentGeneration() === generation &&
      options.getGpuStore() === store &&
      store.getMeshGpuHandles(input.meshHandle, source.resources) === resident.value;
    const release = (evict = true) => {
      if (physicalReleased) return completion;
      released = true;
      const accepted = source.resources.resolveAsset(input.meshHandle);
      const published = accepted.ok && accepted.value === source.mesh;
      // A source World binding can precede its packet. Keep the prepared
      // allocation until that packet arrives, or cancellation upgrades to true.
      if (!evict && !published) {
        completion ??= new Promise<void>((resolve, reject) => {
          transfer = { resolve, reject };
        });
        return completion;
      }
      physicalReleased = true;
      const fence = lease.release(!published);
      // Keep the handle's payload identity reserved while an old allocation
      // can still be returned by ensureResident during its submission fence.
      if (transfer !== undefined) {
        void Promise.resolve(fence)
          .then(() => source.release())
          .then(transfer.resolve, transfer.reject);
      } else if (fence === undefined) source.release();
      else completion = fence.then(() => source.release());
      return completion;
    };
    retire = () => {
      release(true);
    };
    published = () => {
      if (released) release(false);
    };
    try {
      const completed = options.completeUploads();
      lease.track(completed);
      await completed;
    } catch (cause) {
      await release();
      return err(
        new MeshResidencyError(
          'mesh-residency-gpu-failed',
          'published mesh upload completes on the active GPU queue',
          'recover the Renderer before preparing again',
          cause,
        ),
      );
    }
    if (!isCurrent()) {
      await release();
      return err(
        new MeshResidencyError(
          'mesh-residency-gpu-not-ready',
          'prepared mesh belongs to the current receiver and device generation',
          'discard the stale preparation and retry after recovery',
        ),
      );
    }
    return ok({
      deviceGeneration: generation,
      isCurrent,
      release,
      recordStageLane: (frame, entity) => {
        if (!isCurrent() || frame.deviceGeneration !== generation || !options.isCurrentFrame(frame))
          return err(
            new RenderPublicationError({
              reason: 'revision',
              subject: 'mesh evidence requires the exact current submitted FrameReceipt',
            }),
          );
        if (!Number.isSafeInteger(entity))
          return err(
            new RenderPublicationError({ reason: 'shape', subject: 'mesh evidence entity' }),
          );
        return ok(options.recordStageLane(source.resources, entity, input.meshHandle));
      },
    });
  };
}
