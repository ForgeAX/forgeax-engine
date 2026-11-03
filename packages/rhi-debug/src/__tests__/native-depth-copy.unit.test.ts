import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { isDepth32FloatCopySource, readbackDepthTexture } from '../readback-depth';

it.each([
  { width: 3, backendKind: 'webgpu', copySource: true, direct: true },
  { width: 64, backendKind: 'webgpu', copySource: true, direct: true },
  { width: 3, backendKind: 'wgpu-native', copySource: true, direct: true },
  { width: 3, backendKind: 'webgpu', copySource: false, direct: false },
  { width: 3, backendKind: 'wgpu-webgl2', copySource: true, direct: false },
  { width: 3, backendKind: 'null', copySource: true, direct: false },
])('routes depth readback $backendKind/$copySource/$width', async ({
  width,
  backendKind,
  copySource,
  direct,
}) => {
  const height = 2;
  const expected = new Uint8Array(
    new Float32Array(Array.from({ length: width * height }, (_, index) => index / (width * height)))
      .buffer,
  );
  const storage = new Map<unknown, Uint8Array>();
  const unmap = vi.fn();
  const createBuffer = vi.fn(({ size }: { size: number }) => {
    const bytes = new Uint8Array(size);
    const buffer = { mapAsync: async () => ok({ getMappedRange: () => ok(bytes.buffer), unmap }) };
    storage.set(buffer, bytes);
    return ok(buffer);
  });
  const copy = vi.fn(
    (
      source: { aspect: string; mipLevel: number; origin: { z: number } },
      destination: { buffer: unknown; offset: number; bytesPerRow: number },
    ) => {
      const bytes = storage.get(destination.buffer);
      if (bytes === undefined) throw new Error('unknown staging buffer');
      for (let row = 0; row < height; row++)
        bytes.set(
          expected.subarray(row * width * 4, (row + 1) * width * 4),
          destination.offset + row * destination.bytesPerRow,
        );
      expect(source).toMatchObject({ aspect: 'depth-only', mipLevel: 1, origin: { z: 2 } });
    },
  );
  const createTexture = vi.fn();
  const createPipeline = vi.fn();
  const destroyBuffer = vi.fn();
  const destroyTexture = vi.fn();
  const shader = vi.fn(async () => {
    throw new Error('native depth copy must not compile a raster shader');
  });
  const device = {
    caps: { backendKind },
    limits: { maxBufferSize: 1024 * 1024 },
    createTextureView: () => ok({}),
    createBindGroupLayout: () => ok({}),
    createPipelineLayout: () => ok({}),
    createTexture,
    createRenderPipeline: createPipeline,
    createBuffer,
    createCommandEncoder: () => ok({ copyTextureToBuffer: copy, finish: () => ok({}) }),
    queue: { submit: () => ok(undefined), onSubmittedWorkDone: async () => {} },
    destroyBuffer,
    destroyTexture,
  } as unknown as RhiDevice;
  const result = await readbackDepthTexture(
    device,
    {} as Texture,
    width,
    height,
    1,
    2,
    shader,
    true,
    undefined,
    copySource,
  );
  if (!direct) {
    expect(result.ok).toBe(false);
    expect(shader).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();
    expect(createBuffer).not.toHaveBeenCalled();
    return;
  }
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  if (result.ok) expect(result.value).toEqual(expected);
  expect(copy).toHaveBeenCalledTimes(1);
  expect(createBuffer).toHaveBeenCalledExactlyOnceWith({ size: 512, usage: 9 });
  expect(unmap).toHaveBeenCalledTimes(1);
  expect(destroyBuffer).toHaveBeenCalledTimes(1);
  expect(shader).not.toHaveBeenCalled();
  expect(createTexture).not.toHaveBeenCalled();
  expect(createPipeline).not.toHaveBeenCalled();
  expect(destroyTexture).not.toHaveBeenCalled();
});

it('requires explicit depth32float and COPY_SRC metadata', () => {
  expect(isDepth32FloatCopySource('depth32float', 0x15)).toBe(true);
  expect(isDepth32FloatCopySource('depth32float', 0x14)).toBe(false);
  expect(isDepth32FloatCopySource('depth24plus', 0x15)).toBe(false);
  expect(isDepth32FloatCopySource('depth32float-stencil8', 0x15)).toBe(false);
  expect(isDepth32FloatCopySource(undefined, 0x15)).toBe(false);
  expect(isDepth32FloatCopySource('depth32float', undefined)).toBe(false);
});
