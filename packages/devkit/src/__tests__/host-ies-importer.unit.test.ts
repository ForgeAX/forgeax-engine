import { declaredPackExternalOutputs, ImporterRegistry } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORTERS } from '../host.js';
import { commandError } from '../project.js';

describe('standalone host IES importer seed', () => {
  it('preserves actual UI source diagnostics through Pack staging and CLI serialization', async () => {
    const registry = new ImporterRegistry();
    for (const importer of DEFAULT_IMPORTERS) registry.register(importer);
    const guid = '019ffa97-0000-7000-8000-000000000001';
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw parsed.error;
    const sourcePath = '/project/assets/combat.ui.html.meta.json';
    try {
      await declaredPackExternalOutputs(
        new Map([
          [
            sourcePath,
            {
              format: 'meta.json' as const,
              sourcePath,
              sourceRevision: 'sha256:ui',
              value: {
                schemaVersion: '1.0.0',
                kind: 'external-asset-package' as const,
                importer: 'ui',
                source: 'combat.ui.html',
                importSettings: {},
                subAssets: [{ guid, sourceIndex: 0, kind: 'ui' as const }],
              },
            },
          ],
        ]),
        [],
        [parsed.value],
        {
          importerRegistry: registry,
          fsForImport: {
            readSource: async (path) => ({
              ok: true as const,
              value: new TextEncoder().encode(path.endsWith('.css') ? '' : '<iframe></iframe>'),
            }),
          },
        },
      );
      expect.fail('invalid UI source must fail import');
    } catch (cause) {
      const wire = JSON.parse(JSON.stringify(commandError(cause, 'pack-build-failed')));
      expect(JSON.stringify(wire)).toContain('runtime-html-surface');
      expect(JSON.stringify(wire)).toContain('combat.ui.html');
      expect(JSON.stringify(wire)).toContain('sourceRange');
    }
  });

  it('seeds the built-in importers beside the existing importer set', () => {
    const ies = DEFAULT_IMPORTERS.find((importer) => importer.key === 'ies');
    expect(ies).toBeDefined();
    expect(DEFAULT_IMPORTERS.map((importer) => importer.key)).toEqual([
      'audio',
      'image',
      'fbx',
      'gltf',
      'obj',
      'stl',
      'svg',
      'font',
      'ies',
      'ui',
    ]);
  });
});
