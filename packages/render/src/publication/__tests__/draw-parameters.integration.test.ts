import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { MeshDrawParameters } from '../../components/mesh-draw-parameters';
import { Materials } from '../../materials';
import { stageDrawParameters } from '../draw-parameters';
import { createRenderPublisher, type RenderPublicationCandidate } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { renderPublicationSendTransfers } from '../record';
import { worldRenderResources } from '../resource-scope';

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

it('reads optional world parameters into caller storage across edits, removal and reuse', () => {
  const world = new World();
  const scope = worldRenderResources(world);
  world.components.register(MeshDrawParameters).unwrap();
  const ordinary = world.spawn().unwrap();
  const owner = world.spawn({ component: MeshDrawParameters, data: { x: 1, extraW: -2 } }).unwrap();
  const scratch = new Array<number>(8);
  const held = scope.drawParameters?.(owner);
  expect(held).toEqual([1, 0, 0, 0, 0, 0, 0, -2]);
  const get = vi.spyOn(world, 'get');
  try {
    for (let frame = 1; frame <= 32; frame++) {
      world.set(owner, MeshDrawParameters, { x: frame, extraZ: frame + 0.5 }).unwrap();
      expect(scope.drawParameters?.(ordinary, scratch)).toBeUndefined();
      expect(scope.drawParameters?.(owner, scratch)).toBe(scratch);
      expect(scratch).toEqual([frame, 0, 0, 0, 0, 0, frame + 0.5, -2]);
    }
    expect(get).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
  world.despawn(owner).unwrap();
  const replacement = world.spawn({ component: MeshDrawParameters, data: { y: 3 } }).unwrap();
  expect(scope.drawParameters?.(owner, scratch)).toBeUndefined();
  expect(scope.drawParameters?.(replacement, scratch)).toBe(scratch);
  expect(scratch).toEqual([0, 3, 0, 0, 0, 0, 0, 0]);
  expect(held).toEqual([1, 0, 0, 0, 0, 0, 0, -2]);
});

it('detaches every staged parameter and leaves accepted rows intact after a malformed final value', () => {
  const accepted = new Map<number, readonly number[]>([[5, [3, 2, 1, 0, 0, 0, 0, 0]]]);
  const held = accepted.get(5);
  const entities = Uint32Array.of(5, 9);
  const values = Float32Array.from({ length: 16 }, (_, i) => i + 1);
  values[15] = Number.NaN;
  const removed = new Uint32Array();
  const hasDraw = (entity: number) => entity === 5 || entity === 9;
  expect(stageDrawParameters({ entities, values, removed }, accepted, hasDraw)).toBeUndefined();
  expect(accepted.get(5)).toBe(held);
  expect(accepted.has(9)).toBe(false);
  values[15] = -0;
  const pending = stageDrawParameters({ entities, values, removed }, accepted, hasDraw);
  expect(pending).toBeDefined();
  values.fill(37);
  entities.fill(19);
  pending?.apply(accepted);
  expect(accepted.get(5)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(accepted.get(9)).toEqual([9, 10, 11, 12, 13, 14, 15, -0]);
  expect(held).toEqual([3, 2, 1, 0, 0, 0, 0, 0]);
});
