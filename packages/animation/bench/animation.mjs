// Real World/property/pose CPU costs. GPU frame time is measured separately.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import {
  AnimationPlayer,
  animationPlugin,
  bindObjectProperty,
  createIKSolver,
  createSkeletonRetargeter,
  deriveAnimationTargetId,
} from '../dist/index.mjs';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';

const warmup = 60;
const samples = process.argv.includes('--quick') ? 60 : 300;
const out = resolve(process.env.ANIMATION_EVIDENCE ?? 'artifacts/animation');
mkdirSync(out, { recursive: true });
const results = [];
const percentile = (sorted, fraction) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

async function measure(name, count, joints, setup) {
  const world = new World();
  await createWorldContext(world, [scenePlugin(), animationPlugin()]);
  const tick = await setup(world);
  for (let i = 0; i < warmup; i++) {
    tick(i);
    world.update(0).unwrap();
  }
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    tick(i + warmup);
    times.push(performance.now() - start);
    world.update(0).unwrap();
  }
  const sorted = [...times].sort((a, b) => a - b);
  const row = {
    name,
    count,
    joints,
    warmup,
    samples,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1),
    samplesMs: times,
  };
  assert(times.every((time) => Number.isFinite(time) && time >= 0));
  results.push(row);
  console.log(JSON.stringify({ ...row, samplesMs: undefined }));
}

function chain(world, count, length = 1) {
  const joints = [];
  for (let i = 0; i < count; i++)
    joints.push(
      world
        .spawn(
          { component: Transform, data: { pos: [i === 0 ? 0 : length, 0, 0] } },
          ...(i === 0 ? [] : [{ component: ChildOf, data: { parent: joints[i - 1] } }]),
        )
        .unwrap(),
    );
  return joints;
}

for (const count of [100, 1000])
  await measure('property-player-world-update', count, 0, (world) => {
    const id = deriveAnimationTargetId(['Bench']);
    const clip = {
      kind: 'animation-clip',
      duration: 10,
      channels: [
        {
          targetId: id,
          property: 'property',
          binding: 'value',
          sampler: {
            input: new Float32Array([0, 10]),
            output: new Float32Array([0, 10]),
            interpolation: 'LINEAR',
          },
        },
      ],
    };
    const handle = world.allocSharedRef('AnimationClip', clip);
    const objects = [];
    for (let i = 0; i < count; i++) {
      const object = { value: 0 };
      objects.push(object);
      const player = world
        .spawn({
          component: AnimationPlayer,
          data: { clips: [handle], times: [0], weights: [1], speeds: [1], looping: false },
        })
        .unwrap();
      bindObjectProperty(world, player, id, 'value', { object, path: ['value'] }).unwrap();
    }
    return () => {
      world.update(1 / 60).unwrap();
      assert(objects[0].value > 0);
    };
  });

for (const bones of [3, 16, 64])
  await measure('retarget-100-rigs', 100, bones, (world) => {
    const rigs = [];
    for (let i = 0; i < 100; i++) {
      const source = chain(world, bones);
      const target = chain(world, bones, 1.5);
      const solver = createSkeletonRetargeter(world, {
        pairs: source.map((joint, index) => ({ source: joint, target: target[index] })),
      }).unwrap();
      rigs.push({ source, target, solver });
    }
    return (frame) => {
      const angle = Math.sin(frame / 30) * 0.2;
      for (const { source, solver } of rigs) {
        world
          .set(source[0], Transform, { quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] })
          .unwrap();
        solver.retarget().unwrap();
      }
    };
  });

for (const bones of [3, 8, 16])
  await measure('ik-100-rigs', 100, bones, (world) => {
    const solvers = [];
    for (let i = 0; i < 100; i++) {
      const joints = chain(world, bones);
      solvers.push({
        joints,
        solver: createIKSolver(world, { joints, maxIterations: 32, tolerance: 1e-3 }).unwrap(),
      });
    }
    return (frame) => {
      const goal = [(bones - 1) * 0.65, Math.sin(frame / 30) * 0.3 + 0.6, 0];
      for (const { solver } of solvers) {
        const result = solver.solve(goal, bones === 3 ? { pole: [0, 2, 0] } : {}).unwrap();
        assert(result.iterations <= 32);
        assert(result.error < 0.03, `IK error ${result.error}`);
      }
    };
  });

writeFileSync(
  resolve(out, 'performance.json'),
  JSON.stringify(
    {
      environment: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        platform: platform(),
        arch: arch(),
        node: process.version,
      },
      conditions: {
        renderer: false,
        warmup,
        samples,
        timing:
          'performance.now; current-pose read and actual World writes included; cold compilation and post-solver Scene propagation excluded; World ticks drain change evidence between samples',
      },
      results,
    },
    null,
    2,
  ),
);
