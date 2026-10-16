import type { RenderError } from '../errors/render';
import type { PointsLinesRetainedSnapshot, PointsLinesStyle } from './snapshot';

export type PointsLinesSourceError = Extract<
  RenderError,
  { readonly code: `points-lines-${string}` }
>;

export type PointsLinesInspectionLane =
  | 'pending'
  | 'refused'
  | 'direct'
  | 'clustered'
  | 'cpu-webgl2';

export interface PointsLinesInspectionCache {
  readonly hit: boolean;
  readonly rebuilds: number;
  readonly evictions: number;
}

export type PointsLinesInspectionRefusal = Pick<
  PointsLinesSourceError,
  'code' | 'expected' | 'hint' | 'detail'
> & {
  readonly generation: number;
  readonly lastKnownGood: boolean;
};

export interface PointsLinesInspection {
  readonly entityKey: number;
  readonly worldId: number;
  readonly component: 'Points' | 'Lines';
  readonly meshHandle: number;
  readonly meshGeneration: number;
  readonly materialHandle: number;
  readonly materialGeneration: number;
  readonly style: PointsLinesStyle;
  readonly topology: 'point-list' | 'line-list' | 'line-strip';
  readonly lane: PointsLinesInspectionLane;
  readonly pointCount: number;
  readonly segmentCount: number;
  readonly sourceBytes: number;
  readonly derivedBytes: number;
  readonly cache: PointsLinesInspectionCache;
  readonly drawCount: number;
  readonly uploadBytes: number;
  readonly lastKnownGood: boolean;
  readonly refusal?: PointsLinesInspectionRefusal;
}

export interface PointsLinesInspectionInput {
  readonly snapshot: PointsLinesRetainedSnapshot;
  readonly topology: 'point-list' | 'line-list' | 'line-strip';
  readonly lane: PointsLinesInspectionLane;
  readonly pointCount: number;
  readonly segmentCount: number;
  readonly sourceBytes: number;
  readonly derivedBytes: number;
  readonly cache: PointsLinesInspectionCache;
  readonly drawCount: number;
  readonly uploadBytes: number;
  readonly lastKnownGood: boolean;
  readonly refusal?: PointsLinesInspectionRefusal;
}

export function inspectPointsLines(input: PointsLinesInspectionInput): PointsLinesInspection {
  const { snapshot } = input;
  if (snapshot.component === undefined) {
    throw new Error('Points/Lines inspection requires a retained style component');
  }
  return {
    entityKey: snapshot.entityKey,
    worldId: snapshot.worldId,
    component: snapshot.component,
    meshHandle: snapshot.meshHandle,
    meshGeneration: snapshot.meshGeneration,
    materialHandle: snapshot.materialHandle,
    materialGeneration: snapshot.materialGeneration,
    style: snapshot.style ?? { kind: 'lines', width: 0 },
    topology: input.topology,
    lane: input.lane,
    pointCount: input.pointCount,
    segmentCount: input.segmentCount,
    sourceBytes: input.sourceBytes,
    derivedBytes: input.derivedBytes,
    cache: { ...input.cache },
    drawCount: input.drawCount,
    uploadBytes: input.uploadBytes,
    lastKnownGood: input.lastKnownGood,
    ...(input.refusal === undefined ? {} : { refusal: { ...input.refusal } }),
  };
}
