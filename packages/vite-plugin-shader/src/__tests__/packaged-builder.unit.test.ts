import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishShaderManifest } from '../manifest-publication.js';
// Prepare the mocked module graph during collection; cases still reset module state.
import '../index.js';

const fixtures = vi.hoisted(() => ({ packaged: vi.fn(), source: vi.fn(), compile: vi.fn() }));
const packaged = (entries: { hash: string; wgsl: string; bindings: string }[]) => ({
  entries,
  materialShaders: [],
  imports: {},
  publication: publishShaderManifest(
    entries.map((entry) => ({ ...entry, glsl: '' })),
    [],
  ),
});
vi.mock('../shared-engine-inputs.js', async (original) => ({
  ...(await original<typeof import('../shared-engine-inputs.js')>()),
  loadPackagedEngineShaderInputs: fixtures.packaged,
}));
vi.mock('../engine-inputs/load-engine-shader-entries.js', async (original) => ({
  ...(await original<typeof import('../engine-inputs/load-engine-shader-entries.js')>()),
  loadEngineShaderEntries: fixtures.source,
}));
vi.mock('../material/cook-adapter.js', async (original) => ({
  ...(await original<typeof import('../material/cook-adapter.js')>()),
  cookMaterialSource: fixtures.compile,
}));

beforeEach(() => {
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);
  vi.resetModules();
  fixtures.packaged.mockReset();
  fixtures.source.mockReset().mockRejectedValue(new Error('source compiler selected'));
  fixtures.compile.mockReset().mockRejectedValue(new Error('engine source recompiled'));
});
afterEach(() => vi.unstubAllEnvs());

describe('standalone builder input ownership', () => {
  it('rechecks a replaced packaged profile instead of caching only its option path', async () => {
    const original = packaged([{ hash: 'before', wgsl: 'before', bindings: '[]' }]);
    fixtures.packaged.mockReturnValue(original);
    const { buildEngineShaderManifest } = await import('../index.js');
    const before = await buildEngineShaderManifest();
    fixtures.packaged.mockReturnValue(packaged([{ hash: 'after', wgsl: 'after', bindings: '[]' }]));
    const after = await buildEngineShaderManifest();
    expect(after.entries[0]?.wgsl).toBe('after');
    expect(before.entries[0]?.wgsl).toBe('before');
  });

  it('uses the prepared base profile for the point-shadow-disabled GPU control', async () => {
    const previous = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    fixtures.packaged.mockReturnValue(
      packaged([{ hash: 'base', wgsl: 'base shader', bindings: '[]' }]),
    );
    try {
      const { buildEngineShaderManifest } = await import('../index.js');
      const manifest = await buildEngineShaderManifest();
      expect(fixtures.packaged).toHaveBeenCalledWith(false, true);
      expect(fixtures.source).not.toHaveBeenCalled();
      expect(manifest.entries).toEqual([
        { hash: 'base', wgsl: 'base shader', bindings: '[]', glsl: '' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previous;
    }
  });

  it('does not expand packaged publications while discovering unselected projects', async () => {
    fixtures.packaged.mockImplementation(() => {
      throw new Error('publication expanded during project discovery');
    });
    const { forgeaxShader } = await import('../index.js');
    expect(() => Array.from({ length: 100 }, () => forgeaxShader())).not.toThrow();
    expect(fixtures.packaged).not.toHaveBeenCalled();
  });

  it('keeps a configured shared input ahead of a leftover base profile', async () => {
    const previous = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = '/missing/shared-inputs/manifest.json';
    fixtures.packaged.mockReturnValue({ entries: [], materialShaders: [], imports: {} });
    try {
      const { buildEngineShaderManifest } = await import('../index.js');
      await expect(buildEngineShaderManifest()).rejects.toThrow(/ENOENT/);
      expect(fixtures.packaged).not.toHaveBeenCalled();
      expect(fixtures.source).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previous;
    }
  });
  it('uses the prepared point profile without invoking the source producer', async () => {
    fixtures.packaged.mockReturnValue(
      packaged([{ hash: 'point', wgsl: 'point shader', bindings: '[]' }]),
    );
    const { buildEngineShaderManifest } = await import('../index.js');
    const manifest = await buildEngineShaderManifest({ pointShadows: true });
    expect(fixtures.packaged).toHaveBeenCalledWith(true, true);
    expect(fixtures.source).not.toHaveBeenCalled();
    expect(manifest.entries).toEqual([
      { hash: 'point', wgsl: 'point shader', bindings: '[]', glsl: '' },
    ]);
  });

  it('falls back to source when the packaged loader rejects missing or forced-source input', async () => {
    fixtures.packaged.mockReturnValue(null);
    const { buildEngineShaderManifest } = await import('../index.js');
    await expect(buildEngineShaderManifest({ pointShadows: true })).rejects.toThrow(
      'source compiler selected',
    );
    expect(fixtures.source).toHaveBeenCalledOnce();
  });

  it('does not let an earlier packaged result hide a forced source validation', async () => {
    const previous = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '0';
    fixtures.packaged.mockReturnValue(packaged([]));
    try {
      const { buildEngineShaderManifest } = await import('../index.js');
      await buildEngineShaderManifest({ pointShadows: true });
      process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
      fixtures.packaged.mockReturnValue(null);
      await expect(buildEngineShaderManifest({ pointShadows: true })).rejects.toThrow(
        'source compiler selected',
      );
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
      else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previous;
    }
  });

  it.each([
    false,
    true,
  ])('reuses admitted engine inputs and cooks fresh authored materials: point=%s', async (pointShadows) => {
    vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', undefined);
    vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
    const actual = await vi.importActual<
      typeof import('../engine-inputs/load-engine-shader-entries.js')
    >('../engine-inputs/load-engine-shader-entries.js');
    // Bound the engine fleet; the authored package below still uses real Naga.
    fixtures.source.mockImplementation(async () =>
      Object.fromEntries(
        Object.entries(await actual.loadEngineShaderEntries()).map(([name, entry]) => [
          name,
          name === 'imports'
            ? {}
            : Array.isArray(entry)
              ? []
              : {
                  id: (entry as { id: string }).id,
                  source: `#define_import_path reuse_probe::${name}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
                },
        ]),
      ),
    );
    fixtures.packaged.mockReturnValue({
      entries: [{ hash: 'profile', wgsl: 'admitted engine shader', bindings: '[]' }],
      materialShaders: [],
      imports: {},
    });
    const directory = await mkdtemp(join(tmpdir(), 'packaged-authored-builder-'));
    try {
      await writeFile(
        join(directory, 'custom.wgsl'),
        `#define_import_path profile_test::custom
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.25); }`,
      );
      const packagePath = join(directory, 'custom.pack.json');
      await writeFile(
        packagePath,
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: '00000000-0000-4000-8000-000000000001',
              kind: 'material',
              sourceKey: 'custom.wgsl',
              refs: [],
              payload: {
                kind: 'material',
                parameters: [],
                passes: [
                  {
                    name: 'Forward',
                    program: {
                      module: 'profile_test::custom',
                      vertexEntry: 'vs_main',
                      fragmentEntry: 'fs_main',
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      const { buildEngineShaderManifest } = await import('../index.js');
      const manifest = await buildEngineShaderManifest({
        pointShadows,
        materialPackages: [packagePath],
      });
      expect(fixtures.packaged).toHaveBeenCalledWith(pointShadows, true);
      expect(fixtures.compile).not.toHaveBeenCalled();
      expect(manifest.entries[0]?.hash).toBe('profile');
      expect(manifest.entries).toHaveLength(2);
      expect(manifest.materialShaders[0]?.identifier).toBe('profile_test::custom');
      expect(manifest.materialShaders[0]?.composedWgsl).toContain('fs_main');
      await expect(
        buildEngineShaderManifest({
          pointShadows,
          materialPackages: [join(directory, 'missing.pack.json')],
        }),
      ).rejects.toThrow('missing.pack.json');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps authored point-shadow packages on source when the prepared profile is missing', async () => {
    fixtures.packaged.mockReturnValue(null);
    const { buildEngineShaderManifest } = await import('../index.js');
    await expect(
      buildEngineShaderManifest({ pointShadows: true, materialPackages: ['custom.pack.json'] }),
    ).rejects.toThrow('source compiler selected');
    expect(fixtures.packaged).toHaveBeenCalledWith(true, true);
  });
});
