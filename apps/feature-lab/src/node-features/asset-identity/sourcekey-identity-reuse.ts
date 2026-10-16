import { reimportReuseMeta } from '@forgeax/engine/gltf';
import { scanInventory } from '@forgeax/engine/pack/scanner';
import { defineFeature } from '../../lab/feature';
import { withFixture } from './support/fixture';

const PACKAGE = '0190a1b2-0000-7000-8000-00000000b001';

function directPack(order: readonly string[]): string {
  const assets: Record<string, unknown> = {};
  for (const key of order) assets[key] = { kind: 'sampler', payload: {}, refs: [] };
  return JSON.stringify({ schemaVersion: '3.0.0', packageId: PACKAGE, assets });
}

async function guidsByKey(path: string, body: string): Promise<Map<string, string>> {
  return withFixture({ [path]: body }, async (root) => {
    const result = await scanInventory([root]);
    const map = new Map<string, string>();
    if (!result.ok) return map;
    for (const row of result.value.inventory) {
      if (row.sourceKey !== undefined) map.set(row.sourceKey, row.guid);
    }
    return map;
  });
}

export default defineFeature({
  title: 'SourceKey identity reuse',
  catalog: 'SourceKey identity reuse',
  kind: 'headless',
  summary:
    'GUIDs follow sourceKey across file renames, reordering, and reimport; sourceIndex only locates data.',
  expect:
    'Renamed/reordered Pack keeps GUIDs; glTF reimport reuses GUIDs by sourceKey while sourceIndex follows the file.',
  async run(checks) {
    const before = await guidsByKey('a.pack.json', directPack(['samplers/a', 'samplers/b']));
    const after = await guidsByKey('renamed/b.pack.json', directPack(['samplers/b', 'samplers/a']));
    checks.equal('two outputs scanned', before.size, 2);
    checks.equal(
      'rename + reorder keeps GUID of samplers/a',
      after.get('samplers/a'),
      before.get('samplers/a'),
    );
    checks.equal(
      'rename + reorder keeps GUID of samplers/b',
      after.get('samplers/b'),
      before.get('samplers/b'),
    );

    const first = reimportReuseMeta(
      [
        { kind: 'mesh', sourceIndex: 0, name: 'Hero' },
        { kind: 'mesh', sourceIndex: 1, name: 'Sword' },
      ],
      undefined,
    );
    checks.ok('first glTF import mints GUIDs', first.ok);
    if (!first.ok) return;
    const existing = {
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'gltf',
      source: 'hero.glb',
      subAssets: first.value.subAssets,
      importSettings: {
        defaultSceneIndex: 0,
        diagnostics: { nodeNames: [], unsupportedExtensions: [], matrixTrsCoexistNodes: [] },
      },
    } as const;
    const second = reimportReuseMeta(
      [
        { kind: 'mesh', sourceIndex: 0, name: 'Sword' },
        { kind: 'mesh', sourceIndex: 1, name: 'Hero' },
        { kind: 'mesh', sourceIndex: 2, name: 'Shield' },
      ],
      existing,
    );
    checks.ok('reimport succeeds', second.ok);
    if (!second.ok) return;
    const guidOf = (list: typeof second.value.subAssets, key: string) =>
      list.find((entry) => entry.sourceKey === key);
    checks.equal(
      'Hero keeps its GUID after reorder',
      guidOf(second.value.subAssets, 'mesh:Hero')?.guid,
      guidOf(first.value.subAssets, 'mesh:Hero')?.guid,
    );
    checks.equal(
      'Hero sourceIndex follows the new file layout',
      guidOf(second.value.subAssets, 'mesh:Hero')?.sourceIndex,
      1,
    );
    const shield = guidOf(second.value.subAssets, 'mesh:Shield')?.guid;
    checks.ok(
      'new sourceKey mints a fresh GUID',
      shield !== undefined && !first.value.subAssets.some((entry) => entry.guid === shield),
    );
    const duplicate = reimportReuseMeta(
      [
        { kind: 'mesh', sourceIndex: 0, name: 'Hero' },
        { kind: 'mesh', sourceIndex: 1, name: 'Hero' },
      ],
      undefined,
    );
    checks.equal(
      'duplicate sourceKey is a structured error',
      duplicate.ok ? 'ok' : duplicate.error.code,
      'duplicate-source-key',
    );
  },
});
