import { type ComputePipeline, type Result, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createIrradianceFieldKernel,
  createIrradianceFieldViewKernels,
} from '../../raytracing/irradiance-field';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const create = device.createComputePipeline.bind(device);
  const sync = vi.spyOn(device, 'createComputePipeline').mockImplementation(() => {
    throw new Error('advertised async preparation called the synchronous compiler');
  });
  const pending: {
    readonly result: Result<ComputePipeline, RhiError>;
    readonly finish: (result: Result<ComputePipeline, RhiError>) => void;
  }[] = [];
  const asyncCreate = vi.fn(
    (descriptor: Parameters<typeof device.createComputePipeline>[0]) =>
      new Promise<Result<ComputePipeline, RhiError>>((finish) => {
        pending.push({ result: create(descriptor), finish });
      }),
  );
  Object.assign(device, { createComputePipelineAsync: asyncCreate });
  const finish = () => {
    const entry = pending.shift();
    if (entry === undefined) throw new Error('no pending native completion');
    entry.finish(entry.result);
  };
  return { device, module, sync, create, asyncCreate, pending, finish };
}

async function readyView(current: () => boolean = () => true) {
  const f = await fixture();
  const deferred = f.asyncCreate.getMockImplementation();
  if (deferred === undefined) throw new Error('missing deferred backend');
  f.asyncCreate.mockImplementation((descriptor) => Promise.resolve(f.create(descriptor)));
  const view = (
    await createIrradianceFieldViewKernels(f.device, f.module, 'live', {
      resolution: 'half',
      radiosity: false,
      gatherView: false,
      current,
    })
  ).unwrap();
  f.asyncCreate.mockImplementation(deferred);
  f.asyncCreate.mockClear();
  return { ...f, view };
}

it.each([
  true,
  false,
])('requests initial gather before pending Card completion (demand: %s)', async (gatherView) => {
  const f = await fixture();
  let settled = false;
  const preparing = createIrradianceFieldViewKernels(f.device, f.module, 'live', {
    resolution: 'full',
    radiosity: false,
    gatherView,
  }).then((value) => {
    settled = true;
    return value;
  });
  try {
    expect(f.asyncCreate.mock.calls.some(([d]) => d.compute.entryPoint === 'lightCards')).toBe(
      true,
    );
    expect(f.asyncCreate.mock.calls.some(([d]) => d.compute.entryPoint === 'gatherField')).toBe(
      gatherView,
    );
    expect(settled).toBe(false);
  } finally {
    for (let i = 0; i < 30 && !settled; i++) {
      while (f.pending.length) f.finish();
      await Promise.resolve();
    }
    (await preparing).unwrap();
  }
});

it('awaits advertised native probe pipeline completion without synchronous creation', async () => {
  const f = await fixture();
  let published = false;
  const prepared = Promise.resolve(
    createIrradianceFieldKernel(f.device, 'traceProbes', f.module, 'global-sdf'),
  ).then((result) => {
    published = true;
    return result.unwrap();
  });
  expect(f.sync).not.toHaveBeenCalled();
  expect(f.asyncCreate).toHaveBeenCalledTimes(1);
  expect(published).toBe(false);
  f.finish();
  expect(await prepared).toHaveProperty('record');
});

it.each([
  'result',
  'reject',
])('drains initial gather after a Card preparation %s failure', async (failure) => {
  const f = await fixture();
  const cause = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'valid Card pipeline',
    hint: 'controlled failure',
  });
  const deferred = f.asyncCreate.getMockImplementation();
  if (deferred === undefined) throw new Error('missing deferred backend');
  f.asyncCreate.mockImplementation((descriptor) => {
    if (descriptor.compute.entryPoint === 'lightCards')
      return failure === 'reject' ? Promise.reject(cause) : Promise.resolve(err(cause));
    return deferred(descriptor);
  });
  let settled = false;
  const preparing = createIrradianceFieldViewKernels(f.device, f.module, 'live', {
    resolution: 'full',
    radiosity: false,
    gatherView: true,
  }).then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return err(error);
    },
  );
  expect(f.pending).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  f.finish();
  expect(await preparing).toMatchObject({ ok: false, error: cause });
  expect(f.pending).toHaveLength(0);
});

it('publishes Card kernels only after every requested pipeline completes', async () => {
  const f = await fixture();
  let published = false;
  const prepared = Promise.resolve(
    createIrradianceFieldViewKernels(f.device, f.module, 'live', {
      resolution: 'half',
      radiosity: false,
      gatherView: false,
    }),
  ).then((result) => {
    published = true;
    return result.unwrap();
  });
  expect(f.sync).not.toHaveBeenCalled();
  expect(published).toBe(false);
  f.finish();
  await vi.waitFor(() => expect(f.asyncCreate).toHaveBeenCalledTimes(2));
  expect(published).toBe(false);
  expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual([
    'lightCards',
    'copyDirectCards',
  ]);
  f.finish();
  const view = await prepared;
  expect(view.kernels.gatherField).toBeUndefined();
  expect(view.kernels.upsampleField).toBeUndefined();
});

it('single-flights gather demand and atomically publishes the full pair without resetting Card state', async () => {
  const f = await readyView();
  const cards = f.view.kernels.lightCards,
    layout = f.view.sampleLayout;
  await f.view.prepareGather(false);
  expect(f.asyncCreate).not.toHaveBeenCalled();
  const pending = f.view.prepareGather(true);
  expect(f.view.prepareGather(true)).toBe(pending);
  expect(f.view.kernels.gatherField).toBeUndefined();
  f.finish();
  await vi.waitFor(() => expect(f.asyncCreate).toHaveBeenCalledTimes(2));
  expect(f.view.kernels.gatherField).toBeUndefined();
  expect(f.view.kernels.upsampleField).toBeUndefined();
  f.finish();
  (await pending).unwrap();
  const gather = f.view.kernels.gatherField;
  expect(gather).toBeDefined();
  expect(f.view.kernels.upsampleField).toBeDefined();
  (await f.view.prepareGather(false)).unwrap();
  (await f.view.prepareGather(true)).unwrap();
  expect(f.view.kernels.gatherField).toBe(gather);
  expect(f.view.kernels.lightCards).toBe(cards);
  expect(f.view.sampleLayout).toBe(layout);
  expect(f.asyncCreate).toHaveBeenCalledTimes(2);
  expect(f.sync).not.toHaveBeenCalled();
});

it('retains a native validation failure without synchronous fallback or per-frame retry', async () => {
  const f = await readyView();
  const pending = f.view.prepareGather(true);
  f.finish();
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  const error = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'valid upsample',
    hint: 'native failure',
  });
  f.pending.shift()?.finish(err(error));
  expect((await pending).ok).toBe(false);
  expect(f.view.kernels.gatherField).toBeUndefined();
  expect(f.view.kernels.upsampleField).toBeUndefined();
  (await f.view.prepareGather(false)).unwrap();
  expect(f.view.prepareGather(true)).toBe(pending);
  expect(await f.view.prepareGather(true)).toMatchObject({ ok: false, error });
  expect(f.asyncCreate).toHaveBeenCalledTimes(2);
  expect(f.sync).not.toHaveBeenCalled();
});

it('does not publish a late gather pair after its owning generation is retired', async () => {
  let current = true;
  const f = await readyView(() => current);
  const pending = f.view.prepareGather(true);
  f.finish();
  await vi.waitFor(() => expect(f.pending).toHaveLength(1));
  current = false;
  f.finish();
  (await pending).unwrap();
  expect(f.view.kernels.gatherField).toBeUndefined();
  expect(f.view.kernels.upsampleField).toBeUndefined();
});

it('uses the existing synchronous RhiNull fallback when no async API is advertised', async () => {
  const f = await fixture();
  f.sync.mockRestore();
  Reflect.deleteProperty(f.device, 'createComputePipelineAsync');
  expect(f.device.createComputePipelineAsync).toBeUndefined();
  expect(
    (await createIrradianceFieldKernel(f.device, 'traceProbes', f.module, 'global-sdf')).ok,
  ).toBe(true);
  expect(f.asyncCreate).not.toHaveBeenCalled();
});
