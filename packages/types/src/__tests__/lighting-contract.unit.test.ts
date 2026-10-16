import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Asset, Handle, IesProfileAsset, TagOf } from '../index';

describe('lighting asset contract', () => {
  it('keeps IesProfileAsset closed and exact', () => {
    const profile = {
      kind: 'ies-profile',
      data: new Uint8Array(256 * 128 * 2),
    } satisfies IesProfileAsset;
    const asset: Asset = profile;

    expect(asset.kind).toBe('ies-profile');
    expect(profile.data.byteLength).toBe(256 * 128 * 2);
    expectTypeOf<TagOf<IesProfileAsset>>().toEqualTypeOf<'IesProfileAsset'>();
    expectTypeOf<Handle<'IesProfileAsset', 'shared'>>().toEqualTypeOf<
      Handle<'IesProfileAsset', 'shared'>
    >();
  });
});
