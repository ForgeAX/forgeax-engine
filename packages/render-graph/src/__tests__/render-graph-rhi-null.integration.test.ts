import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
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

  it('emits changing physical work in order and rejects unreadied scopes before allocating', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    for (let frame = 0; frame < 60; frame++) {
      const size = { width: frame + 1, height: 2 };
      const procedure = RenderGraphBuilder.procedure<{ encoder: RhiCommandEncoder }>({
        device,
        surfaceSize: size,
      });
      const graph = procedure.passes;
      const data = graph.createBuffer('rows', { size: 16 }).unwrap();
      const order: number[] = [];
      const count = 1 + (frame % 13);
      for (let i = 0; i < count; i++) {
        graph
          .addCopyPass(`stage-${i}`, {
            accesses: [{ resource: data, usage: i === 0 ? 'copy-dst' : 'copy-src' }],
            encode: ({ resources }) => {
              expect(resources.buffer(data).ok).toBe(true);
              order.push(i);
            },
          })
          .unwrap();
      }
      const program = procedure.bindResources().unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      program.execute({ encoder }).unwrap();
      encoder.finish().unwrap();
      expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(procedure.bindResources().ok).toBe(false);
      (await program.retire()).unwrap();
    }
    const size = { width: 1, height: 1 };
    const bad = RenderGraphBuilder.procedure({ device, surfaceSize: size });
    const allocation = vi.spyOn(device, 'createBuffer');
    const buffer = bad.passes.createBuffer('empty', { size: 16 }).unwrap();
    bad.passes
      .addCopyPass('first-read', {
        accesses: [{ resource: buffer, usage: 'copy-src' }],
        encodeDirect() {},
      })
      .unwrap();
    expect(bad.bindResources()).toMatchObject({
      ok: false,
      error: {
        code: 'uninitialized-read',
        detail: { passName: 'first-read', resourceLabel: 'empty' },
      },
    });
    expect(allocation).not.toHaveBeenCalled();
    allocation.mockRestore();
  });

  it('resolves attachment load per execution without retaining the previous frame operation', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const output = device
      .createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x10 })
      .unwrap();
    const builder = new RenderGraphBuilder<{
      readonly encoder: RhiCommandEncoder;
      readonly clear: boolean;
    }>();
    const target = builder
      .importTexture(
        'surface',
        { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
        () => output,
      )
      .unwrap();
    const view = builder.view(target).unwrap();
    builder
      .addRasterPass('presentation', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [
          { view, loadOp: (frame) => (frame.clear ? 'clear' : 'load'), storeOp: 'store' },
        ],
        encodeDirect: () => {},
      })
      .unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const begin = encoder.beginRenderPass.bind(encoder);
    const operations: GPULoadOp[] = [];
    encoder.beginRenderPass = (descriptor) => {
      for (const attachment of descriptor.colorAttachments) {
        const operation = attachment?.loadOp;
        if (operation !== undefined) operations.push(operation);
      }
      return begin(descriptor);
    };
    for (const clear of [true, false, true]) compiled.execute({ encoder, clear }).unwrap();
    expect(operations).toEqual(['clear', 'load', 'clear']);
    encoder.finish().unwrap();
    (await compiled.retire()).unwrap();
    device.destroyTexture(output).unwrap();
  });

  it('selects the actual first depth and stencil writer each frame in both execution modes', async () => {
    type Frame = { encoder: RhiCommandEncoder; seeded: boolean };
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const options = { device, surfaceSize: { width: 1, height: 1 } };
    for (const ordered of [false, true]) {
      for (const seedDeclared of [false, true]) {
        const recording = ordered ? RenderGraphBuilder.procedure<Frame>(options) : undefined;
        const graph = recording?.passes ?? new RenderGraphBuilder<Frame>();
        const texture = graph
          .createTexture('depth', { size: 'surface', format: 'depth24plus-stencil8' })
          .unwrap();
        const view = graph.view(texture).unwrap();
        const accesses = [{ resource: view, usage: 'depth-stencil-write' }] as const;
        const store = { view, depthStoreOp: 'store', stencilStoreOp: 'store' } as const;
        if (seedDeclared)
          graph
            .addRasterPass('early', {
              accesses,
              colorAttachments: [],
              executeIf: (frame) => frame.seeded,
              depthStencilAttachment: { ...store, depthLoadOp: 'clear', stencilLoadOp: 'clear' },
              encodeDirect() {},
            })
            .unwrap();
        const load = vi.fn((frame: Frame): GPULoadOp => (frame.seeded ? 'load' : 'clear'));
        graph
          .addRasterPass('geometry', {
            accesses,
            colorAttachments: [],
            depthStencilAttachment: { ...store, depthLoadOp: load, stencilLoadOp: load },
            encodeDirect() {},
          })
          .unwrap();
        const program =
          recording === undefined ? graph.compile(options) : recording.bindResources();
        if (!seedDeclared) {
          expect(program).toMatchObject({ ok: false, error: { code: 'uninitialized-read' } });
          continue;
        }
        const compiled = program.unwrap();
        for (let index = 0; index < 60; index++) {
          const seeded = index % 2 === 0;
          const actual: (GPULoadOp | undefined)[][] = [];
          const encoder = device.createCommandEncoder().unwrap();
          const begin = encoder.beginRenderPass.bind(encoder);
          encoder.beginRenderPass = (desc) => {
            actual.push([
              desc.depthStencilAttachment?.depthLoadOp,
              desc.depthStencilAttachment?.stencilLoadOp,
            ]);
            return begin(desc);
          };
          compiled.execute({ encoder, seeded }).unwrap();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          expect(actual).toEqual(
            seeded
              ? [
                  ['clear', 'clear'],
                  ['load', 'load'],
                ]
              : [['clear', 'clear']],
          );
        }
        expect(load).toHaveBeenCalledTimes(60);
        (await compiled.retire()).unwrap();
      }
    }
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
