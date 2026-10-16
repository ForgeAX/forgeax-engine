import { createWorldContext, World } from '@forgeax/engine/ecs';
import {
  createNavigationMesh,
  NavigationAgent,
  NavigationAgentStatus,
  NavigationCharacter,
  navigationCharacterPlugin,
  setNavigationPath,
  setNavigationTarget,
} from '@forgeax/engine/navigation';
import {
  Collider,
  ColliderShapeValue,
  physicsPlugin,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import type { NavigationMeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Static NavMesh and physical character navigation',
  catalog: 'Static NavMesh and physical character navigation',
  kind: 'headless',
  summary:
    'Portable clearance polygons feed bounded world-space queries and a real Rapier KCC companion. Fixed progress follows actual displacement.',
  expect:
    'Two opposing capsules arrive without overlap; excessive projection fails; cancellation and disposal retain the single physical motor.',
  async run(checks) {
    const asset: NavigationMeshAsset = {
      kind: 'navigation-mesh',
      version: 'recast-poly/1',
      sourceDigest: 'feature-lab-flat',
      settings: {
        radius: 0.35,
        height: 1.8,
        maxSlopeDeg: 45,
        maxStep: 0.3,
        cellSize: 0.1,
        cellHeight: 0.05,
      },
      vertices: [-5, 0.05, -5, 5, 0.05, -5, 5, 0.05, 5, -5, 0.05, 5],
      polygons: [[0, 1, 2, 3]],
    };
    const mesh = createNavigationMesh(JSON.parse(JSON.stringify(asset))).unwrap();
    checks.ok('explicit projection limit', !mesh.project([10, 0, 0], 0.1).ok);
    const world = new World(),
      ctx = await createWorldContext(world, [
        physicsPlugin('rapier-3d'),
        navigationCharacterPlugin(mesh),
      ]);
    try {
      world
        .spawn(
          { component: Transform, data: { pos: [0, -0.1, 0] } },
          { component: Collider, data: { halfExtents: [10, 0.1, 10] } },
        )
        .unwrap();
      const actors = [-2, 2].map((x) =>
        world
          .spawn(
            { component: Transform, data: { pos: [x, 0.82, 0] } },
            { component: NavigationCharacter, data: {} },
            { component: NavigationAgent, data: { speed: 1.5 } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } },
            {
              component: Collider,
              data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.5 },
            },
          )
          .unwrap(),
      );
      for (let i = 0; i < actors.length; i++)
        setNavigationTarget(
          world,
          actors[i] as (typeof actors)[number],
          [i === 0 ? 2 : -2, 0.05, 0],
          { maxProjection: 0.2 },
        ).unwrap();
      let minimum = Infinity;
      for (let frame = 0; frame < 600; frame++) {
        world.update(1 / 60).unwrap();
        const a = world.get(actors[0] as (typeof actors)[number], Transform).unwrap().pos,
          b = world.get(actors[1] as (typeof actors)[number], Transform).unwrap().pos;
        minimum = Math.min(
          minimum,
          Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)),
        );
      }
      checks.ok('real physical separation', minimum > 0.59, `minimum=${minimum}`);
      checks.ok(
        'both arrive from actual pose',
        actors.every((e, i) => {
          const p = world.get(e, Transform).unwrap().pos;
          return (
            world.get(e, NavigationAgent).unwrap().status === NavigationAgentStatus.arrived &&
            Math.hypot((p[0] ?? 0) - (i === 0 ? 2 : -2), p[2] ?? 0) <= 0.081
          );
        }),
      );
      const first = actors[0] as (typeof actors)[number];
      setNavigationTarget(world, first, [-2, 0.05, 0], { maxProjection: 0.2 }).unwrap();
      world.update(1 / 60).unwrap();
      setNavigationPath(world, first, []).unwrap();
      const held = [...world.get(first, Transform).unwrap().pos];
      for (let frame = 0; frame < 60; frame++) world.update(1 / 60).unwrap();
      checks.ok(
        'cancellation holds actual pose',
        world.get(first, NavigationAgent).unwrap().status === NavigationAgentStatus.idle &&
          held.every((value, index) => value === world.get(first, Transform).unwrap().pos[index]),
      );
      checks.ok(
        'single motor authority',
        world.inspect().systems.filter((s) => s.name === 'navigation/character').length === 1,
      );
    } finally {
      await ctx.fiber.dispose();
    }
    checks.ok(
      'disposed motor',
      !world.inspect().systems.some((s) => s.name === 'navigation/character'),
    );
  },
});
