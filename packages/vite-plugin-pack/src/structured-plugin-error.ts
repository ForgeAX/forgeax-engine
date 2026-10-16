export interface StructuredPluginFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly cause?: unknown;
}

/** Preserve machine-readable recovery fields while satisfying Vite's thrown-error boundary. */
export function structuredPluginError(
  failure: StructuredPluginFailure,
): Error & StructuredPluginFailure {
  // Bundlers commonly retain only Error.message in their public diagnostic.
  // Keep the original fields and derive the human diagnostic from the same facts.
  const diagnostic = stringifyPluginDiagnostic(failure);
  return Object.assign(new Error(`${failure.code}: ${failure.expected}\n${diagnostic}`), failure);
}

/** JSON boundary for producer diagnostics, including Error causes. */
export function stringifyPluginDiagnostic(failure: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(failure, (_key, value: unknown) => {
    if (typeof value === 'bigint') return String(value);
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value instanceof Error
      ? { ...value, message: value.message, cause: value.cause }
      : value;
  });
}
