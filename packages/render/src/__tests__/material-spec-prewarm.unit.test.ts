import { assert, describe, expect, it } from 'vitest';
import {
  createReadyPipelineDeviceProvider,
  prewarmMaterialSpecPipelines,
} from '../assembly/webgpu-ready-passes';
import {
  buildSpecConstTable,
  cacheKeyOf,
  type PipelineCache,
  PipelineSpecError,
} from '../pipeline-spec';

type BuildResult = { ok: true; value: unknown } | { ok: false; error: unknown };

function controlledProvider() {
  const pending: Array<(result: BuildResult) => void> = [];
  return {
    pending,
    provider: {
      createRenderPipeline(): BuildResult {
        throw new Error('Blocking compilation must not run on an async device');
      },
      createRenderPipelineAsync() {
        return new Promise<BuildResult>((resolve) => pending.push(resolve));
      },
    },
  };
}

const specs = buildSpecConstTable('rgba8unorm-srgb').filter(
  (spec) => spec.shader.id === 'forgeax::default-unlit',
);
const modules = new Map([['forgeax::default-unlit', { vertex: {}, fragment: {} }]]);

describe('material SPEC_CONST prewarm completion', () => {
  it('starts distinct variants together, deduplicates inputs, and publishes only completed handles', async () => {
    const { provider, pending } = controlledProvider();
    const cache: PipelineCache = new Map();
    let complete = false;
    const work = Promise.resolve(
      prewarmMaterialSpecPipelines([...specs, ...specs], modules, provider, cache),
    ).then(() => {
      complete = true;
    });
    expect(specs).toHaveLength(4);
    expect(pending).toHaveLength(4);
    expect(cache.size).toBe(0);
    pending[0]?.({ ok: true, value: 'first' });
    await Promise.resolve();
    await Promise.resolve();
    assert(specs[0]);
    expect(cache.get(cacheKeyOf(specs[0]))).toBe('first');
    expect(complete).toBe(false);
    for (let index = 1; index < pending.length; index++)
      pending[index]?.({ ok: true, value: `pipeline-${index}` });
    await work;
    expect(cache.size).toBe(4);
    expect([...cache.values()].some((value) => value instanceof Promise)).toBe(false);
    await prewarmMaterialSpecPipelines(specs, modules, provider, cache);
    expect(pending).toHaveLength(4);
  });

  it('waits for every started build before reporting a structured failure', async () => {
    const { provider, pending } = controlledProvider();
    const cache: PipelineCache = new Map();
    let settled = false;
    const work = Promise.resolve(prewarmMaterialSpecPipelines(specs, modules, provider, cache))
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .then((error) => {
        settled = true;
        return error;
      });
    expect(pending).toHaveLength(4);
    pending[0]?.({ ok: false, error: 'compile failed' });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    for (let index = 1; index < pending.length; index++)
      pending[index]?.({ ok: true, value: index });
    expect(await work).toBeInstanceOf(PipelineSpecError);
    assert(specs[0]);
    expect(cache.has(cacheKeyOf(specs[0]))).toBe(false);
    expect(cache.size).toBe(3);
  });

  it('supports synchronous devices and skips absent modules', async () => {
    let builds = 0;
    const provider = { createRenderPipeline: () => ({ ok: true as const, value: ++builds }) };
    const cache: PipelineCache = new Map();
    await prewarmMaterialSpecPipelines(
      buildSpecConstTable('rgba8unorm-srgb'),
      modules,
      provider,
      cache,
    );
    expect(builds).toBe(4);
    expect(cache.size).toBe(4);
  });

  it('normalizes async and synchronous descriptors identically without mutating the caller', async () => {
    const seen: unknown[] = [];
    const device = {
      createRenderPipeline(descriptor: unknown) {
        seen.push(descriptor);
        return { ok: true as const, value: descriptor };
      },
      createRenderPipelineAsync(descriptor: unknown) {
        expect(this).toBe(device);
        seen.push(descriptor);
        return Promise.resolve({ ok: true as const, value: descriptor });
      },
    };
    type ProviderInputs = Parameters<typeof createReadyPipelineDeviceProvider>;
    const unlit = {},
      sprite = {},
      spriteLit = {},
      pbr = {};
    const modules = { unlit, sprite, spriteLit, pbr } as ProviderInputs[1];
    const provider = createReadyPipelineDeviceProvider(
      device as unknown as ProviderInputs[0],
      modules,
      'unlit-layout' as unknown as ProviderInputs[2],
      'pbr-layout' as unknown as ProviderInputs[3],
    );
    assert(provider.createRenderPipelineAsync);
    for (const module of [unlit, sprite, spriteLit, pbr]) {
      for (const format of ['rgba8unorm', 'rgba16float']) {
        const descriptor = { fragment: { module, entryPoint: 'fs_main', targets: [{ format }] } };
        const before = structuredClone(descriptor);
        seen.length = 0;
        provider.createRenderPipeline(descriptor);
        await provider.createRenderPipelineAsync(descriptor);
        expect(seen[0]).toEqual(seen[1]);
        expect(descriptor).toEqual(before);
        const normalized = seen[0] as { layout: unknown; fragment: { entryPoint: string } };
        expect(normalized.layout).toBe(module === unlit ? 'unlit-layout' : 'pbr-layout');
        expect(normalized.fragment.entryPoint).toBe(
          format === 'rgba16float' && (module === sprite || module === spriteLit)
            ? 'fs_main_hdr'
            : 'fs_main',
        );
      }
    }
  });

  it('settles all work on a thrown async failure and preserves completed cache entries', async () => {
    const { provider, pending } = controlledProvider();
    const cache: PipelineCache = new Map();
    assert(specs[0]);
    cache.set(cacheKeyOf(specs[0]), 'already-ready');
    let calls = 0;
    const failing = {
      ...provider,
      createRenderPipelineAsync() {
        if (++calls === 1) throw new Error('foreign native exception');
        return provider.createRenderPipelineAsync();
      },
    };
    let settled = false;
    const work = prewarmMaterialSpecPipelines(specs, modules, failing, cache).catch((error) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pending).toHaveLength(2);
    for (const complete of pending) complete({ ok: true, value: 'new-ready' });
    expect(await work).toBeInstanceOf(PipelineSpecError);
    expect(cache.get(cacheKeyOf(specs[0]))).toBe('already-ready');
    expect(cache.size).toBe(3);
  });
});
