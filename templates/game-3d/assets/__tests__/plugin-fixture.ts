import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { animationClipContribution } from '@forgeax/engine/animation';
import {
  AnimatedBy,
  AnimationPlayer,
  AnimationTargetId,
  AnimationTargets,
} from '@forgeax/engine/animation';
import { createWorldContext, defineComponent, World } from '@forgeax/engine/ecs';
import {
  ChildOf,
  Children,
  Name,
  sceneEntity,
  Transform,
  worldInstantiateSceneAsset,
  worldResolveSceneEntity,
} from '@forgeax/engine/scene';
import type { AnimationClip, SceneAsset } from '@forgeax/engine/types';
import { vi } from 'vitest';
import scenePack from '../scene.pack.ts';

const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'asset<scene>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});

/** Components the fake world registers; other authored components need engine plugins. */
const FIXTURE_COMPONENTS = new Set(['Transform', 'Name', 'ChildOf']);

/**
 * The authored showcase scene reduced to its hierarchy: every entity key the
 * scene pack declares (including entities added later) with only Transform,
 * Name and ChildOf, so plugins resolve the same keys they do in the game.
 */
async function authoredHierarchy(): Promise<SceneAsset> {
  const built = await scenePack.build(undefined as never);
  if (!built.ok) throw new Error(`scene pack build failed: ${JSON.stringify(built.error)}`);
  const scene = built.value['scene/showcase'] as SceneAsset;
  return {
    kind: 'scene',
    entities: Object.fromEntries(
      Object.entries(scene.entities).map(([key, entity]) => [
        key,
        {
          components: Object.fromEntries(
            Object.entries(entity.components).filter(([name]) => FIXTURE_COMPONENTS.has(name)),
          ),
        },
      ]),
    ),
  };
}

export async function sceneWorldFixture() {
  const assets = new AssetRegistry();
  assets.installDecoder(animationClipContribution.kind, animationClipContribution.decoder);
  const world = new World({ assets });
  for (const component of [
    SceneInstance,
    ChildOf,
    Children,
    Name,
    Transform,
    AnimationPlayer,
    AnimationTargetId,
    AnimationTargets,
    AnimatedBy,
  ]) {
    world.components.register(component).unwrap();
  }
  const asset = await authoredHierarchy();
  const ctx = await createWorldContext(world);
  return { world, ctx, asset, assets };
}

export async function pluginFixture() {
  const { world, ctx, asset, assets } = await sceneWorldFixture();
  const source = assets.create(asset).unwrap();
  const root = worldInstantiateSceneAsset(
    world,
    source,
    asset,
    undefined,
    new Set(),
    undefined,
    'scene/showcase',
  ).unwrap();
  assets.release(source);
  const entity = (key: string) =>
    worldResolveSceneEntity(world, root, sceneEntity('scene/showcase', key)).unwrap();
  const clip: AnimationClip = { kind: 'animation-clip', duration: 1, channels: [] };
  const load = vi.spyOn(assets, 'load').mockImplementation(async () => assets.create(clip));
  const unregisterRead = vi.fn();
  const registerRead = vi.fn(() => unregisterRead);
  const pointerLock = vi.fn();
  ctx.provide('physics', {} as never);
  ctx.provide('gameScene', { root, asset });
  ctx.provide('gameHost', {
    assets,
    gameProjection: { registerRead },
    setPointerLockAllowed: pointerLock,
  } as never);
  return { world, ctx, assets, entity, load, registerRead, unregisterRead, pointerLock };
}
