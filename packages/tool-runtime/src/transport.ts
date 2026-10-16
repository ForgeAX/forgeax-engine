import { validateRealmBootstrapPayload } from './capability.js';
import type {
  CarrierLease,
  CarrierLeaseRequest,
  CarrierPhase,
  CarrierResult,
  CarrierState,
} from './carrier.js';
import type { JsonValue, ToolTerminal } from './types.js';

export interface CarrierTransport {
  readonly endpoint: string;
  readonly connected: boolean;
  readonly send: (payload: unknown) => boolean;
  readonly close: () => void;
}

export interface CarrierExecutionRequest {
  readonly leaseId: string;
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly args: unknown;
}

export interface AuthenticatedCarrierTransport {
  readonly endpoint: string;
  readonly connected: boolean;
  readonly lease: (request: CarrierLeaseRequest) => Promise<CarrierResult<CarrierLease>>;
  readonly started: (request: { readonly leaseId: string }) => Promise<CarrierResult<CarrierState>>;
  readonly execute: (request: CarrierExecutionRequest) => Promise<{
    readonly ok: true;
    readonly value: ToolTerminal<unknown>;
    readonly state: CarrierPhase;
  }>;
  readonly exit: (request: { readonly leaseId: string }) => Promise<CarrierResult<CarrierState>>;
  readonly close: () => void;
}

export interface AuthenticatedCarrierTransportOptions {
  readonly endpoint: string;
  readonly bearerToken: string;
}

export class CarrierTransportError extends Error {
  readonly code: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(error: {
    readonly code: string;
    readonly expected?: string;
    readonly hint?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
  }) {
    super(error.code);
    this.name = 'CarrierTransportError';
    this.code = error.code;
    if (error.expected !== undefined) this.expected = error.expected;
    if (error.hint !== undefined) this.hint = error.hint;
    if (error.detail !== undefined) this.detail = error.detail;
  }
}

export function createAuthenticatedCarrierTransport(
  options: AuthenticatedCarrierTransportOptions,
): AuthenticatedCarrierTransport {
  const url = new URL(options.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new TypeError('carrier transport endpoint must be loopback HTTP');
  if (options.bearerToken.length < 8) throw new TypeError('carrier bearer token is too short');
  let connected = true;
  async function request<T>(path: string, payload: unknown): Promise<T> {
    if (!connected)
      throw new CarrierTransportError({
        code: 'carrier-exited',
        expected: 'a connected carrier transport',
        hint: 'Request a fresh visible offer after provider exit.',
      });
    let response: Response;
    try {
      response = await fetch(`${options.endpoint}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      throw new CarrierTransportError({
        code: 'carrier-provider-exit',
        expected: 'the carrier provider to remain reachable',
        hint: 'Offer a fresh carrier; do not fallback after started.',
        detail: { cause: cause instanceof Error ? cause.message : String(cause) },
      });
    }
    const value: unknown = await response.json().catch(() => ({}));
    if (
      !response.ok ||
      typeof value !== 'object' ||
      value === null ||
      !('ok' in value) ||
      value.ok !== true
    ) {
      const error =
        typeof value === 'object' &&
        value !== null &&
        'error' in value &&
        typeof value.error === 'object' &&
        value.error !== null
          ? (value.error as Record<string, unknown>)
          : {
              code: 'carrier-provider-exit',
              expected: 'a successful carrier response',
              hint: 'Offer a fresh carrier and retry from a serialized snapshot.',
            };
      const normalized = {
        code: typeof error.code === 'string' ? error.code : 'carrier-provider-exit',
        ...(typeof error.expected === 'string' ? { expected: error.expected } : {}),
        ...(typeof error.hint === 'string' ? { hint: error.hint } : {}),
        ...(typeof error.detail === 'object' && error.detail !== null
          ? { detail: error.detail as Readonly<Record<string, unknown>> }
          : {}),
      };
      throw new CarrierTransportError(normalized);
    }
    return value as T;
  }
  return {
    endpoint: options.endpoint,
    get connected() {
      return connected;
    },
    lease: (payload) => request('/lease', payload),
    started: (payload) => request('/start', payload),
    execute: (payload) => request('/execute', payload),
    exit: (payload) => request('/exit', payload),
    close() {
      connected = false;
    },
  };
}

/** Minimal loopback transport seam; it carries POD only and owns no operation state. */
export function createLoopbackTransport(endpoint: string): CarrierTransport {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new TypeError('carrier transport endpoint must be loopback HTTP');
  }
  let connected = true;
  return {
    endpoint,
    get connected() {
      return connected;
    },
    send(payload) {
      if (!connected || !validateRealmBootstrapPayload(payload).ok) return false;
      return true;
    },
    close() {
      connected = false;
    },
  };
}

export interface ServiceWireRequest {
  readonly descriptorDigest: string;
  readonly recipeDigest: string;
  readonly args: JsonValue;
}

export type ServiceWireHandler = (
  request: ServiceWireRequest,
) => Promise<ToolTerminal<unknown>> | ToolTerminal<unknown>;

export interface AuthenticatedLoopbackTransport {
  readonly endpoint: string;
  readonly connected: boolean;
  readonly request: (
    request: ServiceWireRequest,
    bearerToken: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<ToolTerminal<unknown>>;
  readonly close: () => void;
}

export interface AuthenticatedLoopbackTransportOptions {
  readonly endpoint: string;
  readonly bearerToken: string;
}

export function createAuthenticatedLoopbackTransport(
  options: AuthenticatedLoopbackTransportOptions,
): AuthenticatedLoopbackTransport {
  const url = new URL(options.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new TypeError('service transport endpoint must be loopback HTTP');
  }
  if (options.bearerToken.length < 8) throw new TypeError('service bearer token is too short');
  let connected = true;
  return {
    endpoint: options.endpoint,
    get connected() {
      return connected;
    },
    async request(request, bearerToken, requestOptions = {}) {
      if (!connected) throw new Error('service transport is disconnected');
      if (bearerToken !== options.bearerToken) throw new Error('service bearer token rejected');
      if (!validateRealmBootstrapPayload(request).ok) {
        throw new Error('service request is not structured-clone safe');
      }
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const detail =
          typeof payload === 'object' && payload !== null && 'error' in payload
            ? String(payload.error)
            : `HTTP ${response.status}`;
        throw new Error(`service request failed: ${detail}`);
      }
      return payload as ToolTerminal<unknown>;
    },
    close() {
      connected = false;
    },
  };
}
