import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';

describe('RenderGraphBuilder RhiNull integration', () => {
  it('records copy and compute in declaration order on one command encoder', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const data = graph.createBuffer('data', { size: 16 }).unwrap();
    graph
      .addCopyPass('seed', {
        accesses: [{ resource: data, usage: 'copy-dst' }],
        encode: ({ encoder, resources }) => {
          encoder.clearBuffer(resources.buffer(data).unwrap());
        },
      })
      .unwrap();
    graph
      .addComputePass('simulate', {
        accesses: [{ resource: data, usage: 'storage-read-write' }],
        encode: ({ pass, resources }) => {
          expect(resources.buffer(data).ok).toBe(true);
          pass.dispatchWorkgroups(1);
        },
      })
      .unwrap();

    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes).toMatchObject([
      { name: 'seed', kind: 'copy', dependencies: [] },
      { name: 'simulate', kind: 'compute', dependencies: ['seed'] },
    ]);
    const encoder = device.createCommandEncoder({ label: 'graph-frame' }).unwrap();
    expect(compiled.execute({ encoder }).ok).toBe(true);
    expect(encoder.finish().ok).toBe(true);
    expect((device as RhiNullDevice).framePassNames).toEqual(['simulate']);
    expect((await compiled.retire()).ok).toBe(true);
  });

  it('observes compute to indirect raster structure and command counts', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
    const args = graph.createBuffer('draw-args', { size: 16 }).unwrap();
    const output = graph
      .createTexture('output', { format: 'rgba8unorm', size: { width: 1, height: 1 } })
      .unwrap();
    const outputView = graph.view(output, { label: 'output.view' }).unwrap();
    graph
      .addComputePass('build-args', {
        accesses: [{ resource: args, usage: 'storage-write' }],
        encode: ({ pass }) => pass.dispatchWorkgroups(1),
      })
      .unwrap();
    graph
      .addRasterPass('consume-args', {
        accesses: [
          { resource: args, usage: 'indirect-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [{ view: outputView, loadOp: 'clear', storeOp: 'store' }],
        encode: ({ pass, resources }) => {
          const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
          pass.setBindGroup(0, device.createBindGroup({ layout, entries: [] }).unwrap());
          pass.drawIndirect(resources.buffer(args).unwrap(), 0);
        },
      })
      .unwrap();

    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    expect(compiled.inspect().passes).toMatchObject([
      { name: 'build-args', kind: 'compute', dependencies: [] },
      { name: 'consume-args', kind: 'raster', dependencies: ['build-args'] },
    ]);
    const encoder = device.createCommandEncoder({ label: 'mixed-frame' }).unwrap();
    expect(compiled.execute({ encoder }).ok).toBe(true);
    expect(encoder.finish().ok).toBe(true);
    expect((device as RhiNullDevice).framePassNames).toEqual(['build-args', 'consume-args']);
    expect((device as RhiNullDevice).totalDispatchCount).toBe(1);
    expect((device as RhiNullDevice).totalDrawCount).toBe(1);
    expect((device as RhiNullDevice).totalBindGroupCount).toBe(1);
    expect((await compiled.retire()).ok).toBe(true);
  });
});

it('resolves declared view extents from compiled imported/created allocation and mip facts', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const importedTexture = device
    .createTexture({ size: [513, 259], format: 'rgba8unorm', mipLevelCount: 4, usage: 0x10 })
    .unwrap();
  const imported = graph
    .importTexture(
      'surface',
      { size: 'surface', format: 'rgba8unorm', mipLevelCount: 4, usage: 0x10 },
      () => importedTexture,
    )
    .unwrap();
  const view = graph.view(imported, { baseMipLevel: 2, mipLevelCount: 1 }).unwrap();
  const undeclared = graph.view(imported, { baseMipLevel: 1, mipLevelCount: 1 }).unwrap();
  const other = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const foreign = other
    .view(
      other
        .createTexture('foreign', { size: { width: 1, height: 1 }, format: 'rgba8unorm' })
        .unwrap(),
    )
    .unwrap();
  graph
    .addRasterPass('extent', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ resources }) => {
        expect(resources.textureViewExtent(view).unwrap()).toEqual({ width: 128, height: 64 });
        const hidden = resources.textureViewExtent(undeclared);
        expect(hidden.ok ? undefined : hidden.error.code).toBe('resource-not-declared-by-pass');
        const wrongOwner = resources.textureViewExtent(foreign);
        expect(wrongOwner.ok ? undefined : wrongOwner.error.code).toBe('foreign-resource-handle');
      },
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 513, height: 259 } }).unwrap();
  compiled.execute({ encoder: device.createCommandEncoder().unwrap() }).unwrap();
  await compiled.retire();
  device.destroyTexture(importedTexture).unwrap();
});
