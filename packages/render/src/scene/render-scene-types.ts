import type { RenderSceneResyncReason } from '../inspection-types';
import type { InstanceBoundsCacheInspection } from '../instances-derived-bounds';
import type { MaterialResource } from '../material-resource';
import type { RenderableSnapshot } from '../render-system-extract';
import type { MeshFrame } from './mesh-frame';

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
  /** Changes with every write of this row; equal versions read equal facts. */
  readonly version: number;
  readonly snapshot: RenderableSnapshot;
}

export interface RenderSceneApplyResult {
  readonly materials?: import('./material-dispatch').MaterialFrame;
  readonly meshes?: MeshFrame;
  /** Shared resource adoption carries no entity operations. */
  readonly materialUpdates?: readonly MaterialResource[];
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
  /** Pre-apply records of the removed rows. */
  readonly removedSlots: readonly RenderSceneSlot[];
  readonly recreatedSlots: readonly RenderSceneSlot[];
  /**
   * Pre-apply record of every updated or recreated row, keyed by its post-apply
   * record. Consumers read prior facts from the delta, never from a captured frame.
   */
  readonly previous: ReadonlyMap<RenderSceneSlot, RenderSceneSlot>;
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
