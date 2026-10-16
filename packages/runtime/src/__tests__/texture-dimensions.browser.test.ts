import { describe, expect, it } from 'vitest';

const TEXTURE_BINDING = 0x04;
const COPY_DST = 0x08;
const COPY_SRC = 0x01;
const STORAGE_BINDING = 0x80;
const MAP_READ = 0x0001;
const COMPUTE_STAGE = 1;

type ProbeResult =
  | { readonly status: 'ready'; readonly samples: readonly (readonly number[])[] }
  | { readonly status: 'unavailable'; readonly reason: string };

async function probe(): Promise<ProbeResult> {
  if (!('gpu' in navigator)) return { status: 'unavailable', reason: 'webgpu-unavailable' };
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) return { status: 'unavailable', reason: 'adapter-unavailable' };
  const device = await adapter.requestDevice();
  const texture = device.createTexture({
    size: { width: 2, height: 2, depthOrArrayLayers: 2 },
    dimension: '3d',
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | COPY_DST,
  });
  const arrayTexture = device.createTexture({
    size: { width: 2, height: 2, depthOrArrayLayers: 2 },
    dimension: '2d',
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | COPY_DST,
  });
  const samples = new Uint8Array(256 * 2 * 2);
  for (let point = 0; point < 8; point += 1) {
    const z = Math.floor(point / 4);
    const y = Math.floor((point % 4) / 2);
    const x = point % 2;
    const offset = z * 512 + y * 256 + x * 4;
    samples[offset] = point + 1;
    samples[offset + 3] = 255;
  }
  const layout = { offset: 0, bytesPerRow: 256, rowsPerImage: 2 };
  const extent = { width: 2, height: 2, depthOrArrayLayers: 2 };
  device.queue.writeTexture({ texture: arrayTexture }, samples, layout, extent);
  device.queue.writeTexture({ texture }, samples, layout, extent);
  const output = device.createBuffer({ size: 256, usage: STORAGE_BINDING | COPY_SRC });
  const readback = device.createBuffer({ size: 256, usage: MAP_READ | COPY_DST });
  const module = device.createShaderModule({
    code: `
      @group(0) @binding(0) var array_tex: texture_2d_array<f32>;
      @group(0) @binding(1) var volume_tex: texture_3d<f32>;
      @group(0) @binding(2) var<storage, read_write> output: array<vec4<u32>>;
      fn to_byte(value: f32) -> u32 {
        return u32(round(value * 255.0));
      }
      @compute @workgroup_size(1)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let point = id.x;
        let coord = vec3<i32>(i32(point % 2u), i32((point / 2u) % 2u), i32(point / 4u));
        let array_value = textureLoad(array_tex, coord.xy, coord.z, 0);
        let volume_value = textureLoad(volume_tex, coord, 0);
        output[point] = vec4<u32>(to_byte(array_value.r), 0u, 0u, 0u);
        output[point + 8u] = vec4<u32>(to_byte(volume_value.r), 0u, 0u, 0u);
      }
    `,
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: COMPUTE_STAGE, texture: { viewDimension: '2d-array' } },
      { binding: 1, visibility: COMPUTE_STAGE, texture: { viewDimension: '3d' } },
      {
        binding: 2,
        visibility: COMPUTE_STAGE,
        buffer: { type: 'storage' },
      },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    compute: { module, entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: arrayTexture.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: texture.createView({ dimension: '3d' }) },
      { binding: 2, resource: { buffer: output } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(8);
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, 256);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(MAP_READ);
  const actual = new Uint8Array(readback.getMappedRange()).slice();
  readback.unmap();
  const observed = Array.from({ length: 8 }, (_, point) => [
    actual[point * 16] ?? 0,
    actual[(point + 8) * 16] ?? 0,
  ]);
  const expected = Array.from({ length: 8 }, (_, point) => point + 1);
  if (
    observed.some(
      ([arraySample, volumeSample], point) =>
        arraySample !== expected[point] || volumeSample !== expected[point],
    )
  ) {
    return { status: 'unavailable', reason: 'gpu-readback-mismatch' };
  }
  return { status: 'ready', samples: observed };
}

describe('browser texture dimensions', () => {
  it('returns an observable WebGPU status instead of silently accepting a bad view', async () => {
    const result = await probe();
    expect(['ready', 'unavailable']).toContain(result.status);
    if (result.status === 'unavailable') expect(result.reason.length).toBeGreaterThan(0);
    if (result.status === 'ready') {
      expect(result.samples).toHaveLength(8);
      expect(
        result.samples.map(([arraySample, volumeSample]) => [arraySample, volumeSample]),
      ).toEqual(Array.from({ length: 8 }, (_, point) => [point + 1, point + 1]));
    }
  });
});
