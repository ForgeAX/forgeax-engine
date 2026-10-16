import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';
import { createSkinPaletteOwner } from '../../assembly/skin-palette-owner';
import { Instances, MeshFilter, MeshRenderer } from '../../components';
import { GlyphText } from '../../components/glyph-text';
import { InstanceProjectionStore } from '../../instances';
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
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'derived-geometry', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene();
  const instances = new InstanceProjectionStore();
  const publish = (palette?: ReturnType<typeof createSkinPaletteOwner>) => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const received = receiver.accept(packet).unwrap();
    const prepared = preparePublicationGeometry(received, scene, palette, assets, instances);
    const frame = scene.consumePublication(prepared);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { packet, frame };
  };
  const spawn = () =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
  return { world, assets, publisher, receiver, scene, instances, publish, spawn };
}
const matrix = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it('derives glyph meshes in the source World and republishes edits under the same mesh handle', () => {
  const f = fixture();
  const font = f.world.allocSharedRef('FontAsset', {
    kind: 'font',
    atlas: AssetGuid.random(),
    sampler: AssetGuid.random(),
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
  });
  const label = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: GlyphText, data: { fontHandle: font, text: 'A', fontSize: 1 } },
    )
    .unwrap();
  const initial = f.publish();
  expect(initial.frame.renderables.map((row) => row.entityKey)).toContain(label);
  const handle = f.world.get(label, MeshFilter).unwrap().assetHandle;
  const mesh = initial.packet.assets.find((row) => row.handle === handle)?.value;
  expect(mesh?.kind).toBe('mesh');
  f.world.set(label, GlyphText, { text: 'AAA' }).unwrap();
  const edited = f.publish();
  expect(f.world.get(label, MeshFilter).unwrap().assetHandle).toBe(handle);
  expect(edited.packet.invalidatedAssets).toContain(handle);
  const next = edited.packet.assets.find((row) => row.handle === handle)?.value;
  expect(
    next?.kind === 'mesh' && mesh?.kind === 'mesh' && next.vertices.length > mesh.vertices.length,
  ).toBe(true);
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
  const initial = required(f.publish().frame.renderables[0]?.instances);
  const moved = matrix();
  moved[12] = 2;
  f.world.set(entity, Instances, { transforms: moved }).unwrap();
  const edited = required(f.publish().frame.renderables[0]?.instances);
  expect(edited.collectionId).toBe(initial.collectionId);
  expect(edited.generations).toEqual(initial.generations);
  expect(edited.revision).toBe(required(initial.revision) + 1);
  f.world
    .set(entity, Instances, { transforms: new Float32Array([...matrix(), ...matrix()]) })
    .unwrap();
  const resized = required(f.publish().frame.renderables[0]?.instances);
  expect(resized.generations?.[0]).not.toBe(initial.generations?.[0]);
  f.world.removeComponent(entity, Instances).unwrap();
  f.publish();
  f.world.addComponent(entity, { component: Instances, data: { transforms: matrix() } }).unwrap();
  const restored = required(f.publish().frame.renderables[0]?.instances);
  expect(restored.collectionId).not.toBe(initial.collectionId);
  f.publisher.dispose();
});

it.each([
  true,
  false,
])('keeps untouched skin palettes and reclaims removed slices (storage=%s)', async (storage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const palette = createSkinPaletteOwner(device, storage);
  const f = fixture();
  const skeleton = f.world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices: matrix(),
  });
  const joint = f.world.spawn({ component: Transform, data: {} }).unwrap();
  const first = f.spawn(),
    second = f.spawn();
  for (const entity of [first, second])
    f.world
      .addComponent(entity, {
        component: Skin,
        data: { skeleton, joints: new Uint32Array([joint]) },
      })
      .unwrap();
  const initial = f.publish(palette).frame;
  const one = required(initial.renderables.find((row) => row.entityKey === first)?.skin);
  const two = required(initial.renderables.find((row) => row.entityKey === second)?.skin);
  expect(one).toBeDefined();
  expect(two).toBeDefined();
  f.world.removeComponent(first, Skin).unwrap();
  const removed = f.publish(palette).frame;
  expect(removed.renderables.find((row) => row.entityKey === first)?.skin).toBeUndefined();
  expect(removed.renderables.find((row) => row.entityKey === second)?.skin?.fence).toBe(two.fence);
  f.world.set(joint, Transform, { pos: [1, 0, 0] }).unwrap();
  const moved = required(
    f.publish(palette).frame.renderables.find((row) => row.entityKey === second)?.skin,
  );
  expect(moved.fence).toBe(two.fence);
  expect(moved.uploadBytes).toBe(64);
  f.world
    .addComponent(first, { component: Skin, data: { skeleton, joints: new Uint32Array([joint]) } })
    .unwrap();
  const restored = required(
    f.publish(palette).frame.renderables.find((row) => row.entityKey === first)?.skin,
  );
  expect(restored.fence).not.toBe(one.fence);
  f.publisher.dispose();
  palette.dispose();
});
