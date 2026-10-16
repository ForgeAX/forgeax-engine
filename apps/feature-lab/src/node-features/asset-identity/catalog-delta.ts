import { buildCatalogResult } from '@forgeax/engine/import';
import { calculateCatalogDelta } from '@forgeax/engine/pack/build';
import { defineFeature } from '../../lab/feature';
import { withFixture } from './support/fixture';

const PACKAGE = '0190a1b2-0000-7000-8000-00000000b101';
type Rows = Awaited<ReturnType<typeof buildCatalogResult>>['entries'];

const pack = (assets: Readonly<Record<string, unknown>>) =>
  JSON.stringify({ schemaVersion: '3.0.0', packageId: PACKAGE, assets });
const sampler = (magFilter: string) => ({ kind: 'sampler', payload: { magFilter }, refs: [] });

async function rows(assets: Readonly<Record<string, unknown>>): Promise<Rows> {
  return withFixture(
    { 'lab.pack.json': pack(assets) },
    async (root) => (await buildCatalogResult([root])).entries,
  );
}

const keyOf = (items: Rows) => items.map((row) => row.sourceKey ?? row.guid).sort();

export default defineFeature({
  title: 'Catalog delta',
  catalog: 'Catalog delta',
  kind: 'headless',
  summary:
    'calculateCatalogDelta derives added/changed/removed facts between complete Catalog projections.',
  expect:
    'Identical projections yield no delta; edits classify by GUID; broken revision windows degrade with no identity rows.',
  async run(checks) {
    const before = await rows({ a: sampler('linear'), b: sampler('linear') });
    const after = await rows({ a: sampler('nearest'), c: sampler('linear') });
    checks.equal(
      'identical projections yield no delta',
      calculateCatalogDelta(before, before),
      undefined,
    );

    const delta = calculateCatalogDelta(before, after);
    checks.equal('added row is c', keyOf(delta?.added ?? []), ['c']);
    checks.equal('changed row is a', keyOf(delta?.changed ?? []), ['a']);
    const removedGuid = before.find((row) => row.sourceKey === 'b')?.guid.toLowerCase();
    checks.equal(
      'removed carries only the GUID of b',
      delta?.removed,
      removedGuid === undefined ? [] : [removedGuid],
    );
    checks.ok(
      'delta carries rows, not decoded payloads',
      (delta?.added[0] as { payload?: unknown } | undefined)?.payload === undefined,
    );

    const window = (baseline: number, current: number) => ({
      baseline: [{ rootId: 'lab', revision: baseline }],
      current: [{ rootId: 'lab', revision: current }],
    });
    const next = calculateCatalogDelta(before, after, window(1, 2));
    checks.equal(
      'baseline+1 is authoritative',
      [next?.authority, next?.diagnostics?.length],
      ['authoritative', 0],
    );
    const skipped = calculateCatalogDelta(before, after, window(1, 3));
    checks.equal(
      'skipped revision degrades with empty identity rows',
      [
        skipped?.authority,
        skipped?.diagnostics?.[0]?.code,
        skipped?.added.length,
        skipped?.removed.length,
      ],
      ['degraded', 'catalog-revision-conflict', 0, 0],
    );
    const stale = calculateCatalogDelta(before, after, window(2, 1));
    checks.equal(
      'older revision is stale',
      stale?.diagnostics?.[0]?.code,
      'catalog-revision-stale',
    );
    const unchanged = calculateCatalogDelta(before, after, window(2, 2));
    checks.equal(
      'changes without a revision bump conflict',
      unchanged?.diagnostics?.[0]?.code,
      'catalog-revision-conflict',
    );
  },
});
