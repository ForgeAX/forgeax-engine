import { expect, it, vi } from 'vitest';

vi.mock('../engine-inputs/load-engine-shader-entries.js', async (original) => {
  const actual = await original<typeof import('../engine-inputs/load-engine-shader-entries.js')>();
  return {
    ...actual,
    loadPackageMaterialShaderEntries: async () => [],
    loadEngineShaderEntries: async () => {
      const entries = await actual.loadEngineShaderEntries();
      return Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          key === 'imports'
            ? value
            : Array.isArray(value)
              ? value.filter((entry) => entry.reservedIdentifier?.startsWith('forgeax::cloud-'))
              : { id: (value as { id: string }).id, source: entries.bloomHorizontal.source },
        ]),
      );
    },
  };
});

it('compiles the production lit cloud programs with their reflected parameter ABI', async () => {
  vi.stubEnv('FORGEAX_ENGINE_SHADER_SOURCE_BUILD', '1');
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  try {
    const { buildEngineShaderManifest } = await import('../index.js');
    const manifest = await buildEngineShaderManifest();
    const sampled = manifest.materialShaders.filter((entry) =>
      entry.identifier.startsWith('forgeax::cloud-sampled-view-'),
    );
    expect(sampled).toHaveLength(2);
    for (const entry of sampled) {
      expect(entry.composedWgsl).toContain('cloud_secondary_optical_depth');
      expect(entry.composedWgsl).toContain('nearTransmittance');
      expect(entry.entryPoints).toEqual(
        expect.arrayContaining(
          ['fs_trace_mode_zero', 'fs_shadow'].map((name) =>
            expect.objectContaining({ name, stage: 'fragment' }),
          ),
        ),
      );
      expect(entry.composedWgsl).toMatch(/\bfn fs_trace_mode_zero\s*\(/);
    }
  } finally {
    vi.unstubAllEnvs();
  }
}, 120_000);
