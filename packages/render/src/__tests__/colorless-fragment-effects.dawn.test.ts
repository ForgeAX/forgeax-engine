import { createMaterialShaderProgram } from '@forgeax/engine-shader';
import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { colorlessFragmentEntry } from '../material-stage-constants';

// Classification inputs isolate the fragment-elision decision. The program's
// effects come from the actual portable compiler, never a handwritten effect.
const receipt = { materialRow: { fields: [] } } as unknown as MaterialProgramAbi;

it.each([
  'depth',
  'discard',
  'storage',
  'legacy-color',
] as const)('keeps native %s effects in a colorless prepass, with a forced-drop negative control', async (effect) => {
  const fragment =
    effect === 'depth'
      ? 'fn fs_ao_input() -> @builtin(frag_depth) f32 { return 0.25; }'
      : effect === 'discard'
        ? 'fn fs_ao_input() { discard; }'
        : effect === 'storage'
          ? 'fn fs_ao_input() { counter[0] = 23u; }'
          : 'fn fs_ao_input() -> @location(0) u32 { return 1u; }';
  const compiled = (
    await compileShader(
      `
@group(0) @binding(0) var<storage, read_write> counter: array<u32, 4>;
fn unused_kill() { discard; }
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var points = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(points[i], 0.5, 1.0);
}
@fragment ${fragment}
`,
      {
        renderEntries: {
          vertex: 'vs_main',
          fragment: 'fs_ao_input',
          colorFormats: effect === 'legacy-color' ? ['r32uint'] : [],
        },
      },
    )
  ).unwrap();
  const program = createMaterialShaderProgram(
    compiled.wgsl,
    effect === 'legacy-color' ? undefined : compiled.reflection.entryPoints,
  );
  const entry = colorlessFragmentEntry(
    true,
    'ALPHA_MASK=false',
    receipt,
    0,
    'fs_ao_input',
    program,
  );
  expect(entry).toBe('fs_ao_input');
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw Error('Native fragment effects need a Dawn adapter');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const module = device.createShaderModule({ code: compiled.wgsl });
  expect(
    (await module.getCompilationInfo()).messages.filter((message) => message.type === 'error'),
  ).toEqual([]);
  try {
    for (const keep of [true, false]) {
      const depth = device.createTexture({
        size: [4, 4],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      const counter = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const readback = device.createBuffer({
        size: 1280,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const pipeline = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs_main' },
          ...(keep
            ? { fragment: { module, entryPoint: entry ?? 'fs_ao_input', targets: [] } }
            : {}),
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: {
            format: 'depth32float',
            depthCompare: 'greater',
            depthWriteEnabled: true,
          },
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        pass.setPipeline(pipeline);
        if (keep && effect === 'storage')
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: counter } }],
            }),
          );
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: depth, aspect: 'depth-only' },
          { buffer: readback, bytesPerRow: 256 },
          [4, 4],
        );
        encoder.copyBufferToBuffer(counter, 0, readback, 1024, 16);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const bytes = readback.getMappedRange();
        expect(new Float32Array(bytes)[0]).toBe(
          keep ? (effect === 'depth' ? 0.25 : effect === 'discard' ? 0 : 0.5) : 0.5,
        );
        expect(new Uint32Array(bytes, 1024, 4)[0]).toBe(keep && effect === 'storage' ? 23 : 0);
        readback.unmap();
        expect(errors).toEqual([]);
      } finally {
        depth.destroy();
        counter.destroy();
        readback.destroy();
      }
    }
  } finally {
    device.destroy();
  }
});
