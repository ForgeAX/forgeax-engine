import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { MeshDrawParameters } from '../../components/mesh-draw-parameters';
import { Materials } from '../../materials';
import { createRenderPublisher, type RenderPublicationCandidate } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { renderPublicationSendTransfers } from '../record';

it('publishes only the changed draw parameters, preserves them on retry and retires old owners', () => {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const registration = world.components.register(MeshDrawParameters).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  const spawn = (x: number) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: MeshDrawParameters, data: { x } },
      )
      .unwrap();
  const first = spawn(1);
  const second = spawn(2);
  const identity = { source: 'draw-parameters', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const renderAssets = new AssetRegistry();
  const admit = (candidate: RenderPublicationCandidate) => {
    const transfers = renderPublicationSendTransfers(candidate.message);
    const parameters = candidate.message.side?.drawParameters;
    if (parameters !== undefined) {
      expect(parameters.entities.buffer).toBe(parameters.values.buffer);
      expect(parameters.entities.buffer).toBe(parameters.removed.buffer);
      expect(transfers.filter((buffer) => buffer === parameters.values.buffer)).toHaveLength(1);
    }
    const message = structuredClone(candidate.message, { transfer: transfers });
    if (parameters !== undefined) expect(parameters.values.buffer.byteLength).toBe(0);
    const result = receiver.accept(message, renderAssets).unwrap();
    candidate.accept();
    publisher.recycle(message.revision, [message.record]).unwrap();
    return result.resources;
  };
  const initial = publisher.prepare(0).unwrap();
  expect(initial.packet.materials).toHaveLength(1);
  const resources = admit(initial);
  expect(resources.drawParameters?.(first)?.[0]).toBe(1);
  expect(resources.drawParameters?.(second)?.[0]).toBe(2);

  world.set(first, MeshDrawParameters, { x: 6 }).unwrap();
  world.set(first, MeshDrawParameters, { x: 7 }).unwrap();
  publisher.prepare(1).unwrap().discard();
  const changed = publisher.prepare(1).unwrap();
  expect(Array.from(changed.packet.drawParameters?.entities ?? [])).toEqual([first]);
  expect(changed.packet.drawParameters?.values[0]).toBe(7);
  expect(changed.packet.materials).toHaveLength(0);
  expect(changed.packet.programs).toHaveLength(0);
  expect(changed.packet.upserts).toHaveLength(0);
  admit(changed);
  expect(resources.drawParameters?.(first)?.[0]).toBe(7);
  expect(resources.drawParameters?.(second)?.[0]).toBe(2);

  world.set(first, MeshDrawParameters, { x: 7 }).unwrap();
  const unchanged = publisher.prepare(2).unwrap();
  expect(unchanged.message.side?.drawParameters).toBeUndefined();
  admit(unchanged);

  world.despawn(first).unwrap();
  const replacement = spawn(9);
  expect(replacement).not.toBe(first);
  admit(publisher.prepare(3).unwrap());
  expect(resources.drawParameters?.(first)).toBeUndefined();
  expect(resources.drawParameters?.(replacement)?.[0]).toBe(9);
  world.despawn(replacement).unwrap();
  world.despawn(second).unwrap();
  admit(publisher.prepare(4).unwrap());
  expect(resources.drawParameters).toBeUndefined();
  registration.dispose().unwrap();
});
