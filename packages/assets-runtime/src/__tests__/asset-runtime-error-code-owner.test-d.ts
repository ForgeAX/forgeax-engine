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
      | 'mesh-ssbo-ceiling-reached'
      | 'scene-collect-entity-ref-out-of-closure'
      | 'scene-collect-asset-guid-unresolved'
    >();

    const acceptAssetRuntimeErrorCode = (code: AssetRuntimeErrorCode): void => {
      void code;
    };
    acceptAssetRuntimeErrorCode('mesh-ssbo-ceiling-reached');
    acceptAssetRuntimeErrorCode('scene-collect-entity-ref-out-of-closure');
    acceptAssetRuntimeErrorCode('scene-collect-asset-guid-unresolved');
    // @ts-expect-error invalid codes must not be accepted.
    acceptAssetRuntimeErrorCode('not-an-asset-runtime-error');

    const exhaustiveAssetRuntimeErrorCode = (code: AssetRuntimeErrorCode): string => {
      switch (code) {
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
      if (error.code === 'scene-collect-entity-ref-out-of-closure') {
        const entity: number = error.detail.entity;
        const field: string = error.detail.field;
        void entity;
        void field;
        // @ts-expect-error code-driven narrowing excludes unrelated detail fields.
        void error.detail.requested;
      }
    };
    void narrowAssetRuntimeError;
  });
});
