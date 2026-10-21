import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { installDefaultAssetDecoders } from '../../asset-contributions';

/** Assemble the real runtime owner for an isolated test World. */
export function testAssets(world: World): AssetRegistry {
  if (world.assets instanceof AssetRegistry) return world.assets;
  const assets = new AssetRegistry();
  installDefaultAssetDecoders(assets);
  world.bindAssets(assets).unwrap();
  return assets;
}
