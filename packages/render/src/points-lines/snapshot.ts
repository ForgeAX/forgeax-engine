import type { PointShape } from '../components/points';
import type { LinesStyleInput } from './admission';

interface PointsLinesViewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export type PointsLinesStyle =
  | { readonly kind: 'points'; readonly sizePx: number; readonly shape: PointShape }
  | ({ readonly kind: 'lines'; readonly width: number } & LinesStyleInput);

/**
 * Detached facts retained between frames for the Points/Lines owner.
 *
 * The snapshot deliberately contains no World, ECS row, AssetRegistry, GPU
 * handle, asset versions, or derived triangle data. Prepare selects versions
 * from the accepted asset scope when consuming an actual draw.
 */
export interface PointsLinesRetainedSnapshot {
  readonly worldId: number;
  readonly entityKey: number;
  readonly component: 'Points' | 'Lines' | undefined;
  readonly meshHandle: number;
  readonly materialHandle: number;
  readonly style: PointsLinesStyle | undefined;
  readonly layer: number;
  readonly sortKey: number | undefined;
  readonly visible: boolean;
  readonly sourceBounds: Float32Array;
  readonly viewport: PointsLinesViewport;
  readonly projection: Float32Array;
  readonly dedicatedResourceBytes?: number;
}

/** Exact content selected by the actual draw preparation, never patched into entity rows. */
export interface PointsLinesPreparedSnapshot extends PointsLinesRetainedSnapshot {
  readonly meshGeneration: number;
  readonly materialGeneration: number;
}

export interface PointsLinesSnapshotInput
  extends Omit<
    PointsLinesRetainedSnapshot,
    'sourceBounds' | 'viewport' | 'projection' | 'sortKey'
  > {
  readonly sortKey?: number | undefined;
  readonly sourceBounds: ArrayLike<number>;
  readonly viewport: PointsLinesViewport;
  readonly projection: ArrayLike<number>;
}

export function createPointsLinesSnapshot(
  input: PointsLinesSnapshotInput,
): PointsLinesRetainedSnapshot {
  return {
    worldId: input.worldId,
    entityKey: input.entityKey,
    component: input.component,
    meshHandle: input.meshHandle,
    materialHandle: input.materialHandle,
    style: input.style === undefined ? undefined : { ...input.style },
    layer: input.layer,
    sortKey: input.sortKey,
    visible: input.visible,
    sourceBounds: new Float32Array(input.sourceBounds),
    viewport: { ...input.viewport },
    projection: new Float32Array(input.projection),
    ...(input.component === undefined ? { dedicatedResourceBytes: 0 } : {}),
  };
}
