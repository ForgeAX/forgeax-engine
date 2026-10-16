import type { ActivityId } from './types';

export type IntelligenceErrorCode =
  | 'intelligence-invalid-request'
  | 'intelligence-session-provider-mismatch'
  | 'intelligence-capacity-exceeded'
  | 'intelligence-activity-not-found'
  | 'intelligence-provider-failed'
  | 'intelligence-output-overflow'
  | 'intelligence-closed';

export interface IntelligenceErrorDetailMap {
  readonly 'intelligence-invalid-request': { readonly field: 'input'; readonly reason: string };
  readonly 'intelligence-session-provider-mismatch': {
    readonly expectedProviderId: string;
    readonly receivedProviderId: string;
  };
  readonly 'intelligence-capacity-exceeded': { readonly limit: number };
  readonly 'intelligence-activity-not-found': { readonly activityId: ActivityId };
  readonly 'intelligence-provider-failed': { readonly providerId: string; readonly cause: unknown };
  readonly 'intelligence-output-overflow': {
    readonly activityId: ActivityId;
    readonly bound: 'output-chars' | 'pending-events';
    readonly limit: number;
  };
  readonly 'intelligence-closed': Readonly<Record<string, never>>;
}

export type IntelligenceErrorDetailFor<C extends IntelligenceErrorCode> =
  IntelligenceErrorDetailMap[C];

const policy = {
  'intelligence-invalid-request': {
    expected: 'activity input must be a non-empty string within the configured bound',
    hint: 'validate and bound player input before submitting the activity',
  },
  'intelligence-session-provider-mismatch': {
    expected: 'a session reference must be resumed by the provider that created it',
    hint: 'discard the incompatible session or select its original provider',
  },
  'intelligence-capacity-exceeded': {
    expected: 'active intelligence work must remain within the configured concurrency bound',
    hint: 'wait for an activity to finish or raise the explicit provider capacity',
  },
  'intelligence-activity-not-found': {
    expected: 'the activity must still be running when cancellation is requested',
    hint: 'ignore an already observed terminal activity or retain the correct ActivityId',
  },
  'intelligence-provider-failed': {
    expected: 'the selected provider must complete or report a structured failure',
    hint: 'inspect detail.cause and provider configuration, then retry or select another provider',
  },
  'intelligence-output-overflow': {
    expected: 'incremental and final output must remain within configured queue and text bounds',
    hint: 'consume events every frame or raise the explicit bound for this application',
  },
  'intelligence-closed': {
    expected: 'the intelligence service must be open for submit and cancel operations',
    hint: 'create a new service after its Cordis realm or owner has been disposed',
  },
} satisfies Record<IntelligenceErrorCode, { readonly expected: string; readonly hint: string }>;

export const INTELLIGENCE_EXPECTED = Object.fromEntries(
  Object.entries(policy).map(([code, value]) => [code, value.expected]),
) as Readonly<Record<IntelligenceErrorCode, string>>;

export const INTELLIGENCE_ERROR_HINTS = Object.fromEntries(
  Object.entries(policy).map(([code, value]) => [code, value.hint]),
) as Readonly<Record<IntelligenceErrorCode, string>>;

class IntelligenceErrorClass extends Error {
  readonly code: IntelligenceErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: IntelligenceErrorDetailFor<IntelligenceErrorCode>;

  constructor(args: {
    code: IntelligenceErrorCode;
    detail: IntelligenceErrorDetailFor<IntelligenceErrorCode>;
  }) {
    const selected = policy[args.code];
    super(
      `[IntelligenceError ${args.code}] expected: ${selected.expected}; hint: ${selected.hint}`,
    );
    this.name = 'IntelligenceError';
    this.code = args.code;
    this.expected = selected.expected;
    this.hint = selected.hint;
    this.detail = args.detail;
  }
}

type IntelligenceErrorVariant<C extends IntelligenceErrorCode> = IntelligenceErrorClass & {
  readonly code: C;
  readonly detail: IntelligenceErrorDetailFor<C>;
};

export type IntelligenceError = {
  [C in IntelligenceErrorCode]: IntelligenceErrorVariant<C>;
}[IntelligenceErrorCode];

interface IntelligenceErrorConstructor {
  new <C extends IntelligenceErrorCode>(args: {
    code: C;
    detail: IntelligenceErrorDetailFor<C>;
  }): IntelligenceErrorVariant<C>;
  readonly prototype: IntelligenceErrorClass;
}

export const IntelligenceError: IntelligenceErrorConstructor =
  IntelligenceErrorClass as unknown as IntelligenceErrorConstructor;

type PodDetailMap = Omit<IntelligenceErrorDetailMap, 'intelligence-provider-failed'> & {
  readonly 'intelligence-provider-failed': { readonly providerId: string; readonly cause: string };
};

export type IntelligenceFailure = {
  [C in IntelligenceErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: PodDetailMap[C];
  };
}[IntelligenceErrorCode];

export function intelligenceFailure(error: IntelligenceError): IntelligenceFailure {
  if (error.code === 'intelligence-provider-failed') {
    return {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: {
        providerId: error.detail.providerId,
        cause:
          error.detail.cause instanceof Error
            ? error.detail.cause.message
            : String(error.detail.cause),
      },
    };
  }
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  } as IntelligenceFailure;
}

export function providerError(providerId: string, cause: unknown): IntelligenceError {
  return new IntelligenceError({
    code: 'intelligence-provider-failed',
    detail: { providerId, cause },
  });
}
