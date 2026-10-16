import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import timings from '../scripts/ci/dawn-file-seconds.json' with { type: 'json' };
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../scripts/ci/dawn-gate-roster.mjs';

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
  const ranked = files
    .map((specification) => {
      const path = relative(root, specification.moduleId).replaceAll('\\', '/');
      return {
        specification,
        path,
        seconds: fileSeconds.get(path) ?? unmeasuredFileSeconds,
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
    if (files.some((specification) => specification.project.name !== 'dawn')) {
      return super.shard(files);
    }
    const shard = this.ctx.config.shard;
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
