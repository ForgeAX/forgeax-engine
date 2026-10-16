import { describe, expectTypeOf, it } from 'vitest';
import type { AssetCodec, AssetCodecFailureDetail } from '../asset.js';

describe('AssetCodec container ownership', () => {
  it('keeps the exact ktx2 | basis membership on the optional owner', () => {
    type Container = NonNullable<AssetCodec['container']>;

    expectTypeOf<AssetCodec['container']>().toEqualTypeOf<'ktx2' | 'basis' | undefined>();
    expectTypeOf<Container>().toEqualTypeOf<'ktx2' | 'basis'>();
    expectTypeOf<'ktx2'>().toExtend<Container>();
    expectTypeOf<'basis'>().toExtend<Container>();
    expectTypeOf<'other'>().not.toExtend<Container>();
  });

  it('derives the required failure projection from the optional owner in both directions', () => {
    type Container = NonNullable<AssetCodec['container']>;

    expectTypeOf<AssetCodecFailureDetail['container']>().toExtend<Container>();
    expectTypeOf<Container>().toExtend<AssetCodecFailureDetail['container']>();
  });

  it('preserves optional codec and required failure-detail property semantics', () => {
    type Container = NonNullable<AssetCodec['container']>;

    expectTypeOf<Pick<AssetCodec, 'container'>>().toEqualTypeOf<{
      readonly container?: Container;
    }>();
    expectTypeOf<Pick<AssetCodecFailureDetail, 'container'>>().toEqualTypeOf<{
      readonly container: Container;
    }>();
  });
});
