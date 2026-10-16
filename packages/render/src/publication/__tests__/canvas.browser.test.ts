import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { Materials } from '../../materials';
import { CanvasTexture, isCanvasTextureSource } from '../../textures/canvas-texture';
import { renderPublicationTransfers } from '../contract';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

it('publishes one native canvas frame for shared models, updates without ECS writes, and retires owned clones', () => {
  const world = new World(),
    assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'canvas-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity),
    receiver = new RenderPublicationReceiver(identity);
  const canvas = new OffscreenCanvas(8, 8),
    ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 8, 8);
  const texture = new CanvasTexture(canvas);
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.unlit([1, 1, 1, 1], {
      baseColorTexture: world.allocSharedRef('CanvasTextureSource', texture.source),
    }),
  );
  world
    .spawn({ component: Transform, data: { pos: [0, 0, 3] } }, { component: Camera, data: {} })
    .unwrap();
  const entities = [0, 1].map((x) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap(),
  );
  world.update(0).unwrap();
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return accepted;
  };
  try {
    const initial = publish();
    expect(initial.packet.canvasFrames).toHaveLength(1);
    expect(initial.packet.templates).toHaveLength(1);
    const token = initial.frame.renderables[0]?.material.textureSources?.get('baseColorTexture');
    expect(isCanvasTextureSource(token)).toBe(true);
    const id = texture.source.canvasTextureId;
    const first = initial.resources.canvasFrame?.(id);
    expect(first?.frame?.displayWidth).toBe(8);
    if (first?.frame === undefined) throw new Error('Canvas frame missing');
    const frame = first.frame,
      key = first.key;
    texture.update();
    const updated = publish();
    expect(updated.packet.upserts.length).toBe(0);
    expect(updated.packet.canvasFrames?.[0]?.version).toBe(2);
    expect(updated.resources.canvasFrame?.(id)?.key).toBe(key);
    expect(frame.displayWidth).toBe(0);
    const candidate = publisher.prepare(0).unwrap();
    const malformed = structuredClone(candidate.packet);
    const rows = malformed.canvasFrames;
    if (rows?.[0] === undefined) throw new Error('Canvas publication missing');
    expect(receiver.accept({ ...malformed, canvasFrames: [rows[0], rows[0]] }).ok).toBe(false);
    expect(receiver.acceptedRevision).toBe(2);
    for (const row of rows) row.frame?.close();
    candidate.discard();
    const signal = updated.resources.canvasFrame?.(id)?.signal;
    canvas.width = 0;
    expect(publish().packet.canvasFrames?.[0]?.frame).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    canvas.width = 8;
    texture.update();
    expect(publish().resources.canvasFrame?.(id)?.frame?.displayWidth).toBe(8);
    texture.dispose();
    const disposed = publish();
    expect(disposed.packet.canvasFrames?.[0]?.frame).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    for (const entity of entities) world.despawn(entity).unwrap();
    world.update(0).unwrap();
    expect(publish().resources.canvasFrame?.(id)).toBeUndefined();
  } finally {
    receiver.dispose();
    publisher.dispose();
    texture.dispose();
  }
});
