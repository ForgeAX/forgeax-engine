import {
  createPointsLinesSnapshot,
  type PointsLinesPreparedSnapshot,
  type PointsLinesSnapshotInput,
} from '../snapshot';

export function createPreparedPointsLinesSnapshot(
  input: PointsLinesSnapshotInput & { meshGeneration: number; materialGeneration: number },
): PointsLinesPreparedSnapshot {
  return {
    ...createPointsLinesSnapshot(input),
    meshGeneration: input.meshGeneration,
    materialGeneration: input.materialGeneration,
  };
}
