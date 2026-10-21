import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

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
] as const;

it('bakes all CubeUV levels and retains the independent native-cube orientation oracle', async ({
  annotate,
}) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const read = (name: string) => readFileSync(new URL(`../${name}.wgsl`, import.meta.url), 'utf8');
  const compiled = await compiler.compileShader(read('ibl-prefilter'), {
    id: 'forgeax_pbr::ibl_prefilter',
    imports: {
      'forgeax_pbr::ibl_shared': read('ibl-shared'),
      'forgeax_pbr::brdf': read('brdf'),
      'forgeax_pbr::pmrem': read('ibl-pmrem'),
    },
  });
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('PMREM requires a real GPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const cube = device.createTexture({
      size: [8, 8, 6],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (let face = 0; face < 6; face++) {
      const pixels = new Uint8Array(8 * 8 * 4);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          pixels.set([20 + face * 35, 20 + x * 30, 20 + y * 30, 255], (y * 8 + x) * 4);
      device.queue.writeTexture(
        { texture: cube, origin: [0, 0, face] },
        pixels,
        { bytesPerRow: 32, rowsPerImage: 8 },
        [8, 8, 1],
      );
    }
    const atlas = () =>
      device.createTexture({
        size: [336, 64],
        format: 'rgba16float',
        usage:
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
    const output = atlas(),
      scratch = atlas();
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({ code: compiled.value.wgsl }),
        entryPoint: 'cubemap_vs',
      },
      fragment: {
        module: device.createShaderModule({ code: compiled.value.wgsl }),
        entryPoint: 'prefilterEnv_fs',
        targets: [{ format: 'rgba16float' }],
      },
    });
    const uniform = device.createBuffer({
      size: 42 * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const inputGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: cube.createView({ dimension: 'cube' }) },
        { binding: 1, resource: sampler },
        { binding: 2, resource: scratch.createView() },
      ],
    });
    const probeBytes = directions.length * 8 * 16;
    const probe = device.createBuffer({
      size: probeBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: probeBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const probePipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: {
        entryPoint: 'probe',
        module: device.createShaderModule({
          code: `
${read('ibl-pmrem').replace(/^#define_import_path.*$/gm, '')}
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var<storage,read_write> output: array<vec4<f32>>;
const directions = array<vec3<f32>, ${directions.length}>(${directions.map((d) => `vec3<f32>(${d.join(',')})`).join(',')});
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id: vec3<u32>) {
  for (var level = 0u; level < 7u; level++) {
    output[id.x * 8u + level] = vec4<f32>(samplePmremLevel(atlas, atlasSampler, directions[id.x], 4.0 - f32(level)), 1.0);
  }
  output[id.x * 8u + 7u] = vec4<f32>(pmremRoughnessToMip(1.0), pmremRoughnessToMip(0.8), pmremRoughnessToMip(0.4), pmremRoughnessToMip(0.21));
}`,
        }),
      },
    });
    const probeGroup = device.createBindGroup({
      layout: probePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: output.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: { buffer: probe } },
      ],
    });
    let maximumMirrorError = 0;
    for (const camera of [false, true]) {
      const data = new Float32Array(42 * 64);
      for (let level = 0; level < 7; level++)
        for (let face = 0; face < 6; face++)
          data.set([level, face, Number(camera), 0], (level * 6 + face) * 64);
      device.queue.writeBuffer(uniform, 0, data);
      const encoder = device.createCommandEncoder();
      for (let level = 0; level < 7; level++)
        for (let face = 0; face < 6; face++) {
          const x = level * 48 + (face % 3) * 16,
            y = Math.floor(face / 3) * 16;
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: output.createView(),
                loadOp: level === 0 && face === 0 ? 'clear' : 'load',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
              },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(1, inputGroup);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                {
                  binding: 1,
                  resource: { buffer: uniform, offset: (level * 6 + face) * 256, size: 16 },
                },
              ],
            }),
          );
          pass.setViewport(x, y, 16, 16, 0, 1);
          pass.setScissorRect(x, y, 16, 16);
          pass.draw(3);
          pass.end();
          encoder.copyTextureToTexture(
            { texture: output, origin: [x, y] },
            { texture: scratch, origin: [x, y] },
            [16, 16],
          );
        }
      const pass = encoder.beginComputePass();
      pass.setPipeline(probePipeline);
      pass.setBindGroup(0, probeGroup);
      pass.dispatchWorkgroups(directions.length);
      pass.end();
      encoder.copyBufferToBuffer(probe, 0, readback, 0, probeBytes);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      for (const [index, original] of directions.entries()) {
        const d: number[] = [...original];
        const a = d.map(Math.abs),
          axis = a.indexOf(Math.max(...a));
        if (camera) {
          const flip = axis === 0 ? 2 : 0;
          d[flip] = -(d[flip] ?? 0);
        }
        const [x = 0, y = 0, z = 0] = d;
        const face = axis * 2 + Number((d[axis] ?? 0) < 0);
        const uv =
          axis === 0
            ? [x > 0 ? -z : z, -y]
            : axis === 1
              ? [x, y > 0 ? z : -z]
              : [z > 0 ? x : -x, -y];
        const expected = [
          (20 + face * 35) / 255,
          (20 + (((uv[0] ?? 0) + 1) * 4 - 0.5) * 30) / 255,
          (20 + (((uv[1] ?? 0) + 1) * 4 - 0.5) * 30) / 255,
        ];
        for (let channel = 0; channel < 3; channel++)
          maximumMirrorError = Math.max(
            maximumMirrorError,
            Math.abs((values[index * 32 + channel] ?? 0) - (expected[channel] ?? 0)),
          );
        const levels = Array.from({ length: 7 }, (_, level) => values[index * 32 + level * 4] ?? 0);
        expect(levels.every((v) => Number.isFinite(v) && v > 0.03 && v < 0.98)).toBe(true);
        expect(new Set(levels.map((v) => Math.round(v * 4096))).size).toBeGreaterThan(3);
        const knots = Array.from(values.slice(index * 32 + 28, index * 32 + 32));
        for (const [i, expected] of [-2, -1, 2, 4].entries())
          expect(knots[i]).toBeCloseTo(expected, 5);
      }
    }
    expect(maximumMirrorError).toBeLessThan(0.005);
    expect(await device.popErrorScope()).toBeNull();
    await annotate('PMREM cube orientation', {
      contentType: 'application/json',
      bodyEncoding: 'utf-8',
      body: JSON.stringify({ maximumMirrorError, levels: 7, faces: 6, sourceOrientations: 2 }),
    });
  } finally {
    device.destroy();
  }
}, 60_000);
