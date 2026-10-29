import type { PipelineLibraryManifest, RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { ownPipelineLibrary, pipelineDescriptorState } from '@forgeax/engine-rhi';
import { ShaderSource, snapshotLoadTimeline } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { disposeDevice, makeRhiDevice } from '../device';
import { createShaderModule, createShaderModuleImmediate } from '../index';
import { PipelineCompilationRecords } from '../pipeline-compilation-records';
import { backgroundPipelineWarmupConcurrency } from '../pipeline-library';
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

it('does not hash an uncached Shader through the pending list during lightweight history inspection', async () => {
  const f = await fixture();
  const pending = f.device.createRenderPipelineAsync(f.descriptor());
  const inspection = f.device.pipelineLibrary.inspect({ runtimeRequests: true });
  expect(inspection.pending).toBeUndefined();
  expect(inspection.runtimeRequests?.requests[0]?.pipeline?.shaders[0]?.sourceDigest).toBeNull();
  await pending;
});

it('retains a runtime request that completed before an asynchronous observer arrives', async () => {
  const f = await fixture();
  await f.device.createRenderPipelineAsync(f.descriptor());
  expect(f.device.pipelineLibrary.inspect().runtimeRequests).toBeUndefined();
  const inspection = f.device.pipelineLibrary.inspect({ runtimeRequests: true });
  expect(inspection.compilationPending).toBe(0);
  expect(inspection.pending).toBeUndefined();
  expect(inspection.runtimeRequests).toMatchObject({
    latestSequence: 1,
    overwritten: 0,
    requests: [
      {
        sequence: 1,
        mode: 'async',
        outcome: 'completed',
        preloadAtDemand: 'absent',
        pipeline: {
          localIdentity: 1,
          identity: null,
          kind: 'render',
          shaders: [{ sourceDigest: null }],
        },
      },
    ],
  });
  const request = inspection.runtimeRequests?.requests[0];
  if (request === undefined || request.startedAtMs === null)
    throw new Error('Missing runtime request');
  expect(request.completedAtMs).toBeGreaterThanOrEqual(request.startedAtMs);
  expect(request.startedAtMs).toBeGreaterThanOrEqual(request.requestedAtMs);
  expect(JSON.stringify(inspection.runtimeRequests)).not.toContain('shader source');
});

it('bounds runtime evidence while completed cache hits add no requests or native work', async () => {
  const f = await fixture();
  for (let i = 0; i < 80; i++)
    await f.device.createRenderPipelineAsync(f.descriptor(`source ${i}`));
  const descriptor = f.descriptor('source 79');
  const record = vi.spyOn(PipelineCompilationRecords.prototype, 'begin');
  const inspect = vi.spyOn(PipelineCompilationRecords.prototype, 'inspect');
  for (let i = 0; i < 500; i++) f.device.createRenderPipeline(descriptor).unwrap();
  expect(record).not.toHaveBeenCalled();
  expect(f.device.pipelineLibrary.inspect().runtimeRequests).toBeUndefined();
  expect(inspect).not.toHaveBeenCalled();
  const history = f.device.pipelineLibrary.inspect({ runtimeRequests: true }).runtimeRequests;
  if (history === undefined) throw new Error('Missing runtime history');
  expect(history).toMatchObject({ capacity: 32, latestSequence: 80, overwritten: 48 });
  expect(history.requests).toHaveLength(32);
  expect(history.requests[0]?.sequence).toBe(49);
  expect(history.requests.at(-1)?.sequence).toBe(80);
  expect(f.render).toHaveBeenCalledTimes(80);
  expect(f.sync).not.toHaveBeenCalled();
  record.mockRestore();
  inspect.mockRestore();
});

it('retains a runtime demand joining an existing background compilation without issuing another one', async () => {
  const a = await fixture();
  a.device.createRenderPipeline(a.descriptor()).unwrap();
  const manifest = a.device.pipelineLibrary.export().unwrap(),
    b = await fixture();
  let release: (value: GPURenderPipeline) => void = () => {
    throw new Error('Native request not started');
  };
  b.render.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const warm = b.device.pipelineLibrary.prepare(manifest, { background: true, concurrency: 1 });
  await vi.waitFor(() => expect(b.render).toHaveBeenCalledOnce());
  expect(
    b.device.pipelineLibrary.inspect({ runtimeRequests: true }).runtimeRequests?.requests,
  ).toEqual([]);
  const demand = b.device.createRenderPipelineAsync(b.descriptor());
  release({} as GPURenderPipeline);
  await warm;
  await demand;
  expect(
    b.device.pipelineLibrary.inspect({ runtimeRequests: true }).runtimeRequests?.requests,
  ).toMatchObject([
    {
      outcome: 'completed',
      origin: 'background-warmup',
      preloadAtDemand: 'background',
      pipeline: { preload: 'background' },
    },
  ]);
  expect(b.render).toHaveBeenCalledOnce();
});

it('retains failures/retries and distinguishes returned sync handles from native completion', async () => {
  const f = await fixture();
  f.render.mockRejectedValueOnce(new Error('deliberate failure'));
  expect((await f.device.createRenderPipelineAsync(f.descriptor())).ok).toBe(false);
  await f.device.createRenderPipelineAsync(f.descriptor());
  f.device.createRenderPipeline(f.descriptor('sync-only')).unwrap();
  expect(
    f.device.pipelineLibrary
      .inspect({ runtimeRequests: true })
      .runtimeRequests?.requests.map((row) => row.outcome),
  ).toEqual(['failed', 'completed', 'returned']);
});

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

async function backgroundArchive(count: number) {
  const a = await fixture();
  for (let i = 0; i < count; i++)
    a.device.createRenderPipeline(a.descriptor(`source ${i}`)).unwrap();
  return JSON.parse(
    JSON.stringify(a.device.pipelineLibrary.export().unwrap()),
  ) as PipelineLibraryManifest;
}

it('keeps background concurrency bounded on small and large machines', () => {
  for (const cores of [undefined, 0, 1, 2, 8, 32, 192, Number.NaN]) {
    const count = backgroundPipelineWarmupConcurrency(cores);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(4);
  }
});

it('yields before issuing background requests and stops after disposal', async () => {
  const archive = await backgroundArchive(5);
  const b = await fixture();
  const prepared = b.device.pipelineLibrary.prepare(archive, { background: true });
  expect(b.render).not.toHaveBeenCalled();
  disposeDevice(b.device);
  expect((await prepared).ok).toBe(false);
  expect(b.render).not.toHaveBeenCalled();
});

it('validates independent background modules concurrently without reordering dependencies', async () => {
  const archive = await backgroundArchive(5);
  const b = await fixture();
  const finish: ((info: GPUCompilationInfo) => void)[] = [];
  const byCode = new Map<string, GPUShaderModule>();
  const modules = vi.spyOn(b.raw, 'createShaderModule').mockImplementation((descriptor) => {
    const module = {
      getCompilationInfo: () => new Promise<GPUCompilationInfo>((resolve) => finish.push(resolve)),
    } as GPUShaderModule;
    byCode.set(descriptor.code, module);
    return module;
  });
  const prepared = b.device.pipelineLibrary.prepare(archive, { background: true, concurrency: 2 });
  await vi.waitFor(() => expect(finish).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(modules).toHaveBeenCalledTimes(2);
  finish[1]?.({ messages: [] } as unknown as GPUCompilationInfo);
  await vi.waitFor(() => expect(finish).toHaveLength(3));
  finish[0]?.({ messages: [] } as unknown as GPUCompilationInfo);
  for (let i = 2; i < 5; i++) {
    await vi.waitFor(() => expect(finish.length).toBeGreaterThan(i));
    finish[i]?.({ messages: [] } as unknown as GPUCompilationInfo);
  }
  expect((await prepared).ok).toBe(true);
  expect(modules).toHaveBeenCalledTimes(5);
  for (const [index, [descriptor]] of b.render.mock.calls.entries()) {
    const recipe = archive.renderPipelines[index];
    if (recipe === undefined) throw new Error('Missing archived recipe');
    const code = archive.shaders[recipe.vertex.module]?.code;
    if (code === undefined) throw new Error('Missing archived shader');
    expect(descriptor.vertex.module).toBe(byCode.get(code));
  }
});

it.each([
  2, 4,
])('bounds background compilation to %i and publishes each completed entry before the import settles', async (concurrency) => {
  const archive = await backgroundArchive(5);
  const b = await fixture();
  const finishes: ((p: GPURenderPipeline) => void)[] = [];
  let inFlight = 0,
    peak = 0;
  b.render.mockImplementation(
    () =>
      new Promise<GPURenderPipeline>((resolve) => {
        peak = Math.max(peak, ++inFlight);
        finishes.push((p) => {
          inFlight--;
          resolve(p);
        });
      }),
  );
  expect(b.device.pipelineLibrary.inspect().backgroundWarmup.state).toBe('idle');
  const prepared = b.device.pipelineLibrary.prepare(archive, { background: true, concurrency });
  await vi.waitFor(() => expect(finishes).toHaveLength(concurrency));
  expect(b.device.pipelineLibrary.inspect().backgroundWarmup).toMatchObject({
    requested: 5,
    completed: 0,
    state: 'running',
  });
  const handle = {} as GPURenderPipeline;
  finishes[0]?.(handle);
  await vi.waitFor(() => expect(finishes).toHaveLength(concurrency + 1));
  // The first completed recipe is a hit while the remaining recipes are still compiling.
  const recipe = archive.renderPipelines[0];
  const code = recipe === undefined ? undefined : archive.shaders[recipe.vertex.module]?.code;
  expect(b.device.createRenderPipeline(b.descriptor(code)).unwrap()).toBe(handle);
  expect(b.sync).not.toHaveBeenCalled();
  for (let i = 1; i < 5; i++) {
    await vi.waitFor(() => expect(finishes.length).toBeGreaterThan(i));
    finishes[i]?.({} as GPURenderPipeline);
  }
  expect((await prepared).unwrap()).toMatchObject({
    warmup: { requested: 0, completed: 0, failed: 0 },
    backgroundWarmup: { requested: 5, completed: 5, failed: 0, state: 'done' },
  });
  expect(peak).toBe(concurrency);
});

it('reports a background failure on its own lane and keeps completed entries usable', async () => {
  const archive = await backgroundArchive(3);
  const b = await fixture();
  b.render.mockRejectedValueOnce(
    Object.assign(new Error('bad pipeline'), { reason: 'validation' }),
  );
  const result = await b.device.pipelineLibrary.prepare(archive, { background: true });
  expect(result.ok).toBe(false);
  expect(b.device.pipelineLibrary.inspect()).toMatchObject({
    warmup: { requested: 0, completed: 0, failed: 0 },
    backgroundWarmup: { requested: 3, completed: 2, failed: 1, state: 'failed' },
    compilationCompleted: 2,
  });
  expect((await b.device.pipelineLibrary.prepare(archive, { concurrency: 0 })).ok).toBe(false);
  expect(
    (await b.device.pipelineLibrary.prepare(archive, { background: true, concurrency: 5 })).ok,
  ).toBe(false);
  expect(b.device.pipelineLibrary.inspect().backgroundWarmup.state).toBe('failed');
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

it('warms recipes in manifest position order across the render and compute tables', async () => {
  const a = await fixture();
  for (let i = 0; i < 3; i++) a.device.createRenderPipeline(a.descriptor(`render ${i}`)).unwrap();
  for (let i = 0; i < 2; i++)
    a.device
      .createComputePipeline({
        layout: 'auto',
        compute: { module: a.module(`compute ${i}`), entryPoint: 'cs' },
      })
      .unwrap();
  const archive = a.device.pipelineLibrary.export().unwrap();
  for (const background of [false, true]) {
    const b = await fixture();
    const order: string[] = [];
    b.render.mockImplementation(async (d) => {
      order.push(`render ${(d.vertex.module as unknown as { label?: string }).label ?? ''}`);
      return {} as GPURenderPipeline;
    });
    b.compute.mockImplementation(async (d) => {
      order.push(`compute ${(d.compute.module as unknown as { label?: string }).label ?? ''}`);
      return {} as GPUComputePipeline;
    });
    expect(
      (await b.device.pipelineLibrary.prepare(archive, { background, concurrency: 1 })).ok,
    ).toBe(true);
    expect(order.map((entry) => entry.split(' ')[0])).toEqual([
      'render',
      'compute',
      'render',
      'compute',
      'render',
    ]);
  }
});

it('keeps projected module identities when prior runtime sources cross the old cumulative collection limit', async () => {
  const f = await fixture();
  // Both individual inputs are legal. Only their device-lifetime sum crosses
  // the old UTF-16 collection boundary, and the projected endpoint is new.
  f.module('a'.repeat(30 * 1024 * 1024));
  const manifest: PipelineLibraryManifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [{ code: 'b'.repeat(3 * 1024 * 1024) }, { code: 'projected' }],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [{ layout: 'auto', compute: { module: 0, entryPoint: 'main' } }],
    computeEntryModules: [{ module: 0, entryPoint: 'main', specializedModule: 1 }],
  };
  const prepared = await f.device.pipelineLibrary.prepare(manifest);
  expect(prepared.ok).toBe(true);
  expect(f.compute).toHaveBeenCalledOnce();
  const originalSource = manifest.shaders[0];
  if (originalSource === undefined) throw new Error('Missing original module');
  const original = f.module(originalSource.code);
  const hit = f.device.createComputePipelineAsync?.({
    layout: 'auto',
    compute: { module: original, entryPoint: 'main' },
  });
  expect((await hit)?.ok).toBe(true);
  expect(f.compute).toHaveBeenCalledOnce();
});

it('keeps resource identity and native reuse beyond the former registration cutoff', async () => {
  const f = await fixture();
  const held = Array.from({ length: 4100 }, (_, i) => f.module(`owned source ${i}`));
  const last = held.at(-1);
  if (last === undefined) throw new Error('Missing final module');
  const descriptor: RenderPipelineDescriptor = {
    layout: 'auto',
    vertex: { module: last, entryPoint: 'main', buffers: [] },
  };
  await f.device.createRenderPipelineAsync(descriptor);
  await f.device.createRenderPipelineAsync(descriptor);
  expect(f.render).toHaveBeenCalledOnce();
  expect(f.device.pipelineLibrary.inspect().unrecordable).toBe(0);
});

it('limits each complete export before source expansion and allows a retry without poisoning readiness', async () => {
  const f = await fixture();
  const descriptor = f.descriptor('export source with "escapes" and \n newline');
  await f.device.createRenderPipelineAsync(descriptor);
  const before = f.device.pipelineLibrary.inspect();
  const read = vi.spyOn(ShaderSource.prototype, 'read');
  const failed = f.device.pipelineLibrary.export({ outputBytes: 1 });
  expect(failed.ok).toBe(false);
  if (!failed.ok)
    expect(failed.error.detail).toMatchObject({
      kind: 'pipeline-library-limit',
      operation: 'export',
      limit: 'outputBytes',
      maximum: 1,
    });
  expect(read).not.toHaveBeenCalled();
  const temporary = f.device.pipelineLibrary.export({ temporaryBytes: 1 });
  expect(temporary.ok).toBe(false);
  if (!temporary.ok) expect(temporary.error.detail).toMatchObject({ limit: 'temporaryBytes' });
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  const manifest = f.device.pipelineLibrary.export().unwrap();
  expect(f.device.pipelineLibrary.inspect()).toEqual(before);
  const next = await fixture();
  expect((await next.device.pipelineLibrary.prepare(manifest)).ok).toBe(true);
  expect(next.device.pipelineLibrary.export().unwrap()).toEqual(manifest);
  await f.device.createRenderPipelineAsync(descriptor);
  expect(f.render).toHaveBeenCalledOnce();
});

it('seals all input recipes even when their shader descriptors already have owners', () => {
  const source = new ShaderSource(['@compute @workgroup_size(1) fn main() {}']);
  const input: PipelineLibraryManifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [source.descriptor(undefined)],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [{ layout: 'auto', compute: { module: 0, entryPoint: 'main' } }],
  };
  const owned = ownPipelineLibrary(input);
  (input.computePipelines as unknown[]).push({});
  expect(owned.computePipelines).toHaveLength(1);
  expect(Object.isFrozen(owned.computePipelines[0]?.compute)).toBe(true);
  expect(ownPipelineLibrary(owned)).toBe(owned);
  expect(() => ownPipelineLibrary(owned, { outputBytes: 2 })).toThrow('limit-exceeded');
});

it('rejects array accessors without evaluating them during input allocation checks', async () => {
  const f = await fixture();
  const input = f.device.pipelineLibrary.export().unwrap();
  const getter = vi.fn(() => ({ layout: 'auto', compute: { module: 0 } }));
  const recipes: unknown[] = [];
  Object.defineProperty(recipes, '0', { get: getter, enumerable: true });
  const result = await f.device.pipelineLibrary.prepare({
    ...input,
    computePipelines: recipes as PipelineLibraryManifest['computePipelines'],
  });
  expect(result.ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});

it('selects the same ready or pending record without snapshot, serialization or native creation', async () => {
  const f = await fixture();
  const descriptor = f.descriptor();
  const state = pipelineDescriptorState('render', descriptor as unknown as Record<string, unknown>);
  const dependencies = {
    layout: descriptor.layout,
    vertex: descriptor.vertex.module,
    ...(descriptor.fragment === undefined ? {} : { fragment: descriptor.fragment.module }),
  };
  const pending = f.device.createRenderPipelineAsync(descriptor);
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    const joined = f.device.pipelineLibrary.selectRender?.(state, dependencies, true);
    expect(joined).toBeInstanceOf(Promise);
    const result = await joined;
    expect(result?.ok).toBe(true);
    const ready = f.device.pipelineLibrary.selectRender?.(state, dependencies, true);
    expect(ready).toEqual(result);
    expect(stringify).not.toHaveBeenCalled();
    expect(f.render).toHaveBeenCalledOnce();
  } finally {
    stringify.mockRestore();
  }
  await pending;
  const changed = pipelineDescriptorState('render', {
    ...descriptor,
    primitive: { topology: 'line-list' },
  } as unknown as Record<string, unknown>);
  expect(f.device.pipelineLibrary.selectRender?.(changed, dependencies, true)).toEqual({
    ok: true,
    value: undefined,
  });
});
