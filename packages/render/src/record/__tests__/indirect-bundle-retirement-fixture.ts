import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import {
  PreparedRasterBundleCache,
  PreparedRasterPass,
} from '../../gpu-driven/prepared-raster-bundle';

export async function indirectBundleRetirementFrames() {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const module = (
    await createShaderModule(device, {
      code: `
@group(0) @binding(0) var<uniform> tint: vec4<f32>;
override GAIN: f32 = 1.0;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var points = array<vec2<f32>,3>(vec2<f32>(-0.25,-0.3),vec2<f32>(0.25,-0.3),vec2<f32>(0.0,0.3));
  return vec4<f32>(points[index] + vec2<f32>(dot(tint.rgb,vec3<f32>(0.0,1.0,2.0))*0.6-0.6,0.0),0.0,1.0);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return vec4<f32>(tint.rgb * GAIN, tint.a); }
`,
    })
  ).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } }],
    })
    .unwrap();
  const emptyLayout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const empty = device.createBindGroup({ layout: emptyLayout, entries: [] }).unwrap();
  const pipelineLayout = device
    .createPipelineLayout({ bindGroupLayouts: [layout, emptyLayout, emptyLayout, emptyLayout] })
    .unwrap();
  const pipeline = (gain: number) =>
    device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vertex', buffers: [] },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [{ format: 'rgba8unorm' }],
          constants: { GAIN: gain },
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      })
      .unwrap();
  const pipelines = [pipeline(1), pipeline(0.5)];
  expect(Object.is(pipelines[0], pipelines[1])).toBe(false);
  const batches = [0, 1, 2].map((index) => {
    const uniform = device.createBuffer({ size: 16, usage: 64 | 8 }).unwrap();
    device.queue
      .writeBuffer(
        uniform,
        0,
        Float32Array.from([Number(index === 0), Number(index === 1), Number(index === 2), 1]),
      )
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: { kind: 'buffer', value: { buffer: uniform, offset: 0, size: 16 } },
          },
        ],
      })
      .unwrap();
    const indices = device.createBuffer({ size: 12, usage: 32 | 16 | 8 }).unwrap();
    device.queue.writeBuffer(indices, 0, Uint32Array.of(0, 1, 2)).unwrap();
    return {
      uniform,
      group,
      indices,
      offset: index * 20,
      bundles: new PreparedRasterBundleCache(),
    };
  });
  const indirect = device.createBuffer({ size: 60, usage: 256 | 8 }).unwrap();
  device.queue
    .writeBuffer(indirect, 0, Uint32Array.of(3, 1, 0, 0, 0, 3, 1, 0, 0, 0, 3, 1, 0, 0, 0))
    .unwrap();
  const target = device
    .createTexture({ size: { width: 32, height: 16 }, format: 'rgba8unorm', usage: 16 | 1 })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256 * 16, usage: 1 | 8 }).unwrap();
  const bundlePass = new PreparedRasterPass({ colorFormats: ['rgba8unorm'] });
  let retired = false;
  let invalidUniformRetired = false;
  let beforePipelineChange: Uint8Array | undefined;
  try {
    for (let frame = 0; frame < 60; frame++) {
      if (frame === 8) {
        const first = batches[0];
        if (first === undefined) throw Error('Missing first batch');
        first.bundles.retire(bundlePass, { hits: 0, builds: 0, evictions: 0, commands: 0 });
        device.destroyBuffer(first.uniform).unwrap();
        device.destroyBuffer(first.indices).unwrap();
        retired = true;
      }
      const current = retired ? batches.slice(1) : batches;
      const counters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
      const record = (pass: RhiRenderPassEncoder) => {
        for (const batch of current) {
          const selected = pipelines[frame >= 24 && batch === batches[1] ? 1 : 0];
          if (selected === undefined) throw Error('Missing pipeline');
          pass.setPipeline(selected);
          pass.setBindGroup(0, batch.group, [0]);
          pass.setBindGroup(1, empty);
          pass.setBindGroup(2, empty);
          pass.setBindGroup(3, empty);
          pass.setIndexBuffer(batch.indices, 'uint32');
          pass.drawIndexedIndirect(indirect, batch.offset);
        }
      };
      const render = async (cached: boolean) => {
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        if (cached) {
          const bundles = current.map((batch) => {
            const selected = pipelines[frame >= 24 && batch === batches[1] ? 1 : 0];
            if (!selected) throw Error('Missing pipeline');
            return batch.bundles.resolveOne(
              bundlePass,
              device,
              {
                pipeline: selected,
                view: batch.group,
                viewOffset: 0,
                material: empty,
                materialOffset: undefined,
                mesh: empty,
                meshOffsets: [],
                vertex: batch.indices,
                index: batch.indices,
                indexFormat: 'uint32',
                indirect,
                indirectOffset: batch.offset,
                indexed: true,
                windows: [empty],
              },
              counters,
            );
          });
          pass.executeBundles(bundles).unwrap();
        } else record(pass);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: target },
          { buffer: readback, bytesPerRow: 256, rowsPerImage: 16 },
          { width: 32, height: 16, depthOrArrayLayers: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        const error = await native.popErrorScope();
        native.pushErrorScope('validation');
        expect(error, error?.message).toBeNull();
        const mapped = (await readback.mapAsync(1)).unwrap();
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
        mapped.unmap();
        return bytes;
      };
      const direct = await render(false);
      expect(equalBytes(await render(true), direct)).toBe(true);
      expect(direct.some((value, index) => index % 4 !== 3 && value > 200)).toBe(true);
      if (frame === 8) expect(counters).toMatchObject({ hits: 2, builds: 0 });
      if (frame === 23) beforePipelineChange = direct;
      if (frame === 24) {
        expect(counters).toMatchObject({ hits: 1, builds: 1 });
        expect(beforePipelineChange).toBeDefined();
        expect(equalBytes(direct, beforePipelineChange)).toBe(false);
      }
    }
    expect(await native.popErrorScope()).toBeNull();
    const invalid = batches[1];
    const valid = batches[2];
    const selected = pipelines[0];
    if (invalid === undefined || valid === undefined || selected === undefined)
      throw Error('Missing validation fixture');
    // Identical raw commands can have different provenance: after an explicit
    // bundle boundary, a formerly inherited setter is an authored command.
    // Even when it is overwritten before drawing, backend validation must see it.
    for (let phase = 0; phase < 3; phase++) {
      native.pushErrorScope('validation');
      if (phase === 2) {
        device.destroyBuffer(invalid.uniform).unwrap();
        invalidUniformRetired = true;
      }
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      });
      pass.setPipeline(selected);
      pass.setBindGroup(1, empty);
      pass.setBindGroup(2, empty);
      pass.setBindGroup(3, empty);
      pass.setBindGroup(0, phase === 2 ? valid.group : invalid.group, [0]);
      pass.setIndexBuffer(invalid.indices, 'uint32');
      pass.drawIndexedIndirect(indirect, invalid.offset);
      if (phase === 2) {
        pass.executeBundles([]).unwrap();
        pass.setBindGroup(0, invalid.group, [0]);
        pass.setIndexBuffer(invalid.indices, 'uint32');
      }
      pass.setPipeline(selected);
      pass.setBindGroup(1, empty);
      pass.setBindGroup(2, empty);
      pass.setBindGroup(3, empty);
      pass.setBindGroup(0, valid.group, [0]);
      pass.setIndexBuffer(valid.indices, 'uint32');
      pass.drawIndexedIndirect(indirect, valid.offset);
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const error = await native.popErrorScope();
      if (phase === 2) expect(error?.message).toContain('destroyed');
      else expect(error, error?.message).toBeNull();
    }
  } finally {
    for (const [index, batch] of batches.entries()) {
      if (index === 0 && retired) continue;
      if (index !== 1 || !invalidUniformRetired) device.destroyBuffer(batch.uniform).unwrap();
      device.destroyBuffer(batch.indices).unwrap();
    }
    device.destroyBuffer(indirect).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(target).unwrap();
    native.destroy();
  }
}
