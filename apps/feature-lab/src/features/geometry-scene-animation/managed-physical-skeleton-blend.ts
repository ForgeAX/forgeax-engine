import {
  bindSkeletalMotion,
  skeletalMotionPlugin,
} from '@forgeax/engine/animation/skeletal-motion';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsWorld,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import { GlobalTransform, Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { skeletalMotionRig } from './support/skeletal-motion-world';

export default defineFeature({
  title: 'Managed physical skeleton blend',
  catalog: 'Managed physical skeleton blend',
  kind: 'visual',
  appOptions: {
    animation: { cadence: 'fixed' },
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 },
    plugins: [physics3d, skeletalMotionPlugin({ physics: true })],
  },
  summary:
    'Three actual Skins share authored cuboid bodies and managed hinges. Green, orange and cyan use visual weights 0, 0.5 and 1 while all bodies run the same native simulation.',
  expect:
    'ON: green keeps its animation, cyan follows the falling bodies, and orange blends between the two. OFF: all ribbons show animation while bodies remain simulated.',
  setup({ world, hud }) {
    spawnStage(world, { eye: [0, 2, 11], target: [0, 1, 0] });
    world
      .spawn(
        { component: Transform, data: { pos: [0, -0.5, 0] } },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
        {
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [10, 0.5, 5] },
        },
      )
      .unwrap();
    const bindings = [
      { rig: skeletalMotionRig(world, -2.4, [0.5, 1, 0.2, 1]), weight: 0 },
      { rig: skeletalMotionRig(world, 0, [1, 0.45, 0.08, 1]), weight: 0.5 },
      { rig: skeletalMotionRig(world, 2.4, [0.1, 0.8, 1, 1]), weight: 1 },
    ].map(({ rig, weight }) => {
      const definition = {
        physical: {
          bones: rig.targets.slice(0, 2).map((target) => ({
            target,
            offset: [0, 0.5, 0],
            rotation: [0, 0, 0, 1],
            mass: 1,
            additionalSolverIterations: 16,
            collisionGroups: 0x00020001,
            shape: { kind: 'cuboid' as const, halfExtents: [0.15, 0.5, 0.1] },
          })),
          joints: [
            {
              bodyA: 0,
              bodyB: 1,
              anchorA: [0, 0.5, 0],
              anchorB: [0, -0.5, 0],
              axisA: [0, 0, 1],
              axisB: [0, 0, 1],
              limits: [-1, 1],
            },
          ],
        },
      };
      const binding = bindSkeletalMotion(
        world,
        rig.player,
        JSON.parse(JSON.stringify(definition)),
      ).unwrap();
      binding.simulate(rig.targets.slice(0, 2)).unwrap();
      binding.setPhysicsWeight(weight).unwrap();
      return { rig, binding, weight };
    });
    const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
    const fullWeight = bindings.find((entry) => entry.weight === 1);
    if (!fullWeight) throw new Error('authored weight-one rig missing');
    let enabled = true;
    hud.status(
      'Green: visual 0 · Orange: visual 0.5 · Cyan: visual 1 · Native simulation remains active',
    );
    return {
      toggle(on) {
        enabled = on;
        for (const { binding, weight } of bindings)
          binding.setPhysicsWeight(on ? weight : 0).unwrap();
      },
      checks() {
        const checks = new CheckList();
        checks.equal('three ordinary managed hinges', physics.getJointCount?.(), 3);
        checks.equal('six ordinary bodies and floor', physics.getBodyCount(), 7);
        for (const [i, { binding }] of bindings.entries())
          checks.equal(`rig ${i} active`, binding.status, 'active');
        if (enabled) {
          const body = fullWeight.binding.bodyEntities[0];
          const readMotion = physics.getBodyMotion;
          if (!readMotion || body === undefined)
            throw new Error('managed body observation missing');
          const motion = readMotion.call(physics, body).unwrap();
          const bone = world.get(fullWeight.rig.joints[0], GlobalTransform).unwrap().world;
          checks.near(
            'weight one body offset X',
            (bone[12] as number) + 0.5 * (bone[4] as number),
            motion.position[0],
            1e-4,
          );
          checks.near(
            'weight one body offset Y',
            (bone[13] as number) + 0.5 * (bone[5] as number),
            motion.position[1],
            1e-4,
          );
        }
        return checks.items;
      },
    };
  },
});
