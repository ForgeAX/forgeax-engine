import { describe, expectTypeOf, it } from 'vitest';
import type { CatalogDelta, CatalogEntry } from '../index';

describe('Catalog POD contract', () => {
  it('publishes a stable entry identity and neutral catalog fields', () => {
    const entry = null as unknown as CatalogEntry;

    expectTypeOf(entry.guid).toEqualTypeOf<string>();
    expectTypeOf(entry.kind).toEqualTypeOf<string>();
    expectTypeOf(entry.packageUrl).toEqualTypeOf<string>();
  });

  it('keeps each GUID in exactly one delta collection', () => {
    type EntryGuid = CatalogEntry['guid'];
    type RemovedGuid = CatalogDelta['removed'][number];

    expectTypeOf<CatalogDelta['added']>().toEqualTypeOf<readonly CatalogEntry[]>();
    expectTypeOf<CatalogDelta['changed']>().toEqualTypeOf<readonly CatalogEntry[]>();
    expectTypeOf<RemovedGuid>().toEqualTypeOf<EntryGuid>();
  });
});
