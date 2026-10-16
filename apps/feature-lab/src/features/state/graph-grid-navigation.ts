import { createWorldContext, World } from '@forgeax/engine/ecs';
import {
  createNavigationGraph,
  createNavigationGrid,
  NavigationAgent,
  NavigationAgentStatus,
  navigationPlugin,
  setNavigationPath,
} from '@forgeax/engine/navigation';
import { GlobalTransform, Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Graph/grid navigation and path following',
  catalog: 'Graph/grid navigation and path following',
  kind: 'headless',
  summary:
    'A directed graph or XY/XZ grid produces an optimal bounded route. A native ECS follower advances it in FixedUpdate before Scene propagation.',
  expect:
    'Checks pass for the wall detour, cheap weighted edges, diagonal corner rejection, 300 fixed frames, final arrival and plugin disposal.',
  async run(checks) {
    const blocked = new Uint8Array(25);
    for (const id of [2, 7, 12, 17]) blocked[id] = 1;
    const graph = createNavigationGrid({ width: 5, height: 5, blocked }).unwrap();
    const path = graph.findPath(0, 4).unwrap();
    checks.equal('detour cost', path.cost, 12);
    checks.ok(
      'route avoids blocked cells',
      path.nodes.every((node) => blocked[node] === 0),
    );
    const corner = createNavigationGrid({
      width: 2,
      height: 2,
      diagonal: true,
      blocked: [0, 1, 1, 0],
    })
      .unwrap()
      .findPath(0, 3);
    checks.equal(
      'blocked diagonal corner',
      corner.ok ? 'unexpected path' : corner.error.code,
      'navigation-unreachable',
    );
    const weighted = createNavigationGraph({
      positions: [0, 0, 0, 1, 0, 0, 100, 0, 0],
      edges: [
        { from: 0, to: 1, cost: 5 },
        { from: 0, to: 2, cost: 1 },
        { from: 2, to: 1, cost: 1 },
      ],
    }).unwrap();
    checks.equal('cheap-edge optimality', weighted.findPath(0, 1).unwrap().cost, 2);
    const world = new World();
    const ctx = await createWorldContext(world, [navigationPlugin()]);
    try {
      const entity = world.spawn({ component: NavigationAgent, data: { speed: 3 } }).unwrap();
      setNavigationPath(world, entity, path.points).unwrap();
      let avoidsWall = true;
      for (let frame = 0; frame < 300; frame++) {
        world.update(1 / 60).unwrap();
        const pos = world.get(entity, Transform).unwrap().pos;
        avoidsWall &&= blocked[Math.round(pos[2] ?? 0) * 5 + Math.round(pos[0] ?? 0)] === 0;
      }
      checks.ok('300-frame wall clearance for point agent', avoidsWall);
      checks.equal(
        'arrived',
        world.get(entity, NavigationAgent).unwrap().status,
        NavigationAgentStatus.arrived,
      );
      checks.equal(
        'final local position',
        [...world.get(entity, Transform).unwrap().pos],
        [4, 0, 0],
      );
      checks.equal(
        'final propagated world position',
        world.get(entity, GlobalTransform).unwrap().world[12],
        4,
      );
    } finally {
      await ctx.fiber.dispose();
    }
    checks.ok(
      'disposed following system',
      !world.inspect().systems.some((system) => system.name === 'navigation/follow-path'),
    );
  },
});
