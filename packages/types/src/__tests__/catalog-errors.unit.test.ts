import { describe, expect, expectTypeOf, it } from 'vitest';
import { ASSET_ERROR_HINTS, AssetError, type AssetErrorCode } from '../index';

describe('catalog source errors', () => {
  it('keeps an unconfigured source distinct and exhaustively discoverable', () => {
    expectTypeOf<'catalog-source-unconfigured'>().toMatchTypeOf<AssetErrorCode>();
    expectTypeOf(ASSET_ERROR_HINTS).toEqualTypeOf<Readonly<Record<AssetErrorCode, string>>>();
  });

  it('supplies a structured recovery error', () => {
    const error = new AssetError({
      code: 'catalog-source-unconfigured',
      expected: 'a configured catalog source',
      hint: ASSET_ERROR_HINTS['catalog-source-unconfigured'],
    });

    expect(error.code).toBe('catalog-source-unconfigured');
    expect(error.expected).toContain('catalog source');
    expect(error.hint).toContain('setCatalogSource');
  });
});
