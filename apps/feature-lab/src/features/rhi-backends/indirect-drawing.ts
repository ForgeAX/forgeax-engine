import type { Buffer, RhiDevice, ShaderModule } from '@forgeax/engine/rhi';
import { CheckList, defineFeature } from '../../lab/feature';
import { readBack, shader, webgpuDevice } from './support/gpu';

const CODE = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0., 1., 0., 1.); }`;

/** Draws a full-screen triangle whose vertex count comes from `args`, returns pixel (0,0) RGBA. */
async function drawWith(
  device: RhiDevice,
  module: ShaderModule,
  args: Buffer,
): Promise<number[] | string> {
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] });
  if (!layout.ok) return `createPipelineLayout: ${layout.error.code}`;
  const pipeline = device.createRenderPipeline({
    layout: layout.value,
    vertex: { module, entryPoint: 'vs', buffers: [] },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  if (!pipeline.ok) return `createRenderPipeline: ${pipeline.error.code}`;
  const target = device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256 * 8,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  if (!target.ok || !readback.ok) return 'target/readback creation failed';
  const view = device.createTextureView(target.value, {});
  const encoder = device.createCommandEncoder({ label: 'lab-indirect-draw' });
  if (!view.ok || !encoder.ok) return 'view/encoder creation failed';
  const pass = encoder.value.beginRenderPass({
    colorAttachments: [
      { view: view.value, loadOp: 'clear', storeOp: 'store', clearValue: [1, 0, 0, 1] },
    ],
  });
  pass.setPipeline(pipeline.value);
  pass.drawIndirect(args, 0);
  pass.end();
  encoder.value.copyTextureToBuffer(
    { texture: target.value },
    { buffer: readback.value, bytesPerRow: 256 },
    [8, 8, 1],
  );
  const finished = encoder.value.finish();
  if (!finished.ok) return `finish: ${finished.error.code}`;
  const submitted = device.queue.submit([finished.value]);
  if (!submitted.ok) return `submit: ${submitted.error.code}`;
  const bytes = await readBack(device, readback.value, 256 * 8);
  return typeof bytes === 'string' ? bytes : Array.from(new Uint8Array(bytes, 0, 4));
}

export default defineFeature({
  title: 'Indirect drawing',
  catalog: 'Indirect drawing',
  kind: 'probe',
  summary:
    'drawIndirect reads vertex/instance counts from a GPU buffer; the same pipeline draws or skips depending only on the indirect arguments.',
  expect:
    'All checks pass: caps.indirectDrawing is true, indirect args [3,1,0,0] paint the red-cleared target green, and args [0,1,0,0] leave it red.',
  setup({ app }) {
    return {
      async checks() {
        const checks = new CheckList();
        const caps = app.renderer.inspect().capabilities;
        checks.equal('lab renderer caps.indirectDrawing', caps.indirectDrawing, true);
        checks.ok(
          'caps.firstInstanceIndirect reported as data',
          typeof caps.firstInstanceIndirect === 'boolean',
          String(caps.firstInstanceIndirect),
        );
        const gpu = await webgpuDevice(checks);
        if (gpu === undefined) return checks.items;
        const { device } = gpu;
        const module = await shader(checks, device, CODE);
        if (module === undefined) return checks.items;
        const usage = GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST;
        const drawArgs = device.createBuffer({ size: 16, usage });
        const skipArgs = device.createBuffer({ size: 16, usage });
        if (!drawArgs.ok || !skipArgs.ok) return checks.ok('indirect buffers created', false).items;
        device.queue.writeBuffer(drawArgs.value, 0, new Uint32Array([3, 1, 0, 0]));
        device.queue.writeBuffer(skipArgs.value, 0, new Uint32Array([0, 1, 0, 0]));
        checks.equal(
          'args [3,1,0,0] -> pixel',
          await drawWith(device, module, drawArgs.value),
          [0, 255, 0, 255],
        );
        checks.equal(
          'args [0,1,0,0] -> pixel',
          await drawWith(device, module, skipArgs.value),
          [255, 0, 0, 255],
        );
        return checks.items;
      },
    };
  },
});
