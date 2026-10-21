import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { defineComponent, World } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'World asset references',
  catalog: 'World asset references',
  kind: 'headless',
  summary:
    'The asset owner creates runtime references. ECS asset fields retain them through the write barrier; a caller can release its own grant while a live entity keeps the content available.',
  expect:
    'An explicit copy has an independent identity. Releasing the caller grant leaves bound content readable; despawning the final holder retires that identity without affecting the copy.',
  run(checks) {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const Holder = defineComponent('FeatureLabAssetHolder', { asset: 'asset<mesh>' });
    world.components.register(Holder).unwrap();
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const copy = assets.copy(mesh).unwrap();
    checks.ok('explicit copy has its own identity', copy !== mesh);
    const entity = world.spawn({ component: Holder, data: { asset: mesh } }).unwrap();
    assets.release(mesh).unwrap();
    checks.ok('entity retains content after the caller releases it', assets.read(mesh).ok);
    world.despawn(entity).unwrap();
    checks.ok('final entity release retires the original identity', !assets.read(mesh).ok);
    checks.ok('independent copy remains available', assets.read(copy).ok);
    assets.release(copy).unwrap();
    checks.ok('final caller release retires the copy', !assets.read(copy).ok);
    assets.dispose();
  },
});
