import {
  AnimationPlayer,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
  deriveAnimationTargetId,
  isAnimationTargetId,
} from '@forgeax/engine/animation';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine/ecs';
import { ChildOf, Name, scenePlugin, Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Stable animation target id',
  catalog: 'Stable animation target id',
  kind: 'headless',
  summary:
    'deriveAnimationTargetId hashes the Name path from the animation root into a 32-hex id; bindAnimationTargets writes it when the target has none, so clips survive entity renumbering.',
  expect:
    'All checks pass: ids are deterministic, path- and order-sensitive, 32 lowercase hex, and a bound target without an id receives deriveAnimationTargetId([root, ..., target]).',
  async run(checks) {
    const id = deriveAnimationTargetId(['Root', 'Hip']);
    checks.ok('32 lowercase hex', isAnimationTargetId(id), id);
    checks.equal('deterministic', deriveAnimationTargetId(['Root', 'Hip']), id);
    checks.ok('segment order matters', deriveAnimationTargetId(['Hip', 'Root']) !== id);
    checks.ok('segment boundaries matter', deriveAnimationTargetId(['RootHip']) !== id);
    checks.ok('uppercase wire rejected', !isAnimationTargetId(id.toUpperCase()));

    const world = new World();
    await createWorldContext(world, [scenePlugin()]);
    await createWorldContext(world, [animationPlugin()]);
    const player = world
      .spawn({ component: Transform, data: {} }, { component: Name, data: { value: 'Root' } })
      .unwrap() as EntityHandle;
    world
      .addComponent(player, {
        component: AnimationPlayer,
        data: { clips: [], times: [], weights: [], speeds: [], paused: true, looping: false },
      })
      .unwrap();
    const hip = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: 'Hip' } },
        { component: ChildOf, data: { parent: player } },
      )
      .unwrap() as EntityHandle;
    const bound = bindAnimationTargets(world, player, [hip]);
    checks.ok('bind succeeds', bound.ok, bound.ok ? undefined : bound.error.code);
    const written = world.get(hip, AnimationTargetId);
    checks.equal(
      'bind writes the path-derived id',
      written.ok ? written.value.value : 'missing',
      id,
    );

    const stray = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;
    const outside = bindAnimationTargets(world, player, [stray]);
    checks.equal(
      'target outside the player root rejected',
      outside.ok ? 'ok' : outside.error.code,
      'animation-target-outside-player-root',
    );
  },
});
