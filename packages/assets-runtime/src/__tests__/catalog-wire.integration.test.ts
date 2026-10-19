import { decodeCatalogWire, encodeCatalogWire } from '@forgeax/engine-pack';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import {
  catalogOperationsFor,
  createStandaloneRuntimeAssetBinding,
  type RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry.js';
import { createCatalogSource } from '../catalog-source.js';
import { parseCatalog } from '../registry/catalog.js';

const indexUrl = 'https://catalog.invalid/pack-index.json';
const packageUrl = 'https://catalog.invalid/assets/samplers.pack.json';
const guids = ['01900000-0000-7000-8000-000000000a01', '01900000-0000-7000-8000-000000000a02'];
const published = createRuntimePackPublication({
  scopeId: 'compact-catalog-fixture',
  sourcePath: 'assets/samplers.pack.ts',
  sourceRevision: 'fixture-revision',
  packageUrl,
  pack: {
    assets: guids.map((guid) => ({
      guid,
      kind: 'sampler',
      payload: { kind: 'sampler', magFilter: 'linear' },
      refs: [],
      artifacts: {},
    })),
  },
});
const projectionFacts = {
  subject: 'internal-asset',
  execution: 'cooked',
  lifecycle: 'current',
} as const;
const rows = published.publication.outputs.map((output) => ({
  ...projectionFacts,
  guid: output.guid,
  kind: output.kind,
  sourcePath: published.publication.sourcePath,
  packageUrl,
  refs: output.refs,
  sourceKey: output.sourceKey,
  publication: published.publication,
  projection: { ...projectionFacts, operations: catalogOperationsFor(projectionFacts) },
}));
const binding = createStandaloneRuntimeAssetBinding('compact-catalog-fixture');
const snapshot: RuntimeCatalogSnapshot = {
  schemaVersion: 'runtime-catalog-snapshot-v1',
  scopeId: binding.scopeId,
  generation: binding.generation,
  authority: 'authoritative',
  entries: rows,
  diagnostics: [],
};

it.each([
  false,
  true,
])('loads both real Pack siblings through the compact HTTP catalog (scoped=%s)', async (scoped) => {
  const wire = JSON.stringify(encodeCatalogWire(scoped ? snapshot : rows));
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === indexUrl) return new Response(wire);
    if (url === packageUrl) return new Response(JSON.stringify(published.pack));
    return new Response('', { status: 404 });
  });
  const source = createCatalogSource({
    url: indexUrl,
    fetch: fetcher,
    ...(scoped ? { expectedScope: binding } : {}),
  });
  const registry = new AssetRegistry({} as never);
  if (scoped) registry.configureRuntimeBinding(binding);
  registry.configurePackIndex(indexUrl);
  registry.setCatalogSource(source, fetcher);
  try {
    for (const guid of guids) {
      const loaded = await registry.loadByGuid(registry.parseGuid(guid));
      if (!loaded.ok) throw loaded.error;
      expect(loaded.ok).toBe(true);
      expect(loaded.value.kind).toBe('sampler');
    }
    const catalog = (await source.enumerate()).unwrap();
    expect(catalog.map((row) => row.publication)).toEqual(rows.map((row) => row.publication));
    expect(catalog.map((row) => row.projection)).toEqual(rows.map((row) => row.projection));
    expect(catalog[0]?.projection).toBe(catalog[1]?.projection);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === packageUrl)).toHaveLength(1);
  } finally {
    registry.clearCatalogSource();
  }
});

it('checks scoped identity and authority before admitting compact rows', () => {
  const wire = JSON.parse(JSON.stringify(encodeCatalogWire(snapshot)));
  const admitted = parseCatalog(wire, undefined, undefined, binding).unwrap();
  expect([...admitted.keys()]).toEqual(guids);
  expect(admitted.get(guids[0] ?? '')?.publication).toEqual(published.publication);
  for (const change of [
    { scopeId: 'foreign' },
    { generation: binding.generation + 1 },
    { generation: 1.5 },
    { authority: 'degraded' },
    { entries: null },
    {
      entries: { ...wire.entries, entries: [{ ...wire.entries.entries[0], publicationIndex: 99 }] },
    },
    {
      entries: { ...wire.entries, entries: [{ ...wire.entries.entries[0], projectionIndex: 99 }] },
    },
  ]) {
    const result = parseCatalog({ ...wire, ...change }, undefined, undefined, binding);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
  }
});

it('returns the existing structured Catalog error for a broken publication reference', () => {
  const wire = encodeCatalogWire(rows);
  if (Array.isArray(wire)) throw new Error('expected repeated complete publications');
  const corrupt = JSON.parse(JSON.stringify(wire));
  corrupt.entries[0].publicationIndex = corrupt.publications.length;
  const result = parseCatalog(corrupt);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('asset-parse-failed');
});

it('keeps malformed scoped authority rejected before compact admission', () => {
  const wire = encodeCatalogWire(rows);
  const result = parseCatalog(wire, undefined, undefined, { scopeId: 'active', generation: 1 });
  expect(result.ok).toBe(false);
  expect(
    decodeCatalogWire(wire)
      .unwrap()
      .map((row) => row.guid),
  ).toEqual(guids);
});
