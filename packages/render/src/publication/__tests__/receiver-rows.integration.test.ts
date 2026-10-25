import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import type { SceneRows } from '../../scene/scene-rows';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';

it('applies pose-only rows by rewriting exactly the changed rows and their pages', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'receiver-rows', epoch: 1 };
  const handle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entities: EntityHandle[] = [];
  for (let index = 0; index < 64; index++)
    entities.push(
      world
        .spawn(
          { component: Transform, data: { pos: [index, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: handle } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap(),
    );
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const publish = () => {
    world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: [
        ...renderPublicationTransfers(candidate.message),
        ...renderPublicationAssetTransfers(candidate.message),
      ],
    });
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    publisher.acknowledgeFeatures(packet.revision, []).unwrap();
    return accepted;
  };
  expect(publish().frame.renderables).toHaveLength(64);

  const rows = (receiver as unknown as { readonly rows: SceneRows }).rows;
  const beforeFrame = rows.capture();
  const before = new Map([...beforeFrame].map((row) => [row.entityKey, row]));

  const moved = [entities[3], entities[41]] as EntityHandle[];
  for (const entity of moved) world.set(entity, Transform, { pos: [0, 7, 0] }).unwrap();
  const delta = publish();

  expect(delta.frame.renderables).toHaveLength(0);
  expect(delta.operations).toHaveLength(2);
  for (const operation of delta.operations) {
    expect(operation.kind).toBe('update');
    expect(operation).not.toHaveProperty('snapshot');
  }
  expect(delta.scene.delta?.updatedSlots).toHaveLength(2);
  expect(delta.scene.delta?.contentUpdatedSlots).toHaveLength(0);
  const movedKeys = new Set(delta.operations.map((operation) => operation.entityKey));
  for (const row of rows.capture()) {
    const prior = before.get(row.entityKey);
    expect(row.slot).toBe(prior?.slot);
    if (movedKeys.has(row.entityKey)) {
      expect(row.snapshot.materials).toBe(prior?.snapshot.materials);
      expect(row.snapshot.transform.world[13]).toBe(7);
    } else expect(row).toBe(prior);
  }
  // O(changed rows): the row-change log names exactly the two moved rows.
  const logged: number[] = [];
  expect(rows.capture().changesSince(beforeFrame, (slot) => logged.push(slot))).toBe(true);
  expect(logged).toHaveLength(2);
});

it('retires only the rows of a disposed source epoch', () => {
  const sources = [1, 2].map((epoch) => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const handle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const world = new World({ assets });
    for (let index = 0; index < 3 + epoch; index++)
      world
        .spawn(
          { component: Transform, data: { pos: [index, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: handle } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
    const identity = { source: 'shared-rows', epoch };
    const publisher = createRenderPublisher(world, assets, identity);
    const receiver = new RenderPublicationReceiver(identity);
    world.update(1 / 60).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    candidate.accept();
    receiver.accept(candidate.message).unwrap();
    return receiver;
  });
  const rows = () =>
    sources.map(
      (receiver) => (receiver as unknown as { readonly rows: SceneRows }).rows.capture().length,
    );
  expect(rows()).toEqual([4, 5]);
  sources[0]?.dispose();
  expect(rows()).toEqual([0, 5]);
  sources[1]?.dispose();
  expect(rows()).toEqual([0, 0]);
});
