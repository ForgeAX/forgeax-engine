import { AnimationSet, createIKSolver } from '@forgeax/engine/animation';
import { defineSystem, Update } from '@forgeax/engine/ecs';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { effector, goalMarker, spawnAnimatedRig } from './support/animated-rig';
import { animationEvidence } from './support/animation-evidence';

const GOAL = [1.1, 1.35, 0] as const;
export default defineFeature({
  title: 'Inverse kinematics',
  catalog: 'Inverse kinematics',
  kind: 'visual',
  appOptions: { gpuPassTiming: {} },
  summary:
    'A cached solver bends the current three-joint Skin toward a world-space target and explicit pole before Scene propagation; the actual GPU skin palette drives the cyan surface.',
  expect:
    'ON: the cyan strip bends so its tip reaches the orange sphere. OFF: the same skeleton and mesh stand straight, visibly missing the goal. Bone translations remain unchanged.',
  setup({ world, app }) {
    spawnStage(world, { eye: [0, 1.6, 6], target: [0, 1.1, 0] });
    const joints = spawnAnimatedRig(world, -0.8, 1.15, [0.1, 0.8, 1, 1]);
    goalMarker(world, GOAL);
    const locked = new URLSearchParams(location.search).has('locked');
    const solver = createIKSolver(world, {
      joints,
      limits: [
        { joint: joints[0], min: [0, 0, locked ? 0 : -Math.PI], max: [0, 0, locked ? 0 : Math.PI] },
        { joint: joints[1], min: [0, 0, locked ? 0 : -Math.PI], max: [0, 0, locked ? 0 : Math.PI] },
      ],
    }).unwrap();
    let enabled = true;
    let residual = Number.POSITIVE_INFINITY;
    let cpuMs = 0;
    animationEvidence(
      app,
      () => cpuMs,
      () => enabled,
    );
    const system = defineSystem({
      name: 'featureLabIK',
      queries: [],
      after: ['advanceAnimationPlayer'],
      before: ['propagateTransforms'],
      fn() {
        for (const joint of joints) world.set(joint, Transform, { quat: [0, 0, 0, 1] }).unwrap();
        const start = performance.now();
        if (enabled) residual = solver.solve(GOAL, { pole: [-2, 2, 0] }).unwrap().error;
        cpuMs = performance.now() - start;
      },
    });
    world.addSystems(Update, AnimationSet, [system]).unwrap();
    return {
      toggle(on) {
        enabled = on;
      },
      checks() {
        const checks = new CheckList();
        const tip = effector(world, joints[2]);
        const distance = Math.hypot(tip[0] - GOAL[0], tip[1] - GOAL[1], tip[2] - GOAL[2]);
        checks.ok(
          'goal reached only when enabled',
          enabled && !locked ? distance < 1e-4 && residual < 1e-4 : distance > 0.5,
          `distance=${distance} solver=${residual}`,
        );
        for (const joint of joints.slice(0, 2)) {
          const q = world.get(joint, Transform).unwrap().quat;
          checks.ok(
            'local hinge axis preserved',
            Math.abs(q[0] as number) < 1e-6 && Math.abs(q[1] as number) < 1e-6,
          );
        }
        checks.near(
          'target bone length preserved',
          world.get(joints[1], Transform).unwrap().pos[1] as number,
          1.15,
        );
        return checks.items;
      },
    };
  },
});
