import type { PipelineLibraryManifest, RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { snapshotLoadTimeline } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { disposeDevice, makeRhiDevice } from '../device';
import { createShaderModule, createShaderModuleImmediate } from '../index';
import { createMockGpu } from './__mocks__/gpu-device';

async function fixture() {
  const gpu = createMockGpu(),
    adapter = await gpu.requestAdapter();
  const raw = (await adapter?.requestDevice()) as unknown as GPUDevice;
  const render = vi.fn(async (_d: GPURenderPipelineDescriptor) => ({}) as GPURenderPipeline);
  const compute = vi.fn(async (_d: GPUComputePipelineDescriptor) => ({}) as GPUComputePipeline);
  Object.assign(raw, {
    createRenderPipelineAsync: render,
    createComputePipelineAsync: compute,
    destroy: vi.fn(),
  });
  const sync = vi.spyOn(raw, 'createRenderPipeline');
  const device = makeRhiDevice(raw).device;
  const module = (code = 'shader source', label = 'module') =>
    createShaderModuleImmediate(device, { code, label }).unwrap();
  const descriptor = (code?: string): RenderPipelineDescriptor => ({
    label: 'fog',
    layout: device
      .createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }).unwrap()],
      })
      .unwrap(),
    vertex: { module: module(code), entryPoint: 'vs', buffers: [] },
    fragment: { module: module(code), entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
  });
  const pipelineLibrary = device.pipelineLibrary,
    createRenderPipelineAsync = device.createRenderPipelineAsync;
  if (pipelineLibrary === undefined || createRenderPipelineAsync === undefined)
    throw new Error('Missing WebGPU pipeline library');
  return {
    raw,
    render,
    compute,
    sync,
    device: Object.assign(device, { pipelineLibrary, createRenderPipelineAsync }),
    module,
    descriptor,
  };
}

it('reuses build-projected compute closures for ordinary sync/async requests and archive round trips', async () => {
  const f = await fixture();
  const manifest: PipelineLibraryManifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [
      { code: 'scan and effect A' },
      { code: 'scan and effect B' },
      { code: 'shared scan' },
    ],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [0, 1].map((module) => ({
      layout: 'auto',
      compute: { module, entryPoint: 'scan', constants: { count: 4 } },
    })),
    computeEntryModules: [0, 1].map((module) => ({
      module,
      entryPoint: 'scan',
      specializedModule: 2,
    })),
  };
  expect((await f.device.pipelineLibrary.prepare(manifest)).ok).toBe(true);
  expect(f.compute).toHaveBeenCalledTimes(1);
  const descriptor = (source: string, count = 4) => ({
    layout: 'auto' as const,
    compute: { module: f.module(source), entryPoint: 'scan', constants: { count } },
  });
  const a = f.device.createComputePipeline(descriptor('scan and effect A')).unwrap();
  const asyncCreate = f.device.createComputePipelineAsync;
  if (asyncCreate === undefined) throw new Error('Missing asynchronous compute factory');
  expect((await asyncCreate(descriptor('scan and effect B'))).unwrap()).toBe(a);
  expect(f.compute).toHaveBeenCalledTimes(1);
  await asyncCreate(descriptor('scan and effect B', 8));
  expect(f.compute).toHaveBeenCalledTimes(2);
  const exported = f.device.pipelineLibrary.export().unwrap();
  expect(exported.computeEntryModules).toHaveLength(2);
  const next = await fixture();
  expect((await next.device.pipelineLibrary.prepare(exported)).ok).toBe(true);
  expect(next.compute).toHaveBeenCalledTimes(2);
});

it('rejects malformed compute projections before native creation', async () => {
  const f = await fixture(),
    create = vi.spyOn(f.raw, 'createShaderModule');
  const manifest: PipelineLibraryManifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [{ code: 'source' }],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [],
    computeEntryModules: [{ module: 0, entryPoint: 'scan', specializedModule: 1 }],
  };
  expect((await f.device.pipelineLibrary.prepare(manifest)).ok).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

it('reuses identical complete pipelines across independently recreated layouts and labels', async () => {
  const f = await fixture();
  const first = f.device.createRenderPipeline(f.descriptor()).unwrap();
  const second = f.device
    .createRenderPipeline({ ...f.descriptor(), label: 'later graph' })
    .unwrap();
  expect(second).toBe(first);
  expect(f.sync).toHaveBeenCalledTimes(1);
  expect(f.device.pipelineLibrary.inspect()).toMatchObject({
    pipelineHits: 1,
    synchronousCreations: 1,
    compilationCompleted: 0,
  });
});

it('exports recipes and prepares native completion on a new device before synchronous use', async () => {
  const a = await fixture();
  a.device.createRenderPipeline(a.descriptor()).unwrap();
  const archive = JSON.parse(
    JSON.stringify(a.device.pipelineLibrary.export().unwrap()),
  ) as PipelineLibraryManifest;
  const b = await fixture();
  const prepared = await b.device.pipelineLibrary.prepare(archive);
  expect(prepared.unwrap()).toMatchObject({
    warmup: { requested: 1, completed: 1, failed: 0 },
    compilationCompleted: 1,
  });
  const expected = await b.render.mock.results[0]?.value;
  expect(b.device.createRenderPipeline(b.descriptor()).unwrap()).toBe(expected);
  expect(b.sync).not.toHaveBeenCalled();
  expect(b.render).toHaveBeenCalledTimes(1);
  expect(b.device.pipelineLibrary.export().unwrap()).toEqual(archive);
});

it('awaits shared native work and does not treat a synchronous handle as compiled', async () => {
  const f = await fixture(),
    d = f.descriptor();
  f.device.createRenderPipeline(d).unwrap();
  let finish!: (p: GPURenderPipeline) => void;
  f.render.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = f.device.createRenderPipelineAsync(d),
    second = f.device.createRenderPipelineAsync(f.descriptor());
  expect(f.device.pipelineLibrary.export().ok).toBe(false);
  await Promise.resolve();
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.device.pipelineLibrary.inspect()).toMatchObject({
    compilationPending: 1,
    compilationCompleted: 0,
  });
  finish({} as GPURenderPipeline);
  expect((await first).unwrap()).toBe((await second).unwrap());
  expect(f.device.pipelineLibrary.inspect().compilationCompleted).toBe(1);
});

it('separates code, specialization, attachments and depth/blend state while ignoring label aliases', async () => {
  const f = await fixture(),
    d = f.descriptor(),
    first = f.device.createRenderPipeline(d).unwrap();
  if (d.fragment === undefined) throw new Error('Fixture fragment missing');
  const variants: RenderPipelineDescriptor[] = [
    f.descriptor('different same-label source'),
    { ...d, vertex: { ...d.vertex, constants: { label: 1 } } },
    { ...d, vertex: { ...d.vertex, constants: { label: 2 } } },
    { ...d, fragment: { ...d.fragment, targets: [{ format: 'rgba8unorm' }] } },
    {
      ...d,
      fragment: {
        ...d.fragment,
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one' },
              alpha: { srcFactor: 'one', dstFactor: 'zero' },
            },
          },
        ],
      },
    },
    {
      ...d,
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
    },
  ];
  for (const variant of variants)
    expect(f.device.createRenderPipeline(variant).unwrap()).not.toBe(first);
  expect(f.device.createRenderPipeline(f.descriptor()).unwrap()).toBe(first);
  expect(f.sync).toHaveBeenCalledTimes(1 + variants.length);
});

it('retries failed preparation without poisoning the cache or reporting success', async () => {
  const f = await fixture(),
    d = f.descriptor();
  f.render.mockRejectedValueOnce(
    Object.assign(new Error('bad pipeline'), { reason: 'validation' }),
  );
  expect((await f.device.createRenderPipelineAsync(d)).ok).toBe(false);
  expect(f.device.pipelineLibrary.inspect()).toMatchObject({
    failures: 1,
    compilationCompleted: 0,
    compilationPending: 0,
  });
  expect((await f.device.createRenderPipelineAsync(d)).ok).toBe(true);
  expect(f.render).toHaveBeenCalledTimes(2);
});

it('rejects malformed dependency graphs before issuing native compilation', async () => {
  const f = await fixture();
  f.device.createRenderPipeline(f.descriptor()).unwrap();
  const manifest = f.device.pipelineLibrary.export().unwrap();
  if (manifest.renderPipelines[0] === undefined) throw new Error('Fixture render recipe missing');
  const broken = {
    ...manifest,
    renderPipelines: [{ ...manifest.renderPipelines[0], layout: 999 }],
  };
  const result = await f.device.pipelineLibrary.prepare(broken);
  expect(result.ok).toBe(false);
  expect(f.render).not.toHaveBeenCalled();
});

it('keeps compute recipes in the same startup library', async () => {
  const a = await fixture();
  a.device
    .createComputePipeline({
      layout: 'auto',
      compute: { module: a.module(), entryPoint: 'cs', constants: { count: 4 } },
    })
    .unwrap();
  const b = await fixture();
  expect(
    (await b.device.pipelineLibrary.prepare(a.device.pipelineLibrary.export().unwrap())).ok,
  ).toBe(true);
  const pipeline = b.device
    .createComputePipeline({
      layout: 'auto',
      compute: { module: b.module(), entryPoint: 'cs', constants: { count: 4 } },
    })
    .unwrap();
  expect(pipeline).toBe(await b.compute.mock.results[0]?.value);
  expect(b.device.pipelineLibrary.inspect().computePipelines).toBe(1);
});

it('refuses an incomplete export instead of silently dropping foreign native dependencies', async () => {
  const f = await fixture();
  f.device
    .createRenderPipeline({ layout: 'auto', vertex: { module: {} as never, buffers: [] } })
    .unwrap();
  expect(f.device.pipelineLibrary.inspect().unrecordable).toBe(1);
  expect(f.device.pipelineLibrary.export().ok).toBe(false);
});

it('never publishes a late completion after device disposal', async () => {
  const f = await fixture();
  let finish!: (p: GPURenderPipeline) => void;
  f.render.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.device.createRenderPipelineAsync(f.descriptor());
  await Promise.resolve();
  disposeDevice(f.device);
  finish({} as GPURenderPipeline);
  expect((await pending).ok).toBe(false);
  expect(f.device.pipelineLibrary.inspect()).toMatchObject({
    state: 'disposed',
    compilationCompleted: 0,
    compilationPending: 0,
    sourceBytes: 0,
  });
  expect(f.device.pipelineLibrary.export().ok).toBe(false);
});

it('drops an unverified sync handle after native asynchronous validation rejects it', async () => {
  const f = await fixture(),
    d = f.descriptor();
  const invalid = f.device.createRenderPipeline(d).unwrap();
  f.render.mockRejectedValueOnce(new Error('validation failed'));
  expect((await f.device.createRenderPipelineAsync(d)).ok).toBe(false);
  expect(f.device.pipelineLibrary.export().unwrap().renderPipelines).toHaveLength(0);
  expect(f.device.createRenderPipeline(d).unwrap()).not.toBe(invalid);
});

it('rejects a mismatched pipeline roster before creating any imported shader', async () => {
  const a = await fixture();
  a.device.createComputePipeline({ layout: 'auto', compute: { module: a.module() } }).unwrap();
  const manifest = a.device.pipelineLibrary.export().unwrap();
  const b = await fixture(),
    spy = vi.spyOn(b.raw, 'createShaderModule');
  const broken = {
    ...manifest,
    renderPipelines: manifest.computePipelines,
    computePipelines: [],
  } as unknown as PipelineLibraryManifest;
  expect((await b.device.pipelineLibrary.prepare(broken)).ok).toBe(false);
  expect(spy).not.toHaveBeenCalled();
});

it('exports only dependencies reachable from observed usable pipelines', async () => {
  const f = await fixture();
  f.module('unused');
  f.device.createBindGroupLayout({ entries: [] }).unwrap();
  f.device.createRenderPipeline(f.descriptor()).unwrap();
  const manifest = f.device.pipelineLibrary.export().unwrap();
  expect(manifest.shaders.map((s) => s.code)).toEqual(['shader source']);
  const fresh = await fixture();
  expect((await fresh.device.pipelineLibrary.prepare(manifest)).ok).toBe(true);
});

it('shares shader compilation diagnostics across concurrent and later source aliases', async () => {
  const f = await fixture();
  const rawModule = f.module() as unknown as GPUShaderModule;
  const info = vi.spyOn(rawModule, 'getCompilationInfo');
  const [first, second] = await Promise.all([
    createShaderModule(f.device, { code: 'shader source', label: 'first' }),
    createShaderModule(f.device, { code: 'shader source', label: 'second' }),
  ]);
  expect(first.unwrap()).toBe(second.unwrap());
  expect(
    (await createShaderModule(f.device, { code: 'shader source', label: 'later' })).unwrap(),
  ).toBe(first.unwrap());
  expect(info).toHaveBeenCalledTimes(1);
});

it('returns a completion-qualified cache hit immediately without rereading raw descriptors', async () => {
  const f = await fixture();
  const d = f.descriptor();
  const reads: string[] = [];
  const raw = {
    ...d,
    get label() {
      reads.push('label');
      return 'raw';
    },
    vertex: {
      ...d.vertex,
      get entryPoint() {
        reads.push('entryPoint');
        return 'vs';
      },
      get constants() {
        reads.push('constants');
        return { value: 1 };
      },
    },
  };
  const miss = f.device.createRenderPipelineAsync(raw);
  expect(miss).toBeInstanceOf(Promise);
  await miss;
  const missReads = [...reads];
  reads.length = 0;
  const ready = f.device.createRenderPipelineAsync(raw);
  expect(ready).not.toBeInstanceOf(Promise);
  if (!('ok' in ready)) throw Error('completed recipe remained async');
  expect(ready.unwrap()).toBe(await f.render.mock.results[0]?.value);
  expect(reads).toEqual(missReads);
  expect(f.render).toHaveBeenCalledTimes(1);
  expect(f.sync).not.toHaveBeenCalled();
  const changed = f.device.createRenderPipelineAsync({
    ...d,
    vertex: { ...d.vertex, constants: { value: 2 } },
  });
  expect(changed).toBeInstanceOf(Promise);
  await changed;
  disposeDevice(f.device);
  expect((await f.device.createRenderPipelineAsync(raw)).ok).toBe(false);
});

it('never qualifies a sync-only compute handle or an unresolved native compilation', async () => {
  const f = await fixture();
  const d = { layout: 'auto' as const, compute: { module: f.module(), entryPoint: 'cs' } };
  f.device.createComputePipeline(d).unwrap();
  let finish!: (pipeline: GPUComputePipeline) => void;
  f.compute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const create = f.device.createComputePipelineAsync;
  if (create === undefined) throw Error('missing compute capability');
  const first = create(d);
  expect(first).toBeInstanceOf(Promise);
  await Promise.resolve();
  expect(create(d)).toBeInstanceOf(Promise);
  const pipeline = {} as GPUComputePipeline;
  finish(pipeline);
  expect((await first).unwrap()).toBe(pipeline);
  const ready = create({ ...d, label: 'fresh player' });
  if (!('ok' in ready)) throw Error('completed compute recipe remained async');
  expect(ready.unwrap()).toBe(pipeline);
  expect(f.compute).toHaveBeenCalledTimes(1);
});

it('records native shader and pipeline creation on the load timeline, once per native call', async () => {
  const before = snapshotLoadTimeline().records.length;
  const f = await fixture();
  const d = f.descriptor('timeline shader source');
  f.device.createRenderPipeline(d).unwrap();
  (await f.device.createRenderPipelineAsync({ ...d, label: 'async fog' })).unwrap();
  // A cache hit performs no native work and records nothing.
  f.device.createRenderPipeline(f.descriptor('timeline shader source')).unwrap();
  const rows = snapshotLoadTimeline().records.slice(before);
  expect(rows.filter((r) => r.kind === 'shader')).toEqual([
    expect.objectContaining({ name: 'module', bytes: 'timeline shader source'.length }),
  ]);
  expect(
    rows.filter((r) => r.kind === 'pipeline').map((r) => [r.name, r.detail?.mode, r.detail?.kind]),
  ).toEqual([
    ['fog', 'sync', 'render'],
    ['async fog', 'async', 'render'],
  ]);
});
