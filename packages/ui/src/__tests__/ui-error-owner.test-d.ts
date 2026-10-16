import type { ImportDiagnostic } from '@forgeax/engine-types';
import { expectTypeOf, test } from 'vitest';
import { uiError } from '../errors.js';
import type { UiError, UiErrorCode, UiResult } from '../index.js';

type ExpectedUiErrorCode =
  | 'inspection-failed'
  | 'ui-resource-invalid'
  | 'invalid-environment'
  | 'invalid-root'
  | 'invalid-asset'
  | 'invalid-layer'
  | 'invalid-preview-rect'
  | 'preview-invalid-transition'
  | 'preview-disposed'
  | 'preview-stale-completion'
  | 'preview-load-failed'
  | 'preview-scenario-failed'
  | 'preview-scenario-missing-part'
  | 'preview-scenario-timeout'
  | 'capture-not-ready'
  | 'capture-failed';

expectTypeOf<UiErrorCode>().toEqualTypeOf<ExpectedUiErrorCode>();
expectTypeOf<UiErrorCode>().toEqualTypeOf<UiError['code']>();
expectTypeOf(uiError).parameter(0).toEqualTypeOf<UiErrorCode>();
expectTypeOf(uiError).parameter(1).toEqualTypeOf<string>();
expectTypeOf(uiError).returns.toEqualTypeOf<UiResult<never>>();

test('rejects a code outside the exact public vocabulary', () => {
  // @ts-expect-error Unknown UI error codes are not assignable.
  const invalidCode: UiErrorCode = 'ui-code-does-not-exist';
  void invalidCode;
});

test('narrows representative detail payloads by code', () => {
  const readDetail = (error: UiError): string => {
    switch (error.code) {
      case 'inspection-failed':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly message: string;
          readonly cause?: unknown;
        }>();
        return error.detail.message;
      case 'invalid-layer':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly message: string;
          readonly layer: number;
        }>();
        return `${error.detail.message}:${error.detail.layer}`;
      case 'preview-invalid-transition':
      case 'preview-disposed':
      case 'preview-stale-completion':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly message: string;
          readonly state: string;
        }>();
        return `${error.detail.message}:${error.detail.state}`;
      case 'preview-load-failed':
        expectTypeOf(error.detail).toEqualTypeOf<{
          readonly message: string;
          readonly guid: string;
          readonly diagnostics?: readonly ImportDiagnostic[];
        }>();
        return `${error.detail.message}:${error.detail.guid}`;
      default:
        return error.detail.message;
    }
  };

  void readDetail;
});
