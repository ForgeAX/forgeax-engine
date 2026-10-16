import type {
  NetError,
  NetRecoverySnapshot,
  NetSession,
  NetSessionFailure,
  NetSessionState,
  SessionId,
} from '@forgeax/engine-net';
import { expectTypeOf } from 'vitest';
import type { createClientWithEndpoint } from '../client';

type ConsumerSessionSurface = {
  readonly session: NetSession;
  readonly sessionId: SessionId;
  readonly getRecoverySnapshot: () => NetRecoverySnapshot;
  readonly dispose: () => void;
};

type CommandDeliverySurface = {
  readonly sendToAuthority: (sessionId: SessionId, data: Uint8Array) => unknown;
  readonly sendToSession: (sessionId: SessionId, data: Uint8Array) => unknown;
};

function lifecycleLabel(state: NetSessionState): string {
  switch (state.kind) {
    case 'connecting':
      return state.kind;
    case 'resyncing':
      return `${state.kind}:${state.epoch}`;
    case 'active':
      return `${state.kind}:${state.epoch}:${state.sequence}`;
    case 'recovering':
      return `${state.kind}:${state.attempt}`;
    case 'failed':
      return `${state.kind}:${state.error.code}`;
    case 'retired':
      return `${state.kind}:${state.reason}`;
  }
}

function failureHint(failure: NetSessionFailure): string {
  switch (failure.code) {
    case 'peer-not-found':
    case 'connection-closed':
    case 'send-failed':
    case 'already-closed':
    case 'connection-failed':
    case 'handshake-profile-mismatch':
    case 'decode-invalid-payload':
    case 'decode-limit-exceeded':
    case 'ordering-invalid-tick':
    case 'identity-invalid':
    case 'schema-invalid':
    case 'remap-unresolved-reference':
    case 'apply-invariant-failed':
    case 'protocol-unsupported-version':
    case 'session-illegal-transition':
    case 'recovery-policy-invalid':
    case 'recovery-rejected':
    case 'recovery-exhausted':
    case 'ack-retry-exhausted':
    case 'session-capacity-exceeded':
      return failure.hint;
  }
}

expectTypeOf<
  Awaited<ReturnType<typeof createClientWithEndpoint>>
>().toMatchTypeOf<ConsumerSessionSurface>();
expectTypeOf<NetSession>().toMatchTypeOf<CommandDeliverySurface>();
expectTypeOf<NetRecoverySnapshot['sessionId']>().toEqualTypeOf<SessionId>();
expectTypeOf<NetRecoverySnapshot['state']>().toEqualTypeOf<NetSessionState>();
expectTypeOf<NetError['code']>().toEqualTypeOf<NetError['code']>();
expectTypeOf(lifecycleLabel).parameter(0).toEqualTypeOf<NetSessionState>();
expectTypeOf(failureHint).parameter(0).toEqualTypeOf<NetSessionFailure>();
