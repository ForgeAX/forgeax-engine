import type { Buffer, RhiDevice, RhiRenderPassEncoder, ShaderModule } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { equalBytes } from '../../../../../scripts/test/byte-equality.mjs';
import { cpuPhysicalRangesFixture } from './cpu-physical-ranges-fixture';

/** Clip-space witness preserves XY transforms while distance still selects the physical LOD. */
export function cpuInstanceLodShader(storage: boolean): string {
  return `
struct Instance { current: mat4x4<f32>${storage ? ', previous: mat4x4<f32>' : ''} };
@group(1) @binding(0) var<uniform> tint: vec4<f32>;
@group(2) @binding(0) var<uniform> meshWorld: mat4x4<f32>;
@group(3) @binding(0) var<${storage ? 'storage, read' : 'uniform'}> instances: array<Instance${storage ? '' : ', 128'}>;
@vertex fn vertex(@location(0) position: vec3<f32>, @builtin(instance_index) i: u32) -> @builtin(position) vec4<f32> {
 let world = meshWorld * instances[i].current * vec4<f32>(position, 1.0);
 return vec4<f32>(world.xy, 0.5, 1.0);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return tint; }
`;
}

/** Actual recording, resident uniform/storage pages, nonzero baseVertex, and independent pixels. */
export async function verifyCpuInstanceLodPixels(
  device: RhiDevice,
  module: ShaderModule,
  kind: 'forward' | 'shadow',
) {
  const f = cpuPhysicalRangesFixture(device, module);
  // The production residency owner rebases packed LOD indices for WebGL2.
  // The older native physical-range fixture intentionally exercises nonzero
  // baseVertex; materialize its equivalent portable index representation here.
  if (!device.caps.storageBuffer) {
    if (f.secondMesh.indexBuffer === null) throw new Error('Expected index buffer');
    device.queue
      .writeBuffer(f.secondMesh.indexBuffer.handle, 0, Uint32Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8))
      .unwrap();
    Object.assign(f.secondMesh, {
      lodRanges: [[{ first: 3, count: 3, baseVertex: 0 }], [{ first: 6, count: 3, baseVertex: 0 }]],
    });
  }
  const count = 257;
  const transforms = new Float32Array(count * 16);
  const visible = [0, 127, 128, 256];
  const matrices: Float32Array[] = [];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const offset = ordinal * 16;
    transforms[offset] = transforms[offset + 5] = transforms[offset + 10] = 0.3;
    transforms[offset + 15] = 1;
    transforms[offset + 12] = 10;
    transforms[offset + 14] = -35;
  }
  for (const [index, ordinal] of visible.entries()) {
    transforms[ordinal * 16 + 12] = -0.8 + index * 0.5;
    transforms[ordinal * 16 + 14] = index % 2 === 0 ? 0 : -35;
    matrices.push(transforms.slice(ordinal * 16, (ordinal + 1) * 16));
  }
  Object.assign(f.second.source, {
    localAabb: Float32Array.of(-5, -5, -5, 5, 5, 5),
    instances: { transforms, instanceCount: count, cacheKey: 2, archVersion: 0 },
  });
  const buffers: Buffer[] = [];
  const oracleGroups = matrices.map((matrix) => {
    const values = new Float32Array(device.caps.storageBuffer ? 32 : 128 * 16);
    values.set(matrix);
    if (device.caps.storageBuffer) values.set(matrix, 16);
    const buffer = device
      .createBuffer({ size: values.byteLength, usage: (device.caps.storageBuffer ? 128 : 64) | 8 })
      .unwrap();
    buffers.push(buffer);
    device.queue.writeBuffer(buffer, 0, values).unwrap();
    return device
      .createBindGroup({
        layout: f.instancesLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer } } }],
      })
      .unwrap();
  });
  const shadow = kind === 'shadow';
  const target = device
    .createTexture({
      size: { width: 64, height: 64 },
      format: shadow ? 'depth32float' : 'rgba8unorm',
      usage: 16 | 1,
    })
    .unwrap();
  const view = device.createTextureView(target, {}).unwrap();
  const readback = device.createBuffer({ size: 256 * 64, usage: 1 | 8 }).unwrap();
  const render = async (record: (pass: RhiRenderPassEncoder) => void) => {
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass(
      shadow
        ? {
            colorAttachments: [],
            depthStencilAttachment: {
              view,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: 1,
            },
          }
        : {
            colorAttachments: [
              { view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
            ],
          },
    );
    pass.setBindGroup(0, f.viewGroup);
    record(pass);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target, ...(shadow ? { aspect: 'depth-only' as const } : {}) },
      { buffer: readback, bytesPerRow: 256 },
      { width: 64, height: 64, depthOrArrayLayers: 1 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    return bytes;
  };
  let last = new Uint8Array();
  try {
    // The oracle binds four independent single-instance buffers. It shares no
    // page splitting, run selection, instance offset, or selected range helper.
    const oracle = (pass: RhiRenderPassEncoder, wrong: boolean, far = false) => {
      f.oracle(pass, kind, 0, 'omit');
      pass.setVertexBuffer(0, f.secondMesh.vertexBuffer.handle);
      if (f.secondMesh.indexBuffer === null) throw new Error('Expected indexed geometry');
      pass.setIndexBuffer(f.secondMesh.indexBuffer.handle, 'uint32');
      for (const [index, group] of oracleGroups.entries()) {
        pass.setBindGroup(3, group);
        const lower = !wrong && (far || index % 2 === 1);
        pass.drawIndexed(3, 1, lower ? 6 : 3, device.caps.storageBuffer ? (lower ? 5 : 2) : 0, 0);
      }
    };
    const expected = await render((pass) => oracle(pass, false));
    const expectedFar = await render((pass) => oracle(pass, false, true));
    expect(equalBytes(expected, expectedFar)).toBe(false);
    const wrong = await render((pass) => oracle(pass, true));
    expect(equalBytes(expected, wrong)).toBe(false);
    for (let frame = 0; frame < 60; frame++) {
      const far = frame >= 20 && frame < 40;
      last = await render((pass) => f.recordRange(pass, kind, far ? 1 : 0, frame % 2 === 0));
      expect(equalBytes(last, far ? expectedFar : expected), `${kind} frame ${frame}`).toBe(true);
    }
    expect(f.errors).toEqual([]);
    return { near: expected, far: expectedFar, actual: last };
  } finally {
    f.dispose();
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(target).unwrap();
  }
}
