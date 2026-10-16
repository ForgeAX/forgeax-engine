import type { CodecError, CodecErrorCode, CodecResult } from '@forgeax/engine-codec';
import { codecError } from '@forgeax/engine-codec';
import { describe, expectTypeOf, it } from 'vitest';

describe('CodecError code/detail correlation', () => {
  it('accepts every existing code with its matching detail payload', () => {
    codecError('decompression-failed', { reason: 'reason' });
    codecError('codec-init-failed', { stage: 'stage' });
    codecError('ktx2-parse-failed', { reason: 'reason' });
    codecError('ktx2-unsupported-scheme', { scheme: 3 });
    codecError('transcode-failed', {
      sourceFormat: 'uastc-ldr',
      targetFormat: 'bc7-rgba-unorm',
    });
    codecError('ktx2-encode-failed', { mode: 'uastc-ldr', reason: 'reason' });
  });

  it('narrows detail from the checked code', () => {
    function assertNarrowing(error: CodecError): void {
      switch (error.error.code) {
        case 'decompression-failed':
          expectTypeOf(error.error.detail.reason).toBeString();
          break;
        case 'codec-init-failed':
          expectTypeOf(error.error.detail.stage).toBeString();
          break;
        case 'ktx2-parse-failed':
          expectTypeOf(error.error.detail.reason).toBeString();
          break;
        case 'ktx2-unsupported-scheme':
          expectTypeOf(error.error.detail.scheme).toBeNumber();
          break;
        case 'transcode-failed':
          expectTypeOf(error.error.detail.sourceFormat).toBeString();
          expectTypeOf(error.error.detail.targetFormat).toBeString();
          break;
        case 'ktx2-encode-failed':
          expectTypeOf(error.error.detail.mode).toBeString();
          expectTypeOf(error.error.detail.reason).toBeString();
          break;
      }
    }

    assertNarrowing(codecError('decompression-failed', { reason: 'reason' }));
  });

  it('rejects a detail belonging to a different code', () => {
    // @ts-expect-error -- ktx2-unsupported-scheme accepts `{ scheme }`, not `{ reason }`.
    codecError('ktx2-unsupported-scheme', { reason: 'wrong-detail' });
  });

  it('preserves the six-code public union and structural Result compatibility', () => {
    expectTypeOf<CodecErrorCode>().toEqualTypeOf<
      | 'decompression-failed'
      | 'codec-init-failed'
      | 'ktx2-parse-failed'
      | 'ktx2-unsupported-scheme'
      | 'transcode-failed'
      | 'ktx2-encode-failed'
    >();

    const failure: CodecResult<Uint8Array> = codecError('ktx2-parse-failed', {
      reason: 'reason',
    });
    expectTypeOf(failure).toMatchTypeOf<CodecResult<Uint8Array>>();
  });
});
