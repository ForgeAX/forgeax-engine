// Error variants intersect the backing class. Check detail assignability in both
// directions so equivalent intersection representations retain exact contracts.
declare const error: NetErrorType;
import { expectTypeOf, test } from 'vitest';
import { NetError } from '../src/index';
import type { NetError as NetErrorType, NetErrorCode, NetErrorDetailFor } from '../src/index';

test('recovery errors preserve code-specific detail inference', () => {
  const unsupported = new NetError({
    code: 'protocol-unsupported-version',
    expected: 'protocol version 2',
    hint: 'upgrade the peer before sending replicated bytes',
    detail: { receivedVersion: 1, supportedVersion: 2 },
  });
  const transition = new NetError({
    code: 'session-illegal-transition',
    expected: 'a legal session transition',
    hint: 'wait for the current state before requesting recovery',
    detail: { from: 'active', to: 'connecting' },
  });
  expectTypeOf(unsupported.detail).toMatchTypeOf<NetErrorDetailFor<'protocol-unsupported-version'>>();
  expectTypeOf<NetErrorDetailFor<'protocol-unsupported-version'>>().toMatchTypeOf<typeof unsupported.detail>();
  expectTypeOf(transition.detail).toMatchTypeOf<NetErrorDetailFor<'session-illegal-transition'>>();
  expectTypeOf<NetErrorDetailFor<'session-illegal-transition'>>().toMatchTypeOf<typeof transition.detail>();
});

test('all public error codes and details remain exhaustively narrowable', () => {
  const describe = (current: NetErrorType): string => {
    switch (current.code) {
      case 'handshake-profile-mismatch':
        return current.detail.localFingerprint;
      case 'decode-invalid-payload':
        return current.detail.reason;
      case 'decode-limit-exceeded':
        return `${current.detail.limit}:${current.detail.actual}/${current.detail.maximum}`;
      case 'ordering-invalid-tick':
        return `${current.detail.receivedTick}:${current.detail.lastTick}`;
      case 'identity-invalid':
        return `${current.detail.id}:${current.detail.reason}`;
      case 'schema-invalid':
        return `${current.detail.component}:${current.detail.reason}`;
      case 'remap-unresolved-reference':
        return `${current.detail.id}:${current.detail.referencedId}`;
      case 'apply-invariant-failed':
        return current.detail.reason;
      case 'protocol-unsupported-version':
        return `${current.detail.receivedVersion}:${current.detail.supportedVersion}`;
      case 'session-illegal-transition':
        return `${current.detail.from}:${current.detail.to}`;
      case 'recovery-policy-invalid':
        return current.detail.field;
      case 'recovery-rejected':
        return current.detail.reason;
      case 'recovery-exhausted':
        return `${current.detail.attempts}/${current.detail.maxAttempts}`;
      case 'ack-retry-exhausted':
        return `${current.detail.peerId}:${current.detail.retries}/${current.detail.maxRetries}`;
      case 'session-capacity-exceeded':
        return `${current.detail.peerId}:${current.detail.attachedPeers}/${current.detail.maxSessions}`;
    }
  };

  expectTypeOf(error.code).toEqualTypeOf<NetErrorCode>();
  expectTypeOf(describe).returns.toEqualTypeOf<string>();
});

