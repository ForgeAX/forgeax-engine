import type { Buffer, MappedBuffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { runDeliverFeatureSourceCompletion } from '../assembly/renderer-frame-operations';
import { projectReceiptColorObservations } from '../assembly/webgpu-renderer-observation';
import { createRendererObservationCaptureOwner } from '../assembly/webgpu-renderer-observation-owner';
import type { FrameReceipt, RenderPipelineObservationCapture } from '../render-contract';

it('releases automatic completed receipt roots while an externally held receipt can reread', async () => {
  const owner = createRendererObservationCaptureOwner((error) => {
    throw error;
  });
  let held: FrameReceipt | undefined;
  let heldBytes: Uint8Array | undefined;
  for (let frameId = 1; frameId <= 60; frameId++) {
    const receipt: FrameReceipt = {
      frameId,
      deviceGeneration: 0,
      presentation: 'ready',
      backendId: 'null',
      completed: Promise.resolve(ok(undefined)),
    };
    const data = new ArrayBuffer(256);
    new Uint8Array(data)[0] = frameId;
    const capture: RenderPipelineObservationCapture = {
      domain: 'feature-texture',
      featureTexture: { featureIdentity: 'water', name: 'height', targetName: 'height' },
      format: 'r32float',
      device: { destroyBuffer: () => ok(undefined) } as unknown as RhiDevice,
      texture: {} as Texture,
      buffer: {
        mapAsync: async () => ok({ getMappedRange: () => ok(data), unmap() {} }),
      } as unknown as Buffer,
      frameNumber: frameId,
      deviceGeneration: 0,
      graphGeneration: 1,
      backendId: 'null',
      width: 1,
      height: 1,
      bytesPerRow: 256,
    };
    owner.observationCaptureOwner.register(capture);
    const read = owner.registerReceiptReads(
      receipt,
      owner.observationCaptureOwner.consume(frameId),
    );
    const result = await read();
    if (!result.ok) throw result.error;
    if (frameId === 1) {
      held = receipt;
      heldBytes = result.value.captures[0]?.bytes;
    }
    expect(owner.receiptObservationBuffers.size).toBe(0);
  }
  if (held === undefined) throw new Error('Missing held receipt');
  const read = owner.receiptObservationCaptures.get(held);
  if (read === undefined) throw new Error('Missing externally held observation');
  const result = await read();
  if (!result.ok) throw result.error;
  expect(result.value.captures[0]?.bytes).toBe(heldBytes);
  expect(heldBytes?.[0]).toBe(1);
  expect(owner.stats.liveCount).toBe(0);
});

it('holds a pending map and retains failed cleanup independently of its completed receipt', async () => {
  const mapping = deferred<ReturnType<typeof ok<MappedBuffer>>>();
  const cleanupError = new RhiError({
    code: 'webgpu-runtime-error',
    expected: 'destroy buffer',
    hint: 'retry cleanup',
  });
  let cleanupFails = true;
  const errors: unknown[] = [];
  const owner = createRendererObservationCaptureOwner((error) => errors.push(error));
  const receipt: FrameReceipt = {
    frameId: 91,
    deviceGeneration: 0,
    presentation: 'ready',
    backendId: 'null',
    completed: Promise.resolve(ok(undefined)),
  };
  const capture: RenderPipelineObservationCapture = {
    domain: 'feature-texture',
    featureTexture: { featureIdentity: 'water', name: 'height', targetName: 'height' },
    format: 'r32float',
    device: {
      destroyBuffer: () => (cleanupFails ? err(cleanupError) : ok(undefined)),
    } as unknown as RhiDevice,
    texture: {} as Texture,
    buffer: { mapAsync: () => mapping.promise } as unknown as Buffer,
    frameNumber: 91,
    deviceGeneration: 0,
    graphGeneration: 1,
    backendId: 'null',
    width: 1,
    height: 1,
    bytesPerRow: 256,
  };
  owner.observationCaptureOwner.register(capture);
  const read = owner.registerReceiptReads(receipt, owner.observationCaptureOwner.consume(91));
  const pending = read();
  await Promise.resolve();
  expect(owner.receiptObservationBuffers.size).toBe(1);
  expect(owner.stats.liveCount).toBe(1);
  mapping.resolve(
    ok({ getMappedRange: () => ok(new ArrayBuffer(256)), unmap() {} } as unknown as MappedBuffer),
  );
  expect((await pending).ok).toBe(false);
  expect(owner.receiptObservationBuffers.size).toBe(0);
  expect(owner.failedObservationCaptures.has(capture.buffer)).toBe(true);
  expect(errors.length).toBeGreaterThan(0);
  cleanupFails = false;
  expect(owner.disposeReceiptObservationCaptures()).toBeUndefined();
  expect(owner.failedObservationCaptures.size).toBe(0);
  expect(owner.stats.liveCount).toBe(0);
});

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
    const read = owner.registerReceiptReads(
      receipt,
      owner.observationCaptureOwner.consume(capture.frameNumber),
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
  expect(
    owner.receiptObservationBuffers.size,
    'unread explicit receipts retain admission credit',
  ).toBe(4);
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
