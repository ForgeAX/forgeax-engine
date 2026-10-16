import { err, ok, type Result } from '@forgeax/engine-types';
import type { NetEndpointConnector } from '../endpoint/endpoint';
import type { EndpointError } from '../endpoint/errors';
import { NetError, type NetErrorCode } from '../replication/errors';

declare const sessionIdBrand: unique symbol;

/** Authority-issued application identity; it is distinct from transport PeerId. */
export type SessionId = number & { readonly [sessionIdBrand]: true };

export type NetSessionStateKind = NetSessionState['kind'];

export type NetSessionFailure = NetError | EndpointError;

/** Public lifecycle state owned by one logical session. */
export type NetSessionState =
  | { readonly kind: 'connecting'; readonly sessionId: SessionId }
  | { readonly kind: 'resyncing'; readonly sessionId: SessionId; readonly epoch: number }
  | {
      readonly kind: 'active';
      readonly sessionId: SessionId;
      readonly epoch: number;
      readonly sequence: number;
    }
  | {
      readonly kind: 'recovering';
      readonly sessionId: SessionId;
      readonly epoch: number;
      readonly attempt: number;
    }
  | {
      readonly kind: 'failed';
      readonly sessionId: SessionId;
      readonly error: NetSessionFailure;
    }
  | {
      readonly kind: 'retired';
      readonly sessionId: SessionId;
      readonly reason: 'disposed' | 'terminal-failure';
    };

export interface NetRecoveryPolicy {
  readonly maxSessions: number;
  readonly maxPendingPackets: number;
  readonly ackTimeoutMs: number;
  readonly maxPacketRetries: number;
  readonly maxReconnectAttempts: number;
  readonly reconnectDeadlineMs: number;
  readonly reconnectDelaysMs: readonly number[];
}

/** Finite, deterministic recovery bounds shared by every transport adapter. */
export const DEFAULT_NET_RECOVERY_POLICY: NetRecoveryPolicy = Object.freeze({
  maxSessions: 64,
  maxPendingPackets: 32,
  ackTimeoutMs: 250,
  maxPacketRetries: 3,
  maxReconnectAttempts: 5,
  reconnectDeadlineMs: 10_000,
  reconnectDelaysMs: Object.freeze([0, 100, 200, 400, 800]),
});

function policyError(field: string, reason: string): NetError {
  return new NetError({
    code: 'recovery-policy-invalid',
    expected: 'finite positive recovery policy bounds',
    hint: 'provide positive safe integers and a finite non-negative delay sequence',
    detail: { field, reason },
  });
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Validate a complete policy without mutating it. */
export function validateNetRecoveryPolicy(policy: NetRecoveryPolicy): Result<void, NetError> {
  const positiveFields: readonly (keyof Omit<NetRecoveryPolicy, 'reconnectDelaysMs'>)[] = [
    'maxSessions',
    'maxPendingPackets',
    'ackTimeoutMs',
    'maxPacketRetries',
    'maxReconnectAttempts',
    'reconnectDeadlineMs',
  ];
  for (const field of positiveFields) {
    if (!isPositiveSafeInteger(policy[field]))
      return err(policyError(field, 'value must be a positive safe integer'));
  }
  if (
    !Array.isArray(policy.reconnectDelaysMs) ||
    policy.reconnectDelaysMs.length === 0 ||
    policy.reconnectDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)
  )
    return err(
      policyError('reconnectDelaysMs', 'values must be a non-empty finite delay sequence'),
    );
  return ok(undefined);
}

/** Merge caller overrides with the bounded defaults and validate the result. */
export function resolveNetRecoveryPolicy(
  overrides: Partial<NetRecoveryPolicy> = {},
): Result<NetRecoveryPolicy, NetError> {
  const policy: NetRecoveryPolicy = {
    ...DEFAULT_NET_RECOVERY_POLICY,
    ...overrides,
    reconnectDelaysMs:
      overrides.reconnectDelaysMs === undefined
        ? DEFAULT_NET_RECOVERY_POLICY.reconnectDelaysMs
        : [...overrides.reconnectDelaysMs],
  };
  const valid = validateNetRecoveryPolicy(policy);
  return valid.ok ? ok(Object.freeze(policy)) : err(valid.error);
}

/** Create a positive application identity without allowing plain numbers to cross the seam. */
export function createSessionId(value: number): Result<SessionId, NetError> {
  if (!isPositiveSafeInteger(value))
    return err(
      new NetError({
        code: 'recovery-policy-invalid',
        expected: 'a positive safe integer SessionId',
        hint: 'use the authority-issued application session identity',
        detail: { field: 'sessionId', reason: 'SessionId must be a positive safe integer' },
      }),
    );
  return ok(value as SessionId);
}

/** Observable bounded accounting for one logical recovery session. */
export interface NetRecoverySnapshot {
  readonly sessionId: SessionId;
  readonly state: NetSessionState;
  readonly pendingPackets: number;
  readonly maxPendingPackets: number;
  readonly acknowledgedSequence: number;
  readonly reconnectAttempts: number;
  readonly epoch: number;
  readonly sequence: number;
  readonly ownedResources: {
    readonly pendingConnects: number;
    readonly timers: number;
    readonly ledgers: number;
    readonly callbacks: number;
  };
  readonly lastError?: NetSessionFailure;
}

/** Stable result kinds for repeated recovery requests. */
export type NetRecoveryOutcome =
  | { readonly kind: 'started'; readonly sessionId: SessionId }
  | { readonly kind: 'already-recovering'; readonly sessionId: SessionId }
  | { readonly kind: 'already-active'; readonly sessionId: SessionId }
  | { readonly kind: 'retired'; readonly sessionId: SessionId };

const LEGAL_TRANSITIONS: Readonly<Record<NetSessionStateKind, readonly NetSessionStateKind[]>> = {
  connecting: ['recovering', 'resyncing', 'failed', 'retired'],
  resyncing: ['active', 'recovering', 'failed', 'retired'],
  active: ['active', 'recovering', 'failed', 'retired'],
  recovering: ['recovering', 'resyncing', 'failed', 'retired'],
  failed: ['retired'],
  retired: ['retired'],
};

/** `failed` and `retired` own no further transport work; only retirement may follow. */
export function isTerminalNetSessionState(state: Pick<NetSessionState, 'kind'>): boolean {
  return state.kind === 'failed' || state.kind === 'retired';
}

export function isLegalNetSessionTransition(
  from: NetSessionStateKind,
  to: NetSessionStateKind,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Validate an immutable state replacement before a session publishes it. */
export function transitionNetSessionState(
  from: NetSessionState,
  to: NetSessionState,
): Result<NetSessionState, NetError> {
  if (from.sessionId !== to.sessionId || !isLegalNetSessionTransition(from.kind, to.kind))
    return err(
      new NetError({
        code: 'session-illegal-transition',
        expected: 'a legal transition for the same SessionId',
        hint: 'wait for the current session state or retire the session before replacing it',
        detail: { from: from.kind, to: to.kind },
      }),
    );
  return ok(to);
}

export type { NetEndpointConnector };

export const RECOVERY_ERROR_CODES: readonly NetErrorCode[] = [
  'protocol-unsupported-version',
  'session-illegal-transition',
  'recovery-policy-invalid',
  'recovery-rejected',
  'recovery-exhausted',
];
