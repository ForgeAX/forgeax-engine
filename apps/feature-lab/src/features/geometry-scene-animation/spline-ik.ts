import { animationPlugin } from '@forgeax/engine/animation';
import { SplineIK, splineIKPlugin } from '@forgeax/engine/animation/spline-ik';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { SceneInstance } from '@forgeax/engine/render';
import {
  GlobalTransform,
  Name,
  scenePlugin,
  worldDespawnScene,
  worldInstantiateSceneFlat,
} from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Spline IK',
  catalog: 'Spline IK',
  kind: 'headless',
  summary:
    'An ordinary JSON SceneAsset binds an instance-local Path to a four-joint Spline IK chain. The installed Animation cadence commits local pose before Scene propagation; zero weight and disabling restore the authored base.',
  expect:
    'The straight +X path places joints at x=0,1,2,3. Zero weight and disabling restore z=0,1,2,3, and re-enabling returns to +X without accumulating deformation. These pose checks are independent of the separate native Skin and RHI gates.',
  async run(checks) {
    const world = new World();
    const instanceLease = world.components.register(SceneInstance).unwrap();
    const context = await createWorldContext(world, [
      scenePlugin(),
      animationPlugin(),
      splineIKPlugin(),
    ]);
    const source: SceneAsset = {
      kind: 'scene',
      entities: {
        curve: { components: { Transform: {}, Path: { points: [0, 0, 0, 3, 0, 0] } } },
        a: { components: { Name: { value: 'joint-0' }, Transform: {} } },
        b: {
          components: {
            Name: { value: 'joint-1' },
            Transform: { pos: [0, 0, 1] },
            ChildOf: { parent: 'a' },
          },
        },
        c: {
          components: {
            Name: { value: 'joint-2' },
            Transform: { pos: [0, 0, 1] },
            ChildOf: { parent: 'b' },
          },
        },
        d: {
          components: {
            Name: { value: 'joint-3' },
            Transform: { pos: [0, 0, 1] },
            ChildOf: { parent: 'c' },
          },
        },
        controller: {
          components: { SplineIK: { path: 'curve', root: 'a', tip: 'd', lengthMode: 1 } },
        },
      },
    };
    const handle = world.allocSharedRef(
      'SceneAsset',
      JSON.parse(JSON.stringify(source)) as SceneAsset,
    );
    const instance = worldInstantiateSceneFlat(world, handle).unwrap();
    try {
      const controller = [...world.query({ read: [SplineIK] }).unwrap()][0]?.entity;
      if (controller === undefined) throw new Error('Scene controller is missing');
      const config = world.get(controller, SplineIK).unwrap();
      const joints = Array.from(world.query({ read: [Name] }).unwrap(), (row) => ({
        entity: row.entity,
        name: row.get(Name).value,
      }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((row) => row.entity);
      checks.equal('ordinary Scene resolves all four joints', joints.length, 4);
      checks.equal('root reference resolves inside this instance', config.root, joints[0]);
      checks.equal('tip reference resolves inside this instance', config.tip, joints[3]);
      const verify = (label: string, axis: number) => {
        for (const [index, joint] of joints.entries()) {
          const matrix = world.get(joint, GlobalTransform).unwrap().world;
          for (let component = 0; component < 3; component++)
            checks.near(
              `${label} joint ${index} axis ${component}`,
              matrix[12 + component] as number,
              component === axis ? index : 0,
              2e-4,
            );
        }
      };
      world.update(1 / 60).unwrap();
      verify('enabled', 0);
      world.set(controller, SplineIK, { weight: 0 }).unwrap();
      world.update(1 / 60).unwrap();
      verify('zero weight', 2);
      world.set(controller, SplineIK, { weight: 1 }).unwrap();
      for (let frame = 0; frame < 60; frame++) world.update(1 / 60).unwrap();
      verify('repeated enabled', 0);
      world.set(controller, SplineIK, { enabled: false }).unwrap();
      world.update(1 / 60).unwrap();
      verify('disabled', 2);
    } finally {
      for (const root of instance.roots) worldDespawnScene(world, root).unwrap();
      world.update(1 / 60).unwrap();
      await context.fiber.dispose();
      instanceLease.dispose();
    }
  },
});
