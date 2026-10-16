import { describe, expectTypeOf, it } from 'vitest';
import type {
  CatalogDelta,
  CatalogEntry,
  CatalogEntryV2,
  CatalogLifecycle,
  CatalogProjection,
  CatalogSubject,
  CookExecution,
} from '../catalog.js';

describe('Catalog v2 POD contract', () => {
  it('uses packageUrl as the only package navigation field', () => {
    const entry = null as unknown as CatalogEntry;

    expectTypeOf(entry.guid).toEqualTypeOf<string>();
    expectTypeOf(entry.packageUrl).toEqualTypeOf<string>();
    expectTypeOf(entry.kind).toEqualTypeOf<string>();
    expectTypeOf(entry.sourcePath).toEqualTypeOf<string>();
    expectTypeOf(entry.cookReceiptUrl).toEqualTypeOf<string | undefined>();
  });

  it('does not expose content facts or legacy navigation fields', () => {
    expectTypeOf<'packageUrl' extends keyof CatalogEntry ? true : false>().toEqualTypeOf<true>();
    expectTypeOf<'metadata' extends keyof CatalogEntry ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'compression' extends keyof CatalogEntry ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'artifacts' extends keyof CatalogEntry ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<
      'contentEncoding' extends keyof CatalogEntry ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<'assetCodec' extends keyof CatalogEntry ? true : false>().toEqualTypeOf<false>();
  });

  it('keeps GUID changes neutral and keyed by the new entry shape', () => {
    type EntryGuid = CatalogEntry['guid'];
    type RemovedGuid = CatalogDelta['removed'][number];

    expectTypeOf<CatalogDelta['added']>().toEqualTypeOf<readonly CatalogEntry[]>();
    expectTypeOf<CatalogDelta['changed']>().toEqualTypeOf<readonly CatalogEntry[]>();
    expectTypeOf<RemovedGuid>().toEqualTypeOf<EntryGuid>();
  });

  it('exposes the three axes as closed, machine-readable fields', () => {
    expectTypeOf<CatalogSubject>().toEqualTypeOf<'internal-asset' | 'imported-output'>();
    expectTypeOf<CookExecution>().toEqualTypeOf<'direct' | 'cooked'>();
    expectTypeOf<CatalogLifecycle>().toEqualTypeOf<
      'missing' | 'cooking' | 'current' | 'stale' | 'failed'
    >();
    expectTypeOf<CatalogProjection>().toHaveProperty('subject');
    expectTypeOf<CatalogProjection>().toHaveProperty('execution');
    expectTypeOf<CatalogProjection>().toHaveProperty('lifecycle');
  });

  it('makes the runtime publication tuple part of one canonical row', () => {
    expectTypeOf<CatalogEntryV2['scopeId']>().toBeString();
    expectTypeOf<CatalogEntryV2['generation']>().toEqualTypeOf<number>();
    expectTypeOf<CatalogEntryV2['digest']>().toBeString();
    expectTypeOf<CatalogEntryV2['outputSetDigest']>().toBeString();
  });
});
