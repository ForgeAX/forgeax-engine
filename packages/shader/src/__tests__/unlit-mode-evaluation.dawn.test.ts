import { readdirSync, readFileSync } from 'node:fs';
import { derive } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import { DEFAULT_UNLIT_PARAM_SCHEMA } from '../material-schemas';

const root = new URL('../', import.meta.url);
const source = (name: string) =>
  readFileSync(new URL(name, root), 'utf8').replace(/^#pragma[^\n]*$/gm, '');

function countedSource(): string {
  let text = source('unlit.wgsl');
  for (const [name, lane] of [
    ['unlitViewBasis', 'x'],
    ['unlitViewNormal', 'y'],
    ['unlitMatcapUv', 'z'],
  ]) {
    const signature = new RegExp(`fn ${name}\\([^]*?\\) -> [^{]+\\{`);
    if (!signature.test(text)) throw new Error(`Missing real unlit helper ${name}`);
    text = text.replace(signature, (match) => `${match}\n  modeCalls.${lane} += 1u;`);
  }
  return `${text}\nvar<private> modeCalls: vec3<u32>;`;
}

async function program(): Promise<string> {
  const catalog: Record<string, string> = {};
  for (const file of readdirSync(root).filter((file) => file.endsWith('.wgsl'))) {
    if (file === 'unlit.wgsl') continue;
    const text = source(file);
    const name = text.match(/^#define_import_path (\S+)/m)?.[1];
    if (name) catalog[name] = text;
  }
  const modules: Record<string, string> = {};
  const visit = (text: string) => {
    for (const match of text.matchAll(/^#import ([\w]+(?:::[\w]+)*)/gm)) {
      const name = match[1];
      if (!name) throw new Error('Missing shader import identity');
      if (modules[name]) continue;
      const imported = catalog[name];
      if (!imported) throw new Error(`Missing production module ${name}`);
      modules[name] = imported;
      visit(imported);
    }
  };
  visit(source('unlit.wgsl'));
  return composeShader(
    `${countedSource()}
@vertex fn testVertex(@builtin(vertex_index) index: u32) -> VsOut {
  var input: VsIn;
  input.pos = vec3(f32((index << 1u) & 2u) * 2.0 - 1.0,
    1.0 - f32(index & 2u) * 2.0, 0.5);
  input.normal = vec3(0.6, 0.0, 0.8);
  input.uv = vec2(0.125, 0.125);
  input.color = vec4(0.5, 0.75, 1.0, 0.5);
  return unlitVertex(input, 0u);
}
struct TestOutput { @location(0) color: vec4<f32>, @location(1) calls: vec4<f32> }
@fragment fn testFragment(input: VsOut) -> TestOutput {
  let color = unlitColor(input, true);
  return TestOutput(color, vec4(vec3<f32>(modeCalls), 1.0));
}
@fragment fn testBackFragment(input: VsOut) -> TestOutput {
  let color = unlitColor(input, false);
  return TestOutput(color, vec4(vec3<f32>(modeCalls), 1.0));
}`,
    modules,
    {
      STORAGE_BUFFER_AVAILABLE: true,
      SKINNING_DISABLED: true,
      VERTEX_COLOR_AVAILABLE: true,
      EXTENDED_LIGHTING_AVAILABLE: false,
      PER_INSTANCE_REGION: false,
    },
  );
}

// Instrument the real shader's helper reachability, not GPU execution time:
// these observable counters deliberately prevent dead-call elimination.
// The independent pixel oracle also covers the production OIT entry points.
it('unlit color skips normal/MatCap work and preserves mode, fog and coverage pixels', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Unlit mode regression requires a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const buffers: GPUBuffer[] = [];
  const textures: GPUTexture[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage });
    buffers.push(value);
    return value;
  };
  const texture = (descriptor: GPUTextureDescriptor) => {
    const value = device.createTexture(descriptor);
    textures.push(value);
    return value;
  };
  try {
    const code = await program();
    const module = device.createShaderModule({ code });
    expect((await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')).toEqual(
      [],
    );
    const pipeline = async (entryPoint: string) =>
      device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'testVertex' },
        primitive: { frontFace: 'cw' },
        fragment: {
          module,
          entryPoint,
          targets: [{ format: 'rgba32float' }, { format: 'rgba32float' }],
        },
      });
    const routes = [
      { entry: 'testFragment', facing: true, oit: undefined },
      { entry: 'testBackFragment', facing: false, oit: undefined },
      { entry: 'fs_oit', facing: true, oit: 'straight' },
      { entry: 'fs_oit_premultiplied', facing: true, oit: 'premultiplied' },
    ] as const;
    const view = buffer(1280, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const materialLayout = derive(DEFAULT_UNLIT_PARAM_SCHEMA);
    const coordinates = materialLayout.coordinateRecords.find(
      (record) => record.parameter === 'baseColorTexture',
    );
    if (coordinates === undefined) throw new Error('Missing Unlit texture coordinates');
    const material = buffer(
      materialLayout.totalBytes,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const mesh = buffer(160, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const instance = buffer(144, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    device.queue.writeBuffer(mesh, 0, identity);
    device.queue.writeBuffer(instance, 0, identity);
    const tex = texture({
      size: [2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Color samples the red top-left texel; MatCap selects the right column.
    device.queue.writeTexture(
      { texture: tex },
      new Uint8Array([255, 64, 32, 128, 32, 255, 64, 0, 255, 64, 32, 128, 32, 255, 64, 0]),
      { bytesPerRow: 8 },
      [2, 2],
    );
    const targets = [0, 1].map(() =>
      texture({
        size: [16, 4],
        format: 'rgba32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }),
    );
    const readback = buffer(2048, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const groups = (p: GPURenderPipeline) => [
      device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: view } }],
      }),
      device.createBindGroup({
        layout: p.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: material } },
          { binding: 1, resource: device.createSampler() },
          { binding: 2, resource: tex.createView() },
        ],
      }),
      device.createBindGroup({
        layout: p.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: mesh } }],
      }),
      device.createBindGroup({
        layout: p.getBindGroupLayout(3),
        entries: [{ binding: 0, resource: { buffer: instance } }],
      }),
    ];
    const draws = [];
    for (const route of routes) {
      const compiled = await pipeline(route.entry);
      draws.push({ ...route, pipeline: compiled, groups: groups(compiled) });
    }
    for (const mode of [0, 1, 2, 0]) {
      for (const composition of [0, 1, 2, 3]) {
        for (const cutoff of [0, 0.35, 0.45]) {
          const values = new Float32Array(320);
          values.set(identity, 0);
          values.set(identity, 44);
          values.set([0, 0, 3], 24);
          values.set([0.1, 0.2, 0.3, 0.2], 284);
          values.set([0, 0.75, composition, 0], 288);
          device.queue.writeBuffer(view, 0, values);
          const params = new Float32Array(materialLayout.totalBytes / 4);
          params.set([0.8, 0.6, 0.4, 0.8, cutoff, 0, mode]);
          params.set([0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0], coordinates.offset / 4);
          device.queue.writeBuffer(material, 0, params);
          for (const draw of draws) {
            const { facing, oit } = draw;
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: targets.map((target) => ({
                view: target.createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
              })),
            });
            pass.setPipeline(draw.pipeline);
            for (const [index, group] of draw.groups.entries()) pass.setBindGroup(index, group);
            pass.draw(3);
            pass.end();
            for (const [index, target] of targets.entries())
              encoder.copyTextureToBuffer(
                { texture: target },
                { buffer: readback, offset: index * 1024, bytesPerRow: 256 },
                [16, 4],
              );
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            expect(errors).toEqual([]);
            const actual = new Float32Array(readback.getMappedRange());
            for (let i = 0; i < 64; i++) {
              const alpha = 0.4 * (mode === 0 ? 128 / 255 : 1);
              const visible = alpha >= cutoff;
              const expectedCalls = mode === 0 ? [0, 0, 0] : mode === 1 ? [1, 1, 0] : [2, 1, 1];
              const x = ((i % 16) + 0.5) / 8 - 1;
              const y = 1 - (Math.floor(i / 16) + 0.5) / 2;
              const distance = Math.hypot(x, y, 2.5);
              const opacity = 0.75 * (1 - Math.exp(-0.2 * distance));
              const weight = Math.min(
                500,
                Math.max(0.01, 10 / (0.00001 + (distance / 5) ** 2 + (distance / 200) ** 6)),
              );
              const auxiliary = oit ? [alpha * weight, 0, 0, alpha] : [...expectedCalls, 1];
              for (let channel = 0; channel < 4; channel++)
                expect(
                  Math.abs(
                    (actual[256 + i * 4 + channel] ?? NaN) -
                      (visible ? (auxiliary[channel] ?? NaN) : 0),
                  ),
                  `mode=${mode}, composition=${composition}, cutoff=${cutoff}, entry=${draw.entry}, channel=${channel}`,
                ).toBeLessThan(0.000001 * Math.max(1, Math.abs(auxiliary[channel] ?? NaN)));
              const normal = facing ? [0.8, 0.5, 0.9] : [0.2, 0.5, 0.1];
              const texel =
                mode === 2 && facing ? [32 / 255, 1, 64 / 255] : [1, 64 / 255, 32 / 255];
              const color = [0.4, 0.45, 0.4].map((tint, channel) => {
                if (mode === 1) return normal[channel] ?? NaN;
                const shaded = tint * (texel[channel] ?? NaN);
                if (composition === 0) return shaded;
                return (
                  shaded * (1 - opacity) +
                  (composition === 3
                    ? 0
                    : (channel + 1) * 0.1 * opacity * (composition === 2 ? alpha : 1))
                );
              });
              const output = [
                ...color.map((value) =>
                  oit ? value * weight * (oit === 'straight' ? alpha : 1) : value,
                ),
                alpha,
              ];
              for (let channel = 0; channel < 4; channel++)
                expect(
                  Math.abs(
                    (actual[i * 4 + channel] ?? NaN) - (visible ? (output[channel] ?? NaN) : 0),
                  ),
                ).toBeLessThan(0.000001 * Math.max(1, Math.abs(output[channel] ?? NaN)));
            }
            readback.unmap();
          }
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    for (const value of buffers) value.destroy();
    for (const value of textures) value.destroy();
    device.destroy();
  }
});
