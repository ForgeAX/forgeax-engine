import { describe, expectTypeOf, it } from 'vitest';
import type { AssetRuntimeError, AssetRuntimeErrorCode } from '../errors/asset';

describe('AssetRuntimeErrorCode owner proof', () => {
  it('derives the exact closed code surface and narrows the correlated detail', () => {
    expectTypeOf<AssetRuntimeError>().toMatchTypeOf<{
      code: string;
      expected: string;
      hint: string;
    }>();
    expectTypeOf<AssetRuntimeErrorCode>().toEqualTypeOf<AssetRuntimeError['code']>();
    expectTypeOf<AssetRuntimeErrorCode>().toEqualTypeOf<
      | 'material-resolved-empty-passes'
      | 'mesh-ssbo-capacity-exceeded'
      | 'mesh-ssbo-ceiling-reached'
      | 'scene-collect-entity-ref-out-of-closure'
      | 'scene-collect-asset-guid-unresolved'
    >();

    const acceptAssetRuntimeErrorCode = (code: AssetRuntimeErrorCode): void => {
      void code;
    };
    acceptAssetRuntimeErrorCode('material-resolved-empty-passes');
    acceptAssetRuntimeErrorCode('mesh-ssbo-capacity-exceeded');
    acceptAssetRuntimeErrorCode('mesh-ssbo-ceiling-reached');
    acceptAssetRuntimeErrorCode('scene-collect-entity-ref-out-of-closure');
    acceptAssetRuntimeErrorCode('scene-collect-asset-guid-unresolved');
    // @ts-expect-error invalid codes must not be accepted.
    acceptAssetRuntimeErrorCode('not-an-asset-runtime-error');

    const exhaustiveAssetRuntimeErrorCode = (code: AssetRuntimeErrorCode): string => {
      switch (code) {
        case 'material-resolved-empty-passes':
          return code;
        case 'mesh-ssbo-capacity-exceeded':
          return code;
        case 'mesh-ssbo-ceiling-reached':
          return code;
        case 'scene-collect-entity-ref-out-of-closure':
          return code;
        case 'scene-collect-asset-guid-unresolved':
          return code;
        default: {
          const exhaustive: never = code;
          return exhaustive;
        }
      }
    };
    void exhaustiveAssetRuntimeErrorCode;

    const narrowAssetRuntimeError = (error: AssetRuntimeError): void => {
      if (error.code === 'material-resolved-empty-passes') {
        const materialGuid: string = error.detail.materialGuid;
        const reason: 'missing-parent' | 'no-pass-in-chain' = error.detail.reason;
        void materialGuid;
        void reason;
        // @ts-expect-error code-driven narrowing excludes unrelated detail fields.
        void error.detail.requested;
      }
    };
    void narrowAssetRuntimeError;
  });
});
