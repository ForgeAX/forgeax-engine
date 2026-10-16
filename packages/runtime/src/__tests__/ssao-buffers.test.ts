// ssao-buffers.test.ts — M1 / w3: SSAO buffer lazy-alloc test (TDD red phase).
//
// Asserts:
//  - getOrCreateSsaoBuffers first call creates kernel UBO + noise texture
//    + SSAO uniform UBO (at least 3 createBuffer/createTexture calls).
//  - Second call returns same cached instance (0 new device calls).
//  - Labels match /^hdrp-ssao-/.
//  - storageBuffer=false still allocates the uniform-backed kernel.
//
// AC-05 anchor: lazy alloc + hdrp-ssao-* labels + call-count assertions.

import type { Buffer, RhiCaps, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import type { RenderSystemRuntime } from '../../../render/src/render-system';
import {
  getOrCreateSsaoBuffers,
  getOrCreateSsaoFallbackTexture,
  resetSsaoResources,
} from '../../../render/src/ssao-buffers';

function mockTexture(label?: string): Texture {
  return { label: label ?? 'mock-tex' } as unknown as Texture;
}

function mockBuffer(label?: string): Buffer {
  return { label: label ?? 'mock-buf' } as unknown as Buffer;
}

function makeMockRuntime(capsOverride: Partial<RhiCaps> = {}): {
  runtime: RenderSystemRuntime;
  createBuffer: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
  createTextureView: ReturnType<typeof vi.fn>;
  createSampler: ReturnType<typeof vi.fn>;
  destroyBuffer: ReturnType<typeof vi.fn>;
  destroyTexture: ReturnType<typeof vi.fn>;
  writeBuffer: ReturnType<typeof vi.fn>;
  writeTexture: ReturnType<typeof vi.fn>;
} {
  const createBuffer = vi.fn(() => ({ ok: true, value: mockBuffer() }));
  const createTexture = vi.fn(() => ({ ok: true, value: mockTexture() }));
  const createTextureView = vi.fn().mockReturnValue({ ok: true, value: {} });
  const createSampler = vi.fn().mockReturnValue({ ok: true, value: { label: 'mock-sampler' } });
  const destroyBuffer = vi.fn().mockReturnValue({ ok: true, value: undefined });
  const destroyTexture = vi.fn().mockReturnValue({ ok: true, value: undefined });
  const writeBuffer = vi.fn().mockReturnValue({ ok: true, value: undefined });
  const writeTexture = vi.fn().mockReturnValue({ ok: true, value: undefined });

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 4,
      ...capsOverride,
    },
    createBuffer,
    createTexture,
    createTextureView,
    createSampler,
    destroyBuffer,
    destroyTexture,
    queue: {
      writeBuffer,
      writeTexture,
    },
  } as unknown as RhiDevice;

  const errorRegistry = {
    fire: vi.fn(),
    listeners: new Set(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const runtime = {
    device,
    errorRegistry,
  } as unknown as RenderSystemRuntime;

  return {
    runtime,
    createBuffer,
    createTexture,
    createTextureView,
    createSampler,
    destroyBuffer,
    destroyTexture,
    writeBuffer,
    writeTexture,
  };
}

describe('getOrCreateSsaoBuffers', () => {
  it('first call creates kernel UBO + noise texture + uniform UBO (>=3 GPU resources)', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime();

    // The first call creates two UBOs (kernel + per-frame uniform)
    // + createTexture (noise), plus potentially a staging buffer
    const bufs = getOrCreateSsaoBuffers(runtime);

    expect(bufs).not.toBeNull();
    expect(bufs?.kernelBuffer).toBeDefined();
    expect(bufs?.kernelBytes).toBeGreaterThan(0);
    expect(bufs?.noiseTexture).toBeDefined();
    expect(bufs?.uniformBuffer).toBeDefined();
    expect(bufs?.uniformBytes).toBeGreaterThan(0);

    // At least 3 GPU resource creations: kernel UBO, noise tex, uniform UBO.
    // Note: noise texture upload may require a staging buffer (extra createBuffer).
    const totalCalls = createBuffer.mock.calls.length + createTexture.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(3);
  });

  it('second call returns cached instance (0 new device calls)', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime();

    const a = getOrCreateSsaoBuffers(runtime);
    expect(a).not.toBeNull();

    // Reset call counts AFTER first call
    const bufCallsAfterFirst = createBuffer.mock.calls.length;
    const texCallsAfterFirst = createTexture.mock.calls.length;

    const b = getOrCreateSsaoBuffers(runtime);

    // Same instance identity
    expect(b).toBe(a);

    // No additional device calls
    expect(createBuffer.mock.calls.length).toBe(bufCallsAfterFirst);
    expect(createTexture.mock.calls.length).toBe(texCallsAfterFirst);
  });

  it('kernel buffer label matches hdrp-ssao-kernel', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const hasKernel = calls.some((c) => c.label === 'hdrp-ssao-kernel');
    expect(hasKernel).toBe(true);
  });

  it('SSAO uniform buffer label matches hdrp-ssao-uniform', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const hasUniform = calls.some((c) => c.label === 'hdrp-ssao-uniform');
    expect(hasUniform).toBe(true);
  });

  it('noise texture label matches hdrp-ssao-noise', () => {
    const { runtime, createTexture } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createTexture.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockTexture() };
    });

    getOrCreateSsaoBuffers(runtime);

    const hasNoise = calls.some((c) => c.label === 'hdrp-ssao-noise');
    expect(hasNoise).toBe(true);
  });

  it('kernel buffer is 1024 bytes (64 vec3 as float32 x3 x4pad)', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const kernelCall = calls.find((c) => c.label === 'hdrp-ssao-kernel');
    expect(kernelCall).toBeDefined();
    // 64 * 4 * 4 = 1024 bytes (4 floats per vec3 wgsl padded vec3 alignment)
    expect(kernelCall?.size).toBe(1024);
  });

  it('uniform buffer is 192 bytes (3 mat4)', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const uniformCall = calls.find((c) => c.label === 'hdrp-ssao-uniform');
    expect(uniformCall).toBeDefined();
    // M7 round-2 D-C: 3 mat4 (192 B) + vec4 intensityPad padded to 256 B
    // for WebGPU UBO min binding offset alignment.
    expect(uniformCall?.size).toBe(256);
  });

  it('storageBuffer=false still allocates the uniform-backed kernel', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime({
      storageBuffer: false,
    });

    const bufs = getOrCreateSsaoBuffers(runtime);

    expect(bufs).not.toBeNull();
    expect(createBuffer.mock.calls.length).toBe(2);
    expect(createTexture.mock.calls.length).toBe(1);
    expect(runtime.errorRegistry.fire).not.toHaveBeenCalled();
  });

  it('storageBuffer=false subsequent calls reuse the same uniform-backed resources', () => {
    const { runtime } = makeMockRuntime({ storageBuffer: false });

    const first = getOrCreateSsaoBuffers(runtime);
    expect(getOrCreateSsaoBuffers(runtime)).toBe(first);
    expect(getOrCreateSsaoBuffers(runtime)).toBe(first);

    expect(runtime.errorRegistry.fire).not.toHaveBeenCalled();
  });

  it('resetSsaoResources destroys cached buffers and fallback texture exactly once', () => {
    const { runtime, destroyBuffer, destroyTexture } = makeMockRuntime();

    expect(getOrCreateSsaoBuffers(runtime)).not.toBeNull();
    expect(getOrCreateSsaoFallbackTexture(runtime)).not.toBeNull();
    resetSsaoResources(runtime);
    resetSsaoResources(runtime);

    expect(destroyBuffer).toHaveBeenCalledTimes(2);
    expect(destroyTexture).toHaveBeenCalledTimes(2);
  });

  it('rolls back the kernel buffer when its initial upload fails', () => {
    const { runtime, destroyBuffer, writeBuffer } = makeMockRuntime();
    writeBuffer.mockReturnValueOnce({
      ok: false,
      error: { code: 'webgpu-runtime-error', expected: 'writeBuffer ok', hint: 'boom' },
    });

    expect(getOrCreateSsaoBuffers(runtime)).toBeNull();
    expect(destroyBuffer).toHaveBeenCalledTimes(1);
  });

  it('rolls back created buffers and texture when the noise upload fails', () => {
    const { runtime, destroyBuffer, destroyTexture, writeTexture } = makeMockRuntime();
    writeTexture.mockReturnValueOnce({
      ok: false,
      error: { code: 'webgpu-runtime-error', expected: 'writeTexture ok', hint: 'boom' },
    });

    expect(getOrCreateSsaoBuffers(runtime)).toBeNull();
    expect(destroyBuffer).toHaveBeenCalledTimes(1);
    expect(destroyTexture).toHaveBeenCalledTimes(1);
  });

  it('rolls back the fallback texture when its upload fails', () => {
    const { runtime, destroyTexture, writeTexture } = makeMockRuntime();
    writeTexture.mockReturnValueOnce({
      ok: false,
      error: { code: 'webgpu-runtime-error', expected: 'writeTexture ok', hint: 'boom' },
    });

    expect(getOrCreateSsaoFallbackTexture(runtime)).toBeNull();
    expect(destroyTexture).toHaveBeenCalledTimes(1);
  });
});
