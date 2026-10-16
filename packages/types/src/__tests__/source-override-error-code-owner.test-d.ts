import { describe, expectTypeOf, it } from 'vitest';
import type { ImportErrorCode, ProducerContractErrorCode, SourceOverrideErrorCode } from '../index';

describe('source-override error-code ownership', () => {
  it('keeps SourceOverrideErrorCode as the exact four-literal owner', () => {
    expectTypeOf<SourceOverrideErrorCode>().toEqualTypeOf<
      | 'unknown-source-key'
      | 'duplicate-source-key'
      | 'invalid-source-overrides'
      | 'invalid-source-override-payload'
    >();
  });

  it('derives both domain supersets without losing their specific members', () => {
    expectTypeOf<ImportErrorCode>().toEqualTypeOf<
      | SourceOverrideErrorCode
      | 'importer-not-registered'
      | 'source-read-failed'
      | 'import-produced-no-assets'
      | 'guid-mismatch'
      | 'mesh-material-slot-topology-change'
      | 'mesh-lod-contract-invalid'
      | 'mesh-lod-topology-change'
      | 'mesh-lod-authority-conflict'
      | 'import-internal-error'
      | 'source-validation-failed'
    >();
    expectTypeOf<ProducerContractErrorCode>().toEqualTypeOf<
      | SourceOverrideErrorCode
      | 'missing-source-key'
      | 'source-index-ambiguous'
      | 'invalid-source-key'
      | 'invalid-source-index'
      | 'invalid-producer-fact'
    >();
    expectTypeOf<SourceOverrideErrorCode>().toExtend<ImportErrorCode>();
    expectTypeOf<SourceOverrideErrorCode>().toExtend<ProducerContractErrorCode>();
    expectTypeOf<'not-an-import-error'>().not.toExtend<ImportErrorCode>();
    expectTypeOf<'not-a-producer-error'>().not.toExtend<ProducerContractErrorCode>();
  });

  it('supports exhaustive consumption of both public supersets', () => {
    function describeImportCode(code: ImportErrorCode): string {
      switch (code) {
        case 'importer-not-registered':
        case 'source-read-failed':
        case 'import-produced-no-assets':
        case 'guid-mismatch':
        case 'mesh-material-slot-topology-change':
        case 'mesh-lod-contract-invalid':
        case 'mesh-lod-topology-change':
        case 'mesh-lod-authority-conflict':
        case 'import-internal-error':
        case 'source-validation-failed':
        case 'unknown-source-key':
        case 'duplicate-source-key':
        case 'invalid-source-overrides':
        case 'invalid-source-override-payload':
          return code;
      }
      const exhaustive: never = code;
      return exhaustive;
    }

    function describeProducerCode(code: ProducerContractErrorCode): string {
      switch (code) {
        case 'missing-source-key':
        case 'duplicate-source-key':
        case 'unknown-source-key':
        case 'invalid-source-overrides':
        case 'invalid-source-override-payload':
        case 'source-index-ambiguous':
        case 'invalid-source-key':
        case 'invalid-source-index':
        case 'invalid-producer-fact':
          return code;
      }
      const exhaustive: never = code;
      return exhaustive;
    }

    expectTypeOf(describeImportCode).returns.toBeString();
    expectTypeOf(describeProducerCode).returns.toBeString();
  });
});
