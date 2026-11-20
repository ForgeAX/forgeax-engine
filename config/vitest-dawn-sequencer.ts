import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { coreValidationFiles } from '../scripts/ci/core-validation.mjs';
import {
  DAWN_GATE_GROUPS,
  DAWN_GATE_SHARDS,
  DAWN_ORDINARY_FILE_FAMILIES,
  dawnAuthoringCapturesOutsideCi,
} from '../scripts/ci/dawn-gate-roster.mjs';
import coverageTimings from '../scripts/ci/modeling-coverage-file-seconds.json' with {
  type: 'json',
};

import { dawnPlanningFileCosts, dawnPlanningOwnerCosts } from './dawn-timings.ts';

const fileSeconds = dawnPlanningFileCosts();
const tailSeconds = dawnPlanningOwnerCosts();
const unmeasuredFileSeconds = Math.max(...fileSeconds.values());
// New complete owners use the existing conservative file forecast until a
// completed run supplies an owner measurement. This does not change deadlines.
const localAuthoringOnly = new Set(dawnAuthoringCapturesOutsideCi());
for (const group of DAWN_GATE_GROUPS) {
  if (group.files.length > 0) {
    tailSeconds.set(
      group.id,
      tailSeconds.get(group.id) ??
        group.files.reduce(
          (sum, file) => sum + (fileSeconds.get(file) ?? unmeasuredFileSeconds),
          0,
        ),
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
  if (
    group.files.length > 0 &&
    coreValidationFiles(group.files).every((file) => localAuthoringOnly.has(file))
  ) {
    tailSeconds.set(group.id, 0);
  }
}

type DawnOrdinaryWorkers = 1 | 2;

/** Balance current complete owners; archived layouts are observations, not constraints. */
// Keep split files in the anchor's original logical owner and physical lane.
// Old receipts charge the complete family to that anchor exactly once.
export function planDawnShards(
  files: TestSpecification[],
  root: string,
  ordinaryWorkers: DawnOrdinaryWorkers = 1,
): TestSpecification[][] {
  const byPath = new Map(
    files.map((file) => [relative(root, file.moduleId).replaceAll('\\', '/'), file]),
  );
  const children = new Set<TestSpecification>();
  const families = new Map<TestSpecification, TestSpecification[]>();
  for (const family of DAWN_ORDINARY_FILE_FAMILIES) {
    const anchor = byPath.get(family.anchor);
    const members = family.children.flatMap((path) => byPath.get(path) ?? []);
    if (members.length === 0) continue;
    if (!anchor || members.length !== family.children.length)
      throw new Error('Dawn file family requires its complete population');
    families.set(anchor, members);
    for (const member of members) children.add(member);
  }
  return planDawnFileOwners(
    files.filter((file) => !children.has(file)),
    root,
    ordinaryWorkers,
  ).map((lane) => lane.flatMap((file) => [file, ...(families.get(file) ?? [])]));
}

function planDawnFileOwners(
  files: TestSpecification[],
  root: string,
  ordinaryWorkers: DawnOrdinaryWorkers = 1,
): TestSpecification[][] {
  if (ordinaryWorkers !== 1 && ordinaryWorkers !== 2)
    throw new Error('Dawn planning requires exactly one or two ordinary workers');
  const weights = new Map(
    [...fileSeconds].map(([file, seconds]) => [file, seconds / ordinaryWorkers]),
  );
  const bins = DAWN_GATE_SHARDS.map((owners) => ({
    files: [] as TestSpecification[],
    seconds: owners.reduce((sum, owner) => {
      if (owner.startsWith('ordinary-')) return sum;
      const forecast = tailSeconds.get(owner);
      if (forecast === undefined) throw new Error(`Dawn owner has no placement forecast: ${owner}`);
      return sum + forecast;
    }, 0),
  }));
  return partitionFiles(files, root, bins, weights, true);
}

function partitionFiles(
  files: TestSpecification[],
  root: string,
  bins: { files: TestSpecification[]; seconds: number }[],
  weights: ReadonlyMap<string, number>,
  spreadFirstWave = false,
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
  // Preserve qualified placement when discovery adds unmeasured files. New
  // owners retain the full fallback cost and backfill the established loads.
  const cohorts = spreadFirstWave
    ? [
        ranked.filter((file) => weights.has(file.path)),
        ranked.filter((file) => !weights.has(file.path)),
      ]
    : [ranked];
  for (const [index, cohort] of cohorts.entries()) {
    // Native reserves must not admit several largest owners before peers.
    const occupied = new Set(
      index === 1
        ? ranked
            .slice(0, bins.length)
            .flatMap((file) => bins.filter((bin) => bin.files.includes(file.specification)))
        : [],
    );
    const firstWave = new Set(spreadFirstWave ? bins.filter((bin) => !occupied.has(bin)) : []);
    for (const file of cohort) {
      const eligible = firstWave.size > 0 ? [...firstWave] : bins;
      const target = eligible.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best));
      firstWave.delete(target);
      target.files.push(file.specification);
      target.seconds += file.seconds;
    }
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
