import type { RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';
import type { CompiledRenderGraph, RenderGraphFrame } from '../types';

const device = async () => (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
const size = { width: 8, height: 8, depthOrArrayLayers: 1 };

function created(gpu: RhiDevice, previous?: CompiledRenderGraph<RenderGraphFrame>) {
  const builder = new RenderGraphBuilder();
  const texture = builder.createTexture('color', { format: 'rgba8unorm', size }).unwrap();
  const view = builder.view(texture).unwrap();
  const unusedTexture = builder.createTexture('unused', { format: 'rgba8unorm', size }).unwrap();
  const unused = builder.view(unusedTexture).unwrap();
  let observed: TextureView | undefined;
  builder
    .addRasterPass('clear', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ resources }) => {
        observed = resources.textureView(view).unwrap();
      },
    })
    .unwrap();
  return {
    graph: builder
      .compile({ device: gpu, surfaceSize: size, reuseResourcesFrom: previous })
      .unwrap(),
    view,
    unused,
    observed: () => observed,
  };
}

function execute(gpu: RhiDevice, graph: CompiledRenderGraph<RenderGraphFrame>) {
  const encoder = gpu.createCommandEncoder().unwrap();
  graph.execute({ encoder }).unwrap();
  gpu.queue.submit([encoder.finish().unwrap()]).unwrap();
}

it('borrows the actual created view before first execution without native work', async () => {
  const gpu = await device(),
    f = created(gpu),
    foreign = created(gpu);
  const creates = vi.spyOn(gpu, 'createTextureView');
  try {
    expect(f.graph.isRetired()).toBe(false);
    const native = f.graph.createdTextureView(f.view);
    expect(native).toBeDefined();
    expect(f.graph.createdTextureView(f.unused)).toBeUndefined();
    expect(f.graph.createdTextureView(foreign.view)).toBeUndefined();
    expect(creates).not.toHaveBeenCalled();
    execute(gpu, f.graph);
    expect(f.observed()).toBe(native);
    expect(f.graph.createdTextureView(f.view)).toBe(native);
    expect(creates).not.toHaveBeenCalled();
  } finally {
    creates.mockRestore();
    const retirement = f.graph.retire();
    expect(f.graph.isRetired()).toBe(true);
    (await retirement).unwrap();
    expect(f.graph.isRetired()).toBe(true);
    (await foreign.graph.retire()).unwrap();
  }
});

it('never turns dynamic imported views into fixed ownership after observing a frame', async () => {
  const gpu = await device();
  const texture = gpu.createTexture({ format: 'rgba8unorm', size, usage: 0x10 }).unwrap();
  const first = gpu.createTextureView(texture, {}).unwrap();
  const second = gpu.createTextureView(texture, {}).unwrap();
  let current = first,
    textures = 0,
    views = 0;
  const observed: TextureView[] = [];
  const builder = new RenderGraphBuilder();
  const input = builder
    .importTexture('input', { format: 'rgba8unorm', size, usage: 0x10 }, () => {
      textures++;
      return texture;
    })
    .unwrap();
  const view = builder
    .importView(input, {}, () => {
      views++;
      return current;
    })
    .unwrap();
  builder
    .addRasterPass('clear', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encode: ({ resources }) => {
        observed.push(resources.textureView(view).unwrap());
      },
    })
    .unwrap();
  const graph = builder.compile({ device: gpu, surfaceSize: size }).unwrap();
  try {
    expect(graph.createdTextureView(view)).toBeUndefined();
    expect([textures, views]).toEqual([0, 0]);
    execute(gpu, graph);
    expect(graph.createdTextureView(view)).toBeUndefined();
    current = second;
    execute(gpu, graph);
    expect(graph.createdTextureView(view)).toBeUndefined();
    expect([textures, views]).toEqual([2, 2]);
    expect(observed).toEqual([first, second]);
  } finally {
    (await graph.retire()).unwrap();
    gpu.destroyTexture(texture).unwrap();
  }
});

it('revokes the retiring graph immediately while keeping a successor shared view live', async () => {
  const gpu = await device(),
    first = created(gpu),
    next = created(gpu, first.graph);
  const native = first.graph.createdTextureView(first.view);
  expect(native).toBeDefined();
  expect(next.graph.createdTextureView(next.view)).toBe(native);
  let release: () => void = () => {};
  const fence = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const wait = vi.spyOn(gpu.queue, 'onSubmittedWorkDone').mockReturnValue(fence);
  try {
    const retiring = first.graph.retire();
    expect(first.graph.createdTextureView(first.view)).toBeUndefined();
    expect(next.graph.createdTextureView(next.view)).toBe(native);
    release();
    (await retiring).unwrap();
    expect(next.graph.createdTextureView(next.view)).toBe(native);
  } finally {
    release();
    wait.mockRestore();
    (await first.graph.retire()).unwrap();
    (await next.graph.retire()).unwrap();
  }
});

it('binds equal slices once across changing logical rows and drops a slice when its last layout leaves', async () => {
  const gpu = await device();
  const creates = vi.spyOn(gpu, 'createTextureView');
  const nativeTextures = vi.spyOn(gpu, 'createTexture');
  let prior: CompiledRenderGraph<RenderGraphFrame> | undefined;
  let common: TextureView | undefined;
  const layouts = [
    [true, 2],
    [true, 2],
    [false, 2],
    [true, 3],
  ] as const;
  try {
    for (const [frame, [withSecondMip, expectedCreates]] of layouts.entries()) {
      const procedure = RenderGraphBuilder.procedure({
        device: gpu,
        surfaceSize: size,
        reuseResourcesFrom: prior,
      });
      const b = procedure.passes;
      const texture = b
        .createTexture('image', { size, format: 'rgba8unorm', mipLevelCount: 2 })
        .unwrap();
      const rows = Array.from({ length: frame + 8 }, (_, index) => {
        const mip = withSecondMip && index % 3 === frame % 3 ? 1 : 0;
        const view = b
          .view(texture, {
            label: `frame-${frame}-view-${index}`,
            baseMipLevel: mip,
            mipLevelCount: 1,
          })
          .unwrap();
        b.addRasterPass(`writer-${index}`, {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          encodeDirect() {},
        }).unwrap();
        return { view, mip };
      });
      const active = procedure.bindResources().unwrap();
      let second: TextureView | undefined;
      for (const { view, mip } of rows) {
        const native = active.createdTextureView(view);
        expect(native).toBeDefined();
        if (mip === 1) {
          second ??= native;
          expect(native).toBe(second);
        } else {
          common ??= native;
          expect(native).toBe(common);
        }
      }
      if (withSecondMip) expect(second).not.toBe(common);
      expect(creates).toHaveBeenCalledTimes(expectedCreates);
      expect(nativeTextures).toHaveBeenCalledTimes(1);
      execute(gpu, active);
      if (prior !== undefined) (await prior.retire()).unwrap();
      prior = active;
    }
  } finally {
    if (prior !== undefined) (await prior.retire()).unwrap();
    creates.mockRestore();
    nativeTextures.mockRestore();
  }
});

it('revokes physical inputs when the source retires before a staged successor binds', async () => {
  const gpu = await device();
  const first = created(gpu);
  const oldView = first.graph.createdTextureView(first.view);
  const candidate = RenderGraphBuilder.procedure({
    device: gpu,
    surfaceSize: size,
    reuseResourcesFrom: first.graph,
  });
  const b = candidate.passes;
  const image = b.createTexture('color', { format: 'rgba8unorm', size }).unwrap();
  const view = b.view(image).unwrap();
  b.addRasterPass('clear', {
    accesses: [{ resource: view, usage: 'color-attachment' }],
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
    encodeDirect() {},
  }).unwrap();
  const retiring = first.graph.retire();
  const replacement = candidate.bindResources().unwrap();
  expect(replacement.createdTextureView(view)).toBeDefined();
  expect(replacement.createdTextureView(view)).not.toBe(oldView);
  (await retiring).unwrap();
  execute(gpu, replacement);
  (await replacement.retire()).unwrap();
});
