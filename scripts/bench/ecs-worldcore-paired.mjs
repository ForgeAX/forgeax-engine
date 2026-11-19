import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
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

function artifactDigest(entry) {
  const root = dirname(resolve(entry));
  const digest = createHash('sha256');
  for (const file of readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith('.mjs'))
    .sort()) {
    digest
      .update(file)
      .update('\0')
      .update(readFileSync(resolve(root, file)))
      .update('\0');
  }
  return digest.digest('hex');
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
  const loadBefore = os.loadavg();
  const ecs = await import(pathToFileURL(entry).href);
  const { Time, Update, World, defineComponent, defineRelationship, defineSystem } = ecs;
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
      const systemToken1 = defineSystem({
        name: 'worldcore-paired-command-batch',
        queries: [],
        fn: (_world, _queries, commands) => {
          for (let index = 0; index < COMMAND_COUNT; index += 1)
            commands.spawn({ component: Marker, data: {} });
        },
      });
      world.addSystem(Update, systemToken1).unwrap();
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
  let revision = 0;
  samples.push(
    measure('changing-query', { entities: changedEntities.length, writes: 5_000 }, () => {
      revision++;
      for (let index = 0; index < changedEntities.length; index += 2)
        changedWorld.set(changedEntities[index], Value, { value: index + revision }).unwrap();
      let count = 0;
      for (const _row of changedQuery) count++;
      if (count !== 5_000) throw new Error(`changing query visited ${count} rows`);
      return count;
    }),
  );
  let parentOffset = 1;
  samples.push(
    measure('changing-relationship', { parents: 8, children: 512 }, () => {
      parentOffset = (parentOffset + 1) % relationshipParents.length;
      for (let index = 0; index < relationshipChildren.length; index++) {
        const parent = relationshipParents[(index + parentOffset) % relationshipParents.length];
        relationshipWorld.reparent(relationshipChildren[index], parent, ChildOf, {}).unwrap();
      }
      let count = 0;
      for (const parent of relationshipParents)
        count += relationshipWorld.get(parent, Children).unwrap().entities.length;
      if (count !== 512) throw new Error(`relationship population changed to ${count}`);
      return count;
    }),
  );
  // API migration adapter only: the byte declarations differ while payloads,
  // work counts and sample gates stay fixed. Record the mapping in every child.
  const byteFields = process.env.FORGEAX_ECS_PERF_BYTE_FIELDS ?? 'array';
  if (byteFields !== 'array' && byteFields !== 'legacy-buffer')
    throw new Error('FORGEAX_ECS_PERF_BYTE_FIELDS must be array or legacy-buffer');
  const byteSchema = {
    bytes: byteFields === 'legacy-buffer' ? 'buffer' : 'array<u8>',
    fixedBytes: byteFields === 'legacy-buffer' ? 'buffer<4>' : 'array<u8, 4>',
  };
  const Managed = defineComponent('WorldCoreManagedWrite', {
    label: 'string',
    ...byteSchema,
    values: 'array<f32>',
    fixedValues: 'array<f32, 4>',
  });
  const bytes = Uint8Array.of(1, 2, 3, 4);
  samples.push(
    measure('managed-field-overwrite', { entities: 5_000, patches: 5_000 }, () => {
      const world = new World();
      let sum = 0;
      for (let index = 0; index < 5_000; index++) {
        const entity = world
          .spawn({
            component: Managed,
            data: {
              label: 'initial',
              bytes,
              fixedBytes: bytes,
              values: [1, 2],
              fixedValues: [1, 2],
            },
          })
          .unwrap();
        world
          .set(entity, Managed, {
            label: 'patched',
            bytes,
            fixedBytes: bytes,
            values: [3, 4],
            fixedValues: [3, 4],
          })
          .unwrap();
        const row = world.get(entity, Managed).unwrap();
        if (row.label !== 'patched' || row.values[0] !== 3 || row.fixedValues[3] !== 0)
          throw new Error('managed field overwrite lost payload');
        sum += row.bytes.length + row.fixedBytes.length + row.values.length;
        world.despawn(entity).unwrap();
      }
      if (world.inspect().entityCount !== 0) throw new Error('managed field workload leaked rows');
      return sum;
    }),
  );
  samples.push(
    measure(
      'owned-buffer-lifecycle',
      { allocations: 2_048, initialWords: 127, grownWords: 513, finalWords: 129 },
      () => {
        const world = new World();
        let sum = 0;
        for (let index = 0; index < 2_048; index++) {
          const handle = world.buffers.alloc(Float32Array, 127).unwrap();
          const initial = world.buffers.view(handle).unwrap();
          initial[0] = index;
          initial[126] = 1;
          world.buffers.resize(handle, 513).unwrap();
          const grown = world.buffers.view(handle).unwrap();
          if (grown[0] !== index || grown[512] !== 0)
            throw new Error('owned growth lost prefix or exposed a dirty tail');
          world.buffers.resize(handle, 63).unwrap();
          world.buffers.resize(handle, 129).unwrap();
          const reader = world.buffers.borrow(handle).unwrap();
          world.buffers.release(handle).unwrap();
          if (reader.view[0] !== index || reader.view[126] !== 0)
            throw new Error('owned retirement lost a pinned view or cleared tail');
          sum += reader.view[0] + reader.view.length;
          reader.release().unwrap();
        }
        const memory = world.memoryStats();
        if (
          memory.buffers.logicalBytes !== 0 ||
          memory.readers.leases !== 0 ||
          memory.readers.pendingRetirements !== 0
        )
          throw new Error('owned buffer lifecycle leaked ownership or readers');
        return sum;
      },
    ),
  );
  samples.push(
    measure('resource-lookup', { reads: CLOCK_READ_COUNT }, () => {
      let sum = 0;
      for (let index = 0; index < CLOCK_READ_COUNT; index++)
        sum += hierarchy.world.getResource(Time).elapsed;
      return sum;
    }),
  );
  samples.push(
    measure('invalid-component-input', { failures: 10_000 }, () => {
      const world = new World();
      for (let index = 0; index < 10_000; index++) {
        const result = world.spawn({ component: Value, data: { unknown: index } });
        if (result.ok || result.error.code !== 'spawn-data-unknown-field')
          throw new Error('invalid input was admitted');
      }
      if (world.inspect().entityCount !== 0) throw new Error('invalid input mutated storage');
      return 10_000;
    }),
  );
  return {
    schemaVersion: 2,
    api: { byteFields: byteSchema },
    revision: process.env.FORGEAX_ECS_PERF_REVISION ?? 'unknown',
    entry: resolve(entry),
    entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
    artifactSha256: artifactDigest(entry),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      loadBefore,
      loadAfter: os.loadavg(),
      warmupRounds: WARMUP_ROUNDS,
      measuredRounds: MEASURED_ROUNDS,
    },
    samples,
  };
}

function compare(baseline, candidate) {
  const baselineByName = new Map(baseline.samples.map((sample) => [sample.name, sample]));
  if (baseline.samples.length !== candidate.samples.length)
    throw new Error('workload population mismatch');
  const workloads = candidate.samples.map((sample) => {
    const before = baselineByName.get(sample.name);
    if (before === undefined) throw new Error(`missing baseline workload ${sample.name}`);
    if (JSON.stringify(before.workload) !== JSON.stringify(sample.workload))
      throw new Error(`workload inputs differ for ${sample.name}`);
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
  for (const report of reports) {
    if (JSON.stringify(report.api) !== JSON.stringify(first.api))
      throw new Error('benchmark API mapping changed within one revision');
    if (report.artifactSha256 !== first.artifactSha256 || report.revision !== first.revision)
      throw new Error('artifact changed during benchmark cohort');
    for (const key of ['node', 'platform', 'arch', 'cpu', 'warmupRounds', 'measuredRounds'])
      if (report.environment[key] !== first.environment[key])
        throw new Error(`cohort environment changed: ${key}`);
  }
  const samples = first.samples.map((sample, index) => {
    const repeated = reports.map((report) => report.samples[index]);
    if (
      repeated.some(
        (candidate) =>
          candidate === undefined ||
          candidate.name !== sample.name ||
          JSON.stringify(candidate.workload) !== JSON.stringify(sample.workload),
      )
    )
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
      runs: reports.map((report) => ({
        loadBefore: report.environment.loadBefore,
        loadAfter: report.environment.loadAfter,
      })),
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
  const versions = {
    baseline: {
      entry: baselineEntry,
      revision: process.env.FORGEAX_ECS_PERF_BASELINE_REVISION ?? 'baseline',
      byteFields: process.env.FORGEAX_ECS_PERF_BASELINE_BYTE_FIELDS ?? 'array',
    },
    candidate: {
      entry: candidateEntry,
      revision: process.env.FORGEAX_ECS_PERF_CANDIDATE_REVISION ?? 'candidate',
      byteFields: process.env.FORGEAX_ECS_PERF_CANDIDATE_BYTE_FIELDS ?? 'array',
    },
  };
  const reports = { baseline: [], candidate: [] };
  const evidence = process.env.FORGEAX_ECS_PERF_EVIDENCE;
  if (evidence) mkdirSync(evidence);
  const loadCeiling = os.availableParallelism();
  const allowLoadedHost = process.env.FORGEAX_ECS_PERF_ALLOW_LOADED_HOST === '1';
  const deadline = Date.now() + 20 * 60 * 1_000;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const order = repetition % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const label of order) {
      const { entry: entryPath, revision, byteFields } = versions[label];
      const load = os.loadavg()[0];
      if (Date.now() > deadline)
        throw new Error('benchmark cohort exceeded its 20 minute deadline');
      if (load > loadCeiling && !allowLoadedHost)
        throw new Error(
          `host load ${load} exceeds ${loadCeiling} before ${label} ${repetition + 1}`,
        );
      const result = spawnSync(process.execPath, [process.argv[1], '--child', entryPath], {
        env: {
          ...process.env,
          FORGEAX_ECS_PERF_REVISION: revision,
          FORGEAX_ECS_PERF_BYTE_FIELDS: byteFields,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      const identity = `${label}-${String(repetition + 1).padStart(3, '0')}`;
      if (result.status !== 0) {
        if (evidence)
          writeFileSync(resolve(evidence, `${identity}-failed.json`), JSON.stringify(result));
        throw new Error(
          `${revision} benchmark repetition ${repetition + 1} exited ${result.status}: ${result.stderr}`,
        );
      }
      const line = result.stdout.trim().split('\n').at(-1);
      if (!line) throw new Error(`${revision} benchmark emitted no report`);
      const report = JSON.parse(line);
      reports[label].push(report);
      if (evidence)
        writeFileSync(resolve(evidence, `${identity}.json`), JSON.stringify(report, null, 2));
      process.stderr.write(`${identity} completed\n`);
    }
  }
  const baseline = mergeReports(reports.baseline);
  const candidate = mergeReports(reports.candidate);
  process.stdout.write(
    `${JSON.stringify({ baseline, candidate, admission: { loadCeiling, allowLoadedHost }, comparison: compare(baseline, candidate) }, null, 2)}\n`,
  );
}
