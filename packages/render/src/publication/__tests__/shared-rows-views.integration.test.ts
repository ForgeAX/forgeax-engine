import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { PersistentRenderScene, type RenderScene } from '../../scene/render-scene';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';

const COUNT = 48;

function fixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'shared-render-world-views', epoch: 1 };
  const handle = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entities: EntityHandle[] = [];
  for (let index = 0; index < COUNT; index++)
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
  const rows = (receiver as unknown as { readonly rows: RenderScene['sceneRows'] }).rows;
  const rowCount = () => rows.size;
  return { assets, world, entities, receiver, rows, publish, rowCount };
}

it('shares one row store across two camera views without per-view row storage', () => {
  const f = fixture();
  const first = new PersistentRenderScene({ assets: f.assets });
  const second = new PersistentRenderScene({ assets: f.assets });
  const accepted = f.publish();
  first.consumePublication(accepted);
  // A late view seeds from the current rows, not from a materialized baseline.
  const baseline = f.receiver.snapshot(accepted);
  expect(baseline.frame.renderables).toHaveLength(0);
  second.consumePublication(baseline);
  expect(f.rowCount()).toBe(COUNT);
  const roster = first.compositionSlots();
  expect(roster.length).toBe(COUNT);
  expect(second.compositionSlots()).toBe(roster);
  for (const record of roster) expect(second.compositionSlot(0, record.entityKey)).toBe(record);

  // Pose edits commit once; both views observe the same delta.
  const moved = [f.entities[5], f.entities[30]] as EntityHandle[];
  for (const entity of moved) f.world.set(entity, Transform, { pos: [0, 4, 0] }).unwrap();
  const delta = f.publish();
  first.consumePublication(delta);
  second.consumePublication(delta);
  expect(f.rowCount()).toBe(COUNT);
  expect(delta.scene.delta?.updatedSlots).toHaveLength(2);
  expect(second.compositionSlots()).toBe(first.compositionSlots());
  first.dispose();
  second.dispose();
  // Views own no rows: disposing them leaves the receiver's rows.
  expect(f.rowCount()).toBe(COUNT);
  f.receiver.dispose();
  expect(f.rowCount()).toBe(0);
});

it('commits a pose edit in O(changed rows) without per-row copies of unchanged rows', () => {
  const f = fixture();
  const view = new PersistentRenderScene({ assets: f.assets });
  view.consumePublication(f.publish());
  const before = view.compositionSlots();
  const moved = f.entities[17] as EntityHandle;
  f.world.set(moved, Transform, { pos: [0, 9, 0] }).unwrap();
  view.consumePublication(f.publish());
  const after = view.compositionSlots();
  let replaced = 0;
  let movedSlot = -1;
  for (const record of after) {
    if (before.slotAt(record.slot) === record) continue;
    replaced++;
    movedSlot = record.slot;
    expect(record.entityKey).toBe(Number(moved));
    expect(record.snapshot.transform.world[13]).toBe(9);
  }
  expect(replaced).toBe(1);
  // The row-change log names only the moved row.
  const logged: string[] = [];
  expect(after.changesSince(before, (slot, kind) => logged.push(`${slot}:${kind}`))).toBe(true);
  expect(logged).toEqual([`${movedSlot}:update`]);
  f.receiver.dispose();
});
