import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { defineComponent, World } from '@forgeax/engine/ecs';
import { SceneInstance } from '@forgeax/engine/render';
import { ChildOf, Children } from '@forgeax/engine/scene';
import { SkinJointPathUnresolvedError } from '@forgeax/engine/skinning';
import type { SceneAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Scene instantiate transaction',
  catalog: 'Scene instantiate transaction',
  kind: 'headless',
  summary:
    'AssetRegistry.instantiate spawns a SceneAsset as one transaction. An injected structured Skin post-spawn failure must roll back only this attempt; after the repair the same scene handle instantiates again.',
  expect:
    'The failing attempt returns err and leaves entity count and shared-ref count at baseline; an unrelated pre-existing entity survives; the retry succeeds and spawns the scene.',
  run(checks) {
    let failing = true;
    let hookFailure: SkinJointPathUnresolvedError | undefined;
    const guarded = new AssetRegistry({
      shaderRegistry: {} as never,
      postSpawnHook: (_world, _resolver, root) => {
        if (!failing) return { ok: true };
        hookFailure = new SkinJointPathUnresolvedError(root, ['injected-post-spawn-joint'], 0);
        return { ok: false, error: hookFailure };
      },
    });
    const Tag = defineComponent('FeatureLabSceneTag', { value: 'f32' });
    const world = new World({ assets: guarded });

    for (const component of [Tag, ChildOf, Children, SceneInstance])
      world.components.register(component).unwrap();
    const bystander = world.spawn({ component: Tag, data: { value: 99 } }).unwrap();
    const scene: SceneAsset = {
      kind: 'scene',
      entities: {
        first: { components: { FeatureLabSceneTag: { value: 1 } } },
        second: { components: { FeatureLabSceneTag: { value: 2 } } },
      },
    } as SceneAsset;
    const handle = guarded.create(scene).unwrap();
    const entities = world.inspect().entityCount;
    const refs = world.sharedRefs._liveCount();

    const failed = guarded.instantiate(handle, world);
    checks.ok(
      'failing attempt preserves the original structured hook error',
      !failed.ok && failed.error === hookFailure,
      failed.ok ? 'ok' : failed.error.code,
    );
    checks.equal('entities rolled back', world.inspect().entityCount, entities);
    checks.equal('shared-ref grants rolled back', world.sharedRefs._liveCount(), refs);
    checks.ok('bystander entity survives', world.get(bystander, Tag).ok);

    failing = false;
    const retried = guarded.instantiate(handle, world);
    checks.ok(
      'retry of the same scene succeeds',
      retried.ok,
      retried.ok ? undefined : String(retried.error.code),
    );
    checks.ok(
      'retry spawns root + two entities',
      world.inspect().entityCount >= entities + 2,
      `${world.inspect().entityCount - entities} new`,
    );
  },
});
