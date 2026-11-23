import type { Buffer, RhiCommandEncoder, Texture, TextureView } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { ResultOk } from '@forgeax/engine-types';
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

it('binds an imported slot once for all passes and keeps escaped results exact after replacement', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  type Frame = { encoder: RhiCommandEncoder; buffer: Buffer };
  const builder = new RenderGraphBuilder<Frame>();
  const resource = builder
    .importBuffer('stream', { size: 16, usage: 4 }, (frame) => frame.buffer)
    .unwrap();
  const reads: ResultOk<Buffer>[] = [];
  for (const name of ['first', 'second']) {
    builder
      .addCopyPass(name, {
        accesses: [{ resource, usage: 'copy-src' }],
        encodeDirect(_encoder, _frame, resources) {
          const read = resources.buffer(resource);
          if (!read.ok) throw read.error;
          reads.push(read);
        },
      })
      .unwrap();
  }
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const first = device.createBuffer({ size: 16, usage: 4 }).unwrap();
  const second = device.createBuffer({ size: 16, usage: 4 }).unwrap();
  try {
    for (const buffer of [first, first, second]) {
      const encoder = device.createCommandEncoder().unwrap();
      graph.execute({ encoder, buffer }).unwrap();
      encoder.finish().unwrap();
    }
    expect(reads).toHaveLength(6);
    for (let i = 1; i < 4; i++) expect(reads[i]).toBe(reads[0]);
    expect(reads[0]?.value).toBe(first);
    expect(reads[4]?.value).toBe(second);
    expect(reads[5]).toBe(reads[4]);
  } finally {
    await graph.retire();
    device.destroyBuffer(first);
    device.destroyBuffer(second);
  }
});

it('exposes the actual whole image extent to consumers and inspection after each allocation replacement', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  type Size = { width: number; height: number; depthOrArrayLayers: number };
  type Frame = { encoder: RhiCommandEncoder; texture: Texture; view: TextureView; size: Size };
  const builder = new RenderGraphBuilder<Frame>();
  let active: Frame | undefined;
  const requested = { width: 8, height: 8, depthOrArrayLayers: 2 };
  const imported = builder
    .importTexture(
      'received',
      { format: 'depth32float', size: requested, usage: 0x15 },
      (frame) => {
        active = frame;
        return frame.texture;
      },
      {
        *prepare() {
          yield;
          if (active === undefined)
            throw new Error('original frame must prepare this test texture');
          return active.texture;
        },
        current: () => undefined,
        resolvedExtent(texture) {
          if (active?.texture !== texture) throw new Error('stale owner');
          return active.size;
        },
      },
    )
    .unwrap();
  expect(builder.view(imported, { baseArrayLayer: 1 }).ok).toBe(false);
  expect(builder.createTextureLike('fixed-copy', imported).ok).toBe(false);
  const full = builder
    .importView(imported, { dimension: '2d-array', aspect: 'depth-only' }, (frame) => frame.view)
    .unwrap();
  const seen: Size[] = [];
  builder
    .addCopyPass('read', {
      accesses: [{ resource: full, usage: 'copy-src' }],
      encodeDirect(_encoder, frame, resources) {
        const sampled = resources.textureViewSource?.(full).unwrap();
        if (sampled === undefined) throw new Error('missing physical texture source');
        expect(sampled.texture).toBe(frame.texture);
        expect(resources.textureViewExtent(full).unwrap()).toMatchObject({
          width: frame.size.width,
          height: frame.size.height,
        });
        seen.push(sampled.descriptor.size as Size);
      },
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: requested }).unwrap();
  const sizes = [
    requested,
    { width: 16, height: 16, depthOrArrayLayers: 4 },
    { width: 4, height: 4, depthOrArrayLayers: 3 },
  ];
  const textures: Texture[] = [];
  for (const size of sizes) {
    const texture = device
      .createTexture({
        size,
        format: 'depth32float',
        usage: 0x15,
        dimension: '2d',
        sampleCount: 1,
        mipLevelCount: 1,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      })
      .unwrap();
    textures.push(texture);
    const view = device
      .createTextureView(texture, { dimension: '2d-array', aspect: 'depth-only' })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder, texture, view, size }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    expect(graph.inspect().resources.find((r) => r.label === 'received')).toMatchObject({
      extent: size,
      descriptor: { ...size, size },
      byteSizeUnknownReason: 'imported-owner',
    });
  }
  expect(seen).toEqual(sizes);
  (await graph.retire()).unwrap();
  for (const texture of textures) device.destroyTexture(texture).unwrap();
});
