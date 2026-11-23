import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { pmremExtent } from '../ibl/pmrem';
import { addCurrentReflectionProbeFilters } from '../record/reflection-probe-pmrem';
import { addPmremArrayMigrations, PmremArrayPool } from '../reflection/pmrem-array';
import type { RenderPipelineFrame } from '../render-pipeline';

it.each([
  'declared',
  'current',
] as const)('renders PMREM array layers, migrates using %s work and samples both native views', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: unknown[] = [];
  const pool = new PmremArrayPool(device, (error) => errors.push(error));
  const buffers: import('@forgeax/engine-rhi').Buffer[] = [];
  const a = pool.acquire('probe-a', 16, 'rgba8unorm', 3, 64 * 1024 * 1024);
  const b = pool.acquire('probe-b', 16, 'rgba8unorm', 3, 64 * 1024 * 1024);
  if (!a || !b) throw new Error('native array allocation required');
  try {
    const module = (
      await createShaderModule(device, {
        code: `
@group(0) @binding(0) var<uniform> color: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
 return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);
}
@fragment fn fs() -> @location(0) vec4f { return color; }
`,
      })
    ).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
      })
      .unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const fill = device.createCommandEncoder().unwrap();
    for (const [lease, color] of [
      [a, [1, 0, 0, 1]],
      [b, [0, 1, 0, 1]],
    ] as const) {
      const image = pool.snapshot(lease);
      if (!image) throw new Error('native layer view required');
      const uniform = device.createBuffer({ size: 16, usage: 64 | 8 }).unwrap();
      buffers.push(uniform);
      device.queue.writeBuffer(uniform, 0, new Float32Array(color)).unwrap();
      const group = device
        .createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } }],
        })
        .unwrap();
      const pass = fill.beginRenderPass({
        colorAttachments: [
          {
            view: image.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([fill.finish().unwrap()]).unwrap();
    expect(pool.acquire('probe-c', 16, 'rgba8unorm', 4, 64 * 1024 * 1024)).toBeUndefined();
    const ticket = pool.takeMigrations()[0];
    if (!ticket) throw new Error('actual migration required');
    const previous = pool.snapshot(a);
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    if (mode === 'current') addCurrentReflectionProbeFilters(graph).unwrap();
    else addPmremArrayMigrations(graph, [ticket]).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const copies = vi.spyOn(encoder, 'copyTextureToTexture');
    compiled
      .execute({
        encoder,
        probeFilterWork: { work: [], migrations: [ticket] },
      } as unknown as RenderPipelineFrame)
      .unwrap();
    expect(copies.mock.calls.map(([from, to, size]) => [from.origin, to.origin, size])).toEqual(
      [0, 1].map((layer) => [
        [0, 0, layer],
        [0, 0, layer],
        { ...pmremExtent(16), depthOrArrayLayers: 1 },
      ]),
    );
    expect(pool.snapshot(a)).toBe(previous);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    pool.complete(ticket, true);
    const first = pool.snapshot(a),
      second = pool.snapshot(b);
    if (!first || !second) throw new Error('migrated native views required');
    expect(first.texture).not.toBe(previous?.texture);
    const compute = (
      await createShaderModule(device, {
        code: `
@group(0) @binding(0) var layered: texture_2d_array<f32>;
@group(0) @binding(1) var first: texture_2d<f32>;
@group(0) @binding(2) var second: texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> output: array<vec4f>;
@compute @workgroup_size(1) fn cs() {
 output[0]=textureLoad(layered,vec2i(8),0,0);
 output[1]=textureLoad(layered,vec2i(8),1,0);
 output[2]=textureLoad(first,vec2i(8),0);
 output[3]=textureLoad(second,vec2i(8),0);
}
`,
      })
    ).unwrap();
    const computeLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 4,
            texture: { sampleType: 'float', viewDimension: '2d-array' },
          },
          { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
          { binding: 2, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
          { binding: 3, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const consumer = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }).unwrap(),
        compute: { module: compute, entryPoint: 'cs' },
      })
      .unwrap();
    const output = device.createBuffer({ size: 64, usage: 128 | 4 }).unwrap();
    const staging = device.createBuffer({ size: 64, usage: 1 | 8 }).unwrap();
    buffers.push(output, staging);
    const group = device
      .createBindGroup({
        layout: computeLayout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: first.arrayView } },
          { binding: 1, resource: { kind: 'textureView', value: first.view } },
          { binding: 2, resource: { kind: 'textureView', value: second.view } },
          { binding: 3, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const read = device.createCommandEncoder().unwrap();
    const pass = read.beginComputePass();
    pass.setPipeline(consumer);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    read.copyBufferToBuffer(output, 0, staging, 0, 64);
    device.queue.submit([read.finish().unwrap()]).unwrap();
    const mapped = (await staging.mapAsync(1)).unwrap();
    expect(Array.from(new Float32Array(mapped.getMappedRange().unwrap()))).toEqual([
      1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1,
    ]);
    mapped.unmap();
    expect(errors).toEqual([]);
    await compiled.retire();
  } finally {
    pool.dispose();
    for (const buffer of buffers) device.destroyBuffer(buffer);
  }
}, 30_000);
