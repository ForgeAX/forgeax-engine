import { err, type ResultErr } from '@forgeax/engine-types';

interface Details {
  'platform-unavailable': { readonly operation: string };
  'platform-disposed': { readonly operation: string };
  'platform-clock-invalid': { readonly previous: number | undefined; readonly current: number };
  'platform-display-invalid': { readonly cause: unknown };
  'platform-operation-failed': {
    readonly operation: string;
    readonly cause: unknown;
    readonly cleanupCause?: unknown;
  };
}

export type PlatformErrorCode = keyof Details;
export type PlatformError = {
  [C in PlatformErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: Details[C];
  };
}[PlatformErrorCode];

const guidance: { readonly [C in PlatformErrorCode]: readonly [string, string] } = {
  'platform-unavailable': [
    'the selected realm provides the requested native operation',
    'select a qualified host implementation or enable the named host capability',
  ],
  'platform-disposed': [
    'the platform lease is live',
    'create a new platform instance; do not reuse callbacks from a retired instance',
  ],
  'platform-clock-invalid': [
    'native time is finite, non-negative and monotonic after conversion to milliseconds',
    'check the host clock units and lifetime; a failed clock must not advance the World',
  ],
  'platform-display-invalid': [
    'display dimensions are finite and non-negative and pixelRatio is positive',
    'inspect the native display facts before configuring a rendering surface',
  ],
  'platform-operation-failed': [
    'the native host operation completes successfully',
    'inspect detail.operation and detail.cause, then recover the owning host resource',
  ],
};

export function platformError<C extends PlatformErrorCode>(
  code: C,
  detail: Details[C],
): ResultErr<PlatformError> {
  const [expected, hint] = guidance[code];
  return err({ code, expected, hint, detail } as PlatformError);
}
