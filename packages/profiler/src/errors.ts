import type { ProfileResult, ProfileSource } from './types.js';

/** Structured profiler failure with a code-specific detail payload. */
export type ProfilerError =
  | {
      readonly code: 'capture-boundary-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly frameLimit: unknown; readonly eventLimit: unknown };
    }
  | {
      readonly code: 'capture-already-active';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly captureId: string };
    }
  | {
      readonly code: 'profiler-not-enabled';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly enabled: false };
    }
  | {
      readonly code: 'phase-catalog-conflict';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly source: ProfileSource;
        readonly expected: readonly string[];
        readonly actual: readonly string[];
      };
    }
  | {
      readonly code: 'profile-source-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: {
        readonly source: string;
        readonly phase: string;
        readonly frameId: number;
      };
    }
  | {
      readonly code: 'profile-sink-failed';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly message: string };
    }
  | {
      readonly code: 'capture-state-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: { readonly operation: string };
    };

/** Closed expected-failure vocabulary derived from the public profiler error owner. */
export type ProfilerErrorCode = ProfilerError['code'];

/** Result shape returned by profiler operations. */
export type ProfilerResult<T> = ProfileResult<T, ProfilerError>;

export function boundaryError(frameLimit: unknown, eventLimit: unknown): ProfilerError {
  return {
    code: 'capture-boundary-invalid',
    expected: 'positive safe integer frameLimit and eventLimit',
    hint: 'Retry with finite positive safe integer limits.',
    detail: { frameLimit, eventLimit },
  };
}

export function stateError(operation: string): ProfilerError {
  return {
    code: 'capture-state-invalid',
    expected: 'an open capture session in the required phase state',
    hint: 'Finish the open phase or frame before continuing, then retry the operation.',
    detail: { operation },
  };
}
