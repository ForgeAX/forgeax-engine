import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';
import { deferredShaderImports } from './deferred-shader.fixture';

it('projects reverse-Z contact, tile edges, and cascade transitions on native depth', async () => {
  const program = await compileShader(
    `
#import forgeax_pbr::lighting_directional::{canUseProjectedDirectionalPcf, evalProjectedDirectionalShadow}
@group(1) @binding(0) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn sample(@builtin(global_invocation_id) id: vec3<u32>) {
  let point = array<vec4f, 9>(
    vec4f(-0.5, 0.0, 0.5, -6.0), vec4f(0.5, 0.0, 0.5, -6.0),
    vec4f(0.0, 0.0, 0.5, -6.0), vec4f(0.5, 0.0, 0.5, -9.0),
    vec4f(0.5, 0.0, 0.5, -10.0), vec4f(0.5, 0.0, 0.5, -21.0),
    vec4f(-0.5, -1.0, 0.5, -6.0), vec4f(1.02, 0.0, 0.5, -6.0),
    vec4f(0.5, 0.0, 0.5, -6.0)
  )[id.x];
  let nDotL = select(1.0, 0.5, id.x == 8u);
  output[id.x] = select(-1.0, evalProjectedDirectionalShadow(point.xyz, point.w, 2u, vec2f(0), nDotL),
    canUseProjectedDirectionalPcf());
}`,
    {
      id: 'projected_shadow_fixture',
      imports: deferredShaderImports,
      defines: { STORAGE_BUFFER_AVAILABLE: true, DIRECTIONAL_PCSS_AVAILABLE: true },
    },
  );
  if (!program.ok) throw program.error;
  const view = program.value.reflection?.boundGlobals.find(
    ({ group, binding }) => group === 0 && binding === 0,
  );
  if (view?.span === undefined) throw new Error('Missing projected shadow view layout');
  const data = new Float32Array(view.span / 4);
  const write = (name: string, values: readonly number[]) => {
    const member = view.members?.find((entry) => entry.name === name);
    if (member === undefined) throw new Error(`Missing View.${name}`);
    data.set(values, member.offset / 4);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  write('lightViewProj_A', identity);
  write('lightViewProj_B', identity);
  write('cascadeCount', [2]);
  write('cascadeBlend', [0.2]);
  write('directionalShadowFilter', [6, 0, 0, 0]);
  // A ten millidepth transition. An aspect of two restricts sampling to
  // the top eight rows even though the raw allocation has sixteen.
  write('splitPlanes', [10, 0.004, 1, 0, 20, 0.004, 1, 0, 0, 0, 0, -1, 0, 0, 0, 2]);

  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Projected shadow regression requires a GPU adapter');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const depth = device.createTexture({
      size: [16, 16, 4],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const seed = device.createShaderModule({
      code: `
struct Out { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) layer: u32 }
@vertex fn vs(@builtin(vertex_index) i: u32, @builtin(instance_index) layer: u32) -> Out {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[i];
  return Out(vec4f(p, 0, 1), layer);
}
@fragment fn fs(in: Out) -> @builtin(frag_depth) f32 {
  let blocker = select(0.55, 0.505, in.layer == 2u);
  return select(select(0.0, blocker, in.pos.x >= 8.0), 0.98, in.pos.y >= 8.0);
}`,
    });
    const writer = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: seed, entryPoint: 'vs' },
      fragment: { module: seed, entryPoint: 'fs', targets: [] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    });
    const module = device.createShaderModule({ code: program.value.wgsl });
    const receiver = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'sample' },
    });
    const uniform = (values: Float32Array | Uint32Array) => {
      const buffer = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buffer, 0, values);
      return { buffer };
    };
    const caster = new Uint32Array(20);
    caster[2] = 1; // Native fitted orthographic caster.
    const viewGroup = device.createBindGroup({
      layout: receiver.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: uniform(data) },
        { binding: 3, resource: depth.createView({ dimension: '2d-array' }) },
        { binding: 7, resource: uniform(caster) },
      ],
    });
    const size = 9 * Float32Array.BYTES_PER_ELEMENT;
    const output = device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const outputGroup = device.createBindGroup({
      layout: receiver.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const encoder = device.createCommandEncoder();
    for (const layer of [2, 3]) {
      const raster = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: depth.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
        },
      });
      raster.setPipeline(writer);
      raster.draw(3, 1, 0, layer);
      raster.end();
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(receiver);
    pass.setBindGroup(0, viewGroup);
    pass.setBindGroup(1, outputGroup);
    pass.dispatchWorkgroups(9);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = Array.from(new Float32Array(readback.getMappedRange()));
    readback.unmap();
    const expected = [1, 0.5, 0.75, 0.25, 0, 1, 1, 1, 0.725];
    for (const [index, visibility] of expected.entries())
      expect(actual[index], `projected shadow sample ${index}`).toBeCloseTo(visibility, 5);
  } finally {
    const error = await device.popErrorScope();
    device.destroy();
    expect(error?.message).toBeUndefined();
  }
});
