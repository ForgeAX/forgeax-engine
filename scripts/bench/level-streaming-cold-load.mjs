// Node diagnostic of the real ordinary load route and each cooperative ingestion quantum.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry } from '../../packages/assets-runtime/dist/index.mjs';
import { runtimeAssets } from '../../packages/assets-runtime/dist/internal.mjs';
import { World } from '../../packages/ecs/dist/index.mjs';
import { registerPropagateTransforms, Transform } from '../../packages/scene/dist/index.mjs';
import {
  createLevelStreamingPack,
  levelComponents,
  levelDecoders,
} from './fixtures/level-streaming-pack.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(process.argv[2] ?? '/tmp/forgeax-level-cold-load-20261115.json');
if (output === root || output.startsWith(`${root}/`))
  throw new Error('raw measurements must be outside the source checkout');
const profile = JSON.parse(
  await readFile(new URL('./level-streaming-profile.json', import.meta.url), 'utf8'),
);
const fixture = await createLevelStreamingPack(profile);
const hostBefore = { load: os.loadavg(), freeMemoryBytes: os.freemem() };
function instrument(owner, name, label, stages) {
  const method = owner[name];
  if (typeof method !== 'function')
    throw new Error(`required diagnostic seam disappeared: ${name}`);
  owner[name] = function (...args) {
    const before = performance.now();
    try {
      return method.apply(this, args);
    } finally {
      stages.push({
        stage: label,
        ...(label === 'record' ? { kind: args[2] } : {}),
        ms: performance.now() - before,
      });
    }
  };
}
async function sample(round) {
  const assets = new AssetRegistry({
    components: new Map(levelComponents.map((component) => [component.name, component])),
  });
  for (const contribution of levelDecoders)
    assets.installDecoder(contribution.kind, contribution.decoder);
  const world = new World({ assets });
  for (const component of levelComponents) world.components.register(component).unwrap();
  const unregister = registerPropagateTransforms(world),
    records = runtimeAssets(assets),
    stages = [],
    intervals = [];
  const constant = Array.from({ length: profile.cpuSubstrate.constantEntities }, (_, i) =>
    world.spawn({ component: Transform, data: { pos: [i, 0, 0] } }).unwrap(),
  );
  assets.setCatalogSource(fixture.producer.catalog, fixture.producer.fetch);
  for (const [owner, name, label] of [
    [assets, 'beginSourceIngestion', 'begin'],
    [assets, 'advanceSourceIngestion', 'prepare'],
    [assets, 'commitSourceIngestion', 'commit'],
    [assets, 'retireSourceIngestion', 'retire'],
    [records, 'prepareAdoption', 'record'],
    [assets, 'prepareSourcePrograms', 'programs'],
  ])
    instrument(owner, name, label, stages);
  let ticks = 0,
    last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    intervals.push(now - last);
    last = now;
    ticks++;
    for (let i = 0; i < constant.length; i++)
      world.set(constant[i], Transform, { pos: [i, Math.sin(ticks * 0.01), 0] }).unwrap();
    world.update(1 / 60).unwrap();
  }, 1);
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    intervals.length = 0;
    last = performance.now();
    const begin = performance.now(),
      loaded = await assets.load(fixture.rootGuid, 'scene'),
      end = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const handle = loaded.unwrap();
    const closure = new Set(),
      pending = [handle];
    while (pending.length > 0) {
      const next = pending.pop();
      if (closure.has(next)) continue;
      closure.add(next);
      pending.push(...records.dependencies(next).unwrap());
    }
    if (
      closure.size !== fixture.facts.outputs ||
      records.inspect().assets !== fixture.facts.outputs
    )
      throw new Error('loaded closure differs from the real producer output');
    assets.release(handle).unwrap();
    return {
      round,
      warmup: round < profile.cpuSubstrate.warmupRounds,
      loadMs: end - begin,
      stages,
      eventLoopIntervalsMs: intervals,
      ticks,
      assets: records.inspect().assets,
      closureHandles: closure.size,
    };
  } finally {
    clearInterval(timer);
    unregister();
    for (const entity of constant) world.despawn(entity).unwrap();
    assets.dispose();
  }
}
const samples = [];
try {
  for (
    let round = 0;
    round < profile.cpuSubstrate.warmupRounds + profile.cpuSubstrate.measuredRounds;
    round++
  )
    samples.push(await sample(round));
} finally {
  fixture.producer.dispose();
}
const allStages = samples.flatMap((sample) => sample.stages);
for (const sample of samples) {
  const count = (label) => sample.stages.filter((stage) => stage.stage === label).length;
  if (
    count('begin') !== 1 ||
    count('commit') !== 1 ||
    count('record') !== fixture.facts.outputs ||
    count('prepare') === 0 ||
    count('retire') === 0
  )
    throw new Error(
      'ordinary load stopped using the measured ingestion seams; update the probe instead of counting missing work as zero',
    );
}
const quanta = allStages.filter((stage) =>
  ['begin', 'prepare', 'commit', 'retire'].includes(stage.stage),
);
const result = {
  scope:
    'Real producer/Pack/artifact/decode/adopt in fresh Node registries; production and validation completed before load timing; artifact byte caches may be warm; no GPU/native/App-frame/presentation qualification',
  exercisedCase: {
    geometry: 'ordinary-meshes',
    residentInactiveCopies: 0,
    consumer: 'ordinary AssetRegistry.load',
  },
  profile,
  fixture: fixture.facts,
  source: {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    workingDiffSha256: createHash('sha256')
      .update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root }))
      .digest('hex'),
  },
  machine: {
    cpu: os.cpus()[0]?.model,
    release: os.release(),
    runtime: process.version,
    load: os.loadavg(),
    before: hostBefore,
    freeMemoryBytes: os.freemem(),
  },
  samples,
};
await writeFile(output, JSON.stringify(result));
const maximum = (values) => values.reduce((a, b) => Math.max(a, b), 0);
const summary = {
  scope: result.scope,
  output,
  rounds: samples.length,
  fixture: fixture.facts,
  maxLoadMs: maximum(samples.map((sample) => sample.loadMs)),
  maxBeginMs: maximum(
    allStages.filter((stage) => stage.stage === 'begin').map((stage) => stage.ms),
  ),
  maxPreparationMs: maximum(
    allStages.filter((stage) => stage.stage === 'prepare').map((stage) => stage.ms),
  ),
  maxCommitMs: maximum(
    allStages.filter((stage) => stage.stage === 'commit').map((stage) => stage.ms),
  ),
  maxRetirementMs: maximum(
    allStages.filter((stage) => stage.stage === 'retire').map((stage) => stage.ms),
  ),
  maxRecordMs: maximum(
    allStages.filter((stage) => stage.stage === 'record').map((stage) => stage.ms),
  ),
  maxEventLoopIntervalMs: maximum(samples.flatMap((sample) => sample.eventLoopIntervalsMs)),
  maxIngestionQuantumMs: maximum(quanta.map((stage) => stage.ms)),
};
console.log(JSON.stringify(summary, null, 2));
if (summary.maxEventLoopIntervalMs > profile.budgets.maximumLifecycleAttributedPauseMs)
  process.exitCode = 1;
