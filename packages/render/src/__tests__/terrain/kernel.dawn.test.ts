import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { terrainSurfaceHeight, terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { cookTerrain } from '@forgeax/engine-terrain/cook';
import { expect, it } from 'vitest';

it.each([
  { mode: 'ordinary', n: 8, spacing: 1, translation: 0 },
  { mode: 'translated', n: 8, spacing: 1, translation: 10000 },
  { mode: 'cancellation', n: 8, spacing: 1, translation: 0 },
  { mode: 'pose-cancellation', n: 8, spacing: 1, translation: 1e8 },
  { mode: 'noncoplanar', n: 2, spacing: 1, translation: 0 },
  { mode: 'wide', n: 128, spacing: 2, translation: 0 },
])('reads back the actual Landscape WGSL XZ/height morph across resident mips and coarse neighbors ($mode)', async ({
  mode,
  n,
  spacing,
  translation,
}) => {
  const source = {
    columns: n,
    rows: n,
    spacing,
    subsectionVertices: n,
    heights: Float32Array.from({ length: n * n }, (_, i) =>
      mode === 'noncoplanar'
        ? i === 3
          ? 1
          : 0
        : mode === 'pose-cancellation'
          ? -1e8 + 8 * (i % 8)
          : mode === 'cancellation'
            ? i % 8 === 0
              ? -1e8
              : -0.1
            : 2 * Math.sin((i % 8) * 2.3 + Math.floor(i / 8) * 1.7),
    ),
    weights: new Float32Array(n * n).fill(1),
    layers: [{ material: 'layer', blend: 'weight' as const }],
  };
  const cooked = cookTerrain(source).unwrap(),
    data = defined(cooked.sections[0]).height.data,
    device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({
      size: { width: n, height: n, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      mipLevelCount: Math.log2(n) + 1,
      textureBindingViewDimension: '2d',
      usage: 0x02 | 0x04,
    })
    .unwrap();
  const output = device.createBuffer({ size: n * n * 16, usage: 0x80 | 0x04 }).unwrap(),
    read = device.createBuffer({ size: n * n * 16, usage: 0x01 | 0x08 }).unwrap(),
    uniforms = device.createBuffer({ size: 64, usage: 0x40 | 0x08 }).unwrap();
  const kernel = readFileSync(
    resolve(process.cwd(), 'packages/shader/src/terrain-vertex.wgsl'),
    'utf8',
  ).replace(/^#define_import_path.*\n/, '');
  let offset = 0;
  try {
    for (let mip = 0, size = n; size >= 1; mip++, size /= 2) {
      device.queue
        .writeTexture(
          { texture, mipLevel: mip },
          data.subarray(offset, offset + size * size * 4),
          { bytesPerRow: size * 4, rowsPerImage: size },
          { width: size, height: size, depthOrArrayLayers: 1 },
        )
        .unwrap();
      offset += size * size * 4;
    }
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
          { binding: 1, visibility: 4, buffer: { type: 'storage' } },
          { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(texture, { dimension: '2d' }).unwrap(),
            },
          },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
          { binding: 2, resource: { kind: 'buffer', value: { buffer: uniforms } } },
        ],
      })
      .unwrap();
    for (const lod of [...new Set([0, 0.5, 1, 1.75, Math.log2(n) - 1])].filter(
      (value) => value <= Math.log2(n) - 1,
    )) {
      const k = Math.floor(lod),
        drawN = n / 2 ** k,
        neighbor = Math.min(Math.log2(n) - 1, lod + 0.4),
        range = cooked.heightRange;
      device.queue
        .writeBuffer(
          uniforms,
          0,
          new Float32Array([
            0,
            0,
            (n - 1) * spacing,
            n,
            k,
            lod,
            range[0],
            range[1],
            neighbor,
            lod,
            lod,
            lod,
            0,
            translation,
            0,
            0,
          ]),
        )
        .unwrap();
      const shader =
        kernel +
        `\nstruct Params { section:vec4<f32>, lod:vec4<f32>, neighbors:vec4<f32>, translation:vec4<f32> };\n@group(0) @binding(2) var<uniform> params:Params;\n@group(0) @binding(0) var height: texture_2d<f32>;\n@group(0) @binding(1) var<storage,read_write> result: array<vec4<f32>>;\n@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3<u32>) {\n let x=id.x%${drawN}u; let z=id.x/${drawN}u; let p=vec3<f32>(f32(x)*${2 ** k}.0,0.0,f32(z)*${2 ** k}.0);\n result[id.x]=vec4<f32>(terrainVertex(p,height,params.section,params.lod,params.neighbors)+params.translation.xyz,1.0);\n}`;
      const module = createShaderModuleImmediate(device, { code: shader }).unwrap();
      const pipeline = device
        .createComputePipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
          compute: { module, entryPoint: 'main' },
        })
        .unwrap();
      const encoder = device.createCommandEncoder().unwrap(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(drawN * drawN, 1, 1);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, drawN * drawN * 16);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await read.mapAsync(0x01)).unwrap(),
        values = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
      mapped.unmap();
      for (let i = 0; i < drawN * drawN; i++) {
        const expected = terrainSurfaceVertex(
          {
            vertices: n,
            width: (n - 1) * spacing,
            lod,
            neighbors: [neighbor, lod, lod, lod],
            heightRange: range,
            heights: data,
          },
          i % drawN,
          Math.floor(i / drawN),
          [0, 0],
          [0, translation, 0],
        );
        for (let c = 0; c < 3; c++) {
          const canonical = defined(expected[c]);
          // Keep the small-coordinate height gate strict. Large-domain cases separately
          // budget f32 rounding; a near-zero endpoint never borrows the large root span.
          const budget =
            c !== 1
              ? 5e-5
              : mode === 'pose-cancellation'
                ? // Frozen operand budget: two decoded endpoints, two morph products,
                  // their addition and the pose add; preserve cancellation near world zero.
                  8 * ulp(Math.max(Math.abs(range[0]), Math.abs(range[1]))) + 2 * ulp(translation)
                : mode === 'translated'
                  ? 1e-5 + 2 * ulp(translation)
                  : mode === 'cancellation' && Math.abs(canonical) >= 1
                    ? 2 * ulp(canonical)
                    : 1e-5;
          expect(
            Math.abs(defined(values[i * 4 + c]) - canonical),
            `lod=${lod}, vertex=${i}, channel=${c}, budget=${budget}`,
          ).toBeLessThanOrEqual(budget);
        }
      }
      if (mode === 'ordinary' || mode === 'wide' || mode === 'noncoplanar') {
        const surface = {
          vertices: n,
          width: (n - 1) * spacing,
          lod,
          neighbors: [neighbor, lod, lod, lod],
          heightRange: range,
          heights: data,
        };
        const at = (x: number, z: number) =>
          [
            defined(values[(z * drawN + x) * 4]),
            defined(values[(z * drawN + x) * 4 + 1]),
            defined(values[(z * drawN + x) * 4 + 2]),
          ] as const;
        // Reconstruct interior points from actual GPU output on the canonical index diagonal.
        // Vertex-only equality cannot detect a bilinear or opposite-diagonal query.
        for (const cell of [...new Set([0, Math.floor((drawN - 2) / 2), drawN - 2])]) {
          const a = at(cell, cell),
            b = at(cell + 1, cell),
            c = at(cell, cell + 1),
            d = at(cell + 1, cell + 1);
          for (const vertices of [
            [a, c, b],
            [b, c, d],
          ]) {
            const x = vertices.reduce((sum, p) => sum + p[0], 0) / 3,
              z = vertices.reduce((sum, p) => sum + p[2], 0) / 3;
            const actualHeight = vertices.reduce((sum, p) => sum + p[1], 0) / 3;
            const canonical = terrainSurfaceHeight(surface, x, z, [0, 0], [0, translation, 0]);
            const p = defined(vertices[0]),
              q = defined(vertices[1]),
              r = defined(vertices[2]);
            const dx = q[0] - p[0],
              dz = q[2] - p[2],
              ex = r[0] - p[0],
              ez = r[2] - p[2],
              dy = q[1] - p[1],
              ey = r[1] - p[1],
              determinant = dx * ez - ex * dz;
            // The wide-domain GPU XZ coordinates can differ by f32 ULPs even
            // when all vertex heights meet the unchanged 1e-5 gate. Transport
            // that bounded horizontal error through the actual triangle plane.
            const positionError =
              mode === 'wide' && determinant !== 0
                ? 2 *
                  ulp(surface.width) *
                  (Math.abs((dy * ez - ey * dz) / determinant) +
                    Math.abs((dx * ey - ex * dy) / determinant))
                : 0;
            const budget = 1e-5 + positionError;
            if (canonical !== undefined && Math.abs(canonical - actualHeight) > budget) {
              const directory = 'artifacts/terrain-kernel';
              mkdirSync(directory, { recursive: true });
              writeFileSync(
                `${directory}/${mode}.json`,
                JSON.stringify(
                  {
                    mode,
                    lod,
                    cell,
                    x,
                    z,
                    actualHeight,
                    canonical,
                    budget,
                    vertices,
                    canonicalVertices: [
                      [cell, cell],
                      [cell + 1, cell],
                      [cell, cell + 1],
                      [cell + 1, cell + 1],
                    ].map(([vx, vz]) =>
                      terrainSurfaceVertex(surface, vx ?? 0, vz ?? 0, [0, 0], [0, translation, 0]),
                    ),
                  },
                  null,
                  2,
                ),
              );
            }
            expect(
              Math.abs(defined(canonical) - actualHeight),
              `GPU triangle interior: lod=${lod}, cell=${cell}, budget=${budget}`,
            ).toBeLessThanOrEqual(budget);
          }
        }
        if (mode === 'noncoplanar') {
          expect(terrainSurfaceHeight(surface, 0.5, 0.5)).toBe(0);
          expect(terrainSurfaceHeight(surface, 0.5, 0.5)).not.toBe(0.25); // bilinear falsifier
          expect(terrainSurfaceHeight(surface, 0.5, 0.5)).not.toBe(0.5); // opposite diagonal
        }
      }
    }
  } finally {
    device.destroyTexture(texture).unwrap();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(read).unwrap();
    device.destroyBuffer(uniforms).unwrap();
  }
}, 60000);

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}

function ulp(value: number): number {
  return 2 ** (Math.floor(Math.log2(Math.max(1, Math.abs(value)))) - 23);
}
