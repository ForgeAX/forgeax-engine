import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

it('owns accepted native frames, rejecting duplicates and closed frames before changing revision', () => {
  const identity = { source: 'native-video-lifetime', epoch: 1 };
  const publisher = createRenderPublisher(
    new World(),
    new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
    identity,
  );
  const candidate = publisher.prepare(0).unwrap();
  const receiver = new RenderPublicationReceiver(identity);
  const canvas = new OffscreenCanvas(4, 4);
  canvas.getContext('2d')?.fillRect(0, 0, 4, 4);
  const source = new VideoFrame(canvas, { timestamp: 0 });
  const first = source.clone(),
    next = source.clone(),
    closed = source.clone();
  closed.close();
  const row = { entity: 1, clip: 2, frame: first };
  try {
    expect(
      receiver.accept({ ...candidate.packet, videoFrames: [row, { ...row, frame: next }] }).ok,
    ).toBe(false);
    expect(receiver.acceptedRevision).toBe(0);
    const accepted = receiver.accept({ ...candidate.packet, videoFrames: [row] }).unwrap();
    expect(accepted.resources.videoFrame(1, 2)).toBe(first);
    const second = { ...candidate.packet, baseline: false, revision: 2, base: 1 };
    expect(receiver.accept({ ...second, videoFrames: [{ ...row, frame: closed }] }).ok).toBe(false);
    expect(receiver.acceptedRevision).toBe(1);
    expect(first.displayWidth).toBe(4);
    receiver.accept({ ...second, videoFrames: [{ ...row, frame: next }] }).unwrap();
    expect(first.displayWidth).toBe(0);
    receiver.dispose();
    expect(next.displayWidth).toBe(0);
    expect(source.displayWidth).toBe(4);
  } finally {
    receiver.dispose();
    candidate.discard();
    publisher.dispose();
    source.close();
    first.close();
    next.close();
    closed.close();
  }
});
