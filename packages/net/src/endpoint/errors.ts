// @forgeax/engine-net -- endpoint structured errors.
//
// Closed union of transport-level failures. Each variant carries .code, .expected,
// .hint, and per-code .detail. AI users exhaustively switch on .code without a
// default branch (requirements AC-13).

import type { PeerId } from './endpoint';

// ---------------------------------------------------------------------------
// EndpointErrorCode -- closed 5-member union derived from the detail contract
// ---------------------------------------------------------------------------

/** Transport-level endpoint error codes (requirements AC-02, AC-13). */
export type EndpointErrorCode = keyof EndpointErrorDetailByCode;

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

/** The code-to-detail contract also closes the runtime policy table. */
interface EndpointErrorDetailByCode {
  'peer-not-found': EndpointDetailPeerNotFound;
  'connection-closed': EndpointDetailConnectionClosed;
  'send-failed': EndpointDetailSendFailed;
  'already-closed': EndpointDetailAlreadyClosed;
  'connection-failed': EndpointDetailConnectionFailed;
}

export type EndpointErrorDetailFor<C extends EndpointErrorCode> = EndpointErrorDetailByCode[C];

type EndpointErrorArgs<C extends EndpointErrorCode = EndpointErrorCode> = {
  [Code in C]: {
    code: Code;
    detail: EndpointErrorDetailFor<Code>;
  };
}[C];

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

  constructor(args: EndpointErrorArgs) {
    const { expected, hint } = endpointErrorPolicy[args.code];
    let suffix = '';
    if (args.code === 'peer-not-found') {
      suffix = ` (peerId=${args.detail.peerId})`;
    } else if (args.code === 'connection-closed') {
      suffix = ` (peerId=${args.detail.peerId})`;
    } else if (args.code === 'send-failed') {
      suffix = ` (peerId=${args.detail.peerId}, cause=${args.detail.cause})`;
    } else if (args.code === 'already-closed') {
      suffix = ` (cause=${args.detail.cause})`;
    } else if (args.code === 'connection-failed') {
      suffix = ` (address=${args.detail.address}, cause=${args.detail.cause})`;
    }
    super(`[EndpointError ${args.code}] expected: ${expected}; hint: ${hint}${suffix}`);
    this.name = 'EndpointError';
    this.code = args.code;
    this.expected = expected;
    this.hint = hint;
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
  new <C extends EndpointErrorCode>(args: EndpointErrorArgs<C>): EndpointErrorVariant<C>;
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
    hint: 'the connection is broken; the peer may have disconnected or the buffer is full',
  },
  'already-closed': {
    expected: 'the endpoint must be open for any operation',
    hint: 'the endpoint is closed; create a new endpoint for further communication',
  },
  'connection-failed': {
    expected:
      'the endpoint factory must successfully establish a connection or bind to the listen address',
    hint: 'the initial connection or bind failed; verify the address is reachable and the port is not in use, then retry',
  },
} satisfies Record<EndpointErrorCode, EndpointErrorPolicy>;

/** Type guard for narrowing unknown to EndpointError. */
export function isEndpointError(err: unknown): err is EndpointError {
  return err instanceof EndpointErrorClass;
}
