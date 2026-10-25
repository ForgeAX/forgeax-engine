import type { FrameSet } from './frame-set';
import type { MeshFrame } from './mesh-frame';
import type { ProbeBlendBufferProjection } from './probe-blend';
import type { SceneSlotFrame } from './scene-slots';

/**
 * The fixed roots one Scene owner's `drawSnapshotAt` reads. Two captures of
 * the same owner link: their differences name every slot whose draw snapshot
 * can differ.
 */
export interface DrawEvidence {
  readonly slots: SceneSlotFrame;
  readonly meshes: MeshFrame;
  readonly unavailable: FrameSet;
  readonly probe: ProbeBlendBufferProjection;
  /** Submitted history of temporal snapshots; undefined while untracked. */
  readonly temporal: object | undefined;
}

export interface DrawChangeVisitor {
  /** A slot the row-change log names; its row version tells whether it still differs. */
  slot(slot: number): void;
  /** A slot whose availability or probe record changed without a row write. */
  row(slot: number): void;
  /** A Mesh whose effective draw facts may differ for every slot drawing it. */
  mesh(worldId: number, handle: number): void;
}

/**
 * Visit what may differ between two captures. False when they cannot be
 * linked (absent, another owner's history, or a new temporal history): the
 * caller then re-reads every row it holds.
 */
export function drawChangesSince(
  before: DrawEvidence | undefined,
  after: DrawEvidence | undefined,
  visit: DrawChangeVisitor,
): boolean {
  if (before === undefined || after === undefined) return false;
  if (before === after) return true;
  if (before.temporal !== after.temporal) return false;
  const probe = after.probe;
  if (before.probe !== probe) {
    if (
      probe.sourceIdentity !== before.probe.sourceIdentity ||
      probe.baseRevision !== before.probe.revision
    )
      return false;
    for (const { cacheKey } of probe.dirtyRecords) visit.row(cacheKey);
    for (const cacheKey of probe.removedCacheKeys) visit.row(cacheKey);
  }
  // Entered, left and changed rows come from the Scene's row-change log cursor.
  if (before.slots !== after.slots && !after.slots.changesSince(before.slots, visit.slot))
    return false;
  if (before.unavailable !== after.unavailable)
    after.unavailable.changesSince(before.unavailable, visit.row);
  if (before.meshes !== after.meshes)
    after.meshes.changesSince(before.meshes, (previous, current) => {
      const geometry = current ?? previous;
      if (geometry !== undefined) visit.mesh(geometry.worldId, geometry.handle);
    });
  return true;
}
