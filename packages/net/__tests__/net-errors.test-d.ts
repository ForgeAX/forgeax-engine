// Error variants intersect the backing class. Check detail assignability in both
// directions so equivalent intersection representations retain exact contracts.
import { expectTypeOf } from 'vitest';
import { NetError } from '../src/replication/errors';
import type { NetError as NetErrorType, NetErrorCode, NetErrorDetail } from '../src/replication/errors';

declare const error: NetErrorType;

switch (error.code) {
  case 'handshake-profile-mismatch':
    expectTypeOf(error.detail.localFingerprint).toEqualTypeOf<string>();
    expectTypeOf(error.detail.remoteFingerprint).toEqualTypeOf<string>();
    break;
  case 'decode-invalid-payload':
    expectTypeOf(error.detail).toMatchTypeOf<{ readonly reason: string }>();
    expectTypeOf<{ readonly reason: string }>().toMatchTypeOf<typeof error.detail>();
    break;
  case 'decode-limit-exceeded':
    expectTypeOf(error.detail.limit).toEqualTypeOf<string>();
    expectTypeOf(error.detail.actual).toEqualTypeOf<number>();
    expectTypeOf(error.detail.maximum).toEqualTypeOf<number>();
    break;
  case 'ordering-invalid-tick':
    expectTypeOf(error.detail.receivedTick).toEqualTypeOf<number>();
    expectTypeOf(error.detail.lastTick).toEqualTypeOf<number>();
    break;
  case 'identity-invalid':
    expectTypeOf(error.detail.id).toEqualTypeOf<number>();
    expectTypeOf(error.detail.reason).toEqualTypeOf<string>();
    break;
  case 'schema-invalid':
    expectTypeOf(error.detail.component).toEqualTypeOf<string>();
    expectTypeOf(error.detail.reason).toEqualTypeOf<string>();
    break;
  case 'remap-unresolved-reference':
    expectTypeOf(error.detail.id).toEqualTypeOf<number>();
    expectTypeOf(error.detail.referencedId).toEqualTypeOf<number>();
    break;
  case 'apply-invariant-failed':
    expectTypeOf(error.detail).toMatchTypeOf<{ readonly reason: string }>();
    expectTypeOf<{ readonly reason: string }>().toMatchTypeOf<typeof error.detail>();
    break;
}

new NetError({
  code: 'handshake-profile-mismatch',
  expected: 'matching profiles',
  hint: 'use the same profile',
  detail: { localFingerprint: 'local', remoteFingerprint: 'remote' },
});
new NetError({
  code: 'decode-invalid-payload',
  expected: 'valid payload',
  hint: 'send valid bytes',
  detail: { reason: 'invalid JSON' },
});
new NetError({
  code: 'decode-limit-exceeded',
  expected: 'payload within limits',
  hint: 'reduce the payload',
  detail: { limit: 'maxBytes', actual: 2, maximum: 1 },
});
new NetError({
  code: 'ordering-invalid-tick',
  expected: 'a newer tick',
  hint: 'discard stale data',
  detail: { receivedTick: 1, lastTick: 2 },
});
new NetError({
  code: 'identity-invalid',
  expected: 'a valid identity',
  hint: 'use a session identity',
  detail: { id: 0, reason: 'zero identity' },
});
new NetError({
  code: 'schema-invalid',
  expected: 'a selected component',
  hint: 'use selected components',
  detail: { component: 'Position', reason: 'unselected component' },
});
new NetError({
  code: 'remap-unresolved-reference',
  expected: 'a resolvable reference',
  hint: 'include the referenced entity',
  detail: { id: 1, referencedId: 2 },
});
new NetError({
  code: 'apply-invariant-failed',
  expected: 'valid ECS state',
  hint: 'create a new session',
  detail: { reason: 'stopped' },
});

new NetError({
  code: 'identity-invalid',
  expected: 'a valid identity',
  hint: 'use a session identity',
  // @ts-expect-error code/detail pairs remain correlated even when their fields overlap.
  detail: { component: 'Position', reason: 'wrong detail for this code' },
});

function describe(error: NetErrorType): string {
  switch (error.code) {
    case 'handshake-profile-mismatch':
      return `${error.detail.localFingerprint}:${error.detail.remoteFingerprint}`;
    case 'decode-invalid-payload':
      return `decode:${error.detail.reason}`;
    case 'decode-limit-exceeded':
      return `${error.detail.limit}:${error.detail.actual}/${error.detail.maximum}`;
    case 'ordering-invalid-tick':
      return `${error.detail.receivedTick}:${error.detail.lastTick}`;
    case 'identity-invalid':
      return `${error.detail.id}:${error.detail.reason}`;
    case 'schema-invalid':
      return `${error.detail.component}:${error.detail.reason}`;
    case 'remap-unresolved-reference':
      return `${error.detail.id}:${error.detail.referencedId}`;
    case 'apply-invariant-failed':
      return `apply:${error.detail.reason}`;
    case 'protocol-unsupported-version':
      return `${error.detail.receivedVersion}:${error.detail.supportedVersion}`;
    case 'session-illegal-transition':
      return `${error.detail.from}:${error.detail.to}`;
    case 'recovery-policy-invalid':
      return `${error.detail.field}:${error.detail.reason}`;
    case 'recovery-rejected':
      return error.detail.reason;
    case 'recovery-exhausted':
      return `${error.detail.attempts}/${error.detail.maxAttempts}`;
    case 'ack-retry-exhausted':
      return `${error.detail.peerId}:${error.detail.retries}/${error.detail.maxRetries}`;
    case 'session-capacity-exceeded':
      return `${error.detail.peerId}:${error.detail.attachedPeers}/${error.detail.maxSessions}`;
  }
}

expectTypeOf(describe).returns.toEqualTypeOf<string>();

expectTypeOf<NetErrorCode>().toEqualTypeOf<
  | 'handshake-profile-mismatch'
  | 'decode-invalid-payload'
  | 'decode-limit-exceeded'
  | 'ordering-invalid-tick'
  | 'identity-invalid'
  | 'schema-invalid'
  | 'remap-unresolved-reference'
  | 'apply-invariant-failed'
  | 'protocol-unsupported-version'
  | 'session-illegal-transition'
  | 'recovery-policy-invalid'
  | 'recovery-rejected'
  | 'recovery-exhausted'
  | 'ack-retry-exhausted'
  | 'session-capacity-exceeded'
>();

expectTypeOf<NetErrorDetail>().toEqualTypeOf<
  | { readonly localFingerprint: string; readonly remoteFingerprint: string }
  | { readonly reason: string }
  | { readonly limit: string; readonly actual: number; readonly maximum: number }
  | { readonly receivedTick: number; readonly lastTick: number }
  | { readonly id: number; readonly reason: string }
  | { readonly component: string; readonly reason: string }
  | { readonly id: number; readonly referencedId: number }
  | { readonly receivedVersion: number; readonly supportedVersion: number }
  | { readonly from: string; readonly to: string }
  | { readonly field: string; readonly reason: string }
  | { readonly attempts: number; readonly maxAttempts: number; readonly deadlineMs?: number }
  | { readonly peerId: number; readonly sessionId: number; readonly epoch: number; readonly sequence: number; readonly retries: number; readonly maxRetries: number }
  | { readonly peerId: number; readonly attachedPeers: number; readonly maxSessions: number }
>();
