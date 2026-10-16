import type { Buffer, MappedBuffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRendererObservationCaptureOwner } from '../assembly/webgpu-renderer-observation-owner';

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

it('retires a receipt observation readback only after its pending map completes', async () => {
  const mapStarted = deferred<void>();
  const mapCompleted = deferred<ReturnType<typeof ok<MappedBuffer>>>();
  const mappedBytes = new ArrayBuffer(256);
  const unmap = vi.fn();
  const buffer = {
    mapAsync: async () => {
      mapStarted.resolve();
      return mapCompleted.promise;
    },
  } as unknown as Buffer;
  const texture = {} as Texture;
  const destroyBuffer = vi.fn(() => ok(undefined));
  const device = { destroyBuffer } as unknown as RhiDevice;
  const errors: unknown[] = [];
  const owner = createRendererObservationCaptureOwner((error) => errors.push(error));
  const capture = {
    domain: 'linear-hdr' as const,
    format: 'rgba8unorm' as const,
    device,
    texture,
    buffer,
    frameNumber: 17,
    deviceGeneration: 3,
    graphGeneration: 9,
    backendId: 'null' as const,
    width: 1,
    height: 1,
    bytesPerRow: 256,
  };
  owner.observationCaptureOwner.register(capture);
  expect(owner.observationCaptureOwner.consume(17)).toEqual([capture]);

  const pending = owner.readObservationCapture(capture);
  await mapStarted.promise;
  expect(destroyBuffer).not.toHaveBeenCalled();
  expect(owner.stats).toMatchObject({ liveCount: 1, mapCount: 1, readbackCount: 0 });

  mapCompleted.resolve(
    ok({
      getMappedRange: () => ok(mappedBytes),
      unmap,
    } as unknown as MappedBuffer),
  );
  await expect(pending).resolves.toMatchObject({ ok: true, value: new Uint8Array(256) });
  expect(unmap).toHaveBeenCalledTimes(1);
  expect(destroyBuffer).toHaveBeenCalledTimes(1);
  expect(owner.stats).toMatchObject({ liveCount: 0, mapCount: 1, readbackCount: 1 });
  expect(errors).toEqual([]);
  expect(owner.disposeReceiptObservationCaptures()).toBeUndefined();
  expect(destroyBuffer).toHaveBeenCalledTimes(1);
});
