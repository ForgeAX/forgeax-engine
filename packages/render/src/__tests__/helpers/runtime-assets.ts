import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';

/** Assemble an isolated test World with its real asset owner. */
export function testAssets(world: World): AssetRegistry {
  if (world.assets instanceof AssetRegistry) return world.assets;
  const assets = new AssetRegistry();
  world.bindAssets(assets).unwrap();
  return assets;
}
