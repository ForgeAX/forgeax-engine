import type { ShaderModule } from '@forgeax/engine-rhi';
import { type ManifestEntry, ShaderSource } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  ATMOSPHERE_SHADER_STAGES,
  DEPTH_PYRAMID_SHADER_STAGES,
  prewarmSsrWithDepthPyramid,
  prewarmUtilityShaders,
  SSR_SHADER_STAGES,
  VOLUMETRIC_FOG_SHADER_STAGES,
} from '../assembly/utility-shader-prewarm';

const ssrEntries = ['ssr_trace', 'ssr_temporal', 'vs_ssr_compose'].map(
  (entry) => ({ wgsl: `fn ${entry}() {}` }) as ManifestEntry,
);
const pyramidEntries = ['depth_pyramid_seed', 'depth_pyramid_reduce'].map(
  (entry) => ({ wgsl: `fn ${entry}() {}` }) as ManifestEntry,
);
const prewarmSsr = (
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string | ShaderSource) => Promise<ShaderModule>,
  seed: (label: string, module: ShaderModule) => void,
) => prewarmUtilityShaders('SSR', SSR_SHADER_STAGES, entries, compile, seed);

describe('utility shader bundle preparation', () => {
  it('selects reflected utility entries without reading unselected source bodies', async () => {
    const unread: ManifestEntry = {
      hash: 'unselected-utility-fixture',
      glsl: undefined,
      bindings: '[]',
      entryPoints: [{ name: 'unrelated', stage: 'compute', bindings: [] }],
      get wgsl(): string {
        throw new Error('Unselected source expanded');
      },
    };
    const selected = SSR_SHADER_STAGES.map(([, , name], index) => ({
      ...ssrEntries[index],
      entryPoints: [{ name, stage: 'compute' as const, bindings: [] }],
    })) as ManifestEntry[];
    const compile = vi.fn(async () => ({}) as ShaderModule);
    expect(await prewarmSsr([unread, ...selected], compile, vi.fn())).toBeDefined();
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it('does no compile or publication for an absent optional bundle', async () => {
    const compile = vi.fn(),
      seed = vi.fn();
    expect(await prewarmSsr([], compile, seed)).toBeUndefined();
    expect(await prewarmSsr(pyramidEntries, compile, seed)).toBeUndefined();
    expect(compile).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it('rejects an incomplete bundle before compilation', async () => {
    const compile = vi.fn(),
      seed = vi.fn();
    await expect(prewarmSsr(ssrEntries.slice(0, 2), compile, seed)).rejects.toMatchObject({
      code: 'shader-compile-failed',
    });
    expect(compile).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it('never seeds a partial generation when a later module fails', async () => {
    const seed = vi.fn();
    const compile = vi.fn(async (label: string) => {
      if (label === 'ssr_temporal') throw new Error('compile failed');
      return {} as ShaderModule;
    });
    await expect(prewarmSsr(ssrEntries, compile, seed)).rejects.toThrow('compile failed');
    expect(seed).not.toHaveBeenCalled();
  });

  it('returns and seeds every stage only after the final compile', async () => {
    const seed = vi.fn();
    const compile = vi.fn(async () => {
      expect(seed).not.toHaveBeenCalled();
      return {} as ShaderModule;
    });
    const prepared = await prewarmSsr([...pyramidEntries, ...ssrEntries], compile, seed);
    expect(Object.values(prepared ?? {}).every(ShaderSource.is)).toBe(true);
    expect(
      Object.fromEntries(
        Object.entries(prepared ?? {}).map(([key, source]) => [key, source.read()]),
      ),
    ).toEqual({
      trace: 'fn ssr_trace() {}',
      temporal: 'fn ssr_temporal() {}',
      compose: 'fn vs_ssr_compose() {}',
    });
    expect(seed).toHaveBeenCalledTimes(3);
  });

  it('seeds depth pyramid modules under their manifest stage labels', async () => {
    const seed = vi.fn();
    const sources = await prewarmUtilityShaders(
      'depth pyramid',
      DEPTH_PYRAMID_SHADER_STAGES,
      [...pyramidEntries, ...ssrEntries],
      async () => ({}) as ShaderModule,
      seed,
    );
    expect(
      Object.fromEntries(
        Object.entries(sources ?? {}).map(([key, source]) => [key, source.read()]),
      ),
    ).toEqual({
      seed: 'fn depth_pyramid_seed() {}',
      reduce: 'fn depth_pyramid_reduce() {}',
    });
    expect(seed.mock.calls.map(([label]) => label)).toEqual([
      'depth_pyramid_seed',
      'depth_pyramid_reduce',
    ]);
  });

  it('installs SSR only together with the depth pyramid it traces', async () => {
    const compile = async () => ({}) as ShaderModule;
    await expect(prewarmSsrWithDepthPyramid(ssrEntries, compile, vi.fn())).rejects.toMatchObject({
      code: 'shader-compile-failed',
    });
    expect(await prewarmSsrWithDepthPyramid(pyramidEntries, compile, vi.fn())).toBeUndefined();
    const both = await prewarmSsrWithDepthPyramid(
      [...pyramidEntries, ...ssrEntries],
      compile,
      vi.fn(),
    );
    expect((both?.pyramid.seed as ShaderSource).read()).toBe('fn depth_pyramid_seed() {}');
    expect((both?.ssr.trace as ShaderSource).read()).toBe('fn ssr_trace() {}');
  });
});

describe.each([
  ['atmosphere', ATMOSPHERE_SHADER_STAGES],
  ['volumetric fog', VOLUMETRIC_FOG_SHADER_STAGES],
] as const)('%s shader publication', (bundle, stages) => {
  const entries: ManifestEntry[] = stages.map(([, label, entry]) => ({
    hash: label,
    wgsl: `fn ${entry}() {}`,
    glsl: undefined,
    bindings: '[]',
  }));
  const prewarm = (
    inputs: readonly ManifestEntry[],
    compile: (label: string, source: string | ShaderSource) => Promise<ShaderModule>,
    seed: (label: string, module: ShaderModule) => void,
  ) => prewarmUtilityShaders<string>(bundle, stages, inputs, compile, seed);

  it('admits absence and rejects every partial bundle before compilation', async () => {
    const compile = vi.fn(),
      seed = vi.fn();
    expect(await prewarm([], compile, seed)).toBeUndefined();
    for (let missing = 0; missing < entries.length; missing++) {
      await expect(
        prewarm(
          entries.filter((_, i) => i !== missing),
          compile,
          seed,
        ),
      ).rejects.toMatchObject({ code: 'shader-compile-failed' });
    }
    expect(compile).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it('publishes only after all modules compile, and leaves failure unpublished', async () => {
    const seed = vi.fn();
    const finalLabel = stages.at(-1)?.[1];
    await expect(
      prewarm(
        entries,
        async (label) => {
          if (label === finalLabel) throw new Error('last compile failed');
          return {} as ShaderModule;
        },
        seed,
      ),
    ).rejects.toThrow('last compile failed');
    expect(seed).not.toHaveBeenCalled();
    const sources = await prewarm(
      entries,
      async () => {
        expect(seed).not.toHaveBeenCalled();
        return {} as ShaderModule;
      },
      seed,
    );
    expect(Object.keys(sources ?? {})).toEqual(stages.map(([key]) => key));
    expect(seed.mock.calls.map(([label]) => label)).toEqual(stages.map(([, label]) => label));
    expect(Object.values(sources ?? {}).map((source) => source.read())).toEqual(
      entries.map((entry) => entry.wgsl),
    );
  });
});
