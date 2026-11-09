import type { Buffer, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { CompiledRenderGraph } from '../types';

it('rejects recursive execute before imported resource resolution can overwrite frame state', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  type Frame = { encoder: RhiCommandEncoder; buffer: Buffer };
  const builder = new RenderGraphBuilder<Frame>();
  let graph: CompiledRenderGraph<Frame>,
    resolves = 0,
    encodes = 0,
    recursive: boolean | undefined;
  const resource = builder
    .importBuffer('import', { size: 16, usage: 4 }, (frame) => {
      resolves++;
      if (resolves === 1) recursive = graph.execute(frame).ok;
      return frame.buffer;
    })
    .unwrap();
  builder
    .addCopyPass('consume', {
      accesses: [{ resource, usage: 'copy-src' }],
      encodeDirect() {
        encodes++;
      },
    })
    .unwrap();
  graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const buffer = device.createBuffer({ size: 16, usage: 4 }).unwrap();
  const encoder = device.createCommandEncoder().unwrap();
  expect(graph.execute({ encoder, buffer }).ok).toBe(true);
  encoder.finish().unwrap();
  expect(recursive).toBe(false);
  expect(resolves).toBe(1);
  expect(encodes).toBe(1);
  await graph.retire();
  device.destroyBuffer(buffer);
});
