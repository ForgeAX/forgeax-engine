import { execFileSync } from 'node:child_process';
import os from 'node:os';
import {
  type Component,
  defineComponent,
  defineRelationship,
  type EntityHandle,
  Time,
  Update,
  World,
} from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

const { source: ChildOf, target: Children } = defineRelationship({
  sourceName: 'M0PerfChildOf',
  sourceField: 'parent',
  targetName: 'M0PerfChildren',
  targetField: 'entities',
  exclusive: true,
  linkedSpawn: true,
});

const ENTITY_COUNT = 100_000;
const ROOT_COUNT = 1_000;
const COMMAND_COUNT = 10_000;
const CLOCK_READ_COUNT = 10_000_000;
const SAMPLE_ROUNDS = 3;

type Sample = {
  readonly name: string;
  readonly samplesMs: number[];
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly ci95Ms: readonly [number, number];
  readonly workload: Record<string, number>;
};

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

function summarize(name: string, samplesMs: number[], workload: Record<string, number>): Sample {
  const mean = samplesMs.reduce((sum, sample) => sum + sample, 0) / samplesMs.length;
  const variance =
    samplesMs.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) /
    Math.max(1, samplesMs.length - 1);
  const margin = 1.96 * Math.sqrt(variance / samplesMs.length);
  return {
    name,
    samplesMs,
    medianMs: percentile(samplesMs, 0.5),
    p95Ms: percentile(samplesMs, 0.95),
    ci95Ms: [mean - margin, mean + margin],
    workload,
  };
}

function measure(name: string, run: () => number, workload: Record<string, number>): Sample {
  const samples: number[] = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round += 1) {
    const start = performance.now();
    const result = run();
    samples.push(performance.now() - start);
    if (result < 0) throw new Error('M0 benchmark sink underflow');
  }
  return summarize(name, samples, workload);
}

function createHierarchy(): {
  world: World;
  roots: EntityHandle[];
  entities: EntityHandle[];
  value: Component;
} {
  const Value = defineComponent('M0PerfValue', { value: 'u32' });
  const children = Children as unknown as Component;
  const childOf = ChildOf as unknown as Component;
  const world = new World();
  const roots: EntityHandle[] = [];
  for (let index = 0; index < ROOT_COUNT; index += 1) {
    roots.push(
      world
        .spawn(
          { component: children, data: { entities: [] } },
          { component: Value, data: { value: index } },
        )
        .unwrap(),
    );
  }
  const entities: EntityHandle[] = [...roots];
  for (let index = ROOT_COUNT; index < ENTITY_COUNT; index += 1) {
    const parent = roots[index % ROOT_COUNT];
    if (parent === undefined) throw new Error('M0 benchmark root missing');
    entities.push(
      world
        .spawn(
          { component: childOf, data: { parent } },
          { component: Value, data: { value: index } },
        )
        .unwrap(),
    );
  }
  return { world, roots, entities, value: Value };
}

function createSubtree(): { world: World; root: EntityHandle } {
  const world = new World();
  const root = world
    .spawn({ component: Children as unknown as Component, data: { entities: [] } })
    .unwrap();
  for (let index = 0; index < 10_000; index += 1) {
    world.spawn({ component: ChildOf as unknown as Component, data: { parent: root } }).unwrap();
  }
  return { world, root };
}

describe('M0 ECS reduction workload characterization', () => {
  it('records fixed workload statistics and no comparison verdict', { timeout: 300_000 }, () => {
    const hierarchy = createHierarchy();
    const valueQuery = hierarchy.world.query({ read: [hierarchy.value] });
    expect(valueQuery.ok).toBe(true);
    if (!valueQuery.ok) throw new Error('M0 benchmark query failed');
    const samples: Sample[] = [];
    samples.push(
      measure(
        'row-span-iteration',
        () => {
          let rowSum = 0;
          for (const row of valueQuery.value)
            rowSum += Number((row.get(hierarchy.value) as { value: number }).value);
          let spanSum = 0;
          for (const span of valueQuery.value.spans().unwrap()) {
            const values = (span.get(hierarchy.value) as unknown as { value: ArrayLike<number> })
              .value;
            for (let index = 0; index < span.length; index += 1) spanSum += values[index] ?? 0;
          }
          return rowSum + spanSum;
        },
        { entities: ENTITY_COUNT, roots: ROOT_COUNT },
      ),
    );
    samples.push(
      measure(
        'children-iteration',
        () =>
          hierarchy.roots.reduce(
            (sum, root) =>
              sum +
              ((
                hierarchy.world.get(root, Children as unknown as Component).unwrap() as unknown as {
                  entities: ArrayLike<number>;
                }
              ).entities.length ?? 0),
            0,
          ),
        { entities: ENTITY_COUNT, roots: ROOT_COUNT },
      ),
    );
    samples.push(
      measure(
        'continuous-reparent',
        () => {
          let sum = 0;
          for (let index = ROOT_COUNT; index < ROOT_COUNT * 2; index += 1) {
            const entity = hierarchy.entities[index];
            const parent = hierarchy.roots[(index + 1) % ROOT_COUNT];
            if (entity === undefined || parent === undefined) continue;
            sum += Number(
              hierarchy.world.addComponent(entity, {
                component: ChildOf as unknown as Component,
                data: { parent },
              }).ok,
            );
          }
          return sum;
        },
        { entities: ENTITY_COUNT, roots: ROOT_COUNT, operations: ROOT_COUNT },
      ),
    );
    samples.push(
      measure(
        'subtree-despawn',
        () => {
          const subtree = createSubtree();
          return Number(subtree.world.despawn(subtree.root).ok);
        },
        { subtreeEntities: 10_001 },
      ),
    );
    samples.push(
      measure(
        'mixed-command-batch',
        () => {
          const world = new World();
          const Marker = defineComponent('M0PerfCommandMarker', {});
          world.addSystem(Update, {
            name: 'm0-command-batch',
            queries: [],
            fn: (_world, _queries, commands) => {
              for (let index = 0; index < COMMAND_COUNT; index += 1)
                commands.spawn({ component: Marker, data: {} });
            },
          });
          return Number(world.update(0).ok);
        },
        { commands: COMMAND_COUNT },
      ),
    );
    samples.push(
      measure(
        'clock-getter',
        () => {
          let sink = 0;
          const time = hierarchy.world.getResource(Time);
          for (let index = 0; index < CLOCK_READ_COUNT; index += 1) sink += time.elapsed;
          return sink;
        },
        { reads: CLOCK_READ_COUNT },
      ),
    );
    samples.push(
      measure(
        'shared-ref-churn',
        () => {
          let sink = 0;
          for (let index = 0; index < COMMAND_COUNT; index += 1) {
            const handle = hierarchy.world.allocSharedRef('M0PerfAsset', { index });
            sink += Number(hierarchy.world.sharedRefs.release(handle).ok);
          }
          return sink;
        },
        { handles: COMMAND_COUNT },
      ),
    );
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        baseline: 'M0',
        comparison: null,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: os.cpus()[0]?.model,
          revision,
        },
        samples,
        stopRule: 'same-semantics p95 regression greater than 5 percent requires human decision',
      })}\n`,
    );
    expect(samples).toHaveLength(7);
    expect(samples.every((sample) => sample.p95Ms >= sample.medianMs)).toBe(true);
  });
});
