import {
  err,
  ok,
  type PipelineLibrary,
  type PipelineLibraryInspection,
  type PipelineLibraryManifest,
  type RenderPipelineDescriptor,
  RhiError,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { wrap } from '../recorder';

it('preserves the optional pipeline library owner and its outcomes', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const manifest: PipelineLibraryManifest = {
    version: 1,
    backend: 'webgpu',
    shaders: [],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [],
  };
  const inspection: PipelineLibraryInspection = {
    state: 'active',
    shaders: 0,
    renderPipelines: 0,
    computePipelines: 0,
    shaderHits: 0,
    pipelineHits: 0,
    synchronousCreations: 0,
    asynchronousCreations: 0,
    compilationCompleted: 0,
    compilationPending: 0,
    failures: 0,
    unrecordable: 0,
    overflow: 0,
    sourceBytes: 0,
    warmup: { requested: 0, completed: 0, failed: 0, elapsedMs: 0 },
  };
  const prepared = ok(inspection);
  const preparationFailure = err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'pipeline library preparation to preserve its failure',
      hint: 'controlled failure',
    }),
  );
  let preparationCount = 0;
  const prepare = vi.fn(async function (this: PipelineLibrary, _manifest: PipelineLibraryManifest) {
    expect(this).toBe(pipelineLibrary);
    preparationCount += 1;
    return preparationCount === 1 ? prepared : preparationFailure;
  });
  const exported = ok(manifest);
  const pipelineLibrary: PipelineLibrary = {
    inspect: vi.fn(() => inspection),
    export: vi.fn(() => exported),
    prepare,
  };
  Object.assign(real, { pipelineLibrary });

  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap(
    { requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }) },
    createShaderModule,
  );
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();

  expect(device.pipelineLibrary).toBe(pipelineLibrary);
  expect(device.pipelineLibrary?.inspect()).toBe(inspection);
  expect(device.pipelineLibrary?.export()).toBe(exported);
  expect(await device.pipelineLibrary?.prepare(manifest)).toBe(prepared);
  expect(await device.pipelineLibrary?.prepare(manifest)).toBe(preparationFailure);
  expect(prepare).toHaveBeenNthCalledWith(1, manifest);
  expect(prepare).toHaveBeenNthCalledWith(2, manifest);
});

it('keeps an absent pipeline library absent through the recorder', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap(
    { requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }) },
    createShaderModule,
  );
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();

  expect(device.pipelineLibrary).toBeUndefined();
});

it('preserves native async completion and records the call-time descriptor once', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(real, {
      code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }',
    })
  ).unwrap();
  const desc: RenderPipelineDescriptor = {
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'v', buffers: [] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  };
  const pipeline = real.createRenderPipeline(desc).unwrap();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const createRenderPipelineAsync = vi.fn(async () => {
    await gate;
    return ok(pipeline);
  });
  Object.assign(real, { createRenderPipelineAsync });
  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap(
    {
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }),
    },
    createShaderModule,
  );
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = device.createRenderPipelineAsync;
  if (create === undefined) throw new Error('recorder dropped async capability');
  const promise = create(desc),
    completed = vi.fn();
  void Promise.resolve(promise).then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(debug.bootstrapEvents().filter((e) => e.kind === 'createRenderPipeline')).toHaveLength(0);
  if (desc.primitive !== undefined) desc.primitive.cullMode = 'front';
  if (finish === undefined) throw new Error('missing controlled completion');
  finish();
  expect((await promise).unwrap()).toBe(pipeline);
  const events = debug.bootstrapEvents().filter((e) => e.kind === 'createRenderPipeline');
  expect(events).toHaveLength(1);
  expect(events[0]?.desc.primitive?.cullMode).toBe('none');
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
  expect(debug.lookupPipeline(device, pipeline)).toBe(events[0]?.handleId);
});

it('preserves an immediate completed recipe instead of adding a recorder microtask', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(real, {
      code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }',
    })
  ).unwrap();
  const desc: RenderPipelineDescriptor = {
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'v', buffers: [] },
  };
  const pipeline = real.createRenderPipeline(desc).unwrap();
  Object.assign(real, { createRenderPipelineAsync: () => ok(pipeline) });
  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap(
    {
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }),
    },
    createShaderModule,
  );
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();
  const ready = device.createRenderPipelineAsync?.(desc);
  if (ready === undefined || !('ok' in ready)) throw Error('recorder delayed a completed recipe');
  expect(ready.unwrap()).toBe(pipeline);
  expect(debug.bootstrapEvents().filter((e) => e.kind === 'createRenderPipeline')).toHaveLength(1);
});

it('keeps a custom backend throw on the existing rejected-completion boundary', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const cause = Error('custom backend failed before returning completion');
  Object.assign(real, {
    createRenderPipelineAsync: () => {
      throw cause;
    },
  });
  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap(
    {
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }),
    },
    createShaderModule,
  );
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();
  const completion = device.createRenderPipelineAsync?.({
    layout: 'auto',
    vertex: { module: {} as never, buffers: [] },
  });
  expect(completion).toBeInstanceOf(Promise);
  await expect(completion).rejects.toBe(cause);
});
