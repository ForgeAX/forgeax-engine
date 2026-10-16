import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableAdapterRecoveryFailure } from '../recovery-contract.mjs';

test('retryable adapter recovery uses the canonical acquire-adapter phase', () => {
  assert.equal(
    isRetryableAdapterRecoveryFailure({ phase: 'acquire-adapter', retryable: true }),
    true,
  );
  assert.equal(isRetryableAdapterRecoveryFailure({ phase: 'adapter', retryable: true }), false);
  assert.equal(
    isRetryableAdapterRecoveryFailure({ phase: 'acquire-adapter', retryable: false }),
    false,
  );
});
