import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { Materials } from '../../materials';
import { createRenderPublisher } from '../publisher';

// A steady frame's template delta is bounded by the rows that changed, never by
// how many unchanged rows share their mesh and material.
const templateBytes = (count: number): number => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const base = assets.create(Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] })).unwrap();
  const alt = assets.create(Materials.standard({ baseColor: [0.9, 0.2, 0.2, 1] })).unwrap();
  const spawn = (index: number, material = base) =>
    world
      .spawn(
        { component: Transform, data: { pos: [index, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const rows = Array.from({ length: count }, (_, index) => spawn(index));
  const publisher = createRenderPublisher(world, assets, { source: 'template-delta', epoch: 1 });
  const publish = (time: number) => {
    world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(time).unwrap();
    candidate.accept();
    publisher.recycle(candidate.packet.revision, [candidate.message.record]);
    return candidate.message.side?.templates ?? [];
  };
  publish(0);
  publish(1 / 60);
  for (let i = 0; i < 4; i++)
    world.set(rows[i * 3] as never, Transform, { pos: [i * 3, 1, 0] }).unwrap();
  for (let i = 0; i < 2; i++) world.despawn(rows[10 + i] as never).unwrap();
  for (let i = 0; i < 2; i++) spawn(count + i, alt);
  for (let i = 0; i < 2; i++)
    world.set(rows[20 + i] as never, MeshRenderer, { materials: [alt] }).unwrap();
  return new TextEncoder().encode(JSON.stringify(publish(2 / 60))).byteLength;
};

it('keeps the side.templates delta independent of the unchanged row count', () => {
  const small = templateBytes(256);
  const large = templateBytes(4096);
  expect(small).toBeGreaterThan(0);
  expect(large).toBe(small);
});
