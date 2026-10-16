import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const WARMUP_ROUNDS = 3;
const MEASURED_ROUNDS = 10;
const ENTITY_COUNT = 100_000;
const ROOT_COUNT = 1_000;
const COMMAND_COUNT = 10_000;
const CLOCK_READ_COUNT = 10_000_000;
const MANAGED_REF_COUNT = 10_000;

function percentile(samples, quantile) {
  const ordered = [...samples].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return ordered[index] ?? 0;
}

function summarize(samples) {
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - mean) ** 2, 0) /
    Math.max(1, samples.length - 1);
  const margin = 1.96 * Math.sqrt(variance / samples.length);
  return {
    samplesMs: samples,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    ci95Ms: [mean - margin, mean + margin],
  };
}

function measure(name, workload, run) {
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) run();
  const samples = [];
  let sink = 0;
  for (let round = 0; round < MEASURED_ROUNDS; round += 1) {
    const start = performance.now();
    sink += run();
    samples.push(performance.now() - start);
  }
  if (!Number.isFinite(sink)) throw new Error(`${name} produced a non-finite sink`);
  return { name, workload, ...summarize(samples) };
}

function createHierarchy(World, Value, ChildOf, Children) {
  const world = new World();
  const roots = [];
  for (let index = 0; index < ROOT_COUNT; index += 1) {
    roots.push(
      world
        .spawn(
          { component: Children, data: { entities: [] } },
          { component: Value, data: { value: index } },
        )
        .unwrap(),
    );
  }
  const entities = [...roots];
  for (let index = ROOT_COUNT; index < ENTITY_COUNT; index += 1) {
    const parent = roots[index % ROOT_COUNT];
    if (parent === undefined) throw new Error('benchmark root missing');
    entities.push(
      world
        .spawn(
          { component: ChildOf, data: { parent } },
          { component: Value, data: { value: index } },
        )
        .unwrap(),
    );
  }
  return { world, roots, entities };
}

async function collect(entry) {
  const ecs = await import(pathToFileURL(entry).href);
  const { Time, Update, World, defineComponent, defineRelationship } = ecs;
  const Value = defineComponent('WorldCorePairedValue', { value: 'u32' });
  const Marker = defineComponent('WorldCorePairedMarker', {});
  const { source: ChildOf, target: Children } = defineRelationship({
    sourceName: 'WorldCorePairedChildOf',
    sourceField: 'parent',
    targetName: 'WorldCorePairedChildren',
    targetField: 'entities',
    exclusive: true,
    linkedSpawn: true,
  });

  const hierarchy = createHierarchy(World, Value, ChildOf, Children);
  const valueQuery = hierarchy.world.query({ read: [Value] }).unwrap();
  const changedWorld = new World();
  const changedEntities = [];
  for (let index = 0; index < 10_000; index += 1) {
    changedEntities.push(changedWorld.spawn({ component: Value, data: { value: index } }).unwrap());
  }
  const changedQuery = changedWorld.query({ read: [Value], changed: [Value] }).unwrap();
  const relationshipWorld = new World();
  const relationshipParents = [];
  const relationshipChildren = [];
  for (let index = 0; index < 8; index += 1) {
    relationshipParents.push(
      relationshipWorld.spawn({ component: Children, data: { entities: [] } }).unwrap(),
    );
  }
  for (let index = 0; index < 512; index += 1) {
    const parent = relationshipParents[index % relationshipParents.length];
    if (parent === undefined) throw new Error('relationship parent missing');
    const child = relationshipWorld.spawn().unwrap();
    relationshipWorld.addChild(parent, child, ChildOf, { parent }).unwrap();
    relationshipChildren.push(child);
  }

  const samples = [
    measure('construction', { entities: 10_000 }, () => {
      const world = new World();
      for (let index = 0; index < 10_000; index += 1)
        world.spawn({ component: Value, data: { value: index } }).unwrap();
      return world.inspect().entityCount;
    }),
    measure('public-row-span', { entities: ENTITY_COUNT, roots: ROOT_COUNT }, () => {
      let sum = 0;
      for (const row of valueQuery) sum += row.get(Value).value;
      for (const span of valueQuery.spans().unwrap()) {
        const values = span.get(Value).value;
        for (let index = 0; index < span.length; index += 1) sum += values[index] ?? 0;
      }
      return sum;
    }),
    measure(
      'changed-query',
      { entities: changedEntities.length, changed: Math.floor(changedEntities.length / 2) },
      () => {
        for (let index = 0; index < changedEntities.length; index += 2) {
          const entity = changedEntities[index];
          if (entity !== undefined) changedWorld.set(entity, Value, { value: index }).unwrap();
        }
        let count = 0;
        for (const row of changedQuery) count += row.entity;
        return count;
      },
    ),
    measure(
      'relationship-read-change',
      { parents: 8, children: relationshipChildren.length, rounds: relationshipChildren.length },
      () => {
        let count = 0;
        for (let index = 0; index < relationshipChildren.length; index += 1) {
          const child = relationshipChildren[index];
          const nextParent = relationshipParents[(index + 1) % relationshipParents.length];
          if (child === undefined || nextParent === undefined) continue;
          relationshipWorld.reparent(child, nextParent, ChildOf, { parent: nextParent }).unwrap();
        }
        for (const parent of relationshipParents)
          count += relationshipWorld.get(parent, Children).unwrap().entities.length;
        return count;
      },
    ),
    measure('subtree-despawn', { subtreeEntities: 10_001 }, () => {
      const world = new World();
      const root = world.spawn({ component: Children, data: { entities: [] } }).unwrap();
      for (let index = 0; index < 10_000; index += 1)
        world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();
      return Number(world.despawn(root).ok);
    }),
    measure('mixed-command-batch', { commands: COMMAND_COUNT }, () => {
      const world = new World();
      world
        .addSystem(Update, {
          name: 'worldcore-paired-command-batch',
          queries: [],
          fn: (_world, _queries, commands) => {
            for (let index = 0; index < COMMAND_COUNT; index += 1)
              commands.spawn({ component: Marker, data: {} });
          },
        })
        .unwrap();
      return Number(world.update(0).ok);
    }),
    measure('managed-ref-churn', { handles: MANAGED_REF_COUNT }, () => {
      let count = 0;
      const world = new World();
      for (let index = 0; index < MANAGED_REF_COUNT; index += 1) {
        const handle = world.allocSharedRef('WorldCorePairedAsset', { index });
        count += Number(world.sharedRefs.release(handle).ok);
      }
      return count;
    }),
    measure('resource-time', { reads: CLOCK_READ_COUNT }, () => {
      let sum = 0;
      const time = hierarchy.world.getResource(Time);
      for (let index = 0; index < CLOCK_READ_COUNT; index += 1) sum += time.elapsed;
      return sum;
    }),
  ];
  return {
    schemaVersion: 1,
    revision: process.env.FORGEAX_ECS_PERF_REVISION ?? 'unknown',
    entry,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
    },
    samples,
  };
}

function compare(baseline, candidate) {
  const baselineByName = new Map(baseline.samples.map((sample) => [sample.name, sample]));
  const workloads = candidate.samples.map((sample) => {
    const before = baselineByName.get(sample.name);
    if (before === undefined) throw new Error(`missing baseline workload ${sample.name}`);
    const ratio = sample.p95Ms / Math.max(before.p95Ms, Number.EPSILON);
    return {
      name: sample.name,
      baselineP95Ms: before.p95Ms,
      candidateP95Ms: sample.p95Ms,
      p95Ratio: ratio,
      withinFivePercent: ratio <= 1.05,
    };
  });
  return {
    policy: 'candidate p95 must not exceed baseline p95 by more than 5 percent',
    pass: workloads.every((workload) => workload.withinFivePercent),
    workloads,
  };
}

function mergeReports(reports) {
  const first = reports[0];
  if (first === undefined) throw new Error('benchmark produced no report');
  const samples = first.samples.map((sample, index) => {
    const repeated = reports.map((report) => report.samples[index]);
    if (repeated.some((candidate) => candidate === undefined))
      throw new Error(`benchmark workload mismatch at index ${index}`);
    const allSamples = repeated.flatMap((candidate) => candidate.samplesMs);
    return {
      name: sample.name,
      workload: sample.workload,
      ...summarize(allSamples),
    };
  });
  return {
    ...first,
    environment: {
      ...first.environment,
      repetitions: reports.length,
      measuredRoundsTotal: reports.length * MEASURED_ROUNDS,
    },
    samples,
  };
}

const entry = process.argv[2];
if (entry === '--child') {
  const report = await collect(process.argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  const baselineEntry = process.argv[2];
  const candidateEntry = process.argv[3];
  if (!baselineEntry || !candidateEntry) {
    throw new Error('usage: node ecs-worldcore-paired.mjs <baseline-entry> <candidate-entry>');
  }
  const repetitions = Number(process.env.FORGEAX_ECS_PERF_REPEATS ?? 1);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error('FORGEAX_ECS_PERF_REPEATS must be a positive integer');
  }
  const run = (entryPath, revision) => {
    const reports = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const result = spawnSync(process.execPath, [process.argv[1], '--child', entryPath], {
        env: { ...process.env, FORGEAX_ECS_PERF_REVISION: revision },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      if (result.status !== 0)
        throw new Error(
          `${revision} benchmark repetition ${repetition + 1} exited ${result.status}`,
        );
      const line = result.stdout.trim().split('\n').at(-1);
      if (!line) throw new Error(`${revision} benchmark emitted no report`);
      reports.push(JSON.parse(line));
    }
    return mergeReports(reports);
  };
  const baseline = run(baselineEntry, process.env.FORGEAX_ECS_PERF_BASELINE_REVISION ?? 'baseline');
  const candidate = run(
    candidateEntry,
    process.env.FORGEAX_ECS_PERF_CANDIDATE_REVISION ?? 'candidate',
  );
  process.stdout.write(
    `${JSON.stringify({ baseline, candidate, comparison: compare(baseline, candidate) }, null, 2)}\n`,
  );
}
