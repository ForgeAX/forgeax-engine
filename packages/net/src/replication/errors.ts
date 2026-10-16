export type NetErrorDetailByCode = {
  'handshake-profile-mismatch': {
    readonly localFingerprint: string;
    readonly remoteFingerprint: string;
  };
  'decode-invalid-payload': { readonly reason: string };
  'decode-limit-exceeded': {
    readonly limit: string;
    readonly actual: number;
    readonly maximum: number;
  };
  'ordering-invalid-tick': { readonly receivedTick: number; readonly lastTick: number };
  'identity-invalid': { readonly id: number; readonly reason: string };
  'schema-invalid': { readonly component: string; readonly reason: string };
  'remap-unresolved-reference': { readonly id: number; readonly referencedId: number };
  'apply-invariant-failed': { readonly reason: string };
  'protocol-unsupported-version': {
    readonly receivedVersion: number;
    readonly supportedVersion: number;
  };
  'session-illegal-transition': {
    readonly from: string;
    readonly to: string;
  };
  'recovery-policy-invalid': {
    readonly field: string;
    readonly reason: string;
  };
  'recovery-rejected': { readonly reason: string };
  'session-capacity-exceeded': {
    readonly peerId: number;
    readonly attachedPeers: number;
    readonly maxSessions: number;
  };
  'ack-retry-exhausted': {
    readonly peerId: number;
    readonly sessionId: number;
    readonly epoch: number;
    readonly sequence: number;
    readonly retries: number;
    readonly maxRetries: number;
  };
  'recovery-exhausted': {
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly deadlineMs?: number;
  };
};

export type NetErrorCode = keyof NetErrorDetailByCode;
export type NetErrorDetailFor<C extends NetErrorCode> = NetErrorDetailByCode[C];
export type NetErrorDetail = NetErrorDetailFor<NetErrorCode>;

class NetErrorClass extends Error {
  readonly code: NetErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: NetErrorDetail;
  constructor(args: {
    code: NetErrorCode;
    expected: string;
    hint: string;
    detail: NetErrorDetail;
  }) {
    super(`[NetError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'NetError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

type Variant<C extends NetErrorCode> = NetErrorClass & {
  readonly code: C;
  readonly detail: NetErrorDetailFor<C>;
};

export type NetError = {
  [C in NetErrorCode]: Variant<C>;
}[NetErrorCode];

interface NetErrorConstructor {
  new <C extends NetErrorCode>(args: {
    code: C;
    expected: string;
    hint: string;
    detail: NetErrorDetailFor<C>;
  }): Variant<C>;
  readonly prototype: NetErrorClass;
}
export const NetError: NetErrorConstructor = NetErrorClass as unknown as NetErrorConstructor;
