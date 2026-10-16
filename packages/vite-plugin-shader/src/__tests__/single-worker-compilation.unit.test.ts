import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compilation = vi.hoisted(() => ({ active: 0, peak: 0, completed: 0 }));

// Keep real Naga composition/reflection while bounding the source fixture.
// Every engine entry gets two variants so both public producer paths reach
// the same single-worker scheduling boundary without a full fleet stress run.
vi.mock('../engine-inputs/load-engine-shader-entries.js', async (original) => {
  const actual = await original<typeof import('../engine-inputs/load-engine-shader-entries.js')>();
  return {
    ...actual,
    loadPackageMaterialShaderEntries: async () => [],
    loadEngineShaderEntries: async () => {
      const entries = await actual.loadEngineShaderEntries();
      return Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [
          name,
          name === 'imports'
            ? {}
            : Array.isArray(value)
              ? []
              : {
                  id: (value as { id: string }).id,
                  source: `#define_import_path concurrency_probe::${name}
#pragma variant_axis BOUNDED_COMPILATION
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
                },
        ]),
      );
    },
  };
});

vi.mock('@forgeax/engine-shader-compiler', async (original) => {
  const actual = await original<typeof import('@forgeax/engine-shader-compiler')>();
  return {
    ...actual,
    createShaderProgramCompiler: () => {
      const compile = actual.createShaderProgramCompiler();
      return async (...args: Parameters<typeof compile>) => {
        compilation.active += 1;
        compilation.peak = Math.max(compilation.peak, compilation.active);
        try {
          const result = await compile(...args);
          compilation.completed += 1;
          return result;
        } finally {
          compilation.active -= 1;
        }
      };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  compilation.active = 0;
  compilation.peak = 0;
  compilation.completed = 0;
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  vi.stubEnv('FORGEAX_ENGINE_SHADER_SOURCE_BUILD', '1');
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('single-worker source compilation budget', () => {
  it('standalone manifest compilation admits one real compiler operation at a time', async () => {
    const { buildEngineShaderManifest } = await import('../index.js');
    const manifest = await buildEngineShaderManifest();
    expect(compilation.completed).toBeGreaterThan(2);
    expect(compilation.active).toBe(0);
    expect(compilation.peak).toBe(1);
    expect(manifest.materialShaders.every((entry) => entry.variants.length === 2)).toBe(true);
  }, 60_000);

  it('Vite buildStart preserves both variants within one compiler operation at a time', async () => {
    const { forgeaxShader } = await import('../index.js');
    const plugin = forgeaxShader();
    const emitted: Array<{ fileName: string; source: string }> = [];
    const emitFile = (asset: { fileName: string; source: string }) => emitted.push(asset);
    await plugin.buildStart.call({ emitFile } as never);
    plugin.generateBundle.call({ emitFile } as never);
    expect(compilation.completed).toBeGreaterThan(2);
    expect(compilation.active).toBe(0);
    expect(compilation.peak).toBe(1);
    const manifestAsset = emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(manifestAsset).toBeDefined();
    const manifest = JSON.parse(manifestAsset?.source ?? '{}') as {
      materialShaders: Array<{ variants: unknown[] }>;
    };
    expect(manifest.materialShaders.length).toBeGreaterThan(0);
    expect(manifest.materialShaders.every((entry) => entry.variants.length === 2)).toBe(true);
    // Source fallback must publish the same bounded runtime closure as prepared profiles.
    // Per-variant debug copies can otherwise add gigabytes to a native game package.
    expect(emitted.map((asset) => asset.fileName)).toEqual(['shaders/manifest.json']);
  }, 60_000);
});
