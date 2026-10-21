import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { SceneAsset } from '@forgeax/engine-types';
import { worldInstantiateScene } from '../index';

/** Drop the test producer's hold so assertions measure the actual instance lifetime. */
export function instantiateSource(
  assets: AssetRegistry,
  world: World,
  source: SceneAsset,
  parent?: EntityHandle,
) {
  const handle = assets.create(source).unwrap();
  try {
    return worldInstantiateScene(world, handle, parent);
  } finally {
    assets.release(handle).unwrap();
  }
}
