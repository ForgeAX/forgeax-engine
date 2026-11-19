import { publishShaderProgramTemplates } from '@forgeax/engine-shader';
import { MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { createPublicationAssets } from '../renderer-host';

it('assembles the native program service through the ordinary source-realm host without preparing unused programs', async () => {
  const library = publishShaderProgramTemplates(
    new Map([
      [
        'runtime::source',
        {
          schemaVersion: 'shader-program-template/1',
          compilerProfile: MATERIAL_WGSL_PROFILE,
          source: '@compute @workgroup_size(1) fn main() {}',
          imports: {},
          axes: [],
        },
      ],
    ]),
  ).unwrap();
  const manifest = { schemaVersion: '7.0.0', library, entries: [], materialShaders: [] };
  const assets = await createPublicationAssets({
    shaderManifestUrl: 'memory:source-templates',
    readShaderManifest: async () => JSON.stringify(manifest),
  });
  try {
    expect(assets.shaderRegistry.programTemplateInspection()).toMatchObject({
      templates: 1,
      selections: 0,
    });
    expect(assets.shaderRegistry.sourceInspection().sources).toBe(0);
    const selected = assets.shaderRegistry.resolveProgramTemplate('runtime::source', {}).unwrap();
    expect(selected.manifestEntry.entryPoints).toEqual([
      expect.objectContaining({ name: 'main', stage: 'compute' }),
    ]);
    expect(assets.shaderRegistry.resolveProgramTemplate('runtime::source', {}).unwrap()).toBe(
      selected,
    );
    expect(assets.shaderRegistry.programTemplateInspection()).toMatchObject({
      selections: 1,
      requests: 2,
      cacheHits: 1,
    });
  } finally {
    assets.dispose();
  }
});
