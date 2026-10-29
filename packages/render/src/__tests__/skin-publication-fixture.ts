import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { MeshFilter, MeshRenderer } from '../components';
import { createRenderPublisher } from '../publication/publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';

export function fixture(missing = false) {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const mesh = createPrimitiveMesh('cube').unwrap();
  const count = (mesh.attributes.position as Float32Array).length / 3;
  const attributes = {
    ...mesh.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
  };
  const cube = assets
    .create({
      ...mesh,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    })
    .unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::pbr-skin' } }],
    })
    .unwrap();
  const publisher = createRenderPublisher(world, assets, { source: 'skin-owner', epoch: 1 });
  const skeleton = assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: mat4.identity(mat4.create()),
    })
    .unwrap();
  const firstJoint = missing
    ? world.spawn().unwrap()
    : world.spawn({ component: Transform, data: {} }).unwrap();
  const secondJoint = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: Skin, data: { skeleton, joints: [firstJoint] } },
      )
      .unwrap();
  const first = spawn(),
    second = spawn();
  const prepare = () => {
    world.update(0).unwrap();
    return publisher.prepare(world.getResource(Time).elapsed).unwrap();
  };
  const transfers = renderPublicationTransfers;
  const publish = () => {
    const candidate = prepare();
    const packet = structuredClone(candidate.packet, {
      transfer: transfers(candidate.message),
    });
    candidate.accept();
    const saved = structuredClone(packet);
    publisher.recycle(packet.revision, transfers(encodeRenderPublication(packet))).unwrap();
    return saved;
  };
  return {
    world,
    publisher,
    skeleton,
    firstJoint,
    secondJoint,
    first,
    second,
    spawn,
    assets,
    cube,
    material,
    prepare,
    publish,
  };
}
