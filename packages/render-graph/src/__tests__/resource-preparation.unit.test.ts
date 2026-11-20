import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';

it.each([
  false,
  true,
])('prepares declared created views without a frame or import resolution; retire=%s', async (retired) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder();
  const size = { width: 8, height: 8, depthOrArrayLayers: 1 };
  const texture = builder.createTexture('owned', { format: 'rgba8unorm', size }).unwrap();
  const view = builder.view(texture).unwrap();
  const privateTexture = builder
    .createTexture('not-declared-here', { format: 'rgba8unorm', size })
    .unwrap();
  const privateView = builder.view(privateTexture).unwrap();
  const imported = vi.fn(() => {
    throw Error('preparation must never resolve imports');
  });
  const external = builder
    .importTexture('external', { format: 'rgba8unorm', size, usage: 4 }, imported)
    .unwrap();
  const externalView = builder.view(external).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 4, texture: { sampleType: 'float' } }],
    })
    .unwrap();
  const encoded = vi.fn();
  builder
    .addRasterPass('initialize', {
      accesses: [{ resource: view, usage: 'color-attachment' }],
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
      encodeDirect: encoded,
    })
    .unwrap();
  builder
    .addComputePass('consume', {
      accesses: [
        { resource: view, usage: 'sampled-read' },
        { resource: externalView, usage: 'sampled-read' },
      ],
      *prepareResources(resources, current) {
        const actual = resources.createdTextureView(view);
        assert(actual);
        expect(resources.createdTextureView(privateView)).toBeUndefined();
        expect(resources.createdTextureView(externalView)).toBeUndefined();
        for (let operation = 0; operation < 2; operation++) {
          assert(current());
          device
            .createBindGroup({
              layout,
              entries: [{ binding: 0, resource: { kind: 'textureView', value: actual } }],
            })
            .unwrap();
          assert(current());
          yield;
        }
      },
      encodeDirect: encoded,
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: size }).unwrap();
  const creates = vi.spyOn(device, 'createBindGroup');
  const work = graph.prepareResources(() => true);
  try {
    expect(work.next().done).toBe(false);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(imported).not.toHaveBeenCalled();
    expect(encoded).not.toHaveBeenCalled();
    if (retired) (await graph.retire()).unwrap();
    const next = work.next();
    if (retired) {
      assert(next.done);
      expect(next.value.ok).toBe(false);
      expect(creates).toHaveBeenCalledTimes(1);
    } else {
      expect(next.done).toBe(false);
      expect(creates).toHaveBeenCalledTimes(2);
      const done = work.next();
      assert(done.done);
      done.value.unwrap();
    }
    expect(imported).not.toHaveBeenCalled();
    expect(encoded).not.toHaveBeenCalled();
  } finally {
    creates.mockRestore();
    (await graph.retire()).unwrap();
  }
});

it.each([
  'return',
  'native-return',
  'reentrant-next',
  'throw',
] as const)('closes resource preparation and unwinds its exact recipe on %s', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder();
  let captured: (() => boolean) | undefined;
  let finalized = 0;
  let steps = 0;
  let work: ReturnType<
    import('../types').CompiledRenderGraph<import('../types').RenderGraphFrame>['prepareResources']
  >;
  builder
    .addComputePass('prepare-only', {
      accesses: [],
      *prepareResources(_resources, current) {
        captured = current;
        try {
          steps++;
          if (mode === 'native-return') work.return(ok(undefined));
          if (mode === 'reentrant-next') work.next();
          yield;
          assert(current());
          steps++;
        } finally {
          finalized++;
        }
      },
      encodeDirect() {
        throw Error('preparation must not encode');
      },
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  work = graph.prepareResources(() => true);
  try {
    work.next();
    if (mode === 'return') work.return(ok(undefined));
    if (mode === 'throw') {
      let caught = false;
      try {
        work.throw(undefined);
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
    }
    expect(captured?.()).toBe(false);
    expect(finalized).toBe(1);
    expect(steps).toBe(1);
    expect(work.next().done).toBe(true);
    expect(finalized).toBe(1);
  } finally {
    (await graph.retire()).unwrap();
  }
});

it('prepares an explicit native import through the original imported-view cache and rechecks its exact texture', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const descriptor = { format: 'rgba8unorm' as const, size: { width: 4, height: 4 }, usage: 4 };
  const first = device.createTexture(descriptor).unwrap();
  const second = device.createTexture(descriptor).unwrap();
  let actual = first;
  const resolve = vi.fn(() => actual);
  // biome-ignore lint/correctness/useYield: The lazy preparation contract permits a synchronous completion without a suspension.
  const prepare = vi.fn(function* (current: () => boolean) {
    assert(current());
    return actual;
  });
  const builder = new RenderGraphBuilder();
  const texture = builder
    .importTexture('persistent', descriptor, resolve, { prepare, current: () => actual })
    .unwrap();
  const view = builder.view(texture, { dimension: '2d' }).unwrap();
  const encoded = vi.fn();
  builder
    .addComputePass('read', {
      accesses: [{ resource: view, usage: 'sampled-read' }],
      encodeDirect: encoded,
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
  const creates = vi.spyOn(device, 'createTextureView');
  const work = graph.prepareResources(() => true);
  try {
    expect(graph.preparedResourcesCurrent()).toBe(false);
    expect(work.next().done).toBe(false);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(encoded).not.toHaveBeenCalled();
    const done = work.next();
    assert(done.done);
    done.value.unwrap();
    expect(graph.preparedResourcesCurrent()).toBe(true);
    const execute = () => {
      const encoder = device.createCommandEncoder().unwrap();
      graph.execute({ encoder }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    };
    execute();
    expect(creates).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    actual = second;
    expect(graph.preparedResourcesCurrent()).toBe(false);
    execute();
    expect(creates).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
  } finally {
    creates.mockRestore();
    (await graph.retire()).unwrap();
    device.destroyTexture(first).unwrap();
    device.destroyTexture(second).unwrap();
  }
});

it('holds exact native import texture currency even when every view is supplied by its owner', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const descriptor = { format: 'rgba8unorm' as const, size: { width: 4, height: 4 }, usage: 4 };
  const first = device.createTexture(descriptor).unwrap();
  const second = device.createTexture(descriptor).unwrap();
  let actual = first;
  const view = device.createTextureView(first, {}).unwrap();
  const builder = new RenderGraphBuilder();
  const texture = builder
    .importTexture('owner', descriptor, () => actual, {
      // biome-ignore lint/correctness/useYield: This failure probe completes synchronously through the required generator contract.
      *prepare(current) {
        assert(current());
        return actual;
      },
      current: () => actual,
    })
    .unwrap();
  const imported = builder.importView(texture, { dimension: '2d' }, () => view).unwrap();
  builder
    .addComputePass('sample', {
      accesses: [{ resource: imported, usage: 'sampled-read' }],
      encodeDirect() {},
    })
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 4, height: 4 } }).unwrap();
  try {
    expect(graph.preparedResourcesCurrent()).toBe(false);
    const next = graph.prepareResources(() => true).next();
    assert(next.done);
    next.value.unwrap();
    expect(graph.preparedResourcesCurrent()).toBe(true);
    actual = second;
    expect(graph.preparedResourcesCurrent()).toBe(false);
  } finally {
    (await graph.retire()).unwrap();
    device.destroyTexture(first).unwrap();
    device.destroyTexture(second).unwrap();
  }
});
