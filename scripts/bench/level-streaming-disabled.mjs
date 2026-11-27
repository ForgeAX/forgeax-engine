import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { Disabled, Time, World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import {
  ChildOf,
  GlobalTransform,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';

const profile = JSON.parse(
  await readFile(new URL('./level-streaming-profile.json', import.meta.url), 'utf8'),
);
const COUNTS = profile.cpuSubstrate.entities;
const WARMUP = profile.cpuSubstrate.warmupRounds;
const ROUNDS = profile.cpuSubstrate.measuredRounds;
const CONSTANT_ENTITIES = profile.cpuSubstrate.constantEntities;
const GROUP_SIZE = profile.cpuSubstrate.hierarchyGroupSize;

function summarize(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (fraction) => ordered[Math.ceil(ordered.length * fraction) - 1];
  return {
    samplesMs: samples,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: ordered[ordered.length - 1],
    above33Ms: samples.filter((value) => value > 33).length,
    above50Ms: samples.filter((value) => value > 50).length,
  };
}

function collect(count) {
  const world = new World();
  const unregister = registerPropagateTransforms(world);
  const constant = [];
  for (let index = 0; index < CONSTANT_ENTITIES; index++)
    constant.push(world.spawn({ component: Transform, data: { pos: [index, 0, 0] } }).unwrap());
  const entities = [];
  for (let index = 0; index < count; index++) {
    const local = index % GROUP_SIZE;
    const parent = local === 0 ? undefined : entities[index - local + Math.floor((local - 1) / 4)];
    entities.push(
      world
        .spawn(
          { component: Transform, data: { pos: [1, 0, 0] } },
          { component: Disabled, data: {} },
          ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
        )
        .unwrap(),
    );
  }
  const active = world.query({ read: [Transform] }).unwrap();
  const activeCount = () => {
    let size = 0;
    for (const _row of active) size++;
    return size;
  };
  if (activeCount() !== CONSTANT_ENTITIES)
    throw new Error('Disabled candidate leaked into ordinary queries');
  const projection = createStateProjection(world, [Transform, ChildOf, Disabled], [Transform]);
  projection.read().accept();
  const phases = {
    activateMigration: [],
    activateUpdate: [],
    activateProjection: [],
    deactivateMigration: [],
    deactivateUpdate: [],
    deactivateProjection: [],
    activateTotal: [],
    deactivateTotal: [],
  };
  let maxProjectionRows = 0;
  const transition = (enabled, samples) => {
    const started = performance.now();
    for (const entity of entities) {
      if (enabled) world.removeComponent(entity, Disabled).unwrap();
      else world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
    }
    const migrated = performance.now();
    world.set(constant[0], Transform, { pos: [world.getResource(Time).elapsed, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    const updated = performance.now();
    const candidate = projection.read();
    maxProjectionRows = Math.max(maxProjectionRows, candidate.scannedRows);
    candidate.accept();
    const accepted = performance.now();
    const prefix = enabled ? 'activate' : 'deactivate';
    if (samples) {
      phases[`${prefix}Migration`].push(migrated - started);
      phases[`${prefix}Update`].push(updated - migrated);
      phases[`${prefix}Projection`].push(accepted - updated);
      phases[`${prefix}Total`].push(accepted - started);
    }
    const expected = CONSTANT_ENTITIES + (enabled ? count : 0);
    if (activeCount() !== expected)
      throw new Error('Incomplete candidate membership after synchronous acceptance');
    if (enabled) {
      const last = entities[entities.length - 1];
      if (!Number.isFinite(world.get(last, GlobalTransform).unwrap().world[12]))
        throw new Error('Missing derived transform after activation');
    }
    return accepted - started;
  };
  const coldActivationMs = transition(true, false);
  transition(false, false);
  for (let index = 0; index < WARMUP + ROUNDS; index++) {
    transition(true, index >= WARMUP);
    transition(false, index >= WARMUP);
  }
  const memory = world.memoryStats();
  unregister();
  // ChildOf is linked: retiring the roots may also retire their owned descendants.
  for (const entity of entities) world.despawn(entity).unwrap();
  for (const entity of constant) world.despawn(entity).unwrap();
  return {
    entities: count,
    constantEntities: CONSTANT_ENTITIES,
    hierarchyGroupSize: GROUP_SIZE,
    coldActivationMs,
    maxProjectionRows,
    memory,
    phases: Object.fromEntries(
      Object.entries(phases).map(([name, samples]) => [name, summarize(samples)]),
    ),
  };
}

const result = {
  schemaVersion: 1,
  scope:
    'CPU substrate probe; no Render, Physics, fixed-content copy, GPU or frame-admission proof',
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourcePatchSha256: createHash('sha256')
    .update(execFileSync('git', ['diff', '--binary', 'HEAD']))
    .digest('hex'),
  machine: {
    cpu: os.cpus()[0]?.model,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    node: process.version,
    loadAverage: os.loadavg(),
  },
  workload: { counts: COUNTS, warmup: WARMUP, rounds: ROUNDS, deltaSeconds: 1 / 60 },
  measurements: COUNTS.map(collect),
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (process.argv[2] !== undefined) {
  const output = resolve(process.argv[2]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, json);
}
process.stdout.write(json);
