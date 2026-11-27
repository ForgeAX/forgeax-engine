import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { Camera, MeshFilter, MeshRenderer, perspective } from '../../components';
import { Materials } from '../../materials';
import { CanvasTexture, isCanvasTextureSource } from '../../textures/canvas-texture';
import { renderTextureSourceKey } from '../../textures/source-token';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

it.each([
  false,
  true,
])('publishes shared canvas frames and retires owned clones with snapshot %s', (snapshot) => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const cubeMesh = assets.create(BUILTIN_CUBE).unwrap();
  const identity = { source: 'canvas-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity),
    receiver = new RenderPublicationReceiver(identity);
  const canvas = new OffscreenCanvas(8, 8),
    ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Canvas 2D context unavailable');
  ctx.fillStyle = 'red';
  ctx.fillRect(0, 0, 8, 8);
  const texture = new CanvasTexture(canvas, { snapshot });
  const material = assets
    .create(
      Materials.unlit([1, 1, 1, 1], {
        baseColorTexture: { source: texture.source },
      }),
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3] } },
      { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
    )
    .unwrap();
  const addConsumer = (x: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: cubeMesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const entities = [0, 1].map(addConsumer);
  world.update(0).unwrap();
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return accepted;
  };
  try {
    const initial = publish();
    expect(initial.packet.canvasFrames).toHaveLength(1);
    expect(initial.packet.templates).toHaveLength(1);
    const token = initial.frame.renderables
      .at(0)
      ?.material.snapshot.textureSources?.get('baseColorTexture');
    expect(isCanvasTextureSource(token)).toBe(true);
    const id = renderTextureSourceKey(texture.source);
    const first = initial.resources.canvasFrame?.(id);
    expect(first?.frame?.displayWidth).toBe(8);
    if (first?.frame === undefined) throw new Error('Canvas frame missing');
    const frame = first.frame,
      key = first.key;
    receiver.releaseVideoFrames();
    expect(frame.displayWidth).toBe(snapshot ? 8 : 0);
    const unchanged = publisher.prepare(0).unwrap();
    if (snapshot) {
      const rows = unchanged.packet.canvasFrames;
      const row = rows?.[0];
      expect(row?.snapshot).toBe('reuse');
      expect(row?.frame).toBeUndefined();
      if (row === undefined) throw new Error('Canvas reference missing');
      for (const edit of [
        { version: row.version + 1 },
        { flipY: !row.flipY },
        { id: 'unknown' },
        { disposed: true },
      ]) {
        expect(
          receiver.accept(
            encodeRenderPublication({
              ...unchanged.packet,
              canvasFrames: [{ ...row, ...edit }],
            }),
          ).ok,
        ).toBe(false);
      }
      expect(receiver.acceptedRevision).toBe(1);
      expect(initial.resources.canvasFrame?.(id)?.frame).toBe(frame);
    } else {
      expect(unchanged.packet.canvasFrames?.[0]?.frame?.displayWidth).toBe(8);
    }
    unchanged.discard();
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, 8, 8);
    texture.update();
    const dropped = publisher.prepare(0).unwrap();
    const discardedPixels = dropped.packet.canvasFrames?.[0]?.frame;
    expect(discardedPixels?.displayWidth).toBe(8);
    dropped.discard();
    expect(discardedPixels?.displayWidth).toBe(0);
    const updated = publish();
    const newFrame = updated.resources.canvasFrame?.(id)?.frame;
    if (newFrame === undefined) throw new Error('Updated Canvas pixels missing');
    expect(newFrame.timestamp).toBe(2);
    const sample = new OffscreenCanvas(1, 1).getContext('2d');
    if (sample === null) throw new Error('Canvas readback unavailable');
    sample.drawImage(newFrame, 0, 0, 1, 1);
    expect([...sample.getImageData(0, 0, 1, 1).data]).toEqual([0, 0, 255, 255]);
    expect(updated.packet.upserts.length).toBe(0);
    expect(updated.packet.canvasFrames?.[0]?.version).toBe(2);
    expect(updated.resources.canvasFrame?.(id)?.key).toBe(key);
    expect(frame.displayWidth).toBe(0);
    const candidate = publisher.prepare(0).unwrap();
    const malformed = structuredClone(candidate.packet);
    const rows = malformed.canvasFrames;
    if (rows?.[0] === undefined) throw new Error('Canvas publication missing');
    expect(
      receiver.accept(encodeRenderPublication({ ...malformed, canvasFrames: [rows[0], rows[0]] }))
        .ok,
    ).toBe(false);
    expect(receiver.acceptedRevision).toBe(2);
    for (const row of rows) row.frame?.close();
    candidate.discard();
    const signal = updated.resources.canvasFrame?.(id)?.signal;
    canvas.width = 0;
    if (snapshot) {
      expect(() => texture.update()).toThrow();
      const sealed = publish();
      expect(sealed.packet.canvasFrames?.[0]?.snapshot).toBe('reuse');
      expect(sealed.resources.canvasFrame?.(id)?.frame).toBe(newFrame);
    } else {
      expect(publish().packet.canvasFrames?.[0]?.frame).toBeUndefined();
    }
    expect(signal?.aborted).toBe(false);
    canvas.width = 8;
    texture.update();
    expect(publish().resources.canvasFrame?.(id)?.frame?.displayWidth).toBe(8);
    for (const entity of entities) world.despawn(entity).unwrap();
    world.update(0).unwrap();
    expect(publish().resources.canvasFrame?.(id)).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    const returning = addConsumer(0);
    world.update(0).unwrap();
    const reopened = publish();
    const reopenedState = reopened.resources.canvasFrame?.(id);
    const reopenedFrame = reopenedState?.frame;
    expect(reopenedFrame?.displayWidth).toBe(8);
    expect(reopenedState?.key).not.toBe(key);
    texture.dispose();
    const disposed = publish();
    expect(disposed.packet.canvasFrames?.[0]?.frame).toBeUndefined();
    expect(reopenedState?.signal.aborted).toBe(true);
    expect(reopenedFrame?.displayWidth).toBe(0);
    world.despawn(returning).unwrap();
    world.update(0).unwrap();
    expect(publish().resources.canvasFrame?.(id)).toBeUndefined();
  } finally {
    receiver.dispose();
    publisher.dispose();
    texture.dispose();
    assets.dispose();
  }
});
