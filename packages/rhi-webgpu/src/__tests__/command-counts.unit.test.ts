import type { BindGroup, RenderBundle, RenderPipeline } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBGPU_STUB_PROFILE,
  installWebGpuStub,
  RHI_COMMAND_COUNT_KEYS,
  type RhiCommandCounts,
  readRhiCommandCounts,
  requestAdapter,
  subtractRhiCommandCounts,
} from '../index';

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

const nonZero = (counts: RhiCommandCounts): Partial<RhiCommandCounts> =>
  Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== 0));

describe('RHI command counts', () => {
  it('count each encoded command once, per lane, through the ordinary WebGPU path', async () => {
    const device = (await (await requestAdapter()).unwrap().requestDevice()).unwrap();
    const before = readRhiCommandCounts();

    const buffer = device
      .createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      .unwrap();
    const texture = device
      .createTexture({
        size: [4, 4],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      })
      .unwrap();
    expect(device.queue.writeBuffer(buffer, 0, new Float32Array(8)).ok).toBe(true);
    expect(device.queue.writeBuffer(buffer, 0, new Uint8Array(32), 8, 16).ok).toBe(true);
    expect(
      device.queue.writeTexture({ texture }, new Uint8Array(64), { bytesPerRow: 16 }, [4, 4]).ok,
    ).toBe(true);
    const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const group = device.createBindGroup({ layout, entries: [] }).unwrap();
    const pipeline = {} as RenderPipeline;

    const bundleEncoder = device
      .createRenderBundleEncoder({ colorFormats: ['rgba8unorm'] })
      .unwrap();
    bundleEncoder.setPipeline(pipeline);
    bundleEncoder.setBindGroup(0, group);
    bundleEncoder.setVertexBuffer(0, buffer);
    bundleEncoder.draw(3);
    bundleEncoder.draw(3);
    const bundle = bundleEncoder.finish().unwrap() as RenderBundle;

    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: device.createTextureView(texture, {}).unwrap(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group as BindGroup);
    pass.setBindGroup(1, group as BindGroup, new Uint32Array([0]), 0, 1);
    pass.setVertexBuffer(0, buffer);
    pass.draw(3);
    pass.drawIndexed(6);
    expect(pass.executeBundles([bundle, bundle]).ok).toBe(true);
    pass.end();
    const compute = encoder.beginComputePass();
    compute.dispatchWorkgroups(1);
    compute.end();
    expect(device.queue.submit([encoder.finish().unwrap()]).ok).toBe(true);

    expect(nonZero(subtractRhiCommandCounts(readRhiCommandCounts(), before))).toEqual({
      submits: 1,
      renderPasses: 1,
      computePasses: 1,
      draws: 2,
      pipelineSets: 1,
      bindGroupSets: 2,
      vertexBufferSets: 1,
      dispatches: 1,
      bundlesExecuted: 2,
      bundleDraws: 2,
      bundlePipelineSets: 1,
      bundleBindGroupSets: 1,
      bundleVertexBufferSets: 1,
      bindGroupCreates: 1,
      bufferCreates: 1,
      textureCreates: 1,
      bufferWrites: 2,
      bufferWriteBytes: 48,
      textureWrites: 1,
      textureWriteBytes: 64,
    });
  });

  it('snapshots are independent copies over one key list', () => {
    const snapshot = readRhiCommandCounts();
    expect(Object.keys(snapshot)).toEqual([...RHI_COMMAND_COUNT_KEYS]);
    expect(snapshot).not.toBe(readRhiCommandCounts());
    const zero = subtractRhiCommandCounts(snapshot, snapshot);
    expect(Object.values(zero).every((value) => value === 0)).toBe(true);
  });
});
