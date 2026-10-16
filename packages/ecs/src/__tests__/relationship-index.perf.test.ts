import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { EntityHandle } from '../entity-handle';
import { defineRelationship } from '../relationship-index';
import { World } from '../world';

const SAMPLE_ROUNDS = 7;
const PARENT_COUNT = 8;
const CHILD_COUNT = 512;
const pair = defineRelationship({
  sourceName: 'PerfWorldRelationshipSource',
  sourceField: 'target',
  targetName: 'PerfWorldRelationshipTargets',
  targetField: 'sources',
});

type SampleStats = {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly ci95Ms: readonly [number, number];
  readonly sampleCount: number;
};

function percentile(samples: readonly number[], quantile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function summarize(samples: readonly number[]): SampleStats {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) /
    Math.max(1, samples.length - 1);
  const margin = 1.96 * Math.sqrt(variance / samples.length);
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    ci95Ms: [mean - margin, mean + margin],
    sampleCount: samples.length,
  };
}

function makeFixture(): {
  world: World;
  parents: readonly EntityHandle[];
  children: readonly EntityHandle[];
} {
  const world = new World();
  const parents = Array.from({ length: PARENT_COUNT }, () => world.spawn().unwrap());
  const children: EntityHandle[] = [];
  for (let index = 0; index < CHILD_COUNT; index += 1) {
    const child = world.spawn().unwrap();
    const parent = parents[index % PARENT_COUNT];
    if (parent === undefined) throw new Error('relationship benchmark parent missing');
    world.addChild(parent, child, pair.source, { target: parent }).unwrap();
    children.push(child);
  }
  return { world, parents, children };
}

function runWorldWorkload(mode: 'baseline' | 'candidate'): number {
  const { world, parents, children } = makeFixture();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const nextParent = parents[(index + 1) % PARENT_COUNT];
    if (child === undefined || nextParent === undefined)
      throw new Error('benchmark entity missing');
    world.reparent(child, nextParent, pair.source, { target: nextParent }).unwrap();
    world.removeChild(nextParent, child, pair.source).unwrap();
    world.addChild(nextParent, child, pair.source, { target: nextParent }).unwrap();
  }

  let count = 0;
  if (mode === 'candidate') {
    for (const parent of parents) count += world.get(parent, pair.target).unwrap().sources.length;
  } else {
    const sources = world.query({ read: [pair.source] }).unwrap();
    for (const parent of parents) {
      for (const row of sources) {
        if (row.get(pair.source).target === parent) count += 1;
      }
    }
  }
  return count;
}

function measure(mode: 'baseline' | 'candidate'): SampleStats {
  const samples: number[] = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round += 1) {
    const start = performance.now();
    const count = runWorldWorkload(mode);
    samples.push(performance.now() - start);
    if (count !== CHILD_COUNT) throw new Error(`relationship workload count mismatch: ${count}`);
  }
  return summarize(samples);
}

describe('M2 relationship World workload', () => {
  it('collects same-semantics baseline/candidate attach-detach-reparent-read evidence', () => {
    const baseline = measure('baseline');
    const candidate = measure('candidate');
    const environment = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    };
    const p95Stop = candidate.p95Ms > baseline.p95Ms * 1.05;
    // biome-ignore lint/suspicious/noConsole: benchmark emits machine-readable evidence
    console.info(
      JSON.stringify({
        schemaVersion: 1,
        workload: 'world-relationship-attach-detach-reparent-read',
        baseline,
        candidate,
        environment,
        workloadShape: { parents: PARENT_COUNT, children: CHILD_COUNT, rounds: SAMPLE_ROUNDS },
        stopRule: 'candidate p95 > baseline p95 * 1.05 requires human decision',
        p95Stop,
      }),
    );
    expect(baseline.sampleCount).toBe(SAMPLE_ROUNDS);
    expect(candidate.sampleCount).toBe(SAMPLE_ROUNDS);
    expect(p95Stop).toBe(false);
  });
});
