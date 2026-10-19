import type { SubmissionPlan } from './batch-topology';
import { prepareLodProjectionPlan, rasterLodDraws } from './production-raster-lod';

interface ShadowLodLevels {
  readonly runs: readonly {
    readonly levels: readonly number[];
    readonly count: number;
  }[];
  readonly finest: number;
}

const cohortsByPlan = new WeakMap<SubmissionPlan, ReturnType<typeof prepareLodProjectionPlan>>();

function sameLevels(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((level, index) => level === right[index]);
}

/** Exact ordered per-primitive LOD sequences, compacted by repeated instances. */
export function shadowLodLevels(
  plan: SubmissionPlan,
  heights: ReadonlyMap<number, number> | undefined,
): ReadonlyMap<number, ShadowLodLevels> {
  let cohorts = cohortsByPlan.get(plan);
  if (cohorts === undefined) {
    cohorts = prepareLodProjectionPlan(plan);
    cohortsByPlan.set(plan, cohorts);
  }
  const mutable = new Map<
    number,
    { runs: { levels: readonly number[]; count: number }[]; finest: number }
  >();
  for (const { source, primitiveIndex, candidateCount } of cohorts.groups) {
    const levels = rasterLodDraws(
      source,
      source.lod,
      heights?.get(primitiveIndex) ?? Number.NaN,
    ).map((draw) => draw.level);
    let row = mutable.get(primitiveIndex);
    if (row === undefined) {
      row = { runs: [], finest: Number.POSITIVE_INFINITY };
      mutable.set(primitiveIndex, row);
    }
    const previous = row.runs.at(-1);
    if (previous !== undefined && sameLevels(previous.levels, levels))
      previous.count += candidateCount;
    else row.runs.push({ levels: Object.freeze(levels), count: candidateCount });
    for (const level of levels) row.finest = Math.min(row.finest, level);
  }
  return new Map(
    [...mutable].map(([primitive, row]) => [
      primitive,
      Object.freeze({
        runs: Object.freeze(row.runs.map((run) => Object.freeze(run))),
        finest: row.finest,
      }),
    ]),
  );
}

export function sameShadowLodLevels(
  left: ShadowLodLevels | undefined,
  right: ShadowLodLevels,
): boolean {
  return (
    left !== undefined &&
    (left === right ||
      (left.runs.length === right.runs.length &&
        left.runs.every((run, index) => {
          const other = right.runs[index];
          return (
            other !== undefined && run.count === other.count && sameLevels(run.levels, other.levels)
          );
        })))
  );
}
