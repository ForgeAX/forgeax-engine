import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { createViewportHitProxy, type ViewportHitDraw } from '../assembly/viewport-hit-proxy';
import { GpuBuffer } from '../gpu-resource';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import { nativeDeviceFixture } from './native-device-fixture';

it('reads the closest visible integer ID from resident indexed geometry', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const vertices = new Float32Array([-0.5, -0.5, 0.25, 0.5, -0.5, 0.25, 0, 0.5, 0.25]);
  const indices = new Uint32Array([0, 1, 2]);
  const vertexBuffer = new GpuBuffer(
    device,
    device.createBuffer({ size: vertices.byteLength, usage: 0x20 | 0x08 }).unwrap(),
  );
  const indexBuffer = new GpuBuffer(
    device,
    device.createBuffer({ size: indices.byteLength, usage: 0x10 | 0x08 }).unwrap(),
  );
  try {
    device.queue.writeBuffer(vertexBuffer.handle, 0, vertices.buffer).unwrap();
    device.queue.writeBuffer(indexBuffer.handle, 0, indices.buffer).unwrap();
    const proxy = createViewportHitProxy(device, async (code) =>
      createShaderModuleImmediate(device, { code }).unwrap(),
    );
    const track = vi.fn();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
    const admitted = (lift: number, mask = false) =>
      buildPipelineForMaterialShader(
        'hit-parity',
        {
          source: `
override lift: f32 = 0.0;
@vertex fn vs_main(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return vec4f(p.xy, p.z + lift, 1.0);
}
@fragment fn fs_main(@builtin(position) p: vec4f) -> @location(0) vec4f {
  ${mask ? 'if (p.x > 31.0 && p.x < 34.0) { discard; }' : ''}
  return vec4f(0.3);
}
`,
          paramSchema: [],
          entryPoints: [
            {
              name: 'fs_main',
              stage: 'fragment',
              bindings: [],
              effects: {
                mayDiscard: mask,
                writesDepth: false,
                writesSampleMask: false,
                writesStorage: false,
              },
            },
          ],
        },
        {
          device,
          pipelineLayout: layout,
          colorFormat: 'rgba8unorm',
          depthFormat: 'depth32float',
          shaderModuleFactory: {
            createShaderModule: (desc) => createShaderModuleImmediate(device, desc),
          },
          vertexConstants: { lift },
          vertexBuffers: [
            {
              arrayStride: 12,
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
      ).unwrap();
    const back: ViewportHitDraw = {
      entity: 0x12345678,
      pipeline: admitted(0),
      state: undefined,
      bindings: [],
      vertex: vertexBuffer.handle,
      indices: { buffer: indexBuffer.handle, format: 'uint32' },
      first: 0,
      count: 3,
      baseVertex: 0,
      instanceCount: 1,
      firstInstance: 0,
    };
    const front = { ...back, entity: 0, pipeline: admitted(0.5) };
    const masked = { ...front, pipeline: admitted(0.5, true) };
    const signal = new AbortController().signal;
    await proxy.warm([back, front, masked], signal);
    const shader = await proxy.prepare();
    expect(proxy.prepareDraws(shader, [back, front, masked]).kind).toBe('ready');
    expect(track).not.toHaveBeenCalled();
    const center = { x: 32, y: 32, width: 64, height: 64 };
    const drawAt = async (at: typeof center, draws: readonly ViewportHitDraw[]) => {
      const recipes = await vi.waitFor(() => {
        const result = proxy.prepareDraws(shader, draws);
        if (result.kind !== 'ready')
          throw new Error(`Waiting for GPU pick pipelines: ${result.kind}`);
        return result.value;
      });
      return proxy.submit(at, draws, recipes, track);
    };
    await expect(drawAt(center, [front, back])).resolves.toBe(0);
    await expect(drawAt(center, [back, front])).resolves.toBe(0);
    await expect(drawAt({ ...center, x: 0 }, [back])).resolves.toBeNull();
    await expect(drawAt(center, [back, masked])).resolves.toBe(back.entity);
    await expect(drawAt({ ...center, x: 35 }, [back, masked])).resolves.toBe(0);
    const clipped = { ...back, pipeline: admitted(-0.5) };
    await expect(
      drawAt(center, [...Array<ViewportHitDraw>(256).fill(clipped), front]),
    ).resolves.toBe(0);
    expect(track).toHaveBeenCalledTimes(6);
  } finally {
    vertexBuffer.destroy();
    indexBuffer.destroy();
    expect(await native.popErrorScope()).toBeNull();
  }
});
