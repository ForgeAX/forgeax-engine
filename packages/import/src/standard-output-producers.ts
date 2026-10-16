import type { ScriptablePackSceneComponent } from '@forgeax/engine-pack/source';
import { pluginAssetOutputProducer } from './plugin-asset-producer.js';
import type { AssetOutputProducerRegistry } from './scriptable-pack.js';
import { createAssetOutputProducerRegistry } from './scriptable-pack-output-producers.js';

export function createStandardAssetOutputProducerRegistry(
  sceneComponents: readonly ScriptablePackSceneComponent[] = [],
): AssetOutputProducerRegistry {
  const registry = createAssetOutputProducerRegistry(sceneComponents);
  registry.register(pluginAssetOutputProducer);
  return registry;
}
