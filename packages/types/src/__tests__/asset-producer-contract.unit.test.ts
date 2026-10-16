import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AssetRelation,
  CatalogDiagnostic,
  CatalogDiagnosticSeverity,
  CatalogEntry,
  ProducerContractDiagnostic,
  ProviderProvenance,
  ResourceRevision,
} from '../index.js';

describe('asset producer contract POD', () => {
  it('keeps producer facts separate from locator fields', () => {
    expectTypeOf<CatalogEntry['packageId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CatalogEntry['sourceKey']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CatalogEntry['sourceIndex']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<CatalogEntry['sourcePath']>().toEqualTypeOf<string>();
    expectTypeOf<CatalogEntry['packageUrl']>().toEqualTypeOf<string>();
  });

  it('exposes complete producer fact fields as neutral PODs', () => {
    expectTypeOf<ProviderProvenance>().toHaveProperty('provider');
    expectTypeOf<ProviderProvenance>().toHaveProperty('version');
    expectTypeOf<ResourceRevision>().toHaveProperty('digest');
    expectTypeOf<ResourceRevision>().toHaveProperty('observedAt');
    expectTypeOf<AssetRelation>().toHaveProperty('from');
    expectTypeOf<AssetRelation>().toHaveProperty('to');
    expectTypeOf<CatalogDiagnostic>().toHaveProperty('code');
    expectTypeOf<CatalogDiagnostic>().toHaveProperty('severity');
    expectTypeOf<ProducerContractDiagnostic>().toHaveProperty('subject');
    expectTypeOf<ProducerContractDiagnostic>().toHaveProperty('expected');
    expectTypeOf<ProducerContractDiagnostic>().toHaveProperty('hint');
  });

  it('uses open strings for provider kinds and diagnostic severities', () => {
    const severity: CatalogDiagnosticSeverity = 'blocking';
    const provider: ProviderProvenance = { provider: 'host-fixture', version: '1' };
    expect(severity).toBe('blocking');
    expectTypeOf(provider.provider).toEqualTypeOf<string>();
  });
});
