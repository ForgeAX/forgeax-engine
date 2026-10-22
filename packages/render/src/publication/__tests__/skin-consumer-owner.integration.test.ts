import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';

function fixture() {
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
  const firstJoint = world.spawn({ component: Transform, data: {} }).unwrap();
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

const changedEntities = (packet: ReturnType<ReturnType<typeof fixture>['publish']>) =>
  [...packet.upserts].filter((_, index) => index % 2 === 0).sort((a, b) => a - b);

it('keeps static membership separate from repeated poses, rebinding, Skin removal and entity replacement', () => {
  const f = fixture(),
    pair = [Number(f.first), Number(f.second)].sort((a, b) => a - b);
  try {
    expect(changedEntities(f.publish())).toEqual(pair);
    for (const position of [1, 2, 3]) {
      f.world.set(f.firstJoint, Transform, { pos: [position, 0, 0] }).unwrap();
      const packet = f.publish();
      expect(changedEntities(packet)).toEqual([]);
      expect([...packet.transformEntities]).toEqual([Number(f.firstJoint)]);
      expect(packet.transforms[12]).toBe(position);
      expect(f.publish().transformEntities).toHaveLength(0);
    }
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    expect(changedEntities(f.publish())).toEqual([Number(f.first)]);
    for (const joint of [f.firstJoint, f.secondJoint]) {
      f.world.set(joint, Transform, { pos: [5, 0, 0] }).unwrap();
      const packet = f.publish();
      expect(changedEntities(packet)).toEqual([]);
      expect([...packet.transformEntities]).toEqual([Number(joint)]);
    }
    f.world.removeComponent(f.first, Skin).unwrap();
    f.world.set(f.first, MeshRenderer, { materials: [] }).unwrap();
    const removed = f.publish();
    expect(changedEntities(removed)).toEqual([Number(f.first)]);
    expect([...removed.retiredJoints]).toEqual([Number(f.secondJoint)]);
    f.world.set(f.secondJoint, Transform, { pos: [6, 0, 0] }).unwrap();
    expect(f.publish().transformEntities).toHaveLength(0);
    f.world.despawn(f.second).unwrap();
    const replacement = f.spawn();
    expect(replacement).not.toBe(f.second);
    expect(changedEntities(f.publish())).toEqual([Number(replacement)]);
    f.world.set(f.firstJoint, Transform, { pos: [7, 0, 0] }).unwrap();
    const packet = f.publish();
    expect(changedEntities(packet)).toEqual([]);
    expect([...packet.transformEntities]).toEqual([Number(f.firstJoint)]);
  } finally {
    f.publisher.dispose();
  }
});

it('keeps reference ownership after a discarded joint publication and admits the latest rebind', () => {
  const f = fixture();
  try {
    f.publish();
    f.world.set(f.firstJoint, Transform, { pos: [1, 0, 0] }).unwrap();
    f.prepare().discard();
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    f.world.set(f.firstJoint, Transform, { pos: [3, 0, 0] }).unwrap();
    const packet = f.publish();
    expect(changedEntities(packet)).toEqual([Number(f.first)]);
    const skin = packet.templates[packet.upserts[1] ?? -1]?.snapshot.skinBinding;
    expect(skin?.joints).toEqual([Number(f.secondJoint)]);
    const first = packet.transformEntities.indexOf(Number(f.firstJoint)),
      second = packet.transformEntities.indexOf(Number(f.secondJoint));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(packet.transforms[first * 16 + 12]).toBe(3);
    expect(packet.transforms[second * 16 + 12]).toBe(2);
    f.world.set(f.firstJoint, Transform, { pos: [4, 0, 0] }).unwrap();
    const next = f.publish();
    expect(changedEntities(next)).toEqual([]);
    expect([...next.transformEntities]).toEqual([Number(f.firstJoint)]);
  } finally {
    f.publisher.dispose();
  }
});

it('keeps accepted reference ownership private from later packet metadata replacement', () => {
  const f = fixture();
  try {
    const baseline = f.prepare();
    baseline.accept();
    const index = [...baseline.packet.upserts].findIndex(
      (entity, offset) => offset % 2 === 0 && entity === f.first,
    );
    const template = baseline.packet.templates[baseline.packet.upserts[index + 1] ?? -1];
    if (template === undefined || template.snapshot.skinBinding === undefined)
      throw new Error('Missing static Skin packet metadata');
    const replacement = {
      ...template.snapshot,
      skinBinding: { ...template.snapshot.skinBinding, joints: [Number(f.secondJoint)] },
    };
    Object.assign(template, { snapshot: replacement });
    f.publisher
      .recycle(baseline.packet.revision, renderPublicationTransfers(baseline.packet))
      .unwrap();
    f.world.set(f.first, Skin, { joints: [f.secondJoint] }).unwrap();
    f.publish();
    for (const joint of [f.secondJoint, f.firstJoint]) {
      f.world.set(joint, Transform, { pos: [4, 0, 0] }).unwrap();
      const packet = f.publish();
      expect(changedEntities(packet)).toEqual([]);
      expect([...packet.transformEntities]).toEqual([Number(joint)]);
    }
  } finally {
    f.publisher.dispose();
  }
});
