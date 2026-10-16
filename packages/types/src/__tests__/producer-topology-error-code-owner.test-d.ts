import { describe, expectTypeOf, it } from 'vitest';
import type {
  ProducerContractErrorCode,
  SourceOverrideErrorCode,
  TopologyConflictReason,
} from '../index';

describe('producer topology error-code ownership', () => {
  it('keeps TopologyConflictReason as the exact three-literal owner', () => {
    expectTypeOf<TopologyConflictReason>().toEqualTypeOf<
      'duplicate-source-key' | 'missing-source-key' | 'source-index-ambiguous'
    >();
  });

  it('derives the exact nine-member producer contract surface', () => {
    expectTypeOf<ProducerContractErrorCode>().toEqualTypeOf<
      | SourceOverrideErrorCode
      | TopologyConflictReason
      | 'invalid-source-key'
      | 'invalid-source-index'
      | 'invalid-producer-fact'
    >();
    expectTypeOf<TopologyConflictReason>().toExtend<ProducerContractErrorCode>();
    expectTypeOf<'not-a-producer-error'>().not.toExtend<ProducerContractErrorCode>();
  });

  it('accepts every topology reason and supports exhaustive narrowing', () => {
    function asProducerErrorCode(reason: TopologyConflictReason): ProducerContractErrorCode {
      return reason;
    }

    function describeProducerCode(code: ProducerContractErrorCode): string {
      switch (code) {
        case 'duplicate-source-key':
        case 'missing-source-key':
        case 'source-index-ambiguous':
        case 'unknown-source-key':
        case 'invalid-source-overrides':
        case 'invalid-source-override-payload':
        case 'invalid-source-key':
        case 'invalid-source-index':
        case 'invalid-producer-fact':
          return code;
      }
      const exhaustive: never = code;
      return exhaustive;
    }

    expectTypeOf(asProducerErrorCode).returns.toEqualTypeOf<ProducerContractErrorCode>();
    expectTypeOf(describeProducerCode).returns.toBeString();
  });
});
