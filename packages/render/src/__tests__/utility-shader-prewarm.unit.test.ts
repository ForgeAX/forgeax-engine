import type { ShaderModule } from '@forgeax/engine-rhi';
import type { ManifestEntry } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  DEPTH_PYRAMID_SHADER_STAGES,
  prewarmSsrWithDepthPyramid,
  prewarmUtilityShaders,
  SSR_SHADER_STAGES,
} from '../assembly/utility-shader-prewarm';

const ssrEntries = ['ssr_trace', 'ssr_temporal', 'vs_ssr_compose'].map(
  (entry) => ({ wgsl: `fn ${entry}() {}` }) as ManifestEntry,
);
const pyramidEntries = ['depth_pyramid_seed', 'depth_pyramid_reduce'].map(
  (entry) => ({ wgsl: `fn ${entry}() {}` }) as ManifestEntry,
);
const prewarmSsr = (
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string) => Promise<ShaderModule>,
  seed: (label: string, module: ShaderModule) => void,
) => prewarmUtilityShaders('SSR', SSR_SHADER_STAGES, entries, compile, seed);

describe('utility shader bundle preparation', () => {
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
    expect(await prewarmSsr([...pyramidEntries, ...ssrEntries], compile, seed)).toEqual({
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
    expect(sources).toEqual({
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
    expect(both?.pyramid.seed).toBe('fn depth_pyramid_seed() {}');
    expect(both?.ssr.trace).toBe('fn ssr_trace() {}');
  });
});
