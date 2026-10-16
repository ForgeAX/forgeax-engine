import { describe, expect, it } from 'vitest';
import { createMockGpu } from '../../__tests__/__mocks__/gpu-device';
import { makeRhiDevice } from '../../device';

describe('timestamp query pass descriptor forwarding', () => {
  it('maps an opaque QuerySet in a compute-pass timestampWrites descriptor', async () => {
    const gpu = createMockGpu();
    const adapter = await gpu.requestAdapter();
    if (adapter === null) throw new Error('mock adapter should exist');
    const raw = await adapter.requestDevice();
    (raw.features as unknown as Set<GPUFeatureName>).add('timestamp-query');
    let rawQuerySet: unknown;
    const originalCreateQuerySet = raw.createQuerySet.bind(raw);
    raw.createQuerySet = (descriptor) => {
      const result = originalCreateQuerySet(descriptor);
      rawQuerySet = result;
      return result;
    };
    let captured: GPUComputePassDescriptor | undefined;
    const originalCreateCommandEncoder = raw.createCommandEncoder.bind(raw);
    raw.createCommandEncoder = (descriptor) => {
      const encoder = originalCreateCommandEncoder(descriptor) as unknown as Record<
        string,
        unknown
      >;
      const originalBegin = encoder.beginComputePass as (
        passDescriptor?: GPUComputePassDescriptor,
      ) => unknown;
      encoder.beginComputePass = (passDescriptor?: GPUComputePassDescriptor) => {
        captured = passDescriptor;
        return originalBegin.call(encoder, passDescriptor);
      };
      return encoder as unknown as ReturnType<typeof raw.createCommandEncoder>;
    };
    const { device } = makeRhiDevice(raw as unknown as GPUDevice);
    const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    expect(querySet.ok).toBe(true);
    if (!querySet.ok) return;
    const encoder = device.createCommandEncoder();
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    const pass = encoder.value.beginComputePass({
      label: 'timestamp-pass',
      timestampWrites: {
        querySet: querySet.value,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    pass.end();
    expect(captured).toMatchObject({
      label: 'timestamp-pass',
      timestampWrites: {
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    expect(rawQuerySet).toBeDefined();
    expect(captured?.timestampWrites?.querySet).toBe(rawQuerySet);
  });

  it('maps an opaque QuerySet in a render-pass timestampWrites descriptor', async () => {
    const gpu = createMockGpu();
    const adapter = await gpu.requestAdapter();
    if (adapter === null) throw new Error('mock adapter should exist');
    const raw = await adapter.requestDevice();
    (raw.features as unknown as Set<GPUFeatureName>).add('timestamp-query');
    let captured: GPURenderPassDescriptor | undefined;
    const originalCreateCommandEncoder = raw.createCommandEncoder.bind(raw);
    raw.createCommandEncoder = (descriptor) => {
      const encoder = originalCreateCommandEncoder(descriptor) as unknown as Record<
        string,
        unknown
      >;
      const originalBegin = encoder.beginRenderPass as (
        passDescriptor: GPURenderPassDescriptor,
      ) => unknown;
      encoder.beginRenderPass = (passDescriptor: GPURenderPassDescriptor) => {
        captured = passDescriptor;
        return originalBegin.call(encoder, passDescriptor);
      };
      return encoder as unknown as ReturnType<typeof raw.createCommandEncoder>;
    };
    const { device } = makeRhiDevice(raw as unknown as GPUDevice);
    const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    expect(querySet.ok).toBe(true);
    if (!querySet.ok) return;
    const texture = device.createTexture({
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: 0x10,
    });
    expect(texture.ok).toBe(true);
    if (!texture.ok) return;
    const view = device.createTextureView(texture.value, {});
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const encoder = device.createCommandEncoder();
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    const pass = encoder.value.beginRenderPass({
      label: 'timestamp-raster',
      colorAttachments: [{ view: view.value, loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: {
        querySet: querySet.value,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    pass.end();
    expect(captured).toMatchObject({
      label: 'timestamp-raster',
      timestampWrites: {
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      },
    });
    expect(captured?.timestampWrites?.querySet).toBeDefined();
  });
});
