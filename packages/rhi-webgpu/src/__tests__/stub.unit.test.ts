import { describe, expect, it } from 'vitest';
import {
  acquireCanvasContext,
  captureWebGpuStubProfile,
  DEFAULT_WEBGPU_STUB_PROFILE,
  installedWebGpuStub,
  installWebGpuStub,
  requestAdapter,
} from '../index';

// Node provides `navigator` but no canvas; give the realm a minimal canvas class
// before installing so the stub patches its 'webgpu' context like a browser's.
class TestCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  getContext(_type: string): unknown {
    return null;
  }
}
Object.assign(globalThis, { OffscreenCanvas: TestCanvas });
installWebGpuStub(DEFAULT_WEBGPU_STUB_PROFILE);

describe('WebGPU stub', () => {
  it('drives the ordinary ambient WebGPU RHI path with the profiled caps', async () => {
    expect(installedWebGpuStub()).toBe(DEFAULT_WEBGPU_STUB_PROFILE.name);
    const adapter = (await requestAdapter()).unwrap();
    const device = (
      await adapter.requestDevice({
        requiredFeatures: ['timestamp-query', 'texture-compression-astc'],
      })
    ).unwrap();
    expect(device.caps.backendKind).toBe('webgpu');
    expect(device.caps.timestampQuery).toBe(true);
    expect(device.caps.textureCompressionAstc).toBe(true);
    // Spec: a device exposes only requested features.
    expect(device.caps.textureCompressionBc).toBe(false);

    const usage = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
    const buffer = device.createBuffer({ size: 16, usage }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.end();
    const commands = encoder.finish().unwrap();
    expect(device.queue.submit([commands]).ok).toBe(true);
    const mapped = (await buffer.mapAsync(GPUMapMode.READ)).unwrap();
    expect([...new Uint8Array(mapped.getMappedRange().unwrap())]).toEqual(new Array(16).fill(0));
  });

  it('serves canvas contexts and preserves adapter feature admission', async () => {
    const canvas = new TestCanvas(4, 2);
    expect(canvas.getContext('2d')).toBeNull();
    const context = acquireCanvasContext(canvas as unknown as OffscreenCanvas).unwrap();
    expect(context).toBeDefined();
    const raw = canvas.getContext('webgpu') as GPUCanvasContext;
    expect(raw).toBe(canvas.getContext('webgpu'));
    const texture = raw.getCurrentTexture();
    expect([texture.width, texture.height, texture.format]).toEqual([4, 2, 'bgra8unorm']);
    const adapter = await navigator.gpu.requestAdapter();
    await expect(
      adapter?.requestDevice({ requiredFeatures: ['unsupported-feature' as GPUFeatureName] }),
    ).rejects.toThrow(/unsupported-feature/);
  });

  it('captures the profile it reports', async () => {
    const captured = await captureWebGpuStubProfile(
      navigator.gpu,
      DEFAULT_WEBGPU_STUB_PROFILE.name,
    );
    expect(captured).toEqual({
      ...DEFAULT_WEBGPU_STUB_PROFILE,
      wgslLanguageFeatures: [...DEFAULT_WEBGPU_STUB_PROFILE.wgslLanguageFeatures].sort(),
      features: [...DEFAULT_WEBGPU_STUB_PROFILE.features].sort(),
    });
  });
});
