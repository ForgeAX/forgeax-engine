import type { RenderSceneResyncReason } from '../inspection-types';
import type { InstanceOrdinalOrder } from '../instance-generations';
import type { InstanceBoundsCacheInspection } from '../instances-derived-bounds';
import type { MaterialResource } from '../material-resource';
import type { RenderableSnapshot, RenderableTemporalSnapshot } from '../render-system-extract';
import type { FrameList } from './frame-list';
import type { MeshFrame, MeshGeometry } from './mesh-frame';

export type { RenderSceneResyncReason } from '../inspection-types';

/** Temporal fields and the qualified instance order borrowed by a synchronous upload. */
export type GpuSceneMotion = {
  -readonly [K in 'motionValid' | 'reactive' | 'previousInstances']: RenderableTemporalSnapshot[K];
} & {
  instanceOrder?: InstanceOrdinalOrder | undefined;
  instanceOrderGenerations?: Uint32Array | undefined;
};

export interface RenderSceneIdentity {
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

/** Final owner-issued identity and owned source facts, still absent from active Scene rows. */
export interface ReservedSceneRow extends RenderSceneRecord {
  readonly snapshot: RenderableSnapshot;
}

/** Captured geometry for the exact reserved identity; authored row data stays with Scene. */
export interface SceneRowGeometry {
  readonly source: ReservedSceneRow;
  readonly geometry: MeshGeometry;
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
  /** Issued rows in commit order. Pure pose writes read their captured Scene pages. */
  readonly updatedSlots: FrameList<RenderSceneSlot>;
  /** Full draw updates for authored content or changed winding, including any instance edits. */
  readonly contentUpdatedSlots: readonly RenderSceneSlot[];
  /** Instance edits for slots outside the content lane. Root transforms may change too. */
  readonly instanceUpdatedSlots: readonly RenderSceneSlot[];
  /** Pre-apply records of the removed rows. */
  readonly removedSlots: readonly RenderSceneSlot[];
  readonly recreatedSlots: readonly RenderSceneSlot[];
  /**
   * Prior authored rows for content replacement and recreation, keyed by the
   * issued row. Pose, winding and instance-only changes leave authored facts
   * intact. Readers of prior poses use their captured Scene frame.
   */
  readonly previous: ReadonlyMap<RenderSceneSlot, RenderSceneSlot>;
  readonly resynced: number;
  /**
   * The written rows' change journal; the GPU Scene appends its content
   * entries to it so shadow caches read one cursor.
   */
  readonly journal?: import('./row-change-log').RowChangeLog;
}

export interface RenderSceneInspection {
  readonly records: readonly RenderSceneRecord[];
  readonly slotCapacity: number;
  readonly freeSlots: number;
  /** Physical numeric storage held for the active culling bounds. */
  readonly cullingBoundsBackingBytes?: number;
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
