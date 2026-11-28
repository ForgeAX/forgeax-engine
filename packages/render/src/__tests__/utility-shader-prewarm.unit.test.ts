import type { ShaderModule } from '@forgeax/engine-rhi';
import {
  publishShaderProgramTemplates,
  type ShaderCatalog,
  type ShaderProgramCompiler,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { type ManifestEntry, ok, ShaderSource } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  ATMOSPHERE_SHADER_STAGES,
  DEPTH_PYRAMID_SHADER_STAGES,
  prepareSsrWithDepthPyramid,
  prepareUtilityShaders,
  SSR_SHADER_STAGES,
  VOLUMETRIC_FOG_SHADER_STAGES,
} from '../assembly/utility-shader-prewarm';

import { prepareStandardSceneSources } from '../assembly/webgpu-ready-shaders';

const ssrEntries = ['ssr_trace', 'vs_ssr_compose'].map(
  (entry) => ({ wgsl: `fn ${entry}() {}` }) as ManifestEntry,
);
it('leaves all Deferred source variants cold at boot and prepares only the selected variant', async () => {
  const identifier = 'forgeax::engine-standard-deferred-lighting';
  const compilerProfile = {
    id: 'test',
    language: 'wgsl',
    profileVersion: '1',
    adapterVersion: '1',
    compilerVersion: '1',
    nagaVersion: '1',
  } as const;
  const selection = { CLUSTER_FORWARD_AVAILABLE: true, DIRECT_DFG_LUT_AVAILABLE: false };
  const library = publishShaderProgramTemplates(
    new Map([
      [
        identifier,
        {
          schemaVersion: 'shader-program-template/1' as const,
          compilerProfile,
          source: '// Deferred source',
          imports: {},
          axes: Object.keys(selection),
        },
      ],
    ]),
  ).unwrap();
  const compile = vi.fn<ShaderProgramCompiler['compile']>();
  const compileAsync = vi.fn<NonNullable<ShaderProgramCompiler['compileAsync']>>(
    async (_, defines) =>
      ok({
        manifestEntry: {
          hash: 'compiled',
          wgsl: `// LUT: ${defines.DIRECT_DFG_LUT_AVAILABLE}`,
          bindings: '[]',
          glsl: '',
        },
        uvSetCount: 0,
      }),
  );
  const declaration = { identifier, program: identifier, selection };
  const registry = new ShaderRegistry({
    manifestUrl: 'memory:deferred',
    programCompiler: { profile: compilerProfile, compile, compileAsync },
    readText: async () =>
      JSON.stringify({
        schemaVersion: '7.0.0',
        library,
        entries: [
          {
            ...declaration,
            hash: 'deferred',
            programContract: {
              schemaVersion: 'shader-program-contract/1',
              gbuffer: 'standard-gbuffer/2',
            },
          },
        ],
        materialShaders: [{ ...declaration, sourcePath: identifier, paramSchema: '[]' }],
      }),
  });
  (await registry.loadManifest()).unwrap();
  const prepareModule = vi.fn();
  const sources = await prepareStandardSceneSources(registry, prepareModule, vi.fn(), {
    storageBuffer: true,
    webgl2Downlevel: false,
    extendedLighting: false,
    atmosphere: false,
    directionalPcss: false,
    projector: false,
  });
  expect(compileAsync).not.toHaveBeenCalled();
  expect(compile).not.toHaveBeenCalled();
  expect(sources?.prepareDeferredLighting?.(true, true)).toBe(false);
  (await registry.pendingTemplatePreparations())?.unwrap();
  expect(sources?.prepareDeferredLighting?.(true, true)).toBe(true);
  expect((sources?.deferred?.clusteredLut as ShaderSource).read()).toBe('// LUT: true');
  expect(compileAsync).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    ...selection,
    DIRECT_DFG_LUT_AVAILABLE: true,
  });
  expect(compile).not.toHaveBeenCalled();
  expect(prepareModule).not.toHaveBeenCalled();
});

const pyramidEntries = ['depth_pyramid_seed', 'depth_pyramid_reduce'].map(
  (entry) => ({ wgsl: `fn ${entry}() {}` }) as ManifestEntry,
);

it('keeps optional Standard companion sources out of native device preparation', async () => {
  const id = 'forgeax::engine-decal-project';
  const source = 'fn vs_main() {}';
  const readSource = vi.fn(() => source);
  const catalog = {
    entries: () => [],
    materialShaderManifestEntries: () => [
      {
        identifier: id,
        hash: 'decal',
        get composedWgsl() {
          return readSource();
        },
        paramSchema: '[]',
        variants: [],
      },
    ],
  } as unknown as ShaderCatalog;
  const compile = vi.fn(async () => ({}) as ShaderModule);
  const seed = vi.fn();
  const caps = {
    storageBuffer: true,
    webgl2Downlevel: false,
    extendedLighting: false,
    atmosphere: false,
    directionalPcss: false,
    projector: false,
  };
  const native = await prepareStandardSceneSources(catalog, undefined, seed, caps);
  expect(native).toBeDefined();
  expect(native !== undefined && 'decalProject' in native).toBe(true);
  expect(readSource).not.toHaveBeenCalled();
  const selected = native?.decalProject;
  expect(ShaderSource.is(selected) && selected.read()).toBe(source);
  expect(native?.decalProject).toBe(selected);
  expect(readSource).toHaveBeenCalledOnce();
  expect(compile).not.toHaveBeenCalled();
  expect(seed).not.toHaveBeenCalled();
  const fallback = await prepareStandardSceneSources(catalog, compile, seed, caps);
  expect(readSource).toHaveBeenCalledTimes(2);
  expect(ShaderSource.is(fallback?.decalProject) && fallback.decalProject.read()).toBe(source);
  expect(compile).toHaveBeenCalledExactlyOnceWith(id, expect.any(ShaderSource), 'Decal');
  expect(seed).toHaveBeenCalledOnce();
});
const prewarmSsr = (
  entries: readonly ManifestEntry[],
  compile: (label: string, source: string | ShaderSource) => Promise<ShaderModule>,
  seed: (label: string, module: ShaderModule) => void,
) => prepareUtilityShaders('SSR', SSR_SHADER_STAGES, entries, compile, seed);

describe('utility shader bundle preparation', () => {
  it('admits SSR metadata without opening its native or depth program sources', async () => {
    const readTrace = vi.fn(() => 'fn ssr_trace() {}');
    const readCompose = vi.fn(() => 'fn vs_ssr_compose() {}');
    const sourceRows = SSR_SHADER_STAGES.map(([, label, name], index) => ({
      hash: label,
      get wgsl() {
        return (index === 0 ? readTrace : readCompose)();
      },
      glsl: undefined,
      bindings: '',
      entryPoints: [{ name, stage: 'compute' as const, bindings: [] }],
      programContract: {
        schemaVersion: 'shader-program-contract/1' as const,
        gbuffer: 'standard-gbuffer/2' as const,
        compactGbuffer: 'standard-gbuffer/4' as const,
      },
    }));
    const readSeed = vi.fn(() => 'fn depth_pyramid_seed() {}');
    const readReduce = vi.fn(() => 'fn depth_pyramid_reduce() {}');
    const depthRows = DEPTH_PYRAMID_SHADER_STAGES.map(([, label, name], index) => ({
      hash: label,
      get wgsl() {
        return (index === 0 ? readSeed : readReduce)();
      },
      glsl: undefined,
      bindings: '',
      entryPoints: [{ name, stage: 'compute' as const, bindings: [] }],
    }));
    const seed = vi.fn();
    const admitted = await prepareSsrWithDepthPyramid(
      [...depthRows, ...sourceRows],
      undefined,
      seed,
    );
    expect(admitted?.ssr?.compactGbuffer).toBe('standard-gbuffer/4');
    expect(seed).not.toHaveBeenCalled();
    expect(readTrace).not.toHaveBeenCalled();
    expect(readCompose).not.toHaveBeenCalled();
    expect(readSeed).not.toHaveBeenCalled();
    expect(readReduce).not.toHaveBeenCalled();
    expect(admitted?.pyramid !== undefined && 'seed' in admitted.pyramid).toBe(true);
    const seedSource = admitted?.pyramid.seed;
    expect(ShaderSource.is(seedSource) && seedSource.read()).toBe('fn depth_pyramid_seed() {}');
    expect(admitted?.pyramid.seed).toBe(seedSource);
    expect(readSeed).toHaveBeenCalledOnce();
    expect(readReduce).not.toHaveBeenCalled();
    const trace = admitted?.ssr?.trace;
    expect(ShaderSource.is(trace) && trace.read()).toBe('fn ssr_trace() {}');
    expect(admitted?.ssr?.trace).toBe(trace);
    expect(readTrace).toHaveBeenCalledOnce();
    expect(readCompose).not.toHaveBeenCalled();
  });

  it('admits G-buffer metadata from the selected compiled SSR entries without identifiers', async () => {
    const entries = ssrEntries.map((entry) => ({
      ...entry,
      programContract: {
        schemaVersion: 'shader-program-contract/1' as const,
        gbuffer: 'standard-gbuffer/2' as const,
        compactGbuffer: 'standard-gbuffer/4' as const,
      },
    }));
    const prepare = (rows: readonly ManifestEntry[]) =>
      prepareSsrWithDepthPyramid(
        [...pyramidEntries, ...rows],
        async () => ({}) as ShaderModule,
        vi.fn(),
      );
    expect((await prepare(entries))?.ssr.gbuffer).toBe('standard-gbuffer/2');
    expect((await prepare(entries))?.ssr.compactGbuffer).toBe('standard-gbuffer/4');
    const older = {
      ...entries[0],
      programContract: {
        schemaVersion: 'shader-program-contract/1',
        gbuffer: 'standard-gbuffer/2',
      },
    } as ManifestEntry;
    const mixed = (await prepare([older, ...entries.slice(1)]))?.ssr;
    expect(mixed?.gbuffer).toBe('standard-gbuffer/2');
    expect(mixed?.compactGbuffer).toBeUndefined();
    const unversioned = ssrEntries[0];
    if (unversioned === undefined) throw new Error('Missing unversioned SSR fixture');
    expect((await prepare([unversioned, ...entries.slice(1)]))?.ssr.gbuffer).toBeUndefined();
  });
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
    expect(compile).toHaveBeenCalledTimes(2);
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
    await expect(prewarmSsr(ssrEntries.slice(0, 1), compile, seed)).rejects.toMatchObject({
      code: 'shader-compile-failed',
    });
    expect(compile).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
  });

  it('never seeds a partial generation when a later module fails', async () => {
    const seed = vi.fn();
    const compile = vi.fn(async (label: string) => {
      if (label === 'ssr_compose') throw new Error('compile failed');
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
      compose: 'fn vs_ssr_compose() {}',
    });
    expect(seed).toHaveBeenCalledTimes(2);
  });

  it('seeds depth pyramid modules under their manifest stage labels', async () => {
    const seed = vi.fn();
    const sources = await prepareUtilityShaders(
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

  it('keeps native fragment aliases lazy and shares exact source identity', async () => {
    const readSeed = vi.fn(() => 'fn depth_pyramid_seed_fragment() {}');
    const entry = (name: string, read: () => string): ManifestEntry => ({
      hash: name,
      get wgsl() {
        return read();
      },
      glsl: undefined,
      bindings: '',
      entryPoints: [{ name, stage: 'fragment', bindings: [] }],
    });
    const rows = [
      entry('depth_pyramid_seed_fragment', readSeed),
      entry('depth_pyramid_reduce_fragment', () => 'fn depth_pyramid_reduce_fragment() {}'),
      entry('ssr_trace_fragment', () => 'fn ssr_trace_fragment() {}'),
      entry('vs_ssr_compose_fragment', () => 'fn vs_ssr_compose_fragment() {}'),
    ];
    const seed = vi.fn();
    const prepared = await prepareSsrWithDepthPyramid(rows, undefined, seed, 'fragment');
    expect(readSeed).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    const source = prepared?.pyramid.seedFragment;
    expect(ShaderSource.is(source) && source.read()).toBe('fn depth_pyramid_seed_fragment() {}');
    expect(source).toBe(prepared?.pyramid.seed);
    expect(prepared?.ssr?.traceFragment).toBe(prepared?.ssr?.trace);
    expect(readSeed).toHaveBeenCalledOnce();
    await expect(
      prepareSsrWithDepthPyramid(rows.slice(0, -1), undefined, seed, 'fragment'),
    ).rejects.toMatchObject({ code: 'shader-compile-failed' });
  });

  it('installs SSR only together with the depth pyramid it traces', async () => {
    const compile = async () => ({}) as ShaderModule;
    await expect(prepareSsrWithDepthPyramid(ssrEntries, compile, vi.fn())).rejects.toMatchObject({
      code: 'shader-compile-failed',
    });
    expect(await prepareSsrWithDepthPyramid(pyramidEntries, compile, vi.fn())).toEqual({
      pyramid: { seed: expect.any(Object), reduce: expect.any(Object) },
    });
    const both = await prepareSsrWithDepthPyramid(
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
  it('publishes the whole source bundle without device work when native creation is deferred', async () => {
    const seed = vi.fn();
    const resolved = await prepareUtilityShaders<string>(bundle, stages, entries, undefined, seed);
    expect(Object.keys(resolved ?? {})).toEqual(stages.map(([stage]) => stage));
    for (const [stage, , entry] of stages)
      expect(resolved?.[stage]?.read()).toBe(`fn ${entry}() {}`);
    expect(seed).not.toHaveBeenCalled();
    await expect(
      prepareUtilityShaders<string>(bundle, stages, entries.slice(1), undefined, seed),
    ).rejects.toMatchObject({ code: 'shader-compile-failed' });
  });
  const prewarm = (
    inputs: readonly ManifestEntry[],
    compile: (label: string, source: string | ShaderSource) => Promise<ShaderModule>,
    seed: (label: string, module: ShaderModule) => void,
  ) => prepareUtilityShaders<string>(bundle, stages, inputs, compile, seed);

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

it('publishes Deferred lighting and diffusion sources without creating native modules', async () => {
  const identifier = 'forgeax::engine-standard-deferred-lighting';
  const diffusion = 'forgeax::engine-subsurface-diffusion';
  const variants = [false, true].flatMap((clustered) =>
    [false, true].map((directDfgLut) => ({
      composedWgsl: `// Deferred: ${clustered} ${directDfgLut}`,
      defines: {
        CLUSTER_FORWARD_AVAILABLE: clustered,
        DIRECT_DFG_LUT_AVAILABLE: directDfgLut,
        EXTENDED_LIGHTING_AVAILABLE: true,
        PROJECTOR_AVAILABLE: true,
      },
    })),
  );
  const registry = {
    entries: () =>
      [identifier, diffusion].map((identifier) => ({
        identifier,
        programContract: { gbuffer: 'standard-gbuffer/2' },
      })),
    materialShaderManifestEntries: () => [
      { identifier, variants },
      { identifier: diffusion, variants: [], composedWgsl: '// Subsurface diffusion' },
    ],
  } as unknown as ShaderCatalog;
  const compile = vi.fn(async () => ({}) as ShaderModule),
    seed = vi.fn();
  const sources = await prepareStandardSceneSources(registry, compile, seed, {
    storageBuffer: true,
    webgl2Downlevel: false,
    extendedLighting: true,
    atmosphere: false,
    directionalPcss: false,
    projector: true,
  });
  expect(sources?.gbuffer).toBe('standard-gbuffer/2');
  expect((sources?.subsurface as ShaderSource).read()).toBe('// Subsurface diffusion');
  const published = Object.values(sources?.deferred ?? {});
  Object.values(sources?.deferred ?? {}).forEach((source, index) => {
    expect(source).toBe(published[index]);
  });
  expect(published.map((source) => (source as ShaderSource).read())).toEqual([
    '// Deferred: true false',
    '// Deferred: false false',
    '// Deferred: true true',
    '// Deferred: false true',
  ]);
  expect(compile).not.toHaveBeenCalled();
  expect(seed).not.toHaveBeenCalled();
});
