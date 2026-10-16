import type { Buffer, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import type { CompiledRenderGraph, RenderGraphFrame } from '../types.js';

interface Frame extends RenderGraphFrame {
  readonly external: Buffer;
}
async function compile(graph: RenderGraphBuilder<Frame>) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  return { device, result: graph.compile({ device, surfaceSize: { width: 16, height: 16 } }) };
}
function passDependencies(compiled: CompiledRenderGraph<Frame>) {
  return compiled.inspect().passes.map(({ name, dependencies }) => ({ name, dependencies }));
}

describe('RenderGraph access history public contracts', () => {
  it('retains RAW/WAR/WAW and execution order across unrelated resource accesses', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const x = graph.createBuffer('x', { size: 16 }).unwrap();
    const y = graph.createBuffer('y', { size: 16 }).unwrap();
    const noise = graph.createBuffer('noise', { size: 16 }).unwrap();
    graph
      .addCopyPass('seed-x', {
        accesses: [{ resource: x, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('noise-write', {
        accesses: [{ resource: noise, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('reader-one', {
        accesses: [
          { resource: x, usage: 'copy-src' },
          { resource: y, usage: 'copy-dst' },
        ],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('reader-two', {
        accesses: [{ resource: x, usage: 'copy-src' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('rewrite-x', {
        accesses: [
          { resource: y, usage: 'copy-src' },
          { resource: x, usage: 'copy-dst' },
        ],
        encode: () => undefined,
      })
      .unwrap();
    const { device, result } = await compile(graph);
    const compiled = result.unwrap();
    const external = device.createBuffer({ size: 16, usage: 0x00c4 }).unwrap();
    try {
      expect(passDependencies(compiled)).toEqual([
        { name: 'seed-x', dependencies: [] },
        { name: 'noise-write', dependencies: [] },
        { name: 'reader-one', dependencies: ['seed-x'] },
        { name: 'reader-two', dependencies: ['seed-x'] },
        { name: 'rewrite-x', dependencies: ['seed-x', 'reader-one', 'reader-two'] },
      ]);
      const encoder: RhiCommandEncoder = device
        .createCommandEncoder({ label: 'access-history' })
        .unwrap();
      const events: string[] = [];
      compiled
        .execute({ encoder, external }, (pass, encode) => {
          events.push(`${pass.executionIndex}:${pass.kind}:${pass.name}`);
          encode();
        })
        .unwrap();
      encoder.finish().unwrap();
      expect(events).toEqual([
        '0:copy:seed-x',
        '1:copy:noise-write',
        '2:copy:reader-one',
        '3:copy:reader-two',
        '4:copy:rewrite-x',
      ]);
    } finally {
      device.destroyBuffer(external).unwrap();
      await compiled.retire();
    }
  });

  it('retains older overlapping writers and readers when newer mips and layers are disjoint', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph
      .createTexture('subresource', {
        format: 'rgba8unorm',
        size: { width: 16, height: 16, depthOrArrayLayers: 2 },
        mipLevelCount: 2,
      })
      .unwrap();
    const a = graph
      .view(texture, {
        label: 'mip0-layer0',
        dimension: '2d-array',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      })
      .unwrap();
    const b = graph
      .view(texture, {
        label: 'mip1-layer1',
        dimension: '2d-array',
        baseMipLevel: 1,
        mipLevelCount: 1,
        baseArrayLayer: 1,
        arrayLayerCount: 1,
      })
      .unwrap();
    graph
      .addCopyPass('seed-a', {
        accesses: [{ resource: a, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('newer-disjoint-b', {
        accesses: [{ resource: b, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('read-a', {
        accesses: [{ resource: a, usage: 'copy-src' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('read-b', {
        accesses: [{ resource: b, usage: 'copy-src' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('rewrite-a', {
        accesses: [{ resource: a, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    const compiled = (await compile(graph)).result.unwrap();
    try {
      expect(passDependencies(compiled)).toEqual([
        { name: 'seed-a', dependencies: [] },
        { name: 'newer-disjoint-b', dependencies: [] },
        { name: 'read-a', dependencies: ['seed-a'] },
        { name: 'read-b', dependencies: ['newer-disjoint-b'] },
        { name: 'rewrite-a', dependencies: ['seed-a', 'read-a'] },
      ]);
    } finally {
      await compiled.retire();
    }
  });

  it('retains separate depth/stencil ranges and all-aspect overlap', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph
      .createTexture('depth-stencil', {
        format: 'depth24plus-stencil8',
        size: { width: 16, height: 16 },
      })
      .unwrap();
    const depth = graph.view(texture, { label: 'depth', aspect: 'depth-only' }).unwrap();
    const stencil = graph.view(texture, { label: 'stencil', aspect: 'stencil-only' }).unwrap();
    const all = graph.view(texture, { label: 'all', aspect: 'all' }).unwrap();
    graph
      .addCopyPass('seed-depth', {
        accesses: [{ resource: depth, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('seed-stencil', {
        accesses: [{ resource: stencil, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('read-depth', {
        accesses: [{ resource: depth, usage: 'copy-src' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('read-all', {
        accesses: [{ resource: all, usage: 'copy-src' }],
        encode: () => undefined,
      })
      .unwrap();
    const compiled = (await compile(graph)).result.unwrap();
    try {
      expect(passDependencies(compiled)).toEqual([
        { name: 'seed-depth', dependencies: [] },
        { name: 'seed-stencil', dependencies: [] },
        { name: 'read-depth', dependencies: ['seed-depth'] },
        { name: 'read-all', dependencies: ['seed-stencil'] },
      ]);
    } finally {
      await compiled.retire();
    }
  });

  it('retains the original first conflicting pair across interleaved resources', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const a = graph
      .importBuffer('earliest-a', { size: 16, usage: 0x0080 }, (frame) => frame.external)
      .unwrap();
    const b = graph
      .importBuffer('later-b', { size: 16, usage: 0x0080 }, (frame) => frame.external)
      .unwrap();
    graph
      .addComputePass('two-conflicts', {
        accesses: [
          { resource: a, usage: 'storage-read' },
          { resource: b, usage: 'storage-read' },
          { resource: b, usage: 'storage-write' },
          { resource: a, usage: 'storage-write' },
        ],
        encode: () => undefined,
      })
      .unwrap();
    const { result } = await compile(graph);
    expect(result.ok).toBe(false);
    if (result.ok) {
      await result.value.retire();
      throw new Error('Expected original access conflict');
    }
    expect({
      code: result.error.code,
      expected: result.error.expected,
      hint: result.error.hint,
      detail: result.error.detail,
    }).toEqual({
      code: 'access-conflict',
      expected:
        "pass 'two-conflicts' uses resource 'earliest-a' in one compatible WebGPU usage scope",
      hint: 'split conflicting read/write roles into ordered passes or use storage-read-write once',
      detail: {
        passName: 'two-conflicts',
        resourceLabel: 'earliest-a',
        accesses: ['storage-read', 'storage-write'],
      },
    });
  });

  it('publishes compatible same-pass imported read-write accesses only after that pass', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const data = graph
      .importBuffer('imported-read-write', { size: 16, usage: 0x0080 }, (frame) => frame.external)
      .unwrap();
    graph
      .addComputePass('same-pass-compatible', {
        accesses: [
          { resource: data, usage: 'storage-read-write' },
          { resource: data, usage: 'storage-read-write' },
        ],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addComputePass('later-reader', {
        accesses: [{ resource: data, usage: 'storage-read' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addComputePass('rewrite', {
        accesses: [{ resource: data, usage: 'storage-write' }],
        encode: () => undefined,
      })
      .unwrap();
    const compiled = (await compile(graph)).result.unwrap();
    try {
      expect(passDependencies(compiled)).toEqual([
        { name: 'same-pass-compatible', dependencies: [] },
        { name: 'later-reader', dependencies: ['same-pass-compatible'] },
        { name: 'rewrite', dependencies: ['same-pass-compatible', 'later-reader'] },
      ]);
      expect(compiled.inspect().passes[0]?.accesses).toEqual([
        { resource: 'imported-read-write', usage: 'storage-read-write' },
        { resource: 'imported-read-write', usage: 'storage-read-write' },
      ]);
    } finally {
      await compiled.retire();
    }
  });

  it('does not let a graph-created read-write access initialize its own pass', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const data = graph.createBuffer('created-read-write', { size: 16 }).unwrap();
    graph
      .addComputePass('must-not-self-initialize', {
        accesses: [{ resource: data, usage: 'storage-read-write' }],
        encode: () => undefined,
      })
      .unwrap();
    const { result } = await compile(graph);
    expect(result.ok).toBe(false);
    if (result.ok) {
      await result.value.retire();
      throw new Error('Expected uninitialized read');
    }
    expect(result.error.code).toBe('uninitialized-read');
    expect(result.error.detail).toEqual({
      passName: 'must-not-self-initialize',
      resourceLabel: 'created-read-write',
      usage: 'storage-read-write',
    });
  });

  it('refuses reading an unwritten mip despite a writer for another mip', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph
      .createTexture('partly-written', {
        format: 'rgba8unorm',
        size: { width: 16, height: 16 },
        mipLevelCount: 2,
      })
      .unwrap();
    const mip0 = graph
      .view(texture, { label: 'written-mip0', baseMipLevel: 0, mipLevelCount: 1 })
      .unwrap();
    const mip1 = graph
      .view(texture, { label: 'unwritten-mip1', baseMipLevel: 1, mipLevelCount: 1 })
      .unwrap();
    graph
      .addCopyPass('seed-only-mip0', {
        accesses: [{ resource: mip0, usage: 'copy-dst' }],
        encode: () => undefined,
      })
      .unwrap();
    graph
      .addCopyPass('refuse-mip1-read', {
        accesses: [{ resource: mip1, usage: 'copy-src' }],
        encode: () => undefined,
      })
      .unwrap();
    const { result } = await compile(graph);
    expect(result.ok).toBe(false);
    if (result.ok) {
      await result.value.retire();
      throw new Error('Expected uninitialized mip read');
    }
    expect(result.error.code).toBe('uninitialized-read');
    expect(result.error.detail).toEqual({
      passName: 'refuse-mip1-read',
      resourceLabel: 'partly-written',
      usage: 'copy-src',
    });
  });
});
