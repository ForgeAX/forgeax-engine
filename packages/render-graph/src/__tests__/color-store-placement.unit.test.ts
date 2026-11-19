import type { RenderPassDescriptor, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder.js';

async function fixture(
  options: {
    store?: 'auto' | 'store' | 'discard';
    imported?: boolean;
    persistent?: boolean;
    diagnostic?: boolean;
    consumer?: boolean;
    alias?: boolean;
    conditional?: boolean;
    resolve?: boolean;
    chain?: boolean;
    subgraph?: boolean;
  } = {},
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
  const shape = { size: { width: 4, height: 4 }, format: 'rgba8unorm' as const, sampleCount: 4 };
  const external = options.imported
    ? device.createTexture({ ...shape, usage: 0x10 }).unwrap()
    : undefined;
  const source =
    external === undefined
      ? graph
          .createTexture('source', {
            ...shape,
            ...(options.persistent ? { lifetime: 'persistent' as const } : {}),
            ...(options.diagnostic ? { usage: 0x01 } : {}),
          })
          .unwrap()
      : graph.importTexture('source', { ...shape, usage: 0x10 }, () => external).unwrap();
  const resolved = graph
    .createTexture('resolved', {
      size: shape.size,
      format: shape.format,
    })
    .unwrap();
  const sourceView = graph.view(source).unwrap();
  const resolvedView = graph.view(resolved).unwrap();
  const count = options.chain ? 3 : 1;
  for (let index = 0; index < count; index++) {
    graph
      .addRasterPass(`scene-${index}`, {
        accesses: [
          { resource: sourceView, usage: 'color-attachment' },
          ...(options.resolve === false
            ? []
            : [{ resource: resolvedView, usage: 'color-attachment' as const }]),
        ],
        colorAttachments: [
          {
            view: sourceView,
            ...(options.resolve === false ? {} : { resolveTarget: resolvedView }),
            loadOp: index === 0 ? 'clear' : 'load',
            storeOp: options.store ?? 'auto',
          },
        ],
        ...(options.conditional ? { executeIf: () => true } : {}),
        encodeDirect() {},
      })
      .unwrap();
  }
  if (options.consumer) {
    const view = options.alias ? graph.view(source).unwrap() : sourceView;
    graph
      .addCopyPass('observe-samples', {
        accesses: [{ resource: view, usage: 'copy-src' }],
        encodeDirect() {},
      })
      .unwrap();
  }
  if (options.subgraph)
    graph.addSubgraphPass('opaque-domain', { accesses: [], commands() {} }).unwrap();
  const compiled = graph.compile({ device, surfaceSize: shape.size }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  const begin = vi.spyOn(encoder, 'beginRenderPass');
  compiled.execute({ encoder }).unwrap();
  const stores = begin.mock.calls.map(
    ([descriptor]) => Array.from((descriptor as RenderPassDescriptor).colorAttachments)[0]?.storeOp,
  );
  return {
    stores,
    async dispose() {
      (await compiled.retire()).unwrap();
      if (external !== undefined) device.destroyTexture(external).unwrap();
    },
  };
}

describe('resolved color attachment store placement', () => {
  it.each([false, true])('discards automatic dead MSAA samples (chain=%s)', async (chain) => {
    const f = await fixture({ chain });
    try {
      expect(f.stores).toEqual(['discard']);
    } finally {
      await f.dispose();
    }
  });

  it.each([
    { imported: true },
    { persistent: true },
    { diagnostic: true },
    { consumer: true },
    { consumer: true, alias: true },
    { conditional: true },
    { resolve: false },
    { subgraph: true },
    { store: 'store' as const },
  ])('preserves samples for an ownership or consumer boundary: %j', async (options) => {
    const f = await fixture(options);
    try {
      expect(f.stores).toEqual(['store']);
    } finally {
      await f.dispose();
    }
  });

  it('preserves an explicit discard', async () => {
    const f = await fixture({ store: 'discard' });
    try {
      expect(f.stores).toEqual(['discard']);
    } finally {
      await f.dispose();
    }
  });
});
