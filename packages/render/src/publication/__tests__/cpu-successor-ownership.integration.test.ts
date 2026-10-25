import { createHash } from 'node:crypto';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { FixedTime, FixedUpdate, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import type { RenderFeature } from '../../features/types';
import type { RenderPublication } from '../contract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../record';

function columns(packet: RenderPublication): string[] {
  return renderPublicationTransfers(encodeRenderPublication(packet)).map((buffer) =>
    createHash('sha256').update(new Uint8Array(buffer)).digest('hex'),
  );
}

it.each(
  [1, 2].flatMap((steps) => [false, true].map((deferThird) => ({ steps, deferThird }))),
)('holds three sealed publications across $steps FixedUpdates (third consumption deferred: $deferThird)', ({
  steps,
  deferThird,
}) => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'cpu-successor-ownership', epoch: 1 };
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const handle = assets.create(mesh).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: handle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  const retiring = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: handle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world
    .addSystem(FixedUpdate, {
      name: 'author-dynamic-mesh',
      queries: [],
      fn: () => {
        const tick = world.getResource(FixedTime).tick;
        const vertices = new Float32Array(mesh.vertices);
        vertices[0] = tick;
        assets.update(handle, { vertices }).unwrap();
        world.set(entity, Transform, { pos: [tick, 0, 0] }).unwrap();
      },
    })
    .unwrap();
  const extracted: number[] = [];
  const submitted: number[] = [];
  const feature: RenderFeature<{ tick: number }> = {
    identity: 'fixed-step-source',
    extract: () => {
      const tick = world.getResource(FixedTime).tick;
      extracted.push(tick);
      return ok({ tick });
    },
    plan: () => ok({ work: [{ scope: 'frame', resources: [], passes: [] }] }),
    onSourceFrameSubmitted: (data) => submitted.push(data.tick),
  };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    undefined,
    [feature],
    undefined,
    undefined,
    3,
  );
  const receiver = new RenderPublicationReceiver(identity);
  const packets: RenderPublication[] = [];
  const send = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: [
        ...renderPublicationTransfers(candidate.message),
        ...renderPublicationAssetTransfers(candidate.message),
      ],
    });
    candidate.accept();
    packets.push(packet);
    return packet;
  };
  const publish = () => receiver.accept(encodeRenderPublication(send())).unwrap();
  try {
    let accepted: ReturnType<typeof publish> | undefined;
    for (let index = 0; index < 3; index++) {
      world.update(1 / 60).unwrap();
      if (index === 2 && deferThird) send();
      else accepted = publish();
      if (index === 0) world.despawn(retiring).unwrap();
      // Submission acknowledges exactly its source extraction; GPU completion
      // and all four transport columns are still held independently.
      if (index !== 2 || !deferThird)
        publisher
          .acknowledgeFeatures(index + 1, [{ identity: feature.identity, feedback: {} }])
          .unwrap();
    }
    if (accepted === undefined) throw new Error('Missing accepted publication');
    expect(packets.some((packet) => packet.removed.length > 0)).toBe(true);
    const sealedColumns = packets.map(columns);
    const sealedMeshes = packets.map((packet) => {
      const value = packet.assets.find((row) => row.handle === handle)?.value;
      if (value?.kind !== 'mesh') throw new Error('Missing published dynamic mesh');
      return value.vertices[0];
    });
    const retained = receiver.snapshot(accepted);
    const retainedMesh = retained.resources.resolveAsset(handle).unwrap();
    const retainedRows = retained.scene.rows.capture();
    expect(retainedRows.length).toBeGreaterThan(0);
    expect(submitted).toEqual(deferThird ? [1, 2] : [1, 2, 3]);
    world.update(steps / 60).unwrap();
    const successorTick = world.getResource(FixedTime).tick;
    expect(successorTick).toBe(3 + steps);
    expect(runtimeAssets(assets).borrow(handle).unwrap()).not.toBe(retainedMesh);
    expect(extracted).toEqual([1, 2, 3]);
    expect(publisher.prepare(0)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'in-flight' } },
    });
    expect(publisher.inspect().inFlightCount).toBe(3);
    expect(receiver.acceptedRevision).toBe(deferThird ? 2 : 3);
    expect(retained.resources.resolveAsset(handle).unwrap()).toBe(retainedMesh);
    expect(retained.scene.rows.capture()).toBe(retainedRows);
    expect(packets.map(columns)).toEqual(sealedColumns);
    expect(sealedMeshes).toEqual([1, 2, 3]);
    const [first, second] = packets;
    if (first === undefined || second === undefined) throw new Error('Missing held packets');
    expect(
      publisher.recycle(2, renderPublicationTransfers(encodeRenderPublication(second))).ok,
    ).toBe(false);
    expect(publisher.inspect().inFlightCount).toBe(3);
    if (deferThird) {
      const third = packets[2];
      if (third === undefined) throw new Error('Missing deferred publication');
      const received = receiver.accept(encodeRenderPublication(third)).unwrap();
      expect(received.packet.features[0]?.data).toEqual({ tick: 3 });
      publisher.acknowledgeFeatures(3, [{ identity: feature.identity, feedback: {} }]).unwrap();
      expect(submitted).toEqual([1, 2, 3]);
    }
    // The completion owner returns the oldest storage only after its proof
    // work. This contract does not turn an early World update into retirement.
    publisher.recycle(1, renderPublicationTransfers(encodeRenderPublication(first))).unwrap();
    const successor = publish();
    expect(successor.packet.base).toBe(3);
    expect(successor.packet.features[0]?.data).toEqual({ tick: successorTick });
    expect(extracted).toEqual([1, 2, 3, successorTick]);
    expect(publisher.inspect().inFlightCount).toBe(3);
    expect(submitted).toEqual([1, 2, 3]);
    publisher.acknowledgeFeatures(4, [{ identity: feature.identity, feedback: {} }]).unwrap();
    expect(submitted).toEqual([1, 2, 3, successorTick]);
    for (const packet of packets.slice(1))
      publisher
        .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
        .unwrap();
    expect(publisher.inspect().inFlightCount).toBe(0);
  } finally {
    receiver.dispose();
    publisher.dispose();
    assets.dispose();
  }
});
