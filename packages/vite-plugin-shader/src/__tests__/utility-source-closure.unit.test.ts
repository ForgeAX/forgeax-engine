import { afterEach, expect, it, vi } from 'vitest';

// Bound the roster to a real Engine utility, preserving its source and Naga
// compilation while making an unrelated broken library record observable.
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
            ? {
                ...entries.imports,
                unrelated_utility:
                  '#define_import_path unrelated_utility\n#import missing::unrelated\nfn unused() {}',
              }
            : Array.isArray(value)
              ? []
              : { id: (value as { id: string }).id, source: entries.bloomDownsample.source },
        ]),
      );
    },
  };
});

afterEach(() => vi.unstubAllEnvs());

it('compiles real no-axis Engine utilities independently of unrelated library records', async () => {
  vi.stubEnv('FORGEAX_ENGINE_SHADER_SOURCE_BUILD', '1');
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  const { buildEngineShaderManifest } = await import('../index.js');
  const manifest = await buildEngineShaderManifest();
  expect(manifest.entries.length).toBeGreaterThan(1);
  for (const entry of manifest.entries) {
    expect(entry.wgsl).toContain('textureSampleLevel');
    expect(JSON.parse(entry.bindings).length).toBeGreaterThan(0);
  }
}, 30_000);
