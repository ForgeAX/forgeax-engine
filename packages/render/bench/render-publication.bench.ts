import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { afterAll, bench } from 'vitest';
import { Camera, Instances, MeshFilter, MeshRenderer } from '../src/components';
import { Materials } from '../src/materials';
import { PersistentRenderScene } from '../src/scene/render-scene';
import { renderPublicationTransfers } from '../src/publication/record';
import { createRenderPublisher } from '../src/publication/publisher';
import { RenderPublicationReceiver } from '../src/publication/receiver';

for (const { name, instances, unique } of [
  { name: 'publication: 1000 shared rigid meshes', instances: 0, unique: false },
  { name: 'publication: 1000 unique rigid meshes', instances: 0, unique: true },
  { name: 'publication: 64 carriers with 512 instances', instances: 512, unique: false },
]) {
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const world = new World();
  const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
  const identity = { source: 'publication-workload', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene();
  const material = assets.create(Materials.standard({ baseColor: [0.6, 0.5, 0.4, 1] })).unwrap();
  const sharedMesh = assets.create(geometry).unwrap();
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: { fov: Math.PI / 3, aspect: 1 } })
    .unwrap();
  const entities = Array.from({ length: instances === 0 ? 1000 : 64 }, () => {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        {
          component: MeshFilter,
          data: { assetHandle: unique ? assets.create(geometry).unwrap() : sharedMesh },
        },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    if (instances > 0) {
      const transforms = new Float32Array(instances * 16);
      for (let i = 0; i < instances; i++) {
        transforms[i * 16] =
          transforms[i * 16 + 5] =
          transforms[i * 16 + 10] =
          transforms[i * 16 + 15] =
            1;
        transforms[i * 16 + 12] = i;
      }
      world.addComponent(entity, { component: Instances, data: { transforms } }).unwrap();
    }
    return entity;
  });
  let iteration = 0;
  bench(name, () => {
    for (const entity of entities)
      world.set(entity, MeshRenderer, { lightingChannels: (iteration % 2) + 1 }).unwrap();
    iteration++;
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    scene.consumePublication(receiver.accept(packet).unwrap());
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    publisher.recycle(packet.revision, returned).unwrap();
  });
  afterAll(() => {
    publisher.dispose();
    scene.dispose();
  });
}
