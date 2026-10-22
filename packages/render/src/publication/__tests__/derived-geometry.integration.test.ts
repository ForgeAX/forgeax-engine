import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';
import { samplerContribution } from '../../assets/asset-decoders';
import { Instances, MeshFilter, MeshRenderer } from '../../components';
import { GlyphText } from '../../components/glyph-text';
import { InstanceProjectionStore } from '../../instances';
import { Materials } from '../../materials';
import { SkinTasks } from '../../record/skin-tasks';
import { PersistentRenderScene } from '../../scene/render-scene';
import { renderPublicationTransfers } from '../contract';
import { preparePublicationGeometry } from '../prepare-geometry';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing expected render projection');
  return value;
}

function fixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
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
  const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  const identity = { source: 'derived-geometry', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const instances = new InstanceProjectionStore();
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const received = receiver.accept(packet).unwrap();
    const prepared = preparePublicationGeometry(received, assets, instances);
    const frame = scene.consumePublication(prepared);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { packet, frame };
  };
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: cube } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  return { world, assets, publisher, receiver, scene, instances, publish, spawn };
}
const matrix = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it('publishes authored GlyphText edits through a stable Font without writing Mesh components', () => {
  const f = fixture();
  const atlas = f.assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      shape: { viewDimension: '2d', extent: { width: 8, height: 8 } },
      data: new Uint8Array(8 * 8 * 4),
    })
    .unwrap();
  const sampler = f.assets.create({ kind: 'sampler' }).unwrap();
  const font = f.assets
    .create({
      kind: 'font',
      atlas,
      sampler,
      glyphs: {
        65: {
          advance: 10,
          bearingX: 0,
          bearingY: 8,
          size: { w: 8, h: 8 },
          region: { x: 0, y: 0, w: 8, h: 8 },
        },
      },
      common: {
        lineHeight: 12,
        base: 8,
        distanceRange: 4,
        pxRange: 4,
        atlasWidth: 8,
        atlasHeight: 8,
      },
    })
    .unwrap();
  const label = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: GlyphText, data: { fontHandle: font, text: 'A', fontSize: 1 } },
    )
    .unwrap();
  const initial = f.publish();
  expect(initial.frame.renderables.map((row) => row.entityKey)).toContain(label);
  expect(f.world.hasComponent(label, MeshFilter)).toBe(false);
  expect(initial.frame.renderables.find((row) => row.entityKey === label)?.glyph).toMatchObject({
    font,
    text: 'A',
  });
  f.world.set(label, GlyphText, { text: 'AAA' }).unwrap();
  const edited = f.publish();
  expect(f.world.hasComponent(label, MeshFilter)).toBe(false);
  expect(edited.frame.renderables.find((row) => row.entityKey === label)?.glyph).toMatchObject({
    font,
    text: 'AAA',
  });
  expect(edited.packet.assets).toEqual([]);
  f.publisher.dispose();
  const later = f.world
    .spawn({ component: GlyphText, data: { fontHandle: font, text: 'A' } })
    .unwrap();
  f.world.update(0).unwrap();
  expect(f.world.hasComponent(later, MeshFilter)).toBe(false);
});

it('retains instance history on pose edits and retires it across removal and topology changes', () => {
  const f = fixture();
  const entity = f.spawn();
  f.world.addComponent(entity, { component: Instances, data: { transforms: matrix() } }).unwrap();
  const initial = required(f.publish().frame.renderables.at(0)?.instances);
  const moved = matrix();
  moved[12] = 2;
  f.world.set(entity, Instances, { transforms: moved }).unwrap();
  const edited = required(f.publish().frame.renderables.at(0)?.instances);
  expect(edited.collectionId).toBe(initial.collectionId);
  expect(edited.generations).toEqual(initial.generations);
  expect(edited.revision).toBe(required(initial.revision) + 1);
  f.world
    .set(entity, Instances, { transforms: new Float32Array([...matrix(), ...matrix()]) })
    .unwrap();
  const resized = required(f.publish().frame.renderables.at(0)?.instances);
  expect(resized.generations?.[0]).not.toBe(initial.generations?.[0]);
  f.world.removeComponent(entity, Instances).unwrap();
  f.publish();
  f.world.addComponent(entity, { component: Instances, data: { transforms: matrix() } }).unwrap();
  const restored = required(f.publish().frame.renderables.at(0)?.instances);
  expect(restored.collectionId).not.toBe(initial.collectionId);
  f.publisher.dispose();
});

it.each([
  true,
  false,
])('keeps untouched Skin membership and resolves current tasks after removal/restoration (storage=%s)', async (storage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const tasks = new SkinTasks(device, storage);
  const f = fixture();
  const skinMaterial = f.assets
    .create({
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'forgeax::pbr-skin' } }],
    })
    .unwrap();
  const skeleton = f.assets
    .create({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: matrix(),
    })
    .unwrap();
  const joint = f.world.spawn({ component: Transform, data: {} }).unwrap();
  const first = f.spawn(),
    second = f.spawn();
  for (const entity of [first, second]) {
    f.world.set(entity, MeshRenderer, { materials: [skinMaterial] }).unwrap();
    f.world
      .addComponent(entity, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
  }
  try {
    const initial = f.publish().frame;
    const one = required(initial.renderables.find((row) => row.entityKey === first)?.skinBinding);
    const two = required(initial.renderables.find((row) => row.entityKey === second)?.skinBinding);
    const initialFrame = required(f.scene.skinRecordingFrame());
    tasks.begin(initialFrame);
    // Each one-joint demand uploads one current and one previous matrix.
    expect(tasks.demand(required(f.scene.compositionSlot(0, first)))).toBeDefined();
    expect(tasks.paletteUploadBytes).toBe(128);
    expect(tasks.demand(required(f.scene.compositionSlot(0, second)))).toBeDefined();
    expect(tasks.paletteUploadBytes).toBe(256);
    await tasks.complete();
    f.world.removeComponent(first, Skin).unwrap();
    f.world.set(first, MeshRenderer, { materials: [] }).unwrap();
    const removed = f.publish().frame;
    expect(removed.renderables.find((row) => row.entityKey === first)?.skinBinding).toBeUndefined();
    expect(removed.renderables.find((row) => row.entityKey === second)?.skinBinding).toBe(two);
    f.world.set(joint, Transform, { pos: [1, 0, 0] }).unwrap();
    const moved = f.publish();
    expect(moved.packet.upserts).toHaveLength(0);
    expect([...moved.packet.transformEntities]).toEqual([Number(joint)]);
    expect(moved.frame.renderables.find((row) => row.entityKey === second)?.skinBinding).toBe(two);
    const frame = required(f.scene.skinRecordingFrame()),
      slot = required(f.scene.compositionSlot(0, second));
    tasks.begin(frame);
    required(tasks.demand(slot));
    expect(tasks.paletteUploadBytes).toBe(128);
    await tasks.complete();
    f.world
      .addComponent(first, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
    f.world.set(first, MeshRenderer, { materials: [skinMaterial] }).unwrap();
    const restored = f.publish().frame;
    expect(restored.renderables.find((row) => row.entityKey === first)?.skinBinding).toEqual(one);
    expect(restored.renderables.find((row) => row.entityKey === second)?.skinBinding).toBe(two);
  } finally {
    await tasks.dispose();
    f.scene.dispose();
    f.instances.dispose();
    f.receiver.dispose();
    f.publisher.dispose();
  }
});
