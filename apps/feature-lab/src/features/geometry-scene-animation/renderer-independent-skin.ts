import { createWorldContext, type EntityHandle, World } from '@forgeax/engine/ecs';
import { Name, scenePlugin, Transform } from '@forgeax/engine/scene';
import { resolveSkinJoints, Skin, skinningPlugin } from '@forgeax/engine/skinning';
import type { SkeletonAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Renderer-independent Skin',
  catalog: 'Renderer-independent Skin',
  kind: 'headless',
  summary:
    'Skin { skeleton, joints } and resolveSkinJoints live in skinning, not render: a plain World with scene + skinning plugins binds joint entities by Name path with no renderer.',
  expect:
    'All checks pass: joint paths resolve to the named entities in order, Skin stores the skeleton handle and joints, and an unknown joint returns skin-joint-path-unresolved with expected/hint/detail.',
  async run(checks) {
    const world = new World();
    await createWorldContext(world, [scenePlugin(), skinningPlugin()]);
    const names = new Map<string, EntityHandle>();
    for (const name of ['Hips', 'Spine', 'Head']) {
      names.set(
        name,
        world
          .spawn({ component: Name, data: { value: name } }, { component: Transform, data: {} })
          .unwrap() as EntityHandle,
      );
    }
    const skinEntity = world.spawn({ component: Transform, data: {} }).unwrap() as EntityHandle;

    const resolved = resolveSkinJoints(
      ['Hips', 'Hips/Spine', 'Hips/Spine/Head'],
      names,
      skinEntity,
    );
    checks.ok('paths resolve', resolved.ok);
    if (!resolved.ok) return;
    checks.equal(
      'joint order follows jointPaths',
      Array.from(resolved.value),
      ['Hips', 'Spine', 'Head'].map((name) => names.get(name)),
    );

    const skeleton: SkeletonAsset = {
      kind: 'skeleton',
      jointCount: 3,
      inverseBindMatrices: new Float32Array(48).map((_, i) => ((i % 16) % 5 === 0 ? 1 : 0)),
    };
    const handle = world.allocSharedRef('SkeletonAsset', skeleton);
    const added = world.addComponent(skinEntity, {
      component: Skin,
      data: { skeleton: handle, joints: Array.from(resolved.value) },
    });
    checks.ok('Skin attaches without a renderer', added.ok);
    const stored = world.get(skinEntity, Skin);
    checks.equal(
      'stored joints',
      stored.ok ? Array.from(stored.value.joints) : [],
      Array.from(resolved.value),
    );

    const missing = resolveSkinJoints(['Hips', 'Hips/Tail'], names, skinEntity);
    checks.equal(
      'unknown joint code',
      missing.ok ? 'ok' : missing.error.code,
      'skin-joint-path-unresolved',
    );
    if (!missing.ok && missing.error.code === 'skin-joint-path-unresolved') {
      checks.equal('detail.failedAtIndex', missing.error.detail.failedAtIndex, 1);
      checks.ok(
        'hint names the path',
        missing.error.hint.includes('Hips/Tail'),
        missing.error.hint,
      );
    }
  },
});
