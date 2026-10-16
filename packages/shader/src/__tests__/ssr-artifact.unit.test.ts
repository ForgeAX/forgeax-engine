import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

interface ShaderBinding {
  readonly binding: number;
  readonly visibility: number;
  readonly texture?: Readonly<Record<string, unknown>>;
  readonly storageTexture?: Readonly<Record<string, unknown>>;
}

interface CompileValue {
  readonly wgsl: string;
  readonly glsl: string;
  readonly bindings: readonly Readonly<Record<string, unknown>>[];
  readonly manifestEntry: {
    readonly hash: string;
    readonly wgsl: string;
    readonly glsl: string;
    readonly bindings: string;
  };
  readonly deps: readonly string[];
}

interface CompileResult {
  readonly ok: boolean;
  readonly value?: CompileValue;
  readonly error?: { readonly code: string; readonly message: string };
}

interface CompilerModule {
  compileShader(
    source: string,
    options: { readonly id: string; readonly imports?: Readonly<Record<string, string>> },
  ): Promise<CompileResult>;
}

const SHADER_PATHS = {
  pyramidSeed: resolve(import.meta.dirname, '../depth-pyramid-seed.wgsl'),
  pyramidReduce: resolve(import.meta.dirname, '../depth-pyramid-reduce.wgsl'),
  trace: resolve(import.meta.dirname, '../ssr-trace.wgsl'),
  temporal: resolve(import.meta.dirname, '../ssr-temporal.wgsl'),
  compose: resolve(import.meta.dirname, '../ssr-compose.wgsl'),
} as const;

const SOURCES = {
  pyramidSeed: readFileSync(SHADER_PATHS.pyramidSeed, 'utf8'),
  pyramidReduce: readFileSync(SHADER_PATHS.pyramidReduce, 'utf8'),
  trace: readFileSync(SHADER_PATHS.trace, 'utf8'),
  temporal: readFileSync(SHADER_PATHS.temporal, 'utf8'),
  compose: readFileSync(SHADER_PATHS.compose, 'utf8'),
} as const;
const GBUFFER = readFileSync(resolve(import.meta.dirname, '../standard-gbuffer.wgsl'), 'utf8');
const PYRAMID_SAMPLE = readFileSync(
  resolve(import.meta.dirname, '../depth-pyramid-sample.wgsl'),
  'utf8',
);
const COMMON = readFileSync(resolve(import.meta.dirname, '../common.wgsl'), 'utf8');

const IMPORT_SOURCES = {
  'forgeax_view::common': COMMON,
  'forgeax_pbr::gbuffer': GBUFFER,
  'forgeax_depth_pyramid::sample': PYRAMID_SAMPLE,
} as const;

const STAGE_IMPORTS: Record<keyof typeof SOURCES, readonly (keyof typeof IMPORT_SOURCES)[]> = {
  pyramidSeed: ['forgeax_depth_pyramid::sample', 'forgeax_view::common'],
  pyramidReduce: ['forgeax_depth_pyramid::sample'],
  trace: ['forgeax_depth_pyramid::sample', 'forgeax_pbr::gbuffer', 'forgeax_view::common'],
  temporal: ['forgeax_pbr::gbuffer', 'forgeax_view::common'],
  compose: ['forgeax_pbr::gbuffer', 'forgeax_view::common'],
};

let compiler: CompilerModule;

beforeAll(async () => {
  compiler = (await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  )) as unknown as CompilerModule;
});

async function compile(name: keyof typeof SOURCES): Promise<CompileValue> {
  const result = await compiler.compileShader(SOURCES[name], {
    id: `forgeax_ssr::${name}`,
    imports: Object.fromEntries(STAGE_IMPORTS[name].map((id) => [id, IMPORT_SOURCES[id]])),
  });
  expect(result.ok, result.ok ? undefined : `${name}: ${result.error?.message}`).toBe(true);
  if (!result.ok || result.value === undefined) throw new Error(`failed to compile ${name}`);
  return result.value;
}

describe('SSR built-in shader artifacts', () => {
  it('owns one build-time source for each spatial producer stage', () => {
    expect(SOURCES.pyramidSeed).toContain('#define_import_path forgeax_depth_pyramid::seed');
    expect(SOURCES.pyramidReduce).toContain('#define_import_path forgeax_depth_pyramid::reduce');
    expect(SOURCES.trace).toContain('#define_import_path forgeax_ssr::trace');
    expect(SOURCES.pyramidSeed).toContain('DEPTH_PYRAMID_FORMAT');
    expect(SOURCES.pyramidSeed).toContain('linearizeViewDepth');
    expect(SOURCES.pyramidSeed).toContain('view.temporalProjection');
    expect(SOURCES.pyramidReduce).toContain('reduceDepthPyramidFootprint');
    expect(SOURCES.trace).toContain('SSR_TRACE_MAX_COARSE_STEPS');
    expect(SOURCES.trace).toContain('SSR_TRACE_MAX_REFINE_STEPS');
    expect(SOURCES.trace).toContain('traceScreenRay');
    expect(SOURCES.trace).toContain('textureLoad(depthPyramid');
    expect(SOURCES.trace).toContain('view.ssrParams.w > 0.5');
    expect(SOURCES.temporal).toContain('SsrTemporalParams');
    expect(SOURCES.temporal).toContain('resolvedOutput');
    expect(SOURCES.temporal).toContain('sourceSize.x == size.x * 2u');
    expect(SOURCES.temporal).toContain('topLeft = textureLoad(currentTrace');
    expect(SOURCES.temporal).toContain('bottomRight = textureLoad(currentTrace');
    expect(SOURCES.temporal).toContain('count += 1.0');
  });

  it('compiles and reflects every artifact through the build-time compiler', async () => {
    for (const name of Object.keys(SOURCES) as Array<keyof typeof SOURCES>) {
      const value = await compile(name);
      expect(value.wgsl.length).toBeGreaterThan(0);
      if (name !== 'compose') expect(value.glsl).toBe('');
      expect(value.manifestEntry.wgsl).toBe(value.wgsl);
      if (name !== 'compose') expect(value.manifestEntry.glsl ?? '').toBe('');
      expect(value.manifestEntry.hash).toMatch(/^[0-9a-f]{8,64}$/);
      expect([...value.deps].sort()).toEqual([...STAGE_IMPORTS[name]]);
      expect(JSON.parse(value.manifestEntry.bindings)).toEqual(value.bindings);
    }
  });

  it('keeps artifact identity content-addressed and deterministic', async () => {
    for (const name of Object.keys(SOURCES) as Array<keyof typeof SOURCES>) {
      const first = await compile(name);
      const second = await compile(name);
      expect(second.manifestEntry.hash).toBe(first.manifestEntry.hash);
      expect(second.manifestEntry.wgsl).toBe(first.manifestEntry.wgsl);
      expect(second.manifestEntry.bindings).toBe(first.manifestEntry.bindings);
    }
  });

  it('keeps the runtime registry physically isolated from the compiler', () => {
    const registrySource = readFileSync(
      resolve(import.meta.dirname, '../ShaderRegistry.ts'),
      'utf8',
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(registrySource).not.toMatch(
      /^\s*(?:import|export).*@forgeax\/engine-(?:shader-compiler|naga|wgpu-wasm)/mu,
    );
    expect(Object.keys(packageJson.dependencies ?? {})).not.toEqual(
      expect.arrayContaining([
        '@forgeax/engine-shader-compiler',
        '@forgeax/engine-naga',
        '@forgeax/engine-wgpu-wasm',
      ]),
    );
  });
});

export type { ShaderBinding };
