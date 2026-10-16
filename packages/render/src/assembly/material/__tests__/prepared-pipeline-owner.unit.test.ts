import {
  err,
  ok,
  type RenderPipeline,
  type RenderPipelineDescriptor,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
} from '../../../pipeline-builder';
import { PreparedRenderPipelineOwner } from '../prepared-pipeline-owner';

const descriptor = (): RenderPipelineDescriptor => ({
  layout: 'auto',
  vertex: { module: {} as never, entryPoint: 'vertex', buffers: [] },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

it('stays pending until actual backend completion and reuses exactly its handle', async () => {
  const ready = deferred<ReturnType<RhiDevice['createRenderPipeline']>>();
  const createRenderPipeline = vi.fn();
  const createRenderPipelineAsync = vi.fn(() => ready.promise);
  const owner = new PreparedRenderPipelineOwner(
    { createRenderPipeline, createRenderPipelineAsync } as unknown as RhiDevice,
    () => true,
  );
  const desc = descriptor(),
    pipeline = {} as RenderPipeline;
  expect(owner.request('actual-full-spec', 'actual-wgsl', desc).ok).toBe(false);
  expect(owner.request('actual-full-spec', 'actual-wgsl', desc).ok).toBe(false);
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
  expect(createRenderPipeline).not.toHaveBeenCalled();
  ready.resolve(ok(pipeline));
  await ready.promise;
  expect(owner.request('actual-full-spec', 'actual-wgsl', desc).unwrap()).toBe(pipeline);
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
});

it('shares validated/immediate module instances only under the same actual source and layout', async () => {
  const pipeline = {} as RenderPipeline;
  const createRenderPipelineAsync = vi.fn(async () => ok(pipeline));
  const owner = new PreparedRenderPipelineOwner(
    { createRenderPipelineAsync } as unknown as RhiDevice,
    () => true,
  );
  const desc = descriptor();
  owner.request('full-spec', 'same-code', desc);
  await Promise.resolve();
  expect(
    owner
      .request('full-spec', 'same-code', {
        ...desc,
        vertex: { ...desc.vertex, module: {} as never },
      })
      .unwrap(),
  ).toBe(pipeline);
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
});

it.each([
  'source',
  'layout',
] as const)('does not publish a replaced %s completion', async (changed) => {
  const first = deferred<ReturnType<RhiDevice['createRenderPipeline']>>();
  const second = deferred<ReturnType<RhiDevice['createRenderPipeline']>>();
  const flights = [first, second];
  let count = 0;
  const createRenderPipelineAsync = vi.fn(() => {
    const flight = flights[count++];
    if (flight === undefined) throw new Error('unexpected duplicate pipeline');
    return flight.promise;
  });
  const owner = new PreparedRenderPipelineOwner(
    { createRenderPipelineAsync } as unknown as RhiDevice,
    () => true,
  );
  const desc = descriptor(),
    old = {} as RenderPipeline,
    next = {} as RenderPipeline;
  const nextDesc = changed === 'source' ? desc : { ...desc, layout: {} as never };
  const nextSource = changed === 'source' ? 'new-source' : 'old-source';
  owner.request('full-spec', 'old-source', desc);
  owner.request('full-spec', nextSource, nextDesc);
  first.resolve(ok(old));
  await first.promise;
  expect(owner.request('full-spec', nextSource, nextDesc).ok).toBe(false);
  second.resolve(ok(next));
  await second.promise;
  expect(owner.request('full-spec', nextSource, nextDesc).unwrap()).toBe(next);
});

it('never returns ready after retirement, including a late successful completion', async () => {
  let alive = true;
  const ready = deferred<ReturnType<RhiDevice['createRenderPipeline']>>();
  const createRenderPipelineAsync = vi.fn(() => ready.promise);
  const owner = new PreparedRenderPipelineOwner(
    { createRenderPipelineAsync } as unknown as RhiDevice,
    () => alive,
  );
  const desc = descriptor();
  owner.request('full-spec', 'wgsl', desc);
  alive = false;
  ready.resolve(ok({} as RenderPipeline));
  await ready.promise;
  expect(owner.request('full-spec', 'wgsl', desc).ok).toBe(false);
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
});

it('keeps failure explicit and does not retry or substitute a synchronous handle', async () => {
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'valid pipeline',
    hint: 'fix the invalid actual descriptor',
  });
  const createRenderPipeline = vi.fn();
  const createRenderPipelineAsync = vi.fn(async () => err(failure));
  const owner = new PreparedRenderPipelineOwner(
    { createRenderPipeline, createRenderPipelineAsync } as unknown as RhiDevice,
    () => true,
  );
  const desc = descriptor();
  owner.request('full-spec', 'wgsl', desc);
  await Promise.resolve();
  const result = owner.request('full-spec', 'wgsl', desc);
  if (result.ok) throw new Error('failed pipeline became ready');
  expect(result.error).toBe(failure);
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
  expect(createRenderPipeline).not.toHaveBeenCalled();
});

it('preserves the synchronous boundary for a backend without async completion', () => {
  const pipeline = {} as RenderPipeline;
  const createRenderPipeline = vi.fn(() => ok(pipeline));
  const owner = new PreparedRenderPipelineOwner(
    { createRenderPipeline } as unknown as RhiDevice,
    () => true,
  );
  expect(owner.request('full-spec', 'wgsl', descriptor()).unwrap()).toBe(pipeline);
  expect(createRenderPipeline).toHaveBeenCalledTimes(1);
});

it.each([
  'forward',
  'shadow-caster',
] as const)('preserves %s pending instead of misclassifying an async PSO as shader failure', (passKind) => {
  const pending = new RhiError({
    code: 'rhi-not-available',
    expected: 'PSO completion',
    hint: 'retry after backend resolves',
  });
  const source =
    '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); } @fragment fn f() -> @location(0) vec4f { return vec4f(1); }';
  const result = buildPipelineForMaterialShader(
    'test-pending',
    { source, paramSchema: [] },
    {
      device: {},
      createRenderPipeline: () => err(pending),
      shaderModuleFactory: { createShaderModule: () => ok({}) },
      pipelineLayout: {},
      vertexBuffers: [],
      colorFormat: 'rgba8unorm',
      colorFormats: passKind === 'forward' ? ['rgba8unorm'] : [],
      depthFormat: 'depth32float',
    } as unknown as PipelineBuilderContext,
    undefined,
    undefined,
    'v',
    'f',
    undefined,
    passKind,
  );
  if (result.ok) throw new Error('pending PSO became ready');
  expect(result.error).toBe(pending);
});
