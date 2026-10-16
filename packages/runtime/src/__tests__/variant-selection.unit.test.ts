import { describe, expect, it } from 'vitest';
import { variantSetFromDefines } from '../../../render/src/record/helpers';

describe('material pass variant selection', () => {
  it('uses the manifest key order without mutating the pass map', () => {
    const defines = {
      STORAGE_BUFFER_AVAILABLE: 'true',
      M3_MULTI_UV_VARIANT: 'false',
    };

    expect(variantSetFromDefines(defines)).toBe(
      'M3_MULTI_UV_VARIANT=false+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(Object.keys(defines)).toEqual(['STORAGE_BUFFER_AVAILABLE', 'M3_MULTI_UV_VARIANT']);
  });

  it('leaves an omitted or empty pass selection on the capability path', () => {
    expect(variantSetFromDefines(undefined)).toBeUndefined();
    expect(variantSetFromDefines({})).toBeUndefined();
  });
});
