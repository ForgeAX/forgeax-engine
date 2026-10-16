export type CarrierPhase = 'offered' | 'leased' | 'started' | 'exited' | 'expired' | 'fallback';

export type CarrierErrorCode =
  | 'carrier-consumer-mismatch'
  | 'carrier-token-invalid'
  | 'carrier-offer-expired'
  | 'carrier-started'
  | 'carrier-exited'
  | 'carrier-lease-required'
  | 'carrier-payload-live-state'
  | 'carrier-descriptor-mismatch'
  | 'carrier-recipe-mismatch'
  | 'carrier-provider-exit'
  | 'carrier-capture-failed'
  | 'carrier-cleanup-failed';

export interface CarrierError {
  readonly code: CarrierErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface CarrierOffer {
  readonly schemaVersion: '1.0.0';
  readonly projectId: string;
  readonly consumerId: string;
  readonly offerId: string;
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly livenessToken: string;
  readonly expiresAt: number;
  readonly descriptorDigest?: string;
  readonly recipeDigest?: string;
  readonly state: 'offered';
}

export interface CarrierLease {
  readonly leaseId: string;
  readonly offerId: string;
  readonly consumerId: string;
  readonly state: 'leased';
}

export interface CarrierState {
  readonly state: CarrierPhase;
  readonly leaseId?: string;
}

export interface CarrierStateMachine {
  readonly offer: CarrierOffer;
  readonly lease: {
    (request: CarrierLeaseRequest): CarrierResult<CarrierLease>;
    (leaseId: string, request: CarrierLeaseRequest): CarrierResult<CarrierLease>;
  };
  readonly started: (leaseId: string) => CarrierResult<CarrierState>;
  readonly exit: (leaseId: string) => CarrierResult<CarrierState>;
  readonly fallback: () => CarrierResult<CarrierState>;
  readonly snapshot: () => CarrierState;
}

export interface CarrierLeaseRequest {
  readonly consumerId: string;
  readonly bearerToken: string;
  readonly now: number;
  readonly descriptorDigest?: string;
  readonly recipeDigest?: string;
}

export type CarrierResult<T> =
  | { readonly ok: true; readonly value: T; readonly state: CarrierPhase }
  | { readonly ok: false; readonly error: CarrierError };

export interface CarrierStateMachineOptions {
  readonly projectId: string;
  readonly consumerId: string;
  readonly endpoint: string;
  readonly now: number;
  readonly ttlMs: number;
  readonly payload?: unknown;
  readonly descriptorDigest?: string;
  readonly recipeDigest?: string;
}

function token(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function carrierError(
  code: CarrierErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CarrierError {
  return { code, expected, hint, detail };
}

function containsLiveKey(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsLiveKey(entry, seen));
  return Object.entries(value).some(([key, nested]) => {
    if (
      ['world', 'renderer', 'canvas', 'ui', 'profile', 'liveHandle', 'context', 'fiber'].includes(
        key,
      )
    )
      return true;
    return containsLiveKey(nested, seen);
  });
}

function validateOptions(options: CarrierStateMachineOptions): void {
  if (options.projectId.length === 0 || options.consumerId.length === 0) {
    throw new TypeError('carrier projectId and consumerId must not be empty');
  }
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) {
    throw new TypeError('carrier endpoint must be loopback HTTP');
  }
  if (!Number.isFinite(options.now) || !Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new TypeError('carrier clock and ttl must be finite and positive');
  }
  if (containsLiveKey(options.payload)) throw new TypeError('carrier-payload-live-state');
}

export function createCarrierStateMachine(
  options: CarrierStateMachineOptions,
): CarrierStateMachine {
  validateOptions(options);
  const offer: CarrierOffer = {
    schemaVersion: '1.0.0',
    projectId: options.projectId,
    consumerId: options.consumerId,
    offerId: `offer:${token()}`,
    endpoint: options.endpoint,
    bearerToken: token(),
    livenessToken: token(),
    expiresAt: options.now + options.ttlMs,
    ...(options.descriptorDigest === undefined
      ? {}
      : { descriptorDigest: options.descriptorDigest }),
    ...(options.recipeDigest === undefined ? {} : { recipeDigest: options.recipeDigest }),
    state: 'offered',
  };
  let state: CarrierState = { state: 'offered' };
  let lease: CarrierLease | undefined;

  const leaseOffer = (
    requestOrId: CarrierLeaseRequest | string,
    maybeRequest?: CarrierLeaseRequest,
  ): CarrierResult<CarrierLease> => {
    const request = typeof requestOrId === 'string' ? maybeRequest : requestOrId;
    const requestedLeaseId = typeof requestOrId === 'string' ? requestOrId : undefined;
    if (request === undefined) {
      return {
        ok: false,
        error: carrierError(
          'carrier-token-invalid',
          'a complete lease request',
          'Provide consumer identity, bearer token, and current time.',
          {},
        ),
      };
    }
    if (state.state === 'started') {
      return {
        ok: false,
        error: carrierError(
          'carrier-started',
          'a started carrier not to be retried',
          'Report one terminal failure and clean up the existing started lease.',
          {},
        ),
      };
    }
    if (state.state === 'exited') {
      return {
        ok: false,
        error: carrierError(
          'carrier-exited',
          'an exited carrier not to be retried',
          'Re-run the operation from a serialized snapshot instead of migrating live state.',
          {},
        ),
      };
    }
    if (request.consumerId !== offer.consumerId) {
      return {
        ok: false,
        error: carrierError(
          'carrier-consumer-mismatch',
          'the offer consumer identity to match',
          'Use the consumer identity that was authenticated for this project offer.',
          { expected: offer.consumerId, actual: request.consumerId },
        ),
      };
    }
    if (request.bearerToken !== offer.bearerToken) {
      return {
        ok: false,
        error: carrierError(
          'carrier-token-invalid',
          'the bearer token to match the ephemeral offer',
          'Request a fresh visible offer; never persist or guess bearer tokens.',
          {},
        ),
      };
    }
    if (
      offer.descriptorDigest !== undefined &&
      request.descriptorDigest !== offer.descriptorDigest
    ) {
      return {
        ok: false,
        error: carrierError(
          'carrier-descriptor-mismatch',
          'the descriptor digest to match the authenticated offer',
          'Refresh the descriptor and request a new visible offer before retrying.',
          { expected: offer.descriptorDigest, actual: request.descriptorDigest },
        ),
      };
    }
    if (offer.recipeDigest !== undefined && request.recipeDigest !== offer.recipeDigest) {
      return {
        ok: false,
        error: carrierError(
          'carrier-recipe-mismatch',
          'the recipe digest to match the authenticated offer',
          'Serialize the current snapshot and request a fresh visible offer before retrying.',
          { expected: offer.recipeDigest, actual: request.recipeDigest },
        ),
      };
    }
    if (request.now >= offer.expiresAt) {
      state = { state: 'expired' };
      return {
        ok: false,
        error: carrierError(
          'carrier-offer-expired',
          'the offer to be within its expiry window',
          'Fall back to the ordinary visible carrier before retrying.',
          { expiresAt: offer.expiresAt, now: request.now },
        ),
      };
    }
    if (requestedLeaseId !== undefined && requestedLeaseId !== lease?.leaseId) {
      return {
        ok: false,
        error: carrierError(
          'carrier-token-invalid',
          'the lease id to match the authenticated offer',
          'Use the lease id returned by the first successful lease.',
          {},
        ),
      };
    }
    lease = {
      leaseId: `lease:${token()}`,
      offerId: offer.offerId,
      consumerId: request.consumerId,
      state: 'leased',
    };
    state = { state: 'leased', leaseId: lease.leaseId };
    return { ok: true, value: lease, state: 'leased' };
  };

  const started = (leaseId: string): CarrierResult<CarrierState> => {
    if (lease?.leaseId !== leaseId) {
      return {
        ok: false,
        error: carrierError(
          'carrier-lease-required',
          'a valid lease before started',
          'Lease the authenticated offer before reporting provider started.',
          {},
        ),
      };
    }
    state = { state: 'started', leaseId };
    return { ok: true, value: state, state: 'started' };
  };

  const exit = (leaseId: string): CarrierResult<CarrierState> => {
    if (lease?.leaseId !== leaseId || state.state !== 'started') {
      return {
        ok: false,
        error: carrierError(
          'carrier-lease-required',
          'a started lease before provider exit',
          'Provider exit is terminal only after started has been acknowledged.',
          {},
        ),
      };
    }
    state = { state: 'exited', leaseId };
    return { ok: true, value: state, state: 'exited' };
  };

  const fallback = (): CarrierResult<CarrierState> => {
    if (state.state === 'started' || state.state === 'exited') {
      return {
        ok: false,
        error: carrierError(
          'carrier-started',
          'fallback to happen before provider started',
          'Do not retry or migrate a carrier after started; return its terminal failure.',
          { state: state.state },
        ),
      };
    }
    state = { state: 'fallback' };
    return { ok: true, value: state, state: 'fallback' };
  };

  return {
    offer,
    lease: leaseOffer,
    started,
    exit,
    fallback,
    snapshot: () => state,
  };
}
