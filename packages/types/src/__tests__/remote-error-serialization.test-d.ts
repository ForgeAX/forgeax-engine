import { describe, expectTypeOf, it } from 'vitest';
import type {
  EvalResultNotSerializableDetail,
  RemoteError,
  RemoteErrorCode,
  RemoteErrorDetail,
} from '../index';

describe('remote eval result serialization error contract', () => {
  it('adds one closed code and keeps detail bounded to result shape', () => {
    expectTypeOf<RemoteErrorCode>().toEqualTypeOf<
      | 'script-syntax-error'
      | 'script-runtime-error'
      | 'server-startup-failed'
      | 'server-not-running'
      | 'eval-result-not-serializable'
    >();
    expectTypeOf<EvalResultNotSerializableDetail>().toMatchTypeOf<RemoteErrorDetail>();
    expectTypeOf<RemoteError['detail']>().toEqualTypeOf<RemoteErrorDetail | undefined>();
  });

  it('keeps the result-shape union exhaustively classifiable', () => {
    function describeShape(shape: EvalResultNotSerializableDetail['shape']): string {
      switch (shape) {
        case 'bigint':
          return 'bigint';
        case 'cyclic-object':
          return 'cyclic-object';
        case 'unsupported':
          return 'unsupported';
      }
    }

    expectTypeOf(describeShape).returns.toEqualTypeOf<string>();
  });
});
