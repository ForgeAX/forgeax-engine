// @forgeax/engine-net -- endpoint structured errors.
//
// Closed union of transport-level failures. Each variant carries .code, .expected,
// .hint, and per-code .detail. AI users exhaustively switch on .code without a
// default branch (requirements AC-13).

import type { PeerId } from './endpoint';

// ---------------------------------------------------------------------------
// EndpointErrorCode -- closed 5-member union derived from endpointErrorPolicy
// ---------------------------------------------------------------------------

/** Transport-level endpoint error codes (requirements AC-02, AC-13). */
export type EndpointErrorCode = keyof typeof endpointErrorPolicy;

// ---------------------------------------------------------------------------
// Per-code detail payloads
// ---------------------------------------------------------------------------

export interface EndpointDetailPeerNotFound {
  readonly peerId: PeerId;
}

export interface EndpointDetailConnectionClosed {
  readonly peerId: PeerId;
}

export interface EndpointDetailSendFailed {
  readonly peerId: PeerId;
  readonly cause: string;
}

export interface EndpointDetailAlreadyClosed {
  readonly cause: string;
}

export interface EndpointDetailConnectionFailed {
  readonly address: string;
  readonly cause: string;
}

// ---------------------------------------------------------------------------
// Conditional resolver
// ---------------------------------------------------------------------------

export type EndpointErrorDetailFor<C extends EndpointErrorCode> = C extends 'peer-not-found'
  ? EndpointDetailPeerNotFound
  : C extends 'connection-closed'
    ? EndpointDetailConnectionClosed
    : C extends 'send-failed'
      ? EndpointDetailSendFailed
      : C extends 'already-closed'
        ? EndpointDetailAlreadyClosed
        : C extends 'connection-failed'
          ? EndpointDetailConnectionFailed
          : never;

/** Tagged union of all endpoint error detail variants. */
export type EndpointErrorDetail = EndpointErrorDetailFor<EndpointErrorCode>;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

class EndpointErrorClass extends Error {
  readonly code: EndpointErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: EndpointErrorDetail;

  constructor(args: {
    code: EndpointErrorCode;
    expected: string;
    hint: string;
    detail: EndpointErrorDetail;
  }) {
    let suffix = '';
    if (args.code === 'peer-not-found') {
      const d = args.detail as EndpointDetailPeerNotFound;
      suffix = ` (peerId=${d.peerId})`;
    } else if (args.code === 'connection-closed') {
      const d = args.detail as EndpointDetailConnectionClosed;
      suffix = ` (peerId=${d.peerId})`;
    } else if (args.code === 'send-failed') {
      const d = args.detail as EndpointDetailSendFailed;
      suffix = ` (peerId=${d.peerId}, cause=${d.cause})`;
    } else if (args.code === 'already-closed') {
      const d = args.detail as EndpointDetailAlreadyClosed;
      suffix = ` (cause=${d.cause})`;
    } else if (args.code === 'connection-failed') {
      const d = args.detail as EndpointDetailConnectionFailed;
      suffix = ` (address=${d.address}, cause=${d.cause})`;
    }
    super(`[EndpointError ${args.code}] expected: ${args.expected}; hint: ${args.hint}${suffix}`);
    this.name = 'EndpointError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

type EndpointErrorVariant<C extends EndpointErrorCode> = EndpointErrorClass & {
  readonly code: C;
  readonly detail: EndpointErrorDetailFor<C>;
};

export type EndpointError = {
  [C in EndpointErrorCode]: EndpointErrorVariant<C>;
}[EndpointErrorCode];

interface EndpointErrorConstructor {
  new <C extends EndpointErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: EndpointErrorDetailFor<C>;
  }): EndpointErrorVariant<C>;
  readonly prototype: EndpointErrorClass;
}

export const EndpointError: EndpointErrorConstructor =
  EndpointErrorClass as unknown as EndpointErrorConstructor;

type EndpointErrorPolicy = { readonly expected: string; readonly hint: string };

const endpointErrorPolicy = {
  'peer-not-found': {
    expected: 'the target peer must exist in the current connection set',
    hint: 'verify the PeerId is from a connect event; check that the peer has not disconnected',
  },
  'connection-closed': {
    expected: 'the peer connection must be alive for the operation',
    hint: 'the peer disconnected; poll for a disconnect event and handle the lifecycle',
  },
  'send-failed': {
    expected: 'message bytes must be delivered to the target peer or the connection must fail',
    hint: 'the memory connection is broken; the peer may have disconnected or the buffer is full',
  },
  'already-closed': {
    expected: 'the endpoint must be open for any operation',
    hint: 'the endpoint is closed; create a new endpoint pair for further communication',
  },
  'connection-failed': {
    expected:
      'the endpoint factory must successfully establish a connection or bind to the listen address',
    hint: 'the initial connection or bind failed; verify the address is reachable and the port is not in use, then retry',
  },
} satisfies Record<string, EndpointErrorPolicy>;

/** Expected-invariant table per error code. */
export const ENDPOINT_EXPECTED: Readonly<Record<EndpointErrorCode, string>> = Object.fromEntries(
  Object.entries(endpointErrorPolicy).map(([code, policy]) => [code, policy.expected]),
) as Readonly<Record<EndpointErrorCode, string>>;

/** Actionable hint table per error code. */
export const ENDPOINT_ERROR_HINTS: Readonly<Record<EndpointErrorCode, string>> = Object.fromEntries(
  Object.entries(endpointErrorPolicy).map(([code, policy]) => [code, policy.hint]),
) as Readonly<Record<EndpointErrorCode, string>>;

/** Type guard for narrowing unknown to EndpointError. */
export function isEndpointError(err: unknown): err is EndpointError {
  return err instanceof EndpointErrorClass;
}
