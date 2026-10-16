import { readFileSync } from 'node:fs';
import { assert, expect, it } from 'vitest';

// Six faces, axial and oblique directions, both source orientations, and the
// full roughness domain are compared to the actual pre-repair 1024-sample entry.
it('preserves prefilter radiance when zero roughness collapses repeated samples', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = readFileSync(new URL('../ibl-prefilter.wgsl', import.meta.url), 'utf8')
    .replace('@fragment\nfn prefilterEnv_fs', 'fn prefilterEnv_fs')
    .replace('-> @location(0) vec4<f32>', '-> vec4<f32>');
  const reference = readFileSync(
    new URL('./ibl-prefilter-reference.wgsl.txt', import.meta.url),
    'utf8',
  );
  const directions = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 0.4, 0.2],
    [-1, 0.4, 0.2],
    [0.4, 1, 0.2],
    [0.4, -1, 0.2],
    [0.4, 0.2, 1],
    [0.4, 0.2, -1],
    [1, -0.4, -0.2],
    [-1, -0.4, -0.2],
    [-0.4, 1, -0.2],
    [-0.4, -1, -0.2],
    [-0.4, -0.2, 1],
    [-0.4, -0.2, -1],
  ];
  const compiled = await compiler.compileShader(
    `${source}
${reference}
@group(2) @binding(0) var<storage, read_write> output: array<vec4<f32>>;
const DIRECTIONS = array<vec3<f32>, ${directions.length}>(
${directions.map((v) => `vec3<f32>(${v.join(', ')})`).join(',\n')});
@compute @workgroup_size(1)
fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${directions.length}u) { return; }
  var input: CubemapVsOut;
  input.worldPos = DIRECTIONS[id.x];
  output[id.x * 2u] = prefilterEnv_fs(input);
  output[id.x * 2u + 1u] = prefilterReference(input);
}`,
    {
      id: 'forgeax::ibl-prefilter-zero-reference',
      imports: {
        'forgeax_pbr::brdf': readFileSync(new URL('../brdf.wgsl', import.meta.url), 'utf8'),
        'forgeax_pbr::ibl_shared': readFileSync(
          new URL('../ibl-shared.wgsl', import.meta.url),
          'utf8',
        ),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Prefilter radiance regression requires a real GPU adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const cube = device.createTexture({
    size: [8, 8, 6],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  // Independent gradients distinguish every face and horizontal/vertical flip.
  for (let face = 0; face < 6; face++) {
    const pixels = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        pixels.set([20 + face * 35, 20 + x * 30, 20 + y * 30, 255], (y * 8 + x) * 4);
      }
    device.queue.writeTexture(
      { texture: cube, origin: [0, 0, face] },
      pixels,
      { bytesPerRow: 32, rowsPerImage: 8 },
      [8, 8, 1],
    );
  }
  const uniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bytes = directions.length * 2 * 16;
  const output = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: compiled.value.wgsl }),
        entryPoint: 'probe',
      },
    });
    const groups = [
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 1, resource: { buffer: uniform } }],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: cube.createView({ dimension: 'cube' }) },
          {
            binding: 1,
            resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
          },
        ],
      }),
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: output } }],
      }),
    ];
    for (const cameraCube of [0, 1])
      for (const roughness of [0, 0.00001, 0.04, 0.25, 0.5, 1]) {
        device.queue.writeBuffer(uniform, 0, new Float32Array([roughness, 8, 1, cameraCube]));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        groups.forEach((group, index) => {
          pass.setBindGroup(index, group);
        });
        pass.dispatchWorkgroups(directions.length);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(readback.getMappedRange()));
        readback.unmap();
        expect(values).toHaveLength(directions.length * 8);
        expect(values.every(Number.isFinite)).toBe(true);
        for (let direction = 0; direction < directions.length; direction++) {
          for (let lane = 0; lane < 4; lane++) {
            const actual = values[direction * 8 + lane];
            const reference = values[direction * 8 + 4 + lane];
            assert(actual !== undefined && reference !== undefined);
            expect(
              Math.abs(actual - reference),
              `roughness=${roughness} cameraCube=${cameraCube} direction=${direction} lane=${lane}`,
            ).toBeLessThan(0.0001);
          }
        }
        // All-zero/every-face-identical output cannot satisfy this oracle.
        expect(
          new Set(values.filter((_, index) => index % 8 === 0).map((v) => Math.round(v * 1000)))
            .size,
        ).toBeGreaterThan(3);
      }
    expect(errors).toEqual([]);
  } finally {
    cube.destroy();
    uniform.destroy();
    output.destroy();
    readback.destroy();
    device.destroy();
  }
});
