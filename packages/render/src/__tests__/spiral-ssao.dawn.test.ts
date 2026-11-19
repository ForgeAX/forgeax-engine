import { readFileSync } from 'node:fs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';

const read = (name: string) =>
  readFileSync(new URL(`../../../shader/src/${name}`, import.meta.url), 'utf8');
const size = 16;

async function fixture(contact: boolean, orthographic = false) {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw Error('Spiral SSAO requires a GPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  const projection = orthographic
    ? mat4.orthographicReverseZ(mat4.create(), -3, 3, 3, -3, 0.1, 100)
    : mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  const uniform = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const payload = new Float32Array(64);
  payload.set(mat4.identity(mat4.create()));
  payload.set(projection, 16);
  payload.set(mat4.invert(mat4.create(), projection), 32);
  payload.set([1.6, 0.9, 0, 12], 48);
  payload[52] = 2;
  payload[60] = 0.5;
  device.queue.writeBuffer(uniform, 0, payload);
  const depth = device.createTexture({
    size: [32, 32],
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const linearDepth = device.createTexture({
    size: [size, size],
    format: 'r16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const linearDepthView = linearDepth.createView();
  const outputs = Array.from({ length: 3 }, () =>
    device.createTexture({
      size: [size, size],
      format: 'r8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    }),
  );
  const views = outputs.map((texture) => texture.createView());
  const depthView = depth.createView();
  const sampler = device.createSampler({
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const pipelines: GPURenderPipeline[] = [];
  for (const fragment of ['fs_ssao_spiral', 'fs_ssao_spiral_blur_x', 'fs_ssao_spiral_blur_y']) {
    const compiled = (
      await compileShader(read('hdrp-ssao.wgsl'), {
        imports: {
          'forgeax_view::common': read('common.wgsl'),
          'forgeax_pbr::gbuffer': read('standard-gbuffer.wgsl'),
        },
        renderEntries: { vertex: 'vs_ssao', fragment },
      })
    ).unwrap();
    const module = device.createShaderModule({ code: compiled.wgsl });
    pipelines.push(
      await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_ssao' },
        fragment: { module, entryPoint: fragment, targets: [{ format: 'r8unorm' }] },
      }),
    );
  }
  const depthCompiled = (
    await compileShader(read('hdrp-ssao.wgsl'), {
      imports: {
        'forgeax_view::common': read('common.wgsl'),
        'forgeax_pbr::gbuffer': read('standard-gbuffer.wgsl'),
      },
      renderEntries: { vertex: 'vs_ssao', fragment: 'fs_ssao_linear_depth' },
    })
  ).unwrap();
  const depthModule = device.createShaderModule({ code: depthCompiled.wgsl });
  const halfPipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: depthModule, entryPoint: 'vs_ssao' },
    fragment: {
      module: depthModule,
      entryPoint: 'fs_ssao_linear_depth',
      targets: [{ format: 'r16float' }],
    },
  });
  const depthAt = (z: number) =>
    (-Number(projection[10]) * z + Number(projection[14])) / (orthographic ? 1 : z);
  const seedModule = device.createShaderModule({
    code: `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  return select(${depthAt(3)}, ${depthAt(2.65)}, ${contact} && p.x < 16.0 && p.y < 16.0);
}`,
  });
  const seedPipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module: seedModule, entryPoint: 'vs' },
    fragment: { module: seedModule, entryPoint: 'fs', targets: [] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  });
  const seed = device.createCommandEncoder();
  const depthPass = seed.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: depthView,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
  });
  depthPass.setPipeline(seedPipeline);
  depthPass.draw(3);
  depthPass.end();
  const halfPass = seed.beginRenderPass({
    colorAttachments: [{ view: linearDepthView, loadOp: 'clear', storeOp: 'store' }],
  });
  halfPass.setPipeline(halfPipeline);
  halfPass.setBindGroup(
    0,
    device.createBindGroup({
      layout: halfPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 5, resource: depthView },
      ],
    }),
  );
  halfPass.draw(3);
  halfPass.end();
  device.queue.submit([seed.finish()]);
  const encode = (encoder: GPUCommandEncoder, index: number) => {
    const pipeline = pipelines[index];
    const output = views[index];
    if (pipeline === undefined || output === undefined) throw Error('Missing SSAO stage');
    const entries: GPUBindGroupEntry[] = [
      ...(index === 0 ? [{ binding: 0, resource: { buffer: uniform } }] : []),
      { binding: 12, resource: linearDepthView },
    ];
    if (index > 0) {
      const previous = views[index - 1];
      if (previous === undefined) throw Error('Missing SSAO intermediate');
      entries.push({ binding: 6, resource: sampler }, { binding: 7, resource: previous });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: output, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
    );
    pass.draw(3);
    pass.end();
  };
  const pixels = async (index: number) => {
    const texture = outputs[index];
    if (texture === undefined) throw Error('Missing SSAO readback');
    const readback = device.createBuffer({
      size: 256 * size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readback.getMappedRange());
    const result = Array.from({ length: size * size }, (_, i) =>
      Number(mapped[Math.floor(i / size) * 256 + (i % size)]),
    );
    readback.unmap();
    readback.destroy();
    return result;
  };
  const dispose = async () => {
    expect(await device.popErrorScope()).toBeNull();
    uniform.destroy();
    depth.destroy();
    linearDepth.destroy();
    for (const output of outputs) output.destroy();
    device.destroy();
  };
  return { device, outputs, encode, pixels, dispose };
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('native three-stage spiral SSAO preserves a plane and detects a contact (%s, ortho=%s)', async (contact, orthographic) => {
  const f = await fixture(Boolean(contact), Boolean(orthographic));
  try {
    const encoder = f.device.createCommandEncoder();
    for (let stage = 0; stage < 3; stage++) f.encode(encoder, stage);
    f.device.queue.submit([encoder.finish()]);
    const raw = await f.pixels(0);
    const filtered = await f.pixels(2);
    if (contact) {
      expect(Math.min(...raw)).toBeLessThan(245);
      expect(Math.min(...filtered)).toBeLessThan(250);
    } else {
      expect(raw.every((value) => value === 255)).toBe(true);
      expect(filtered.every((value) => value === 255)).toBe(true);
    }
  } finally {
    await f.dispose();
  }
});

it('matches an independent seven-by-seven separable filter oracle including clamped borders', async () => {
  const f = await fixture(false);
  try {
    const input = Uint8Array.from(
      { length: size * size },
      (_, i) => (i * 37 + Math.floor(i / size) * 51) % 256,
    );
    const raw = f.outputs[0];
    if (raw === undefined) throw Error('Missing raw target');
    f.device.queue.writeTexture({ texture: raw }, input, { bytesPerRow: size }, [size, size]);
    const filter = (source: readonly number[], axis: number) =>
      source.map((_, i) => {
        const x = i % size,
          y = Math.floor(i / size);
        let sum = 0,
          weight = 0;
        for (let k = -3; k <= 3; k++) {
          const xx = Math.max(0, Math.min(size - 1, x + (axis === 0 ? k : 0)));
          const yy = Math.max(0, Math.min(size - 1, y + (axis === 1 ? k : 0)));
          const w = 1 - Math.abs(k) * 0.22;
          sum += Number(source[yy * size + xx]) * w;
          weight += w;
        }
        return Math.round(sum / weight);
      });
    const expected = filter(filter([...input], 0), 1);
    const encoder = f.device.createCommandEncoder();
    f.encode(encoder, 1);
    f.encode(encoder, 2);
    f.device.queue.submit([encoder.finish()]);
    const actual = await f.pixels(2);
    expect(
      Math.max(...actual.map((value, i) => Math.abs(value - Number(expected[i])))),
    ).toBeLessThanOrEqual(2);
  } finally {
    await f.dispose();
  }
});
