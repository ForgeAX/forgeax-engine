import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { cookTerrain } from '@forgeax/engine-terrain/cook';
import { expect, it } from 'vitest';

it.each([
  'plane',
  'large-flat',
  'large-slope',
])('decodes height atlas tiles and seam normals at every drawn mip (%s)', async (mode) => {
  const n = 8,
    columns = 22,
    rows = 15;
  const cooked = cookTerrain({
    columns,
    rows,
    subsectionVertices: n,
    spacing: 0.1,
    heights: Float32Array.from({ length: columns * rows }, (_, i) =>
      mode === 'large-flat'
        ? 3e38
        : mode === 'large-slope'
          ? i % columns < 10
            ? -3e38
            : 3e38
          : 0.3 * (i % columns) + 0.1 * Math.floor(i / columns),
    ),
    weights: new Float32Array(columns * rows).fill(1),
    layers: [{ material: 'layer', blend: 'weight' as const }],
  }).unwrap();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  const width = cooked.height.shape.extent.width,
    height = cooked.height.shape.extent.height;
  const texture = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    mipLevelCount: 4,
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  let offset = 0;
  for (let mip = 0; mip < 4; mip++) {
    const w = width >> mip,
      h = height >> mip;
    device.queue.writeTexture(
      { texture, mipLevel: mip },
      cooked.height.data.subarray(offset, offset + w * h * 4),
      { bytesPerRow: w * 4, rowsPerImage: h },
      [w, h],
    );
    offset += w * h * 4;
  }
  const kernel = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/terrain-vertex.wgsl'),
    'utf8',
  ).replace(/^#define_import_path.*\n/, '');
  try {
    for (let mip = 0; mip < 3; mip++) {
      const size = n >> mip,
        count = size * size * 6,
        bytes = count * 32;
      const output = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const read = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      device.pushErrorScope('validation');
      const module = device.createShaderModule({
        code:
          kernel +
          `
@group(0) @binding(0) var heights: texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> output: array<vec4<f32>>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
 let sectionId = id.x / ${size * size}u;
 let local = id.x % ${size * size}u;
 let section = vec4<f32>(f32(sectionId % 3u) * 0.7, f32(sectionId / 3u) * 0.7, 0.7, 8.0);
 let lod = vec4<f32>(${mip}.0, ${mip}.0, 3.0, 2.0);
 let neighbors = vec4<f32>(${mip}.0);
 let position = vec3<f32>(f32(local % ${size}u) * ${2 ** mip}.0, 0.0, f32(local / ${size}u) * ${2 ** mip}.0);
 output[id.x * 2u] = vec4<f32>(terrainVertex(position, heights, section, lod, neighbors), 1.0);
 output[id.x * 2u + 1u] = vec4<f32>(terrainNormal(position, heights, section, lod, neighbors), 1.0);
}`,
      });
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'main' },
      });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: { buffer: output } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(count);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      expect(await device.popErrorScope()).toBeNull();
      for (let section = 0; section < 6; section++) {
        const surface = {
          vertices: n,
          width: 0.7,
          lod: mip,
          neighbors: [mip, mip, mip, mip],
          sectionIndex: section,
          textureWidth: width,
          textureHeight: height,
          heights: cooked.height.data,
        };
        for (let z = 0; z < size; z++)
          for (let x = 0; x < size; x++) {
            const index = (section * size * size + z * size + x) * 8;
            const expected = terrainSurfaceVertex(surface, x, z, [
              (section % 3) * 0.7,
              Math.floor(section / 3) * 0.7,
            ]);
            for (let c = 0; c < 3; c++) {
              const actual = values[index + c] as number,
                wanted = expected[c] as number;
              expect(Number.isFinite(actual)).toBe(true);
              expect(Math.abs(actual - wanted)).toBeLessThanOrEqual(
                Math.max(1e-5, Math.abs(wanted) * 2e-7),
              );
            }
            const normal = Array.from(values.subarray(index + 4, index + 7));
            expect(normal.every(Number.isFinite)).toBe(true);
            expect(Math.hypot(...normal)).toBeCloseTo(1, 5);
            if (mode === 'large-flat') expect(normal).toEqual([0, 1, 0]);
            if (x === size - 1 && section % 3 < 2) {
              const neighbor = ((section + 1) * size * size + z * size) * 8;
              expect(values[index + 1]).toBe(values[neighbor + 1]);
              for (let c = 4; c < 7; c++)
                expect(values[index + c]).toBeCloseTo(values[neighbor + c] as number, 6);
            }
            if (z === size - 1 && section < 3) {
              const neighbor = ((section + 3) * size * size + x) * 8;
              for (let c = 4; c < 7; c++)
                expect(values[index + c]).toBeCloseTo(values[neighbor + c] as number, 6);
            }
          }
      }
      output.destroy();
      read.destroy();
    }
  } finally {
    texture.destroy();
    device.destroy();
  }
});
