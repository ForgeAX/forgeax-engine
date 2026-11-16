import type { PipelineLibraryManifest, RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { pipelineDescriptorState } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import { makeRhiDevice } from '../device';
import { createShaderModuleImmediate } from '../index';
import { createMockGpu } from './__mocks__/gpu-device';

const requestedOnly = { requestedOnly: true } as const;

async function fixture() {
  const adapter = await createMockGpu().requestAdapter();
  const raw = (await adapter?.requestDevice()) as unknown as GPUDevice;
  const finishes: (() => void)[] = [];
  const native = <T>() =>
    vi.fn(
      () =>
        new Promise<T>((resolve) => {
          finishes.push(() => resolve({} as T));
        }),
    );
  const render = native<GPURenderPipeline>(),
    compute = native<GPUComputePipeline>();
  Object.assign(raw, {
    createRenderPipelineAsync: render,
    createComputePipelineAsync: compute,
    destroy: vi.fn(),
  });
  const device = makeRhiDevice(raw).device;
  const library = device.pipelineLibrary,
    createRenderPipelineAsync = device.createRenderPipelineAsync;
  if (library === undefined || createRenderPipelineAsync === undefined)
    throw new Error('Missing WebGPU pipeline library');
  const module = (code: string) =>
    createShaderModuleImmediate(device, { code, label: code }).unwrap();
  const descriptor = (code: string): RenderPipelineDescriptor => ({
    label: code,
    layout: device
      .createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }).unwrap()],
      })
      .unwrap(),
    vertex: { module: module(code), entryPoint: 'vs', buffers: [] },
    fragment: { module: module(code), entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
  });
  /** Complete native compilations as they are issued until `work` settles. */
  const settle = async <T>(work: Promise<T>): Promise<T> => {
    let settled = false;
    const observed = work.finally(() => {
      settled = true;
    });
    while (!settled) {
      for (const finish of finishes.splice(0)) finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return observed;
  };
  const codes = (manifest: PipelineLibraryManifest) =>
    manifest.shaders.map((shader) => shader.code).sort();
  return {
    device: Object.assign(device, { createRenderPipelineAsync }),
    library,
    render,
    compute,
    finishes,
    module,
    descriptor,
    settle,
    codes,
  };
}

/** A library recorded by a renderer that drew `names`, as a later session would install it. */
async function recorded(names: readonly string[]): Promise<PipelineLibraryManifest> {
  const source = await fixture();
  for (const name of names) source.device.createRenderPipeline(source.descriptor(name)).unwrap();
  const manifest = source.library.export().unwrap();
  // Every recipe here was asked for by the renderer, so the selection changes nothing.
  expect(source.library.export(undefined, requestedOnly).unwrap()).toEqual(manifest);
  return manifest;
}

it('lists recipes compiled only by an installed library by default and leaves them out when asked', async () => {
  const target = await fixture();
  const prepared = await target.settle(
    target.library.prepare(await recorded(['terrain', 'water'])),
  );
  expect(prepared.ok).toBe(true);
  expect(target.render).toHaveBeenCalledTimes(2);
  const everything = target.library.export().unwrap();
  expect(everything.renderPipelines).toHaveLength(2);
  expect(target.codes(everything)).toEqual(['terrain', 'water']);
  const requested = target.library.export(undefined, requestedOnly).unwrap();
  expect(requested.renderPipelines).toHaveLength(0);
  expect(requested.shaders).toHaveLength(0);
  expect(requested.bindGroupLayouts).toHaveLength(0);
  expect(requested.pipelineLayouts).toHaveLength(0);
});

it('keeps a warmed recipe once the renderer asks for it through any creation or selection entry', async () => {
  const target = await fixture();
  await target.settle(target.library.prepare(await recorded(['sync', 'async', 'select', 'idle'])));
  expect(target.render).toHaveBeenCalledTimes(4);

  target.device.createRenderPipeline(target.descriptor('sync')).unwrap();
  expect(target.codes(target.library.export(undefined, requestedOnly).unwrap())).toEqual(['sync']);

  expect((await target.device.createRenderPipelineAsync(target.descriptor('async'))).ok).toBe(true);
  expect(target.codes(target.library.export(undefined, requestedOnly).unwrap())).toEqual([
    'async',
    'sync',
  ]);

  const selected = target.descriptor('select');
  const state = pipelineDescriptorState('render', selected as unknown as Record<string, unknown>);
  const dependencies = {
    layout: selected.layout,
    vertex: selected.vertex.module,
    ...(selected.fragment === undefined ? {} : { fragment: selected.fragment.module }),
  };
  const found = await target.library.selectRender?.(state, dependencies, true);
  expect(found?.ok === true && found.value !== undefined).toBe(true);
  const requested = target.library.export(undefined, requestedOnly).unwrap();
  expect(target.codes(requested)).toEqual(['async', 'select', 'sync']);
  expect(requested.renderPipelines).toHaveLength(3);

  // Every request above was served by the warmed record: no further native compilation.
  expect(target.render).toHaveBeenCalledTimes(4);
  expect(target.library.export().unwrap().renderPipelines).toHaveLength(4);
});

it('keeps the mark after a request that joined an unfinished warmup compilation settles', async () => {
  const target = await fixture();
  const preparing = target.library.prepare(await recorded(['terrain', 'water']), {
    concurrency: 1,
  });
  await vi.waitFor(() => expect(target.finishes).toHaveLength(1));
  // `terrain` is compiling for the warmup and `water` is still queued behind it.
  const joined = target.device.createRenderPipelineAsync(target.descriptor('terrain'));
  expect(target.library.export(undefined, requestedOnly).ok).toBe(false);
  const [prepared, pipeline] = await target.settle(Promise.all([preparing, joined]));
  expect(prepared.ok).toBe(true);
  expect(pipeline.ok).toBe(true);
  expect(target.render).toHaveBeenCalledTimes(2);
  expect(target.library.inspect().pending?.pipelines).toEqual([]);
  const requested = target.library.export(undefined, requestedOnly).unwrap();
  expect(requested.renderPipelines).toHaveLength(1);
  expect(target.codes(requested)).toEqual(['terrain']);
});

it('keeps a compute entry projection only when a listed recipe uses its specialized module', async () => {
  const manifest: PipelineLibraryManifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [
      { code: 'effect A' },
      { code: 'effect B' },
      { code: 'scan of A' },
      { code: 'scan of B' },
    ],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [0, 1].map((module) => ({
      layout: 'auto',
      compute: { module, entryPoint: 'scan' },
    })),
    computeEntryModules: [0, 1].map((module) => ({
      module,
      entryPoint: 'scan',
      specializedModule: module + 2,
    })),
  };
  const target = await fixture();
  expect((await target.settle(target.library.prepare(manifest))).ok).toBe(true);
  expect(target.compute).toHaveBeenCalledTimes(2);
  const none = target.library.export(undefined, requestedOnly).unwrap();
  expect(none.computePipelines).toHaveLength(0);
  expect(none.computeEntryModules).toBeUndefined();
  expect(none.shaders).toHaveLength(0);

  target.device
    .createComputePipeline({
      layout: 'auto',
      compute: { module: target.module('effect A'), entryPoint: 'scan' },
    })
    .unwrap();
  const requested = target.library.export(undefined, requestedOnly).unwrap();
  expect(requested.computePipelines).toHaveLength(1);
  expect(requested.computeEntryModules).toHaveLength(1);
  expect(target.codes(requested)).toEqual(['effect A', 'scan of A']);
  expect(target.compute).toHaveBeenCalledTimes(2);
  expect(target.library.export().unwrap().computeEntryModules).toHaveLength(2);

  // The selected graph is a complete library: a fresh device prepares it and serves the same request.
  const next = await fixture();
  expect((await next.settle(next.library.prepare(requested))).ok).toBe(true);
  expect(next.compute).toHaveBeenCalledTimes(1);
  next.device
    .createComputePipeline({
      layout: 'auto',
      compute: { module: next.module('effect A'), entryPoint: 'scan' },
    })
    .unwrap();
  expect(next.compute).toHaveBeenCalledTimes(1);
});
