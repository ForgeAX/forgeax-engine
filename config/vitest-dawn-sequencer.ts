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

type DawnOrdinaryWorkers = 1 | 2;

// Two isolated forks consume retained work on two slots. The largest-file
// list-scheduling tail and one minute also reserve startup and uneven finishes.
// These are execution forecasts, never rewritten timing observations.
function ordinaryTailSeconds(largestSlotCost: number, workers: DawnOrdinaryWorkers): number {
  return workers === 2 ? largestSlotCost + 60 : 0;
}

export function planDawnShards(
  files: TestSpecification[],
  root: string,
  ordinaryWorkers: DawnOrdinaryWorkers = 1,
): TestSpecification[][] {
  if (ordinaryWorkers !== 1 && ordinaryWorkers !== 2)
    throw new Error('Dawn planning requires exactly one or two ordinary workers');
  const weights = new Map(
    [...fileSeconds].map(([file, seconds]) => [file, seconds / ordinaryWorkers]),
  );
  const largest = Math.max(
    0,
    ...files.map(
      (file) =>
        weights.get(relative(root, file.moduleId).replaceAll('\\', '/')) ??
        unmeasuredFileSeconds / ordinaryWorkers,
    ),
  );
  let best: ReturnType<typeof refineDawnShards> | undefined;
  const placements = DAWN_GATE_SHARDS.reduce((count, _lane, index) => count * (index + 1), 1);
  for (let rotation = 0; rotation < placements; rotation++) {
    const bins: { files: TestSpecification[]; seconds: number }[] = DAWN_GATE_SHARDS.map(
      (owners) => ({
        files: [],
        seconds: owners.reduce(
          (sum, owner) => {
            if (owner.startsWith('ordinary-')) return sum;
            const seconds = tailSeconds.get(owner);
            if (seconds === undefined)
              throw new Error(`Dawn owner has no placement forecast: ${owner}`);
            return sum + seconds;
          },
          ordinaryTailSeconds(largest, ordinaryWorkers),
        ),
      }),
    );
    partitionFiles(files, root, bins, weights, true, rotation);
    const candidate = refineDawnShards(bins, root, ordinaryWorkers);
    if (!best || improvesDawnScore(candidate.score, best.score)) best = candidate;
    if (best.score[0] === 0 || !candidate.totalFits) break;
  }
  if (!best) throw new Error('Dawn has no configured placement lanes');
  return best.partitions;
}

type DawnBin = { files: TestSpecification[]; seconds: number };
type DawnCost = (file: TestSpecification) => number;
type DawnCostVectors = ReadonlyMap<TestSpecification, readonly number[]>;
type DawnTimingSnapshot = {
  readonly files: Readonly<Record<string, number | undefined>>;
  readonly owners: Readonly<Record<string, number | undefined>>;
  readonly reservedFiles?: Readonly<Record<string, number | undefined>>;
  readonly reservedOwners?: Readonly<Record<string, number | undefined>>;
};
type DawnRelocation = { kind: 'move'; from: number; to: number; index: number; score: number[] };
type DawnRefinement =
  | DawnRelocation
  | { kind: 'swap'; left: number; right: number; a: number; b: number; score: number[] };

// Minimize all replay-window violations before balancing the remaining load.
// A pure peak objective can trap pair swaps at tied peaks on different cohorts.
// Keep the five-second shader-profile producer and a one-second planning
// margin inside the existing replay window. Runtime deadlines stay unchanged.
const dawnReplaySeconds = 2_200 - 5 - 1;
function dawnLoadScore(values: number[][]): number[] {
  return [
    values.flat().reduce((sum, value) => sum + Math.max(0, value - dawnReplaySeconds) ** 2, 0),
    Math.max(...values.flat()),
    values.flat().reduce((sum, value) => sum + value * value, 0),
  ];
}

// Score a proposed two-lane transfer without allocating a copied load matrix.
function shiftedDawnScore(
  loads: number[][],
  costs: DawnCostVectors,
  left: number,
  right: number,
  first: TestSpecification,
  second?: TestSpecification,
): number[] {
  let overload = 0;
  let peak = 0;
  let squares = 0;
  const firstCosts = costs.get(first);
  const secondCosts = second ? costs.get(second) : undefined;
  if (!firstCosts) throw new Error('Dawn transfer has no complete cost vector');
  for (let sample = 0; sample < loads.length; sample++) {
    const delta = (secondCosts?.[sample] ?? 0) - firstCosts[sample];
    for (let lane = 0; lane < loads[sample].length; lane++) {
      const value = loads[sample][lane] + (lane === left ? delta : lane === right ? -delta : 0);
      overload += Math.max(0, value - dawnReplaySeconds) ** 2;
      peak = Math.max(peak, value);
      squares += value * value;
    }
  }
  return [overload, peak, squares];
}

function improvesDawnScore(left: number[], right: number[]): boolean {
  for (let index = 0; index < left.length; index++) {
    if (Math.abs(left[index] - right[index]) >= 1e-6) return left[index] < right[index];
  }
  return false;
}

function fitsDawnCapacity(values: number[], capacity: number, largest: number): boolean {
  return (
    Math.max(...values) <= capacity && Math.max(...values) - Math.min(...values) <= largest + 1e-6
  );
}

// Pair swaps retain each lane's file count. A complete-file relocation can
// use remaining capacity when measured cohorts need different lane counts.
function findDawnRelocation(
  bins: DawnBin[],
  loads: number[][],
  firstWave: ReadonlySet<TestSpecification>,
  reserve: DawnCost,
  costs: DawnCostVectors,
  capacity: number,
  largest: number,
): DawnRelocation | undefined {
  let best = dawnLoadScore(loads);
  let selected: DawnRelocation | undefined;
  for (let from = 0; from < bins.length; from++) {
    for (let index = 0; index < bins[from].files.length; index++) {
      const file = bins[from].files[index];
      if (firstWave.has(file)) continue;
      for (let to = 0; to < bins.length; to++) {
        if (to === from) continue;
        const retained = bins.map(
          (bin, lane) =>
            bin.seconds + (lane === to ? reserve(file) : lane === from ? -reserve(file) : 0),
        );
        if (!fitsDawnCapacity(retained, capacity, largest)) continue;
        const next = shiftedDawnScore(loads, costs, from, to, file);
        if (improvesDawnScore(next, best)) {
          best = next;
          selected = { kind: 'move', from, to, index, score: next };
        }
      }
    }
  }
  return selected;
}

function applyDawnRefinement(
  selected: DawnRefinement,
  bins: DawnBin[],
  loads: number[][],
  reserve: DawnCost,
  costs: DawnCost[],
): void {
  if (selected.kind === 'move') {
    const { from, to, index } = selected;
    const [file] = bins[from].files.splice(index, 1);
    bins[to].files.push(file);
    bins[from].seconds -= reserve(file);
    bins[to].seconds += reserve(file);
    costs.forEach((cost, sample) => {
      loads[sample][from] -= cost(file);
      loads[sample][to] += cost(file);
    });
    return;
  }
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

// Retained maxima protect capacity. Distinct complete ordinary-process cohorts
// prevent a slow runner from clustering the next partition; interrupted native
// owners keep the existing conservative forecast, never a synthetic measurement.
function refineDawnShards(
  bins: { files: TestSpecification[]; seconds: number }[],
  root: string,
  ordinaryWorkers: DawnOrdinaryWorkers,
): { partitions: TestSpecification[][]; score: number[]; totalFits: boolean } {
  const snapshots: readonly DawnTimingSnapshot[] = [
    timings.previousRun,
    ...timings.replayRuns,
    timings.latestRun,
  ];
  const firstWave = new Set(bins.flatMap((bin) => bin.files.slice(0, 1)));
  const pathOf = (file: TestSpecification) => relative(root, file.moduleId).replaceAll('\\', '/');
  const paths = new Map(
    bins.flatMap((bin) => bin.files.map((file) => [file, pathOf(file)] as const)),
  );
  const reserves = new Map(
    [...paths].map(([file, path]) => [
      file,
      (fileSeconds.get(path) ?? unmeasuredFileSeconds) / ordinaryWorkers,
    ]),
  );
  const reserve = (file: TestSpecification) =>
    reserves.get(file) ?? unmeasuredFileSeconds / ordinaryWorkers;
  const costs = snapshots.map((snapshot) => {
    // Partial runs keep explicit inherited forecasts separate from observations.
    // The retained global maxima still own capacity and every older scenario.
    const fileCosts = new Map(Object.entries({ ...snapshot.reservedFiles, ...snapshot.files }));
    const values = new Map(
      [...paths].map(([file, path]) => [
        file,
        (fileCosts.get(path) ?? reserve(file) * ordinaryWorkers) / ordinaryWorkers,
      ]),
    );
    return (file: TestSpecification) => values.get(file) ?? reserve(file);
  });
  const loads = snapshots.map((snapshot, sample) => {
    const owners = new Map(Object.entries({ ...snapshot.reservedOwners, ...snapshot.owners }));
    const tail = ordinaryTailSeconds(
      Math.max(0, ...[...paths.keys()].map(costs[sample])),
      ordinaryWorkers,
    );
    return bins.map((bin, lane) =>
      bin.files.reduce(
        (sum, file) => sum + costs[sample](file),
        DAWN_GATE_SHARDS[lane].reduce(
          (sum, owner) =>
            owner.startsWith('ordinary-')
              ? sum
              : sum + (owners.get(owner) ?? tailSeconds.get(owner) ?? 0),
          tail,
        ),
      ),
    );
  });
  const costVectors = new Map(
    [...paths.keys()].map((file) => [file, costs.map((cost) => cost(file))] as const),
  );
  // A cohort larger than all four windows cannot fit any permutation. Keep
  // its forecasts and best placement, without repeating an impossible search.
  const totalFits = loads.every(
    (row) =>
      row.reduce((sum, seconds) => sum + seconds, 0) <= dawnReplaySeconds * row.length + 1e-6,
  );
  const largest = Math.max(...bins.flatMap((bin) => bin.files.map(reserve)));
  const capacity = Math.max(...bins.map((bin) => bin.seconds)) + largest;

  for (let iteration = 0; iteration < 512; iteration += 1) {
    let selected: DawnRefinement | undefined = findDawnRelocation(
      bins,
      loads,
      firstWave,
      reserve,
      costVectors,
      capacity,
      largest,
    );
    let best = selected?.score ?? dawnLoadScore(loads);
    for (let left = 0; left < bins.length; left += 1) {
      for (let right = left + 1; right < bins.length; right += 1) {
        for (let a = 0; a < bins[left].files.length; a += 1) {
          for (let b = 0; b < bins[right].files.length; b += 1) {
            const first = bins[left].files[a];
            const second = bins[right].files[b];
            if (firstWave.has(first) !== firstWave.has(second)) continue;
            const delta = reserve(second) - reserve(first);
            const retained = bins.map(
              (bin, lane) => bin.seconds + (lane === left ? delta : lane === right ? -delta : 0),
            );
            if (!fitsDawnCapacity(retained, capacity, largest)) continue;
            const next = shiftedDawnScore(loads, costVectors, left, right, first, second);
            if (improvesDawnScore(next, best)) {
              best = next;
              selected = { kind: 'swap', left, right, a, b, score: next };
            }
          }
        }
      }
    }
    if (!selected) break;
    applyDawnRefinement(selected, bins, loads, reserve, costs);
  }
  return { partitions: bins.map((bin) => bin.files), score: dawnLoadScore(loads), totalFits };
}

function partitionFiles(
  files: TestSpecification[],
  root: string,
  bins: { files: TestSpecification[]; seconds: number }[],
  weights: ReadonlyMap<string, number>,
  spreadFirstWave = false,
  rotation = 0,
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
  // Native reserves can leave one lane admitting several largest ordinary
  // owners before its peers. Spread that first complete cost-ranked wave;
  // subsequent files still backfill the full retained native/ordinary load.
  const firstWave = new Set(spreadFirstWave ? bins : []);
  for (const file of ranked) {
    const eligible = firstWave.size > 0 ? [...firstWave] : bins;
    // Enumerate every first-wave permutation (24 for four lanes). Reusing one
    // rotation at every depth sampled only four of those distinct placements.
    const divisor = eligible.slice(1).reduce((count, _bin, index) => count * (index + 1), 1);
    const target =
      firstWave.size > 0 && rotation > 0
        ? [...eligible].sort((a, b) => a.seconds - b.seconds)[
            Math.floor(rotation / divisor) % eligible.length
          ]
        : eligible.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best));
    firstWave.delete(target);
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
    // Vitest's resolved project policy overrides root CLI maxWorkers. Plan
    // the pool that will actually execute these specifications.
    const workers = files[0]?.project.config.maxWorkers;
    if (workers !== 1 && workers !== 2)
      throw new Error('Dawn project must resolve exactly one or two ordinary workers');
    const selected = planDawnShards(files, this.ctx.config.root, workers)[lane];
    if (!selected) throw new Error(`Dawn shard index is outside ${shard.count} partitions`);
    return selected;
  }
}
