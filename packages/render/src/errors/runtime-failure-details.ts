export interface RuntimeFailureDetails {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: object;
}

/** Keep structured lower-level error details when a renderer error crosses the RHI boundary. */
export function runtimeFailureDetails(cause: unknown): RuntimeFailureDetails {
  if (!(cause instanceof Error)) return { code: 'unknown', message: String(cause) };

  const structured = cause as Error & {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly cause?: unknown;
    readonly detail?: unknown;
  };
  const detail =
    typeof structured.detail === 'object' && structured.detail !== null
      ? structured.detail
      : structured.cause === undefined
        ? undefined
        : { cause: structured.cause };
  return {
    code: typeof structured.code === 'string' ? structured.code : 'unknown',
    message: structured.message,
    name: structured.name,
    ...(typeof structured.expected === 'string' ? { expected: structured.expected } : {}),
    ...(typeof structured.hint === 'string' ? { hint: structured.hint } : {}),
    ...(detail === undefined ? {} : { detail }),
  };
}
