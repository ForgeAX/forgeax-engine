import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { publishShaderManifest } from '../manifest-publication.js';

vi.mock('../shared-engine-inputs.js', async (original) => ({
  ...(await original<typeof import('../shared-engine-inputs.js')>()),
  loadPackagedEngineShaderInputs: () => ({
    entries: [],
    materialShaders: [],
    imports: {
      'forgeax_view::common':
        '#define_import_path forgeax_view::common\nfn oldFact() -> vec4<f32> { return vec4<f32>(0.0); }',
    },
  }),
}));

it('uses current source imports with explicit shared rows instead of mixing a packaged ABI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-import-owner-'));
  const previous = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
  try {
    const sources = join(root, 'source');
    const shared = join(root, 'shared');
    mkdirSync(sources);
    mkdirSync(shared);
    writeFileSync(
      join(sources, 'common.wgsl'),
      '#define_import_path forgeax_view::common\nfn currentFact() -> vec4<f32> { return vec4<f32>(1.0); }',
    );
    writeFileSync(
      join(root, 'custom.wgsl'),
      '#define_import_path game::current\n#import forgeax_view::common::{currentFact}\n@vertex fn vs_main() -> @builtin(position) vec4<f32> { return currentFact(); }\n@fragment fn fs_main() -> @location(0) vec4<f32> { return currentFact(); }',
    );
    const material = join(root, 'custom.pack.json');
    writeFileSync(
      material,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: '019fb7ce-1000-4000-8000-000000000078',
            kind: 'material',
            execution: 'cooked',
            sourceKey: 'custom.wgsl',
            payload: {
              kind: 'material',
              passes: [{ name: 'Forward', program: { module: 'game::current' } }],
              parameters: [],
              values: {},
            },
            refs: [],
          },
        ],
      }),
    );
    const manifest = join(shared, 'manifest.json');
    writeFileSync(
      manifest,
      JSON.stringify({ payload: { engineShaderManifest: 'shared/shaders.json' } }),
    );
    writeFileSync(join(shared, 'shaders.json'), JSON.stringify(publishShaderManifest([], [])));
    process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = manifest;
    const { forgeaxShader } = await import('../index.js');
    const plugin = forgeaxShader({
      engineEntries: { pointShadows: true },
      engineShaderRoots: [sources],
      materialPackages: [material],
    });
    await expect(
      plugin.buildStart.call({
        error: (error: unknown) => {
          throw error;
        },
        emitFile: () => '',
      }),
    ).resolves.toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
