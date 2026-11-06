import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import timings from '../scripts/ci/dawn-file-seconds.json' with { type: 'json' };
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../scripts/ci/dawn-gate-roster.mjs';
import coverageTimings from '../scripts/ci/modeling-coverage-file-seconds.json' with {
  type: 'json',
};

const fileSeconds = new Map(Object.entries(timings.files));
const tailSeconds = new Map(Object.entries(timings.owners));
const unmeasuredFileSeconds = Math.max(...fileSeconds.values());
// New complete owners use the existing conservative file forecast until a
// completed run supplies an owner measurement. This does not change deadlines.
for (const group of DAWN_GATE_GROUPS) {
  if (!tailSeconds.has(group.id) && group.files.length > 0) {
    tailSeconds.set(
      group.id,
      group.files.reduce((sum, file) => sum + (fileSeconds.get(file) ?? unmeasuredFileSeconds), 0),
    );
  }
  // A placement reserve keeps long native journeys from accumulating ordinary
  // backfill. It never changes a test deadline or lowers a measured forecast.
  if ('placementReserveSeconds' in group && typeof group.placementReserveSeconds === 'number') {
    tailSeconds.set(
      group.id,
      Math.max(tailSeconds.get(group.id) ?? 0, group.placementReserveSeconds),
    );
  }
}

export function planDawnShards(files: TestSpecification[], root: string): TestSpecification[][] {
  const bins: { files: TestSpecification[]; seconds: number }[] = DAWN_GATE_SHARDS.map(
    (owners) => ({
      files: [],
      seconds: owners.reduce((sum, owner) => {
        if (owner.startsWith('ordinary-')) return sum;
        const seconds = tailSeconds.get(owner);
        if (seconds === undefined)
          throw new Error(`Dawn owner has no placement forecast: ${owner}`);
        return sum + seconds;
      }, 0),
    }),
  );
  partitionFiles(files, root, bins, fileSeconds);
  return refineDawnShards(bins, root);
}

// Retained maxima protect capacity, while distinct complete run snapshots
// prevent a single slow runner from clustering the next ordinary partition.
function refineDawnShards(
  bins: { files: TestSpecification[]; seconds: number }[],
  root: string,
): TestSpecification[][] {
  const snapshots = [timings.previousRun, timings.latestRun, ...timings.replayRuns];
  const pathOf = (file: TestSpecification) => relative(root, file.moduleId).replaceAll('\\', '/');
  const paths = new Map(
    bins.flatMap((bin) => bin.files.map((file) => [file, pathOf(file)] as const)),
  );
  const reserves = new Map(
    [...paths].map(([file, path]) => [file, fileSeconds.get(path) ?? unmeasuredFileSeconds]),
  );
  const reserve = (file: TestSpecification) => reserves.get(file) ?? unmeasuredFileSeconds;
  const costs = snapshots.map((snapshot) => {
    const measured = new Map(Object.entries(snapshot.files));
    const values = new Map(
      [...paths].map(([file, path]) => [file, measured.get(path) ?? reserve(file)]),
    );
    return (file: TestSpecification) => values.get(file) ?? reserve(file);
  });
  const loads = snapshots.map((snapshot, sample) => {
    const owners = new Map(Object.entries(snapshot.owners));
    return bins.map((bin, lane) =>
      bin.files.reduce(
        (sum, file) => sum + costs[sample](file),
        DAWN_GATE_SHARDS[lane].reduce(
          (sum, owner) =>
            owner.startsWith('ordinary-')
              ? sum
              : sum + (owners.get(owner) ?? tailSeconds.get(owner) ?? 0),
          0,
        ),
      ),
    );
  });
  const largest = Math.max(...bins.flatMap((bin) => bin.files.map(reserve)));
  const capacity = Math.max(...bins.map((bin) => bin.seconds)) + largest;
  const score = (values: number[][]) => [
    Math.max(...values.flat()),
    values.flat().reduce((sum, value) => sum + value * value, 0),
  ];
  const improves = (left: number[], right: number[]) =>
    left[0] < right[0] - 1e-6 || (Math.abs(left[0] - right[0]) < 1e-6 && left[1] < right[1] - 1e-6);

  for (let iteration = 0; iteration < 32; iteration += 1) {
    let best = score(loads);
    let selected: { left: number; right: number; a: number; b: number } | undefined;
    for (let left = 0; left < bins.length; left += 1) {
      for (let right = left + 1; right < bins.length; right += 1) {
        for (let a = 0; a < bins[left].files.length; a += 1) {
          for (let b = 0; b < bins[right].files.length; b += 1) {
            const first = bins[left].files[a];
            const second = bins[right].files[b];
            const delta = reserve(second) - reserve(first);
            const retained = bins.map(
              (bin, lane) => bin.seconds + (lane === left ? delta : lane === right ? -delta : 0),
            );
            if (
              Math.max(...retained) > capacity ||
              Math.max(...retained) - Math.min(...retained) > largest + 1e-6
            )
              continue;
            const candidate = loads.map((values, sample) => {
              const delta = costs[sample](second) - costs[sample](first);
              return values.map(
                (value, lane) => value + (lane === left ? delta : lane === right ? -delta : 0),
              );
            });
            const next = score(candidate);
            if (improves(next, best)) {
              best = next;
              selected = { left, right, a, b };
            }
          }
        }
      }
    }
    if (!selected) break;
    const { left, right, a, b } = selected;
    const first = bins[left].files[a];
    const second = bins[right].files[b];
    const delta = reserve(second) - reserve(first);
    bins[left].seconds += delta;
    bins[right].seconds -= delta;
    costs.forEach((cost, sample) => {
      const delta = cost(second) - cost(first);
      loads[sample][left] += delta;
      loads[sample][right] -= delta;
    });
    bins[left].files[a] = second;
    bins[right].files[b] = first;
  }
  return bins.map((bin) => bin.files);
}

function partitionFiles(
  files: TestSpecification[],
  root: string,
  bins: { files: TestSpecification[]; seconds: number }[],
  weights: ReadonlyMap<string, number>,
): TestSpecification[][] {
  const fallback = Math.max(...weights.values());
  const ranked = files
    .map((specification) => {
      const path = relative(root, specification.moduleId).replaceAll('\\', '/');
      return {
        specification,
        path,
        seconds: weights.get(path) ?? fallback,
      };
    })
    .sort((a, b) => b.seconds - a.seconds || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ranked) {
    const target = bins.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best));
    target.files.push(file.specification);
    target.seconds += file.seconds;
  }
  return bins.map((bin) => bin.files);
}

export class DawnSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (
      shard &&
      this.ctx.config.coverage?.enabled &&
      files.length > 0 &&
      files.every((specification) => specification.project.name === '@forgeax/engine-modeling')
    ) {
      const bins = Array.from({ length: shard.count }, () => ({ files: [], seconds: 0 }));
      const selected = partitionFiles(
        files,
        this.ctx.config.root,
        bins,
        new Map(Object.entries(coverageTimings.files)),
      )[shard.index - 1];
      if (!selected) throw new Error(`Modeling shard index is outside ${shard.count} partitions`);
      return selected;
    }
    if (files.some((specification) => specification.project.name !== 'dawn')) {
      return super.shard(files);
    }
    if (!shard) return files;
    if (shard.count !== DAWN_GATE_SHARDS.length) {
      throw new Error(`Dawn requires ${DAWN_GATE_SHARDS.length} complete ordinary partitions`);
    }
    const owner = `ordinary-${shard.index}`;
    const lane = DAWN_GATE_SHARDS.findIndex((owners) => owners.includes(owner));
    if (lane < 0) throw new Error(`Dawn ordinary owner has no native lane: ${owner}`);
    const selected = planDawnShards(files, this.ctx.config.root)[lane];
    if (!selected) throw new Error(`Dawn shard index is outside ${shard.count} partitions`);
    return selected;
  }
}
