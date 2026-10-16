import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';

function fixture() {
  const world = new World();
  const publisher = createRenderPublisher(
    world,
    new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
    { source: 'skin-owner', epoch: 1 },
  );
  const skeleton = world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: mat4.identity(mat4.create()),
  });
  const firstJoint = world.spawn({ component: Transform, data: {} }).unwrap();
  const secondJoint = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
        { component: Skin, data: { skeleton, joints: [firstJoint] } },
      )
      .unwrap();
  const first = spawn(),
    second = spawn();
  const prepare = () => {
    world.update(0).unwrap();
    return publisher.prepare(world.getResource(Time).elapsed).unwrap();
  };
  const publish = () => {
    const candidate = prepare();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const saved = structuredClone(packet);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
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
    prepare,
    publish,
  };
}

it('retains current joint subscriptions through repeated poses, rebinding, Skin removal and entity replacement', () => {
  const f = fixture();
  const entities = () =>
    Array.from(f.publish().upserts)
      .filter((_, index) => index % 2 === 0)
      .sort((a, b) => a - b);
  const pair = [Number(f.first), Number(f.second)].sort((a, b) => a - b);
  try {
    expect(entities()).toEqual(pair);
    for (let position = 1; position <= 3; position++) {
      f.world.set(f.firstJoint, Transform, { pos: [position, 0, 0] }).unwrap();
      expect(entities()).toEqual(pair);
      expect(entities()).toEqual([]);
    }
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    expect(entities()).toEqual([Number(f.first)]);
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    expect(entities()).toEqual([Number(f.second)]);
    f.world.set(f.secondJoint, Transform, { pos: [5, 0, 0] }).unwrap();
    expect(entities()).toEqual([Number(f.first)]);
    f.world.removeComponent(f.first, Skin).unwrap();
    const removedSkin = f.publish();
    const binding = Array.from(removedSkin.upserts).findIndex(
      (entity, index) => index % 2 === 0 && entity === f.first,
    );
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(
      removedSkin.templates[removedSkin.upserts[binding + 1] ?? -1]?.snapshot.skinPose,
    ).toBeUndefined();
    f.world.set(f.secondJoint, Transform, { pos: [6, 0, 0] }).unwrap();
    expect(entities()).toEqual([]);
    f.world.despawn(f.second).unwrap();
    const replacement = f.spawn();
    expect(replacement).not.toBe(f.second);
    expect(entities()).toEqual([Number(replacement)]);
    f.world.set(f.firstJoint, Transform, { pos: [7, 0, 0] }).unwrap();
    expect(entities()).toEqual([Number(replacement)]);
  } finally {
    f.publisher.dispose();
  }
});

it('keeps accepted joint ownership after a discarded pose publication and admits the latest rebind', () => {
  const f = fixture();
  try {
    f.publish();
    f.world.set(f.firstJoint, Transform, { pos: [1, 0, 0] }).unwrap();
    f.prepare().discard();
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    f.world.set(f.firstJoint, Transform, { pos: [3, 0, 0] }).unwrap();
    const packet = f.publish();
    // Entity identity is carried by upserts, rather than duplicated in each template.
    const byEntity = new Map(
      Array.from({ length: packet.upserts.length / 2 }, (_, index) => {
        const entity = packet.upserts[index * 2],
          template = packet.templates[packet.upserts[index * 2 + 1] ?? -1];
        return [entity, template?.snapshot.skinPose] as const;
      }),
    );
    expect(byEntity.get(f.first)?.jointWorlds[0]?.[12]).toBe(2);
    expect(byEntity.get(f.second)?.jointWorlds[0]?.[12]).toBe(3);
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    expect(Array.from(f.publish().upserts).filter((_, index) => index % 2 === 0)).toEqual([
      Number(f.second),
    ]);
  } finally {
    f.publisher.dispose();
  }
});

it('keeps accepted joint subscriptions private from a later packet metadata mutation', () => {
  const f = fixture();
  try {
    const baseline = f.prepare();
    baseline.accept();
    const binding = Array.from(baseline.packet.upserts).findIndex(
      (entity, index) => index % 2 === 0 && entity === f.first,
    );
    const template = baseline.packet.templates[baseline.packet.upserts[binding + 1] ?? -1];
    const publishedJoints = template?.snapshot.skinJointEntities;
    if (publishedJoints === undefined) throw new Error('missing fixture joint metadata');
    // Exercise the runtime ownership boundary of the otherwise readonly packet.
    (publishedJoints as number[])[0] = f.secondJoint;
    f.publisher
      .recycle(baseline.packet.revision, renderPublicationTransfers(baseline.packet))
      .unwrap();
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    f.publish();
    f.world.set(f.secondJoint, Transform, { pos: [3, 0, 0] }).unwrap();
    expect(Array.from(f.publish().upserts).filter((_, index) => index % 2 === 0)).toEqual([
      Number(f.first),
    ]);
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    expect(Array.from(f.publish().upserts).filter((_, index) => index % 2 === 0)).toEqual([
      Number(f.second),
    ]);
  } finally {
    f.publisher.dispose();
  }
});
