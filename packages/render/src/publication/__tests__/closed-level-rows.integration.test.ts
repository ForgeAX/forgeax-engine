import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Disabled, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { prepareSceneTransformsSteps } from '@forgeax/engine-scene/internal';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { Instances, MeshFilter, MeshRenderer } from '../../components';
import { prepareExtractContext } from '../../render-system-extract';
import { prepareMeshSourceSteps } from '../../scene/prepared-mesh-source';
import { encodeClosedLevelRows, sameClosedLevelRows } from '../closed-level-rows';
import { createRenderPublisher } from '../publisher';
import { decodeClosedLevelRows, RenderPublicationReceiver } from '../receiver';

function complete<T>(iterator: Generator<void, T>): T {
  for (let next = iterator.next(); ; next = iterator.next()) if (next.done) return next.value;
}

it('decodes transferred inactive rows without advancing the ordinary frame or emitting their geometry', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const identity = { source: 'closed-level', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  try {
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const resident = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    const members = [4, 7].map((x) =>
      world
        .spawn(
          { component: Disabled, data: {} },
          { component: Transform, data: { pos: [x, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: {} },
          {
            component: Instances,
            data: {
              transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]),
            },
          },
        )
        .unwrap(),
    );
    world.update(1 / 60).unwrap();
    const first = publisher.prepare(0).unwrap();
    const firstMessage = structuredClone(first.message);
    first.accept();
    const before = receiver.accept(firstMessage).unwrap();
    expect(before.frame.renderables.map((row) => row.entityKey)).toEqual([resident]);

    const roster = { members, authorDisabled: new Set<typeof resident>(), isCurrent: () => true };
    complete(prepareSceneTransformsSteps(world, roster)).unwrap();
    const captured = complete(
      prepareMeshSourceSteps(
        world,
        prepareExtractContext(world, { assets, cull: 'none', retainHidden: true }),
        roster,
      ),
    ).unwrap();
    const chunks = [...encodeClosedLevelRows(captured, 1)];
    expect(chunks).toHaveLength(2);
    const invalid = structuredClone(chunks[0]);
    if (invalid === undefined) throw new Error('Missing fixture chunk');
    invalid.upserts[0] = resident;
    expect(decodeClosedLevelRows(invalid)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'shape', subject: 'closed Level row identity' } },
    });
    const earliest = members[0];
    if (earliest === undefined) throw new Error('Missing first Level member');
    const stale = encodeClosedLevelRows(
      { ...captured, isCurrent: () => world.hasComponent(earliest, Disabled) },
      1,
    );
    expect(stale.next().done).toBe(false);
    world.removeComponent(earliest, Disabled).unwrap();
    expect(() => stale.next()).toThrow('Closed Level source changed during publication');
    world.addComponent(earliest, { component: Disabled, data: {} }).unwrap();

    let current = true;
    const finalChunk = encodeClosedLevelRows({ ...captured, isCurrent: () => current }, 2);
    expect(finalChunk.next().done).toBe(false);
    current = false;
    expect(() => finalChunk.next()).toThrow('Closed Level source changed during publication');

    const prepared = chunks.flatMap((chunk) => {
      const payload = structuredClone(chunk, {
        transfer: [
          chunk.upserts.buffer as ArrayBuffer,
          chunk.transformEntities.buffer as ArrayBuffer,
          chunk.transforms.buffer as ArrayBuffer,
        ],
      });
      expect(chunk.transforms.byteLength).toBe(0);
      const wireBefore = structuredClone(payload);
      const decoded = decodeClosedLevelRows(payload).unwrap();
      for (const row of decoded) {
        const material = row.material;
        const pass = material.snapshot.passes[0];
        if (pass === undefined) throw new Error('expected a published mesh Pass');
        const observation = material.programObservation(pass);
        expect(observation.identity).toBeDefined();
        expect(material.programObservation(pass)).toBe(observation);
      }
      expect(sameClosedLevelRows(payload, wireBefore)).toBe(true);
      payload.transforms.fill(0);
      return decoded;
    });
    expect(prepared.map((row) => row.entityKey)).toEqual(members);
    expect(prepared.map((row) => row.transform.world[12])).toEqual([4, 7]);
    expect(prepared.map((row) => row.instances?.transforms[12])).toEqual([4, 7]);
    expect(prepared.every((row) => row.assetHandle === mesh)).toBe(true);
    expect(members.every((entity) => world.hasComponent(entity, Disabled))).toBe(true);
    expect(before.resources.revision).toBe(first.packet.revision);

    world.set(resident, Transform, { pos: [12, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    const next = publisher.prepare(1 / 60).unwrap();
    const nextMessage = structuredClone(next.message);
    next.accept();
    const continued = receiver.accept(nextMessage).unwrap();
    expect(continued.packet.base).toBe(first.packet.revision);
    expect([...continued.packet.transformEntities]).toEqual([resident]);
    expect(continued.scene.rows.lookup(resident)?.snapshot.transform.world[12]).toBe(12);
    for (const entity of members) expect(continued.scene.rows.lookup(entity)).toBeUndefined();
  } finally {
    receiver.dispose();
    publisher.dispose();
    assets.dispose();
  }
});
