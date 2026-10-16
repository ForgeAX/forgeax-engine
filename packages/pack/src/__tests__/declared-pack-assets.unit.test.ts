import { describe, expect, it } from 'vitest';
import { AssetGuid } from '../guid.js';
import { parsePackSourceJson } from '../pack-authoring.js';
import { declaredPackAssets, type LegacyPackInventoryDocument } from '../scanner.js';

const DIRECT_PACKAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARENT_PACKAGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE_PACKAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEGACY_GUID = '11111111-1111-4111-8111-111111111111';

function legacy(schemaVersion: LegacyPackInventoryDocument['schemaVersion']) {
  return {
    schemaVersion,
    kind: 'internal-text-package',
    assets: [{ guid: LEGACY_GUID, kind: 'material', sourceKey: 'red', payload: {}, refs: [] }],
  } satisfies LegacyPackInventoryDocument;
}

describe('declaredPackAssets', () => {
  it.each(['1.0.0', '2.0.0'] as const)('returns legacy %s rows unchanged', (version) => {
    const document = legacy(version);
    expect(declaredPackAssets(document)).toBe(document.assets);
  });

  it('projects v3 direct assets with derived GUIDs in source-key order', () => {
    const document = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: DIRECT_PACKAGE,
      assets: {
        zeta: { kind: 'material', payload: {}, refs: [] },
        alpha: { kind: 'scene', name: 'Alpha', payload: {}, refs: [] },
      },
    }).unwrap();
    const { packageId } = document;
    expect(
      declaredPackAssets(document).map(({ guid, sourceKey, kind, name }) => ({
        guid,
        sourceKey,
        kind,
        name,
      })),
    ).toEqual([
      {
        guid: AssetGuid.format(AssetGuid.derive(packageId, 'alpha')),
        sourceKey: 'alpha',
        kind: 'scene',
        name: 'Alpha',
      },
      {
        guid: AssetGuid.format(AssetGuid.derive(packageId, 'zeta')),
        sourceKey: 'zeta',
        kind: 'material',
        name: undefined,
      },
    ]);
  });

  it('declares no rows for a v3 instance; its ScriptablePack parent builds them', () => {
    const document = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: INSTANCE_PACKAGE,
      parent: PARENT_PACKAGE,
      values: { color: 'red' },
    }).unwrap();
    expect(declaredPackAssets(document)).toEqual([]);
  });
});
