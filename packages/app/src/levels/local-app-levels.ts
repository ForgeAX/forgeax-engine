import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { PhysicsWorldResource } from '@forgeax/engine-physics';
import type { Renderer } from '@forgeax/engine-render';
import { levelSourceHost } from '@forgeax/engine-render/internal';
import { AppLevelOwner } from './app-level-owner';
import { localLevelRenderHost } from './candidate-render-source';

export function createLocalLevelOwner(
  world: World,
  assets: AssetRegistry | undefined,
  renderer: Renderer,
  now: () => number,
  stopped: () => boolean,
): AppLevelOwner {
  return new AppLevelOwner({
    world,
    assets,
    now,
    stopped,
    render: () => {
      const host = levelSourceHost(renderer, world);
      return host === undefined ? undefined : localLevelRenderHost(host);
    },
    physics: () =>
      world.hasResource(PhysicsWorldResource) ? world.getResource(PhysicsWorldResource) : undefined,
  });
}

/** Bootstraps the same owner before game plugins start and binds its App clock afterward. */
export function stageLocalAppLevels(
  world: World,
  assets: AssetRegistry | undefined,
  renderer: Renderer,
) {
  let clock: () => number;
  let stopped = () => false;
  return {
    owner: createLocalLevelOwner(
      world,
      assets,
      renderer,
      () => clock(),
      () => stopped(),
    ),
    bind(now: () => number, isStopped: () => boolean): void {
      clock = now;
      stopped = isStopped;
    },
  };
}
