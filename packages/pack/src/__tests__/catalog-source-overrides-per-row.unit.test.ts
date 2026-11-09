import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalogProjection } from '../catalog-builder.js';
import { decodeCatalogWire, encodeCatalogWire } from '../catalog-wire.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sourceOverrides = {
  'mesh/a': {
    lods: [{ screenCoverage: 0.5 }],
    materialSlotDefaultOverrides: { 'material/body': '019f0000-0000-7000-8000-0000000000b1' },
  },
  'mesh/b': { lods: [{ screenCoverage: 0.25 }] },
  'texture/albedo': { colorSpace: 'srgb' },
} as const;

const subAssets = [
  {
    guid: '019f0000-0000-7000-8000-0000000000a1',
    sourceIndex: 0,
    sourceKey: 'mesh/a',
    kind: 'mesh',
  },
  {
    guid: '019f0000-0000-7000-8000-0000000000a2',
    sourceIndex: 1,
    sourceKey: 'mesh/b',
    kind: 'mesh',
  },
  {
    guid: '019f0000-0000-7000-8000-0000000000a3',
    sourceIndex: 2,
    sourceKey: 'material/body',
    kind: 'material',
  },
  {
    guid: '019f0000-0000-7000-8000-0000000000a4',
    sourceIndex: 3,
    sourceKey: 'texture/albedo',
    kind: 'texture',
  },
  {
    guid: '019f0000-0000-7000-8000-0000000000a5',
    sourceIndex: 4,
    sourceKey: 'sampler/0',
    kind: 'sampler',
  },
] as const;

/** What an override consumer resolves for one row: the entry under the row's own source key. */
function effectiveOverride(row: {
  readonly sourceKey?: string;
  readonly sourceOverrides?: object;
}) {
  if (row.sourceKey === undefined) return undefined;
  return (row.sourceOverrides as Record<string, unknown> | undefined)?.[row.sourceKey];
}

async function catalogFor(meta: object) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-overrides-per-row-'));
  roots.push(root);
  await writeFile(join(root, 'scene.glb'), 'fixture');
  await writeFile(join(root, 'scene.glb.meta.json'), JSON.stringify(meta));
  const catalog = await buildCatalogProjection([root], {
    importerPolicy: () => ({ disposition: 'publish', expected: 'fixture', hint: 'fixture' }),
  });
  expect(catalog.diagnostics).toEqual([]);
  return catalog;
}

describe('Catalog rows carry only their own source override', () => {
  it('resolves the same effective override per row as the producer map, through the wire', async () => {
    const meta = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'fixture',
      source: 'scene.glb',
      importSettings: {},
      sourceOverrides,
      subAssets,
    };
    const catalog = await catalogFor(meta);
    const rows = decodeCatalogWire(JSON.parse(JSON.stringify(encodeCatalogWire(catalog.entries))))
      .unwrap()
      .filter((row) => subAssets.some((sub) => sub.guid === row.guid));
    expect(rows).toHaveLength(subAssets.length);

    for (const row of rows) {
      // Before: every row held the whole producer map, so resolution indexed it by sourceKey.
      const before =
        row.sourceKey === undefined
          ? undefined
          : (sourceOverrides as Record<string, unknown>)[row.sourceKey];
      expect(effectiveOverride(row)).toEqual(before);
      expect(Object.keys(row.sourceOverrides ?? {})).toEqual(
        before === undefined ? [] : [row.sourceKey],
      );
    }
    // The rows of one producer still hold the complete map between them.
    expect(Object.assign({}, ...rows.map((row) => row.sourceOverrides ?? {}))).toEqual(
      sourceOverrides,
    );
    // Importers read the declaration, which keeps the whole map.
    const [declaration] = [...catalog.declarations.values()];
    expect(declaration?.sourceOverrides).toEqual(sourceOverrides);
  });

  it('keeps Catalog size linear in overrides rather than rows × overrides', async () => {
    const many = Array.from({ length: 64 }, (_, index) => ({
      guid: `019f0000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`,
      sourceIndex: index,
      sourceKey: `mesh/${index}`,
      kind: 'mesh',
    }));
    const overrides = Object.fromEntries(
      many.map((sub) => [sub.sourceKey, { lods: [{ screenCoverage: 0.5 }] }]),
    );
    const catalog = await catalogFor({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'fixture',
      source: 'scene.glb',
      importSettings: {},
      sourceOverrides: overrides,
      subAssets: many,
    });
    const carried = catalog.entries.reduce(
      (count, row) => count + Object.keys(row.sourceOverrides ?? {}).length,
      0,
    );
    expect(carried).toBe(many.length);
  });
});
