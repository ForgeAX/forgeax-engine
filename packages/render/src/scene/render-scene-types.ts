import type { RenderSceneResyncReason } from '../inspection-types';
import type { InstanceBoundsCacheInspection } from '../instances-derived-bounds';
import type { PointsLinesRetainedSnapshot } from '../points-lines/snapshot';
import type { RenderableSnapshot } from '../render-system-extract';

export type { RenderSceneResyncReason } from '../inspection-types';

export interface RenderSceneIdentity {
  readonly worldId: number;
  readonly entityKey: number;
}

/** One entity update merges the changed producer fields before publication. */
export type RenderSceneOperation =
  | (RenderSceneIdentity & {
      readonly kind: 'update';
      /** Complete source projection for membership, geometry or material edits. */
      readonly snapshot?: RenderableSnapshot;
      /** Detached instance payload; can accompany a root-transform update. */
      readonly instances?: NonNullable<RenderableSnapshot['instances']>;
      readonly world?: Float32Array;
    })
  | (RenderSceneIdentity & { readonly kind: 'remove' });

export interface RenderSceneRecord extends RenderSceneIdentity {
  readonly slot: number;
  readonly generation: number;
}

export interface RenderSceneSlot extends RenderSceneRecord {
  readonly snapshot: RenderableSnapshot;
  /** Optional detached projection carried with the retained render slot. */
  readonly pointsLines?: PointsLinesRetainedSnapshot;
}

export interface RenderSceneApplyResult {
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
  readonly recreated: number;
  readonly ignoredLateUpdates: number;
  readonly createdSlots: readonly RenderSceneSlot[];
  readonly updatedSlots: readonly RenderSceneSlot[];
  /** Full retained-snapshot updates; transform spans stay in updatedSlots only. */
  readonly contentUpdatedSlots: readonly RenderSceneSlot[];
  /** Retained snapshots with changed instance payloads; root transforms may change too. */
  readonly instanceUpdatedSlots: readonly RenderSceneSlot[];
  readonly removedSlots: readonly RenderSceneRecord[];
  readonly recreatedSlots: readonly RenderSceneSlot[];
  readonly resynced: number;
}

export interface RenderSceneInspection {
  readonly records: readonly RenderSceneRecord[];
  readonly slotCapacity: number;
  readonly freeSlots: number;
  readonly revision: number;
  readonly noChangeFrames: number;
  readonly deltaFrames: number;
  readonly renderableScans: number;
  readonly fullRebuilds: number;
  readonly resyncs: number;
  readonly lastResyncReason: RenderSceneResyncReason | undefined;
  /** Allocation/cache evidence for instance bounds derivation. */
  readonly instanceBoundsCache?: InstanceBoundsCacheInspection;
}

export interface RenderSceneBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
