import type {
  Buffer,
  ComputePassDescriptor,
  QuerySet,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { RAY_QUERY_BACKEND_UNSUPPORTED } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';
import { ok } from '../errors.js';
import type { RenderGraphFrame, RenderGraphPassInstrumentation } from '../types.js';

interface Frame extends RenderGraphFrame {
  readonly imported: Buffer;
  readonly importedTexture?: Texture;
  readonly importedView?: TextureView;
}

function caps(overrides: Partial<RhiDevice['caps']> = {}): RhiDevice['caps'] {
  return {
    backendKind: 'null',
    compute: true,
    storageBuffer: true,
    storageTexture: true,
    timestampQuery: false,
    timestampPeriodNanoseconds: null,
    indirectDrawing: true,
    textureCompressionBc: false,
    textureCompressionEtc2: false,
    textureCompressionAstc: false,
    multiDrawIndirect: false,
    pushConstants: false,
    textureBindingArray: false,
    samplerAliasing: true,
    firstInstanceIndirect: false,
    rgba16floatRenderable: true,
    rg11b10ufloatRenderable: true,
    float32Filterable: true,
    textureImport: false,
    externalTexture: false,
    maxColorAttachments: 8,
    rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    ...overrides,
  };
}

function mockDevice(overrides: Partial<RhiDevice> = {}): RhiDevice {
  let next = 1;
  return {
    caps: caps(),
    limits: {} as never,
    features: new Set() as never,
    queue: {
      onSubmittedWorkDone: async () => undefined,
    } as never,
    createBuffer: () => ({ ok: true, value: { id: next++ } as unknown as Buffer }),
    createTexture: () => ({ ok: true, value: { id: next++ } as unknown as Texture }),
    createTextureView: () => ({ ok: true, value: { id: next++ } as unknown as TextureView }),
    destroyBuffer: () => ({ ok: true, value: undefined }),
    destroyTexture: () => ({ ok: true, value: undefined }),
    ...overrides,
  } as unknown as RhiDevice;
}

function mockEncoder(events: string[] = []): RhiCommandEncoder {
  return {
    beginComputePass: ({ label, timestampWrites }: ComputePassDescriptor = {}) => {
      if (timestampWrites !== undefined) events.push('timestamp-writes');
      events.push(`begin-compute:${label}`);
      return {
        setPipeline: () => undefined,
        setBindGroup: () => undefined,
        dispatchWorkgroups: () => events.push('dispatch'),
        dispatchWorkgroupsIndirect: () => events.push('dispatch-indirect'),
        end: () => events.push('end-compute'),
      } as unknown as RhiComputePassEncoder;
    },
    beginRenderPass: () => {
      events.push('begin-raster');
      return { end: () => events.push('end-raster') } as never;
    },
    clearBuffer: () => events.push('clear-buffer'),
  } as unknown as RhiCommandEncoder;
}

function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error('expected ok result');
  return result.value;
}

describe('RenderGraphBuilder resource and temporal contracts', () => {
  it('keeps attachment format declarations closed at the graph boundary', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph.createTexture('format-checked', {
      format: 'rgba8unorm',
      size: 'surface',
    });
    expect(texture.ok).toBe(true);
  });

  it('rejects duplicate resource labels and duplicate pass names at declaration time', () => {
    const graph = new RenderGraphBuilder<Frame>();
    expect(graph.createBuffer('data', { size: 16 }).ok).toBe(true);
    const duplicateResource = graph.createBuffer('data', { size: 16 });
    expect(duplicateResource.ok).toBe(false);
    if (!duplicateResource.ok)
      expect(duplicateResource.error.code).toBe('duplicate-resource-label');

    expect(graph.addCopyPass('copy', { accesses: [], encode: () => undefined }).ok).toBe(true);
    const duplicatePass = graph.addCopyPass('copy', { accesses: [], encode: () => undefined });
    expect(duplicatePass.ok).toBe(false);
    if (!duplicatePass.ok) expect(duplicatePass.error.code).toBe('duplicate-pass-name');
  });

  it('seals the builder after compile and keeps the compiled snapshot immutable', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const compiled = graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    const mutation = graph.createBuffer('late', { size: 16 });
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) expect(mutation.error.code).toBe('builder-sealed');
    if (compiled.ok) expect(compiled.value.inspect().passes).toEqual([]);
  });

  it('deep freezes compiled texture extent objects', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = value(
      graph.createTexture('sized', {
        format: 'rgba8unorm',
        size: { width: 7, height: 5, depthOrArrayLayers: 2 },
      }),
    );
    const view = graph.view(texture).unwrap();
    graph.addRasterPass('write-sized', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    });
    const compiled = graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const resource = compiled.value.inspect().resources.find(({ label }) => label === 'sized');
    expect(resource).toBeDefined();
    if (resource?.descriptor.kind !== 'texture') return;
    expect(Object.isFrozen(resource.descriptor)).toBe(true);
    expect(Object.isFrozen(resource.descriptor.size)).toBe(true);
    const snapshot = JSON.stringify(resource);
    try {
      (resource.descriptor.size as { width: number }).width = 99;
    } catch {
      // Frozen snapshots reject mutation in strict mode.
    }
    expect(JSON.stringify(resource)).toBe(snapshot);
  });

  it('accepts imported first-read and rejects graph-created first-read', () => {
    const importedGraph = new RenderGraphBuilder<Frame>();
    const imported = value(
      importedGraph.importBuffer(
        'external',
        { size: 16, usage: 0x0040 },
        (frame) => frame.imported,
      ),
    );
    importedGraph.addComputePass('consume', {
      accesses: [{ resource: imported, usage: 'uniform-read' }],
      encode: () => undefined,
    });
    expect(
      importedGraph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }).ok,
    ).toBe(true);

    const createdGraph = new RenderGraphBuilder<Frame>();
    const created = value(createdGraph.createBuffer('created', { size: 16 }));
    createdGraph.addComputePass('consume', {
      accesses: [{ resource: created, usage: 'uniform-read' }],
      encode: () => undefined,
    });
    const refused = createdGraph.compile({
      device: mockDevice(),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('uninitialized-read');
  });

  it('resolves a host-owned view for an imported texture without creating a frame view', () => {
    let createViewCount = 0;
    const device = mockDevice({
      createTextureView: () => {
        createViewCount += 1;
        return ok({ id: 9 } as unknown as TextureView);
      },
    });
    const graph = new RenderGraphBuilder<Frame>();
    const texture = value(
      graph.importTexture(
        'surface',
        { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
        (frame) => frame.importedTexture as Texture,
      ),
    );
    const view = value(
      graph.importView(
        texture,
        { label: 'surface.view' },
        (frame) => frame.importedView as TextureView,
      ),
    );
    graph.addRasterPass('present', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    });
    const compiled = value(graph.compile({ device, surfaceSize: { width: 1, height: 1 } }));
    const events: string[] = [];
    const frame = {
      encoder: mockEncoder(events),
      imported: {} as Buffer,
      importedTexture: {} as Texture,
      importedView: { id: 4 } as unknown as TextureView,
    };
    const executed: string[] = [];
    expect(
      compiled.execute(frame, (pass, encode) => {
        executed.push(`${pass.executionIndex}:${pass.kind}:${pass.name}`);
        encode();
      }).ok,
    ).toBe(true);
    expect(createViewCount).toBe(0);
    expect(executed).toEqual(['0:raster:present']);
  });

  it('resolves a frame-owned attachment clear value at execution time', () => {
    const graph = new RenderGraphBuilder<Frame & { readonly clear: number }>();
    const texture = value(
      graph.importTexture(
        'surface',
        { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
        (frame) => frame.importedTexture as Texture,
      ),
    );
    const view = value(
      graph.importView(
        texture,
        { label: 'surface.view' },
        (frame) => frame.importedView as TextureView,
      ),
    );
    graph.addRasterPass('present', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [
        {
          view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: (frame) => ({ r: frame.clear, g: 0, b: 0, a: 1 }),
        },
      ],
      encode: () => undefined,
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    let clearValue: GPUColor | undefined;
    const encoder = {
      ...mockEncoder(),
      beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
        clearValue = Array.from(descriptor.colorAttachments)[0]?.clearValue;
        return { end: () => undefined } as never;
      },
    } as unknown as RhiCommandEncoder;
    expect(
      compiled.execute({
        encoder,
        imported: {} as Buffer,
        importedTexture: {} as Texture,
        importedView: {} as TextureView,
        clear: 0.25,
      }).ok,
    ).toBe(true);
    expect(clearValue).toEqual({ r: 0.25, g: 0, b: 0, a: 1 });
  });

  it('resolves a frame-owned occlusion query set at execution time', () => {
    const graph = new RenderGraphBuilder<Frame & { readonly querySet?: QuerySet }>();
    const texture = value(
      graph.importTexture(
        'surface',
        { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
        (frame) => frame.importedTexture as Texture,
      ),
    );
    const view = value(
      graph.importView(
        texture,
        { label: 'surface.view' },
        (frame) => frame.importedView as TextureView,
      ),
    );
    graph.addRasterPass('present', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      occlusionQuerySet: (frame) => frame.querySet,
      encode: () => undefined,
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    const observed: Array<QuerySet | undefined> = [];
    const encoder = {
      ...mockEncoder(),
      beginRenderPass: (descriptor: { readonly occlusionQuerySet?: QuerySet }) => {
        observed.push(descriptor.occlusionQuerySet);
        return { end: () => undefined } as never;
      },
    } as unknown as RhiCommandEncoder;
    const querySet = { id: 3 } as unknown as QuerySet;
    const base = {
      encoder,
      imported: {} as Buffer,
      importedTexture: {} as Texture,
      importedView: {} as TextureView,
    };
    expect(compiled.execute(base).ok).toBe(true);
    expect(compiled.execute({ ...base, querySet }).ok).toBe(true);
    expect(observed).toEqual([undefined, querySet]);
  });

  it('rejects importView for a graph-created texture', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = value(
      graph.createTexture('created', { format: 'rgba8unorm', size: 'surface' }),
    );
    const imported = graph.importView(
      texture,
      { label: 'created.view' },
      (frame) => frame.importedView as TextureView,
    );
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe('resource-descriptor-invalid');
  });

  it('derives exact declaration-order RAW, WAR, and WAW dependencies', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const x = value(graph.createBuffer('x', { size: 16 }));
    const y = value(graph.createBuffer('y', { size: 16 }));
    graph.addCopyPass('seed-x', {
      accesses: [{ resource: x, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    graph.addCopyPass('consume-x', {
      accesses: [
        { resource: x, usage: 'copy-src' },
        { resource: y, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });
    graph.addCopyPass('rewrite-x', {
      accesses: [
        { resource: y, usage: 'copy-src' },
        { resource: x, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });

    const compiled = graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.inspect().passes).toMatchObject([
      { name: 'seed-x', dependencies: [] },
      { name: 'consume-x', dependencies: ['seed-x'] },
      { name: 'rewrite-x', dependencies: ['seed-x', 'consume-x'] },
    ]);
  });

  it('derives physical usages and refuses imported usage mismatch', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const data = value(
      graph.importBuffer('data', { size: 16, usage: 0x0080 }, (frame) => frame.imported),
    );
    graph.addComputePass('consume', {
      accesses: [{ resource: data, usage: 'uniform-read' }],
      encode: () => undefined,
    });
    const result = graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('import-usage-mismatch');
  });

  it('tracks texture subresources so HZB mip read/write chains are legal', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const hzb = value(
      graph.createTexture('hzb', {
        format: 'r32float',
        size: { width: 16, height: 16 },
        mipLevelCount: 2,
      }),
    );
    const mip0 = value(graph.view(hzb, { label: 'hzb-mip-0', baseMipLevel: 0, mipLevelCount: 1 }));
    const mip1 = value(graph.view(hzb, { label: 'hzb-mip-1', baseMipLevel: 1, mipLevelCount: 1 }));
    graph.addComputePass('seed-mip-0', {
      accesses: [{ resource: mip0, usage: 'storage-write' }],
      encode: () => undefined,
    });
    graph.addComputePass('build-mip-1', {
      accesses: [
        { resource: mip0, usage: 'sampled-read' },
        { resource: mip1, usage: 'storage-write' },
      ],
      encode: () => undefined,
    });
    expect(graph.compile({ device: mockDevice(), surfaceSize: { width: 16, height: 16 } }).ok).toBe(
      true,
    );
  });

  it('rejects handles from another builder before compilation', () => {
    const owner = new RenderGraphBuilder<Frame>();
    const foreign = value(owner.createBuffer('foreign', { size: 16 }));
    const graph = new RenderGraphBuilder<Frame>();
    const result = graph.addComputePass('consume', {
      accesses: [{ resource: foreign, usage: 'storage-read' }],
      encode: () => undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('foreign-resource-handle');
  });

  it('rejects incompatible overlapping usages inside one pass', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const data = value(
      graph.importBuffer('data', { size: 16, usage: 0x0080 }, (frame) => frame.imported),
    );
    graph.addComputePass('conflict', {
      accesses: [
        { resource: data, usage: 'storage-read' },
        { resource: data, usage: 'storage-read-write' },
      ],
      encode: () => undefined,
    });
    const result = graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('access-conflict');
  });

  it('treats attachment load as a read while clear is a first write', () => {
    const clearedGraph = new RenderGraphBuilder<Frame>();
    const clearedTexture = value(
      clearedGraph.createTexture('cleared', { format: 'rgba8unorm', size: 'surface' }),
    );
    const clearedView = value(clearedGraph.view(clearedTexture));
    clearedGraph.addRasterPass('clear', {
      accesses: [{ resource: clearedView, usage: 'color-attachment' }],
      colorAttachments: [{ view: clearedView, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    });
    expect(
      clearedGraph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }).ok,
    ).toBe(true);

    const loadedGraph = new RenderGraphBuilder<Frame>();
    const loadedTexture = value(
      loadedGraph.createTexture('loaded', { format: 'rgba8unorm', size: 'surface' }),
    );
    const loadedView = value(loadedGraph.view(loadedTexture));
    loadedGraph.addRasterPass('load', {
      accesses: [{ resource: loadedView, usage: 'color-attachment' }],
      colorAttachments: [{ view: loadedView, loadOp: 'load', storeOp: 'store' }],
      encode: () => undefined,
    });
    const result = loadedGraph.compile({
      device: mockDevice(),
      surfaceSize: { width: 1, height: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('uninitialized-read');
  });
});

describe('RenderGraphBuilder capability, execution, and lifecycle contracts', () => {
  it('distinguishes an internally initialized sampled/storage chain from incoming read-write data', async () => {
    for (const usage of ['sampled-storage-write', 'sampled-storage-read-write'] as const) {
      const graph = new RenderGraphBuilder<Frame>();
      const texture = graph
        .createTexture('chain', { format: 'rgba16float', size: 'surface' })
        .unwrap();
      const view = graph.view(texture).unwrap();
      graph
        .addComputePass('chain', { accesses: [{ resource: view, usage }], encode: () => undefined })
        .unwrap();
      graph
        .addComputePass('consume', {
          accesses: [{ resource: view, usage: 'sampled-read' }],
          encode: () => undefined,
        })
        .unwrap();
      const compiled = graph.compile({
        device: mockDevice(),
        surfaceSize: { width: 4, height: 4 },
      });
      expect(compiled.ok).toBe(usage === 'sampled-storage-write');
      if (compiled.ok) {
        expect(compiled.value.inspect().resources[0]?.derivedUsage).toBe(0x0c);
        await compiled.value.retire();
      } else expect(compiled.error.code).toBe('uninitialized-read');
      const unavailableGraph = new RenderGraphBuilder<Frame>();
      const unavailableTexture = unavailableGraph
        .createTexture('chain', {
          format: 'rgba16float',
          size: 'surface',
        })
        .unwrap();
      unavailableGraph
        .addComputePass('chain', {
          accesses: [{ resource: unavailableGraph.view(unavailableTexture).unwrap(), usage }],
          encode: () => undefined,
        })
        .unwrap();
      const unavailable = unavailableGraph.compile({
        device: mockDevice({ caps: caps({ storageTexture: false }) }),
        surfaceSize: { width: 4, height: 4 },
      });
      expect(unavailable.ok).toBe(false);
      if (!unavailable.ok) expect(unavailable.error.code).toBe('capability-missing');
    }
  });

  it('rejects write-then-sample declarations outside ordered compute dispatches', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = graph
      .createTexture('chain', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const view = graph.view(texture).unwrap();
    graph
      .addRasterPass('invalid-chain', {
        accesses: [{ resource: view, usage: 'sampled-storage-write' }],
        colorAttachments: [],
        encode: () => undefined,
      })
      .unwrap();
    const result = graph.compile({ device: mockDevice(), surfaceSize: { width: 4, height: 4 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('access-conflict');
  });

  it('derives storage usage for a write-only buffer producer', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const buffer = value(graph.createBuffer('produced', { size: 16 }));
    graph.addComputePass('produce', {
      accesses: [{ resource: buffer, usage: 'storage-write' }],
      encode: () => undefined,
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    expect(compiled.inspect().resources).toContainEqual(
      expect.objectContaining({ label: 'produced', derivedUsage: 0x0080 }),
    );
  });

  it('keeps declared created-texture usage alongside graph-derived usage', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = value(
      graph.createTexture('readback-target', {
        format: 'rgba8unorm',
        size: 'surface',
        usage: 0x01,
      }),
    );
    const view = value(graph.view(texture));
    graph.addRasterPass('write', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    expect(compiled.inspect().resources).toContainEqual(
      expect.objectContaining({ label: 'readback-target', derivedUsage: 0x11 }),
    );
  });

  it('derives compute and storage capabilities from pass/access declarations', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const buffer = value(
      graph.importBuffer('data', { size: 16, usage: 0x0080 }, (frame) => frame.imported),
    );
    graph.addComputePass('compute', {
      accesses: [{ resource: buffer, usage: 'storage-read' }],
      encode: () => undefined,
    });
    const device = mockDevice({ caps: caps({ compute: false }) });
    const refused = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('capability-missing');
      expect(refused.error.detail).toMatchObject({ capability: 'compute', passName: 'compute' });
    }
  });

  it('opens, dispatches, and ends one graph-owned compute pass', () => {
    const events: string[] = [];
    const graph = new RenderGraphBuilder<Frame>();
    const buffer = value(
      graph.importBuffer('data', { size: 16, usage: 0x0080 }, (frame) => frame.imported),
    );
    graph.addComputePass('membership', {
      accesses: [{ resource: buffer, usage: 'storage-read' }],
      begin: () => ({
        timestampWrites: {
          querySet: {} as never,
          beginningOfPassWriteIndex: 0,
          endOfPassWriteIndex: 1,
        },
      }),
      encode: ({ pass }) => pass.dispatchWorkgroups(1),
      after: () => events.push('after-compute'),
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    const executed = compiled.execute({
      imported: {} as Buffer,
      encoder: mockEncoder(events),
    });
    expect(executed.ok).toBe(true);
    expect(events).toEqual([
      'timestamp-writes',
      'begin-compute:membership',
      'dispatch',
      'end-compute',
      'after-compute',
    ]);
  });

  it('applies pass timestamp instrumentation at the real raster and compute boundaries', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const texture = value(
      graph.importTexture(
        'surface',
        { format: 'rgba8unorm', size: 'surface', usage: 0x10 },
        (frame) => frame.importedTexture as Texture,
      ),
    );
    const view = value(
      graph.importView(
        texture,
        { label: 'surface.view' },
        (frame) => frame.importedView as TextureView,
      ),
    );
    graph.addRasterPass('timed-raster', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    });
    graph.addComputePass('timed-compute', {
      accesses: [],
      encode: () => undefined,
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    const querySet = {} as QuerySet;
    const rasterWrites = {
      querySet,
      beginningOfPassWriteIndex: 4,
      endOfPassWriteIndex: 5,
    } as const;
    const computeWrites = {
      querySet,
      beginningOfPassWriteIndex: 6,
      endOfPassWriteIndex: 7,
    } as const;
    let rasterDescriptor: { readonly timestampWrites?: unknown } | undefined;
    const computeDescriptors: Array<{ readonly timestampWrites?: unknown }> = [];
    const encoder = {
      ...mockEncoder(),
      beginRenderPass: (descriptor: { readonly timestampWrites?: unknown }) => {
        rasterDescriptor = descriptor;
        return { end: () => undefined } as never;
      },
      beginComputePass: (descriptor: ComputePassDescriptor = {}) => {
        computeDescriptors.push(descriptor);
        return {
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          dispatchWorkgroups: () => undefined,
          dispatchWorkgroupsIndirect: () => undefined,
          end: () => undefined,
        } as unknown as RhiComputePassEncoder;
      },
    } as unknown as RhiCommandEncoder;
    const instrumentation: RenderGraphPassInstrumentation<Frame> = {
      begin: (pass) =>
        pass.kind === 'raster'
          ? {
              renderPassDescriptor: (descriptor) => ({
                ...descriptor,
                timestampWrites: rasterWrites,
              }),
            }
          : {
              computePassDescriptor: (descriptor) => ({
                ...descriptor,
                timestampWrites: computeWrites,
              }),
            },
    };
    const executed = compiled.execute(
      {
        encoder,
        imported: {} as Buffer,
        importedTexture: {} as Texture,
        importedView: {} as TextureView,
      },
      undefined,
      instrumentation,
    );
    expect(executed.ok).toBe(true);
    expect(rasterDescriptor?.timestampWrites).toBe(rasterWrites);
    expect(computeDescriptors).toHaveLength(1);
    expect(computeDescriptors[0]?.timestampWrites).toBe(computeWrites);
  });

  it('reports a graph-owned compute pass begin failure to the pass owner', () => {
    const events: string[] = [];
    const graph = new RenderGraphBuilder<Frame>();
    graph.addComputePass('timed-compute', {
      accesses: [],
      begin: () => ({}),
      onBeginError: (_frame, cause) => events.push(`begin-error:${String(cause)}`),
      encode: () => events.push('encode'),
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    const result = compiled.execute({
      imported: {} as Buffer,
      encoder: {
        beginComputePass: () => {
          throw new Error('timestamp writes unavailable');
        },
      } as unknown as RhiCommandEncoder,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('pass-encode-failed');
    expect(events).toEqual(['begin-error:Error: timestamp writes unavailable']);
  });

  it('skips a frame-disabled pass before opening its child encoder', () => {
    const events: string[] = [];
    const graph = new RenderGraphBuilder<Frame>();
    graph.addComputePass('cached-producer', {
      accesses: [],
      executeIf: () => false,
      encode: () => events.push('encode'),
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    const executed = compiled.execute({ imported: {} as Buffer, encoder: mockEncoder(events) });
    expect(executed.ok).toBe(true);
    expect(events).toEqual([]);
  });

  it('ends the compute child pass and returns structured failure when encode throws', () => {
    const events: string[] = [];
    const graph = new RenderGraphBuilder<Frame>();
    graph.addComputePass('broken', {
      accesses: [],
      encode: () => {
        throw new Error('boom');
      },
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    const result = compiled.execute({ imported: {} as Buffer, encoder: mockEncoder(events) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('pass-encode-failed');
    expect(events).toEqual(['begin-compute:broken', 'end-compute']);
  });

  it('limits frame-time resolution to the exact pass declaration', () => {
    const graph = new RenderGraphBuilder<Frame>();
    const declared = value(
      graph.importBuffer('declared', { size: 16, usage: 0x0040 }, (frame) => frame.imported),
    );
    const hidden = value(
      graph.importBuffer('hidden', { size: 16, usage: 0x0040 }, (frame) => frame.imported),
    );
    let resolutionCode: string | undefined;
    graph.addComputePass('resolve', {
      accesses: [{ resource: declared, usage: 'uniform-read' }],
      encode: ({ resources }) => {
        const resolved = resources.buffer(hidden);
        if (!resolved.ok) resolutionCode = resolved.error.code;
      },
    });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );
    expect(compiled.execute({ imported: {} as Buffer, encoder: mockEncoder() }).ok).toBe(true);
    expect(resolutionCode).toBe('resource-not-declared-by-pass');
  });

  it('does not resolve imported resources that no pass uses', () => {
    let resolutions = 0;
    const graph = new RenderGraphBuilder<Frame>();
    graph.importBuffer('unused-buffer', { size: 16, usage: 0x0040 }, () => {
      resolutions++;
      throw new Error('unused buffer resolved');
    });
    const texture = value(
      graph.importTexture(
        'unused-texture',
        { format: 'rgba8unorm', size: 'surface', usage: 0x04 },
        () => {
          resolutions++;
          throw new Error('unused texture resolved');
        },
      ),
    );
    graph.view(texture, { label: 'unused-view' });
    const compiled = value(
      graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
    );

    expect(compiled.execute({ imported: {} as Buffer, encoder: mockEncoder() }).ok).toBe(true);
    expect(resolutions).toBe(0);
  });

  it('rolls back earlier graph-owned allocations when a later allocation fails', () => {
    const destroyed: Buffer[] = [];
    let allocations = 0;
    const device = mockDevice({
      createBuffer: () => {
        allocations++;
        if (allocations === 1) return ok({ id: 1 } as unknown as Buffer);
        return {
          ok: false,
          error: {
            code: 'webgpu-runtime-error',
          },
        } as never;
      },
      destroyBuffer: (buffer) => {
        destroyed.push(buffer);
        return ok(undefined);
      },
    });
    const graph = new RenderGraphBuilder<Frame>();
    const first = value(graph.createBuffer('first', { size: 16 }));
    const second = value(graph.createBuffer('second', { size: 16 }));
    graph.addCopyPass('seed', {
      accesses: [
        { resource: first, usage: 'copy-dst' },
        { resource: second, usage: 'copy-dst' },
      ],
      encode: () => undefined,
    });
    const result = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('resource-allocation-failed');
    expect(destroyed).toHaveLength(1);
  });

  it('uses array-layer and 3d depth semantics when projecting mip bytes', () => {
    const compile = (dimension: GPUTextureDimension) => {
      const graph = new RenderGraphBuilder<Frame>();
      const texture = value(
        graph.createTexture(`${dimension}-texture`, {
          format: 'rgba8unorm',
          size: { width: 4, height: 4, depthOrArrayLayers: 4 },
          dimension,
          mipLevelCount: 3,
        }),
      );
      const view = value(
        graph.view(texture, { dimension: dimension === '3d' ? '3d' : '2d-array' }),
      );
      graph.addRasterPass('write', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => undefined,
      });
      return value(graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }));
    };

    expect(compile('2d').inspect().resources[0]?.byteSize).toBe(336);
    expect(compile('3d').inspect().resources[0]?.byteSize).toBe(292);
  });

  it('projects two bytes per texel for 16-bit single-channel formats', () => {
    for (const format of ['r16float', 'r16unorm', 'r16snorm', 'r16uint', 'r16sint'] as const) {
      const graph = new RenderGraphBuilder<Frame>();
      const texture = value(graph.createTexture(format, { format, size: { width: 4, height: 3 } }));
      const view = value(graph.view(texture));
      graph.addRasterPass('write', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encode: () => undefined,
      });
      const compiled = value(
        graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
      );
      expect(compiled.inspect().resources[0]?.byteSize, format).toBe(24);
      expect(compiled.inspect().resourceAllocation?.unknownByteSizeCount, format).toBe(0);
    }
  });

  it('counts depth32float array bytes while keeping implementation-dependent depth unknown', () => {
    for (const format of ['depth32float', 'depth24plus'] as const) {
      const graph = new RenderGraphBuilder<Frame>();
      const texture = value(
        graph.createTexture(format, {
          format,
          size: { width: 4, height: 3, depthOrArrayLayers: 8 },
        }),
      );
      const view = value(graph.view(texture, { dimension: '2d', arrayLayerCount: 1 }));
      graph.addRasterPass('write', {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: { view, depthLoadOp: 'clear', depthStoreOp: 'store' },
        encode: () => undefined,
      });
      const compiled = value(
        graph.compile({ device: mockDevice(), surfaceSize: { width: 1, height: 1 } }),
      );
      const resource = compiled.inspect().resources[0];
      if (format === 'depth32float') expect(resource?.byteSize).toBe(384);
      else {
        expect(resource?.byteSize).toBeUndefined();
        expect(resource?.byteSizeUnknownReason).toBe('format-or-layout-unknown');
      }
    }
  });

  it('projects graph-owned allocation bytes and keeps imported ownership explicit', async () => {
    let resolveFence: (() => void) | undefined;
    const fence = new Promise<void>((resolve) => {
      resolveFence = resolve;
    });
    const graph = new RenderGraphBuilder<Frame>();
    const created = value(graph.createBuffer('created', { size: 32 }));
    const imported = value(
      graph.importBuffer('imported', { size: 64, usage: 0x0004 }, (frame) => frame.imported),
    );
    graph.addCopyPass('seed', {
      accesses: [
        { resource: created, usage: 'copy-dst' },
        { resource: imported, usage: 'copy-src' },
      ],
      encode: () => undefined,
    });
    const device = mockDevice({
      queue: { onSubmittedWorkDone: () => fence } as never,
    });
    const compiled = value(graph.compile({ device, surfaceSize: { width: 1, height: 1 } }));
    const info = compiled.inspect();
    const createdInfo = info.resources.find(({ label }) => label === 'created');
    const importedInfo = info.resources.find(({ label }) => label === 'imported');
    expect(createdInfo?.byteSize).toBe(32);
    expect(importedInfo?.byteSize).toBeUndefined();
    expect(importedInfo?.byteSizeUnknownReason).toBe('imported-owner');
    expect(info.resourceAllocation).toMatchObject({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: 32,
      pendingRetirementBytes: 0,
      peakBytes: 32,
      successfulAllocationCount: 1,
      successfulAllocationBytes: 32,
      importedResourceCount: 1,
      unknownByteSizeCount: 0,
    });

    const retiring = compiled.retire();
    await Promise.resolve();
    expect(compiled.inspect().resourceAllocation).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 32,
      pendingRetirementCount: 1,
      peakBytes: 32,
    });
    resolveFence?.();
    expect((await retiring).ok).toBe(true);
    expect(compiled.inspect().resourceAllocation).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 0,
      pendingRetirementCount: 0,
      retiredBytes: 32,
    });
  });

  it('destroys graph-created resources once and never destroys imported resources', async () => {
    const destroyedBuffers: Buffer[] = [];
    const device = mockDevice({
      destroyBuffer: (buffer) => {
        destroyedBuffers.push(buffer);
        return ok(undefined);
      },
    });
    const graph = new RenderGraphBuilder<Frame>();
    const created = value(graph.createBuffer('created', { size: 16 }));
    const imported = value(
      graph.importBuffer('imported', { size: 16, usage: 0x0040 }, (frame) => frame.imported),
    );
    graph.addCopyPass('seed', {
      accesses: [{ resource: created, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    graph.addComputePass('consume', {
      accesses: [
        { resource: created, usage: 'uniform-read' },
        { resource: imported, usage: 'uniform-read' },
      ],
      encode: () => undefined,
    });
    const compiled = value(graph.compile({ device, surfaceSize: { width: 1, height: 1 } }));
    expect((await compiled.retire()).ok).toBe(true);
    expect((await compiled.retire()).ok).toBe(true);
    expect(destroyedBuffers).toHaveLength(1);
    expect(compiled.execute({ imported: {} as Buffer, encoder: mockEncoder() }).ok).toBe(false);
  });

  it('retains graph allocation tokens when destruction refuses or throws', async () => {
    for (const destroy of [
      () => ({ ok: false, error: { code: 'webgpu-runtime-error' } }) as never,
      () => {
        throw new Error('destroy refused');
      },
    ]) {
      const graph = new RenderGraphBuilder<Frame>();
      const created = value(graph.createBuffer('created', { size: 32 }));
      graph.addCopyPass('seed', {
        accesses: [{ resource: created, usage: 'copy-dst' }],
        encode: () => undefined,
      });
      const compiled = value(
        graph.compile({
          device: mockDevice({ destroyBuffer: destroy }),
          surfaceSize: { width: 1, height: 1 },
        }),
      );

      const result = await compiled.retire();
      expect(result.ok).toBe(false);
      expect(compiled.inspect().resourceAllocation).toMatchObject({
        liveBytes: 0,
        pendingRetirementBytes: 32,
        pendingRetirementCount: 1,
        retiredBytes: 0,
      });
    }
  });

  it('keeps a failed retirement result stable across repeated calls', async () => {
    const graph = new RenderGraphBuilder<Frame>();
    const created = value(graph.createBuffer('created', { size: 16 }));
    graph.addCopyPass('seed', {
      accesses: [{ resource: created, usage: 'copy-dst' }],
      encode: () => undefined,
    });
    const compiled = value(
      graph.compile({
        device: mockDevice({
          queue: {
            onSubmittedWorkDone: async () => {
              throw new Error('device lost');
            },
          } as never,
        }),
        surfaceSize: { width: 1, height: 1 },
      }),
    );

    const first = await compiled.retire();
    const second = await compiled.retire();
    expect(first.ok).toBe(false);
    expect(second).toBe(first);
    if (!second.ok) expect(second.error.code).toBe('resource-retire-failed');
  });
});

it('refuses MRT beyond the device attachment limit before allocation', () => {
  const graph = new RenderGraphBuilder<Frame>();
  const views = [0, 1].map((index) =>
    value(
      graph.view(
        value(graph.createTexture(`color-${index}`, { format: 'rgba8unorm', size: 'surface' })),
      ),
    ),
  );
  value(
    graph.addRasterPass('mrt', {
      accesses: views.map((resource) => ({ resource, usage: 'color-attachment' as const })),
      colorAttachments: views.map((view) => ({
        view,
        loadOp: 'clear' as const,
        storeOp: 'store' as const,
      })),
      encode() {},
    }),
  );
  const result = graph.compile({
    device: mockDevice({ caps: caps({ maxColorAttachments: 1 }) }),
    surfaceSize: { width: 16, height: 16 },
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'capability-missing',
      detail: { passName: 'mrt', capability: 'color-attachments' },
    },
  });
});
