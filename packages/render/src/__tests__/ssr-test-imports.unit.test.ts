import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createTraceProbeCode,
  depthPyramidProbeImports,
  readShader,
} from './depth-pyramid-odd.fixture';

const ownerFiles = [
  'reverse-z-reconstruction.dawn.test.ts',
  'ssr-cube-silhouette.dawn.test.ts',
  'ssr-reflection-mip-reducer.dawn.test.ts',
  'ssr-history-filter.dawn.test.ts',
  'portable-kernel-expansion.dawn.test.ts',
  'ssr-stable-lattice.dawn.test.ts',
  'ssr-full-resolution.dawn.test.ts',
] as const;

function dawnOwnerImports(file: (typeof ownerFiles)[number]): Record<string, string> {
  const owner = readFileSync(new URL(file, import.meta.url), 'utf8');
  const imports: Record<string, string> = {};
  for (const match of owner.matchAll(
    /(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*(?:(?:shader|source|read|readShader)\('([^']+)'\)|(gbufferSource)|readFileSync\(\s*resolve\('packages\/shader\/src\/([^']+)\.wgsl'\),\s*'utf8'\s*,?\s*\))/g,
  )) {
    const module = match[1] ?? match[2];
    const source =
      match[3] ?? (match[4] === 'gbufferSource' ? 'standard-gbuffer' : undefined) ?? match[5];
    if (module === undefined || source === undefined) throw new Error('Missing shader import');
    imports[module] = readFileSync(
      new URL(`../../../shader/src/${source}.wgsl`, import.meta.url),
      'utf8',
    );
  }
  if (file === 'ssr-full-resolution.dawn.test.ts') {
    const catalog = /\[('common'[\s\S]*?)\]\.map\(\s*\(name\) =>/.exec(owner)?.[1];
    if (catalog === undefined) throw new Error('Missing original SSR import catalog');
    for (const match of catalog.matchAll(/'([^']+)'/g)) {
      const source = readFileSync(
        new URL(`../../../shader/src/${match[1]}.wgsl`, import.meta.url),
        'utf8',
      );
      const module = /#define_import_path (\S+)/.exec(source)?.[1];
      if (module === undefined) throw new Error('Missing declared SSR module identity');
      imports[module] = source;
    }
  }
  return imports;
}

describe('SSR numerical test shader import closure', () => {
  it.each(
    ownerFiles,
  )('%s composes its current production shader with its declared imports', async (file) => {
    const imports = dawnOwnerImports(file);
    const { compileShader } = await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    );
    const temporal =
      file === 'ssr-reflection-mip-reducer.dawn.test.ts' ||
      file === 'ssr-history-filter.dawn.test.ts' ||
      file === 'ssr-stable-lattice.dawn.test.ts';
    const source = readShader(temporal ? 'ssr-temporal' : 'ssr-trace');
    const probe = temporal
      ? source
      : `${source}
@group(1) @binding(0) var<storage, read_write> result: array<vec4<f32>>;
@compute @workgroup_size(1) fn probe_imports() {
  result[0] = vec4<f32>(reconstructWorldPosition(vec2<f32>(0.5), 0.5), 1.0);
}`;
    const { forgeax_scene_temporal: requiredSource, ...remainingImports } = imports;
    const rejected = await compileShader(probe, {
      id: `forgeax_ssr::${file}`,
      imports: remainingImports,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('SSR shader composed without its temporal source');
    expect(rejected.error).toMatchObject({
      code: 'shader-import-not-found',
      detail: { importPath: 'forgeax_scene_temporal' },
    });
    const result = await compileShader(probe, { id: `forgeax_ssr::${file}`, imports });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.wgsl).toContain(temporal ? 'fn ssr_reflection_mip(' : 'probe_imports');
    expect(requiredSource).toContain('#define_import_path forgeax_scene_temporal');
  });
});

describe('odd depth pyramid test shader import closure', () => {
  it.each([
    ['depth_pyramid_seed', () => readShader('depth-pyramid-seed')],
    ['depth_pyramid_reduce', () => readShader('depth-pyramid-reduce')],
    ['probe_levels', () => createTraceProbeCode([{ uv: [0.5, 0.5], coarseLevel: 1 }])],
  ] as const)('composes %s using the imports of the GPU test', async (entry, source) => {
    const { compileShader } = await import(
      /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
    );
    const imports = depthPyramidProbeImports();
    const omitted = 'forgeax_depth_pyramid::sample';
    const { [omitted]: _sample, ...incomplete } = imports;
    const id = `forgeax_depth_pyramid::${entry}`;
    const code = source();
    const rejected = await compileShader(code, { id, imports: incomplete });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error(`${entry} composed without the depth pyramid module`);
    expect(rejected.error).toMatchObject({
      code: 'shader-import-not-found',
      detail: { importPath: omitted },
    });
    const result = await compileShader(code, { id, imports });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.wgsl).toContain(`fn ${entry}(`);
  });
});
