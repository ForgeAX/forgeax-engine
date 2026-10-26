import { describe, expect, it, vi } from 'vitest';

const specialize = vi.hoisted(() => vi.fn());
vi.mock('@forgeax/engine-naga', () => ({ specializeComputeEntries: specialize }));

import { precomputePipelineLibraries, precomputePipelineLibrary } from '../pipeline-library.js';

type PipelineLibraryManifest = Parameters<typeof precomputePipelineLibrary>[0];

describe('build-time compute entry projection', () => {
  const manifest = (): PipelineLibraryManifest => ({
    version: 1,
    backend: 'webgpu',
    shaders: [{ code: 'effect A' }, { code: 'effect B' }],
    bindGroupLayouts: [],
    pipelineLayouts: [],
    renderPipelines: [],
    computePipelines: [0, 1].map((module) => ({
      layout: 'auto',
      compute: { module, entryPoint: 'scan', constants: { count: 4 } },
    })),
  });
  it('shares exact reachable source while retaining original recipes and specialization constants', async () => {
    specialize.mockImplementation(async (_source, names) => ({
      ok: true,
      value: names.map((entryPoint: string) => ({ entryPoint, source: 'shared scan' })),
    }));
    const original = manifest(),
      before = structuredClone(original);
    const result = await precomputePipelineLibrary(original);
    expect(result.shaders).toEqual([...original.shaders, { code: 'shared scan' }]);
    expect(result.computeEntryModules).toEqual([
      { module: 0, entryPoint: 'scan', specializedModule: 2 },
      { module: 1, entryPoint: 'scan', specializedModule: 2 },
    ]);
    expect(result.computePipelines).toEqual([original.computePipelines[0]]);
    expect(original).toEqual(before);
    expect(await precomputePipelineLibrary(result)).toBe(result);
  });
  it('preserves omitted-entry selection and propagates compiler failure', async () => {
    const original = manifest();
    const omitted = {
      ...original,
      computePipelines: [{ layout: 'auto' as const, compute: { module: 0 } }],
    };
    specialize.mockClear();
    expect(await precomputePipelineLibrary(omitted)).toBe(omitted);
    expect(specialize).not.toHaveBeenCalled();
    const error = new Error('missing compute entry');
    specialize.mockResolvedValue({ ok: false, error });
    await expect(precomputePipelineLibrary(original)).rejects.toBe(error);
  });
  it('does not ship extra modules for unique entry closures', async () => {
    specialize.mockImplementation(async (source, names) => ({
      ok: true,
      value: names.map((entryPoint: string) => ({ entryPoint, source: `unique ${source}` })),
    }));
    const original = manifest();
    const result = await precomputePipelineLibrary(original);
    expect(result.shaders).toEqual(original.shaders);
    expect(result).toBe(original);
  });
  it('omits exact startup overlap while preserving distinct background recipes', async () => {
    const original = { ...manifest(), computeEntryModules: [] };
    const variant = {
      layout: 'auto' as const,
      compute: { module: 0, entryPoint: 'scan', constants: { count: 8 } },
    };
    const result = await precomputePipelineLibraries({
      pipelineLibrary: original,
      backgroundPipelineLibrary: {
        ...original,
        computePipelines: [...original.computePipelines, variant],
      },
    });
    expect(result.pipelineLibrary?.computePipelines).toHaveLength(2);
    expect(result.backgroundPipelineLibrary?.computePipelines).toEqual([variant]);
    expect(result.backgroundPipelineLibrary?.shaders).toEqual([original.shaders[0]]);
  });
  it('normalizes duplicate recipes even when entry projections were already supplied', async () => {
    const original = manifest();
    const result = await precomputePipelineLibrary({
      ...original,
      shaders: [{ code: 'effect A' }, { code: 'effect A' }],
      computeEntryModules: [],
    });
    expect(result.shaders).toHaveLength(1);
    expect(result.computePipelines).toHaveLength(1);
  });
});
