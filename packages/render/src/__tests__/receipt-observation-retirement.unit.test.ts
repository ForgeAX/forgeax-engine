import type { Buffer, MappedBuffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  runDeliverFeatureSourceCompletion,
  runRegisterObservationReads,
} from '../assembly/renderer-frame-operations';
import { projectReceiptColorObservations } from '../assembly/webgpu-renderer-observation';
import { createRendererObservationCaptureOwner } from '../assembly/webgpu-renderer-observation-owner';
import type { FrameReceipt, RenderPipelineObservationCapture } from '../render-contract';

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

it('keeps four unread receipt copies after source completion retires their physical readbacks', async () => {
  const owner = createRendererObservationCaptureOwner((error) => {
    throw error;
  });
  const pendingMaps = Array.from({ length: 4 }, () =>
    deferred<ReturnType<typeof ok<MappedBuffer>>>(),
  );
  const device = { destroyBuffer: vi.fn(() => ok(undefined)) } as unknown as RhiDevice;
  const captures = pendingMaps.map(
    (map, index): RenderPipelineObservationCapture => ({
      domain: 'visible-surface',
      format: 'rgba32uint',
      frameNumber: index + 1,
      deviceGeneration: 0,
      graphGeneration: 1,
      backendId: 'null',
      width: 64,
      height: 64,
      bytesPerRow: 1024,
      device,
      texture: {} as Texture,
      buffer: { mapAsync: () => map.promise } as unknown as Buffer,
    }),
  );
  const reads = captures.map((capture, index) => {
    owner.observationCaptureOwner.register(capture);
    const receipt: FrameReceipt = {
      frameId: index + 1,
      deviceGeneration: 0,
      graphGeneration: 1,
      backendId: 'null',
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    };
    const read = runRegisterObservationReads(
      owner.disposeObservationCaptures,
      owner.readObservationCapture,
      owner.observationCaptureOwner,
      owner.receiptObservationBuffers,
      owner.receiptObservationCaptures,
      receipt,
      { captures: [capture], graphGenerations: [1] },
      receipt.completed,
    );
    runDeliverFeatureSourceCompletion(
      () => {},
      owner.observationCaptureOwner,
      receipt as Parameters<typeof runDeliverFeatureSourceCompletion>[2],
      receipt.completed,
      read,
      { device: { caps: { backendKind: 'null' } } } as Parameters<
        typeof runDeliverFeatureSourceCompletion
      >[5],
    );
    return read;
  });
  expect(owner.stats).toMatchObject({
    allocationCount: 4,
    liveCount: 4,
    liveByteLength: 4 * 65536,
  });
  for (const [index, map] of pendingMaps.entries()) {
    const bytes = new Uint8Array(65536).fill(index + 1);
    map.resolve(
      ok({ getMappedRange: () => ok(bytes.buffer), unmap: vi.fn() } as unknown as MappedBuffer),
    );
    const read = await reads[index]?.();
    expect(read?.ok).toBe(true);
    if (read?.ok) expect(read.value.captures[0]?.bytes).toEqual(bytes);
    expect(owner.stats.liveCount + owner.stats.readbackCount).toBe(4);
    expect(owner.stats.liveByteLength).toBe(owner.stats.liveCount * 65536);
  }
  expect(owner.stats).toMatchObject({
    liveCount: 0,
    liveByteLength: 0,
    mapCount: 4,
    readbackCount: 4,
  });
  for (const [index, read] of reads.entries()) {
    const retained = await read();
    expect(retained.ok).toBe(true);
    if (retained.ok) expect(retained.value.captures[0]?.bytes[0]).toBe(index + 1);
  }
  expect(owner.stats).toMatchObject({ mapCount: 4, readbackCount: 4 });
  expect(device.destroyBuffer).toHaveBeenCalledTimes(4);
});

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
  expect(owner.observationCaptureOwner.consume(17).captures).toEqual([capture]);

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

it('keeps shared, view and compositor captures inside the submitted frame graph closure', () => {
  const owner = createRendererObservationCaptureOwner((error) => {
    throw error;
  });
  const receipt: FrameReceipt = {
    frameId: 17,
    deviceGeneration: 3,
    presentation: 'ready',
    backendId: 'null',
    graphGeneration: 11,
    completed: Promise.resolve(ok(undefined)),
  };
  const captures = [5, 7, 11].map(
    (graphGeneration, index): RenderPipelineObservationCapture => ({
      domain: index === 0 ? 'feature-texture' : index === 1 ? 'linear-hdr' : 'final-display',
      ...(index === 0
        ? { featureTexture: { featureIdentity: 'shared', name: 'field', targetName: 'field' } }
        : {}),
      format: 'rgba8unorm',
      device: {} as RhiDevice,
      texture: {} as Texture,
      buffer: {} as Buffer,
      frameNumber: 17,
      deviceGeneration: 3,
      graphGeneration,
      backendId: 'null',
      width: 1,
      height: 1,
      bytesPerRow: 256,
    }),
  );
  owner.observationCaptureOwner.recordGraph(16, 2);
  for (const capture of captures) {
    owner.observationCaptureOwner.register(capture);
    owner.observationCaptureOwner.recordGraph(17, capture.graphGeneration);
  }
  const frame = owner.observationCaptureOwner.consume(17);
  const read = frame.captures.map((capture) => ({ capture, bytes: new Uint8Array(256) }));
  const domains = ['feature-texture', 'linear-hdr', 'final-display'] as const;
  const observed = projectReceiptColorObservations(
    receipt,
    read,
    domains,
    'null',
    frame.graphGenerations,
  );
  if (!observed.ok) throw observed.error;
  expect(observed.value.map((value) => value.metadata)).toMatchObject([
    { frameId: 17, deviceGeneration: 3, graphGeneration: 5 },
    { frameId: 17, deviceGeneration: 3, graphGeneration: 7 },
    { frameId: 17, deviceGeneration: 3, graphGeneration: 11 },
  ]);
  for (const invalid of [
    { graphGeneration: 2 },
    { graphGeneration: 99 },
    { frameNumber: 16 },
    { deviceGeneration: 2 },
    { backendId: 'webgpu' },
  ]) {
    const bad = read.map((value, index) =>
      index === 0 ? { ...value, capture: { ...value.capture, ...invalid } } : value,
    );
    expect(
      projectReceiptColorObservations(receipt, bad, domains, 'null', frame.graphGenerations).ok,
    ).toBe(false);
  }
  expect(owner.observationCaptureOwner.consume(17)).toEqual({ captures: [], graphGenerations: [] });
  expect(owner.observationCaptureOwner.consume(16).graphGenerations).toEqual([2]);
});
