import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';

it('clones allocation facts without aliasing storage, while rejecting a foreign texture', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder();
  const source = graph
    .createTexture('source', {
      format: 'depth32float-stencil8',
      size: { width: 7, height: 3 },
      sampleCount: 4,
    })
    .unwrap();
  expect(new RenderGraphBuilder().createTextureLike('foreign', source)).toMatchObject({
    ok: false,
    error: { code: 'foreign-resource-handle' },
  });
  const copy = graph.createTextureLike('copy', source).unwrap();
  expect(copy).not.toBe(source);
  for (const [index, texture] of [source, copy].entries()) {
    const view = graph.view(texture).unwrap();
    graph
      .addRasterPass(`clear-${index}`, {
        accesses: [{ resource: view, usage: 'depth-stencil-write' }],
        colorAttachments: [],
        depthStencilAttachment: { view, depthLoadOp: 'clear', depthStoreOp: 'store' },
        encode: () => undefined,
      })
      .unwrap();
  }
  const created = vi.spyOn(device, 'createTexture');
  const compiled = graph.compile({ device, surfaceSize: { width: 50, height: 40 } }).unwrap();
  try {
    expect(created).toHaveBeenCalledTimes(2);
    expect(created.mock.calls[0]?.[0]).toMatchObject({
      format: 'depth32float-stencil8',
      size: { width: 7, height: 3 },
      sampleCount: 4,
    });
    expect(created.mock.calls[1]?.[0]).toMatchObject({
      format: 'depth32float-stencil8',
      size: { width: 7, height: 3 },
      sampleCount: 4,
    });
    expect(graph.createTextureLike('sealed', source)).toMatchObject({
      ok: false,
      error: { code: 'builder-sealed' },
    });
  } finally {
    await compiled.retire();
  }
});
