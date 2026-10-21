import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { DEFAULT_MSDF_TEXT_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { assert, expect, it } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { GlyphText } from '../components/glyph-text';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

it.each([
  'local',
  'worker',
] as const)('adopts Font content without rewriting labels (%s)', (mode) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  assets.shaderRegistry.installMaterialArtifact('forgeax::msdf-text', {
    source: 'fn main() {}',
    paramSchema: DEFAULT_MSDF_TEXT_PARAM_SCHEMA,
  });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const atlas = assets
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: new Uint8Array([255, 255, 255, 255]),
    })
    .unwrap();
  const sampler = assets
    .create({ kind: 'sampler', minFilter: 'linear', magFilter: 'linear' })
    .unwrap();
  const font = assets
    .create({
      kind: 'font',
      atlas,
      sampler,
      glyphs: {
        65: {
          advance: 1,
          bearingX: 0,
          bearingY: 0,
          size: { w: 1, h: 1 },
          region: { x: 0, y: 0, w: 1, h: 1 },
        },
      },
      common: {
        lineHeight: 1,
        base: 0,
        distanceRange: 1,
        pxRange: 1,
        atlasWidth: 1,
        atlasHeight: 1,
      },
    })
    .unwrap();
  const camera = world
    .spawn({ component: Transform, data: { pos: [0, 0, 5] } }, { component: Camera, data: {} })
    .unwrap();
  const labels = Array.from({ length: 128 }, () =>
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: GlyphText,
          data: { fontHandle: font, text: 'AA', fontSize: 1, color: [1, 0, 0, 1] },
        },
      )
      .unwrap(),
  );
  const lease = createRenderReadLease(world);
  const scene = new PersistentRenderScene({ assets });
  const owner = { cameraOwner: 0, resourceOwner: 0 };
  const identity = { source: 'glyph-test', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  let extractions = 0,
    upserts = 0;
  const draw = () => {
    world.update(0).unwrap();
    if (mode === 'worker') {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet);
      candidate.accept();
      upserts += packet.upserts.length;
      const result = scene.consumePublication(receiver.accept(packet).unwrap());
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      return result;
    }
    return scene.extractComposition(
      [world],
      owner,
      assets,
      (request) => {
        if (typeof request === 'object')
          for (const entities of request.entitiesByWorld) extractions += entities?.size ?? 0;
        else if (request === 'full') extractions += labels.length;
        return extractFrames(
          [world],
          owner,
          assets,
          undefined,
          scene.materialSnapshotCacheStore(),
          {
            cull: 'none',
            retainHidden: true,
            renderables: request,
          },
        );
      },
      [lease],
    );
  };
  try {
    draw();
    const before = draw();
    expect(before.renderables).toHaveLength(labels.length);
    const first = before.renderables.at(0);
    assert(first?.generatedMesh);
    expect(new Set(before.renderables.map((row) => row.generatedMesh)).size).toBe(1);
    expect(new Set(before.renderables.map((row) => row.material)).size).toBe(1);
    expect(
      labels.every(
        (entity) =>
          !world.hasComponent(entity, MeshFilter) && !world.hasComponent(entity, MeshRenderer),
      ),
    ).toBe(true);
    expect(first.assetHandle).toBeUndefined();
    const retained = first.generatedMesh.vertices.slice();
    extractions = 0;
    upserts = 0;
    assets
      .update(font, {
        glyphs: {
          65: {
            advance: 2,
            bearingX: 0,
            bearingY: 0,
            size: { w: 2, h: 1 },
            region: { x: 0, y: 0, w: 1, h: 1 },
          },
        },
      })
      .unwrap();
    const after = draw();
    expect(extractions).toBe(0);
    expect(upserts).toBe(0);
    expect(after.renderables.at(0)?.generatedMesh).not.toBe(first.generatedMesh);
    expect(first.generatedMesh.vertices).toEqual(retained);
    expect(after.renderables.at(0)?.localAabb?.[3]).toBeGreaterThan(first.localAabb?.[3] ?? 0);
    const mesh = after.renderables.at(0)?.generatedMesh;
    const label = labels[0];
    assert(label !== undefined);
    world.set(label, GlyphText, { color: [0, 1, 0, 1] }).unwrap();
    const tinted = draw();
    expect(tinted.renderables.at(0)?.generatedMesh).toBe(mesh);
    expect(tinted.renderables.at(0)?.material.snapshot.paramSnapshot?.tintColor).toEqual([
      0, 1, 0, 1,
    ]);
    const observer = runtimeAssets(assets).observe().unwrap();
    const current = observer.read().unwrap();
    current.accept();
    draw();
    expect(observer.read().unwrap().changes).toHaveLength(0);
    observer.dispose();
    expect(world.get(camera, Camera).ok).toBe(true);
  } finally {
    scene.dispose();
    publisher.dispose();
    receiver.dispose();
    lease.dispose();
    assets.dispose();
  }
});
