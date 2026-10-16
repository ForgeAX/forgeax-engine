import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalogResult } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';

describe('catalog owner projection', () => {
  it('keeps provider-declared sampler outputs discoverable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-catalog-sampler-'));
    try {
      await writeFile(join(root, 'Fox.glb'), new Uint8Array([0]));
      await writeFile(
        join(root, 'Fox.glb.meta.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'external-asset-package',
          importer: 'gltf',
          source: 'Fox.glb',
          importSettings: { defaultSceneIndex: 0 },
          subAssets: [
            {
              guid: '019f0000-0000-7000-8000-000000000021',
              sourceKey: 'material/main',
              sourceIndex: 0,
              kind: 'material',
            },
            {
              guid: '019f0000-0000-7000-8000-000000000022',
              sourceKey: 'sampler/main',
              sourceIndex: 0,
              kind: 'sampler',
            },
          ],
        }),
      );

      const result = await buildCatalogResult([root]);
      expect(result.diagnostics).toEqual([]);
      expect(result.entries.find((entry) => entry.guid.endsWith('000000000022'))).toMatchObject({
        kind: 'sampler',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves declared source overrides and drops undeclared descriptors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-catalog-overrides-'));
    const meshGuid = '019f0000-0000-7000-8000-000000000031';
    const authoredGuid = '019f0000-0000-7000-8000-000000000032';
    const sourceOverrides = {
      'mesh/main': {
        materialSlots: [{ slotName: 'Body', sourceKey: 'material/body' }],
        materialSlotDefaultOverrides: { 'material/body': authoredGuid },
      },
    };
    const sourceOverrideDescriptors = [
      {
        sourceKey: 'mesh/main',
        semantic: 'mesh-material-slot-defaults',
        payloadSchema: {
          type: 'object',
          properties: {
            materialSlots: {
              type: 'array',
              items: { type: 'object', properties: { slotName: { type: 'string' } } },
            },
            materialSlotDefaultOverrides: {
              type: 'object',
              additionalProperties: { type: 'string', nullable: true },
            },
          },
        },
      },
    ];
    try {
      await writeFile(join(root, 'Editable.glb'), new Uint8Array([0]));
      await writeFile(
        join(root, 'Editable.glb.meta.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'external-asset-package',
          importer: 'gltf',
          source: 'Editable.glb',
          importSettings: {},
          sourceOverrides,
          sourceOverrideDescriptors,
          subAssets: [
            {
              guid: meshGuid,
              sourceKey: 'mesh/main',
              sourceIndex: 0,
              kind: 'mesh',
              name: 'Editable',
            },
          ],
        }),
      );

      const result = await buildCatalogResult([root]);
      expect(result.diagnostics).toEqual([]);
      expect(result.entries.find((entry) => entry.guid === meshGuid)).toMatchObject({
        kind: 'mesh',
        sourceKey: 'mesh/main',
        sourceOverrides,
        sourceOverrideDescriptors,
      });

      const metaPath = join(root, 'Editable.glb.meta.json');
      const declaredMeta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
      delete declaredMeta.sourceOverrideDescriptors;
      await writeFile(metaPath, JSON.stringify(declaredMeta));
      const undeclared = await buildCatalogResult([root]);
      expect(undeclared.diagnostics).toEqual([]);
      expect(
        undeclared.entries.find((entry) => entry.guid === meshGuid)?.sourceOverrideDescriptors,
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
