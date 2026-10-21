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
import { PLAYER_RIG } from '../../player/player-rig.ts';

const SceneInstance = defineComponent('SceneInstance', {
  source: { type: 'asset<scene>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});

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
  const asset: SceneAsset = {
    kind: 'scene',
    entities: {
      player: { components: { Transform: {}, Name: { value: 'Player' } } },
      camera: { components: { Transform: {} } },
      ...Object.fromEntries(
        PLAYER_RIG.map((joint) => [
          `player/joint/${joint.name}`,
          {
            components: {
              Transform: {},
              Name: { value: joint.name },
              ChildOf: {
                parent:
                  joint.parent < 0
                    ? 'player'
                    : `player/joint/${PLAYER_RIG[joint.parent]?.name ?? 'missing-parent'}`,
              },
            },
          },
        ]),
      ),
    },
  };
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
