export interface SnakeBrowserError {
  readonly message: string;
  readonly code?: string;
  readonly hint?: string;
  readonly detail?: unknown;
}

export interface SnakeDiagnosticsTarget {
  readonly dataset: Record<string, string | undefined>;
}

/**
 * Record an app failure without destroying the last trusted replica snapshot.
 * The hidden state element is the E2E's readback SSOT, so replacing its text
 * with an error turns a terminal engine failure into an opaque JSON parse or
 * tick timeout.
 */
export function recordSnakeBrowserError(
  target: SnakeDiagnosticsTarget,
  status: { textContent: string | null } | undefined,
  errors: string[],
  error: SnakeBrowserError,
): void {
  errors.push(error.message);
  target.dataset.appErrorTail = JSON.stringify(errors.slice(-8));
  if (error.code !== undefined) target.dataset.appErrorCode = error.code;
  if (error.hint !== undefined) target.dataset.appErrorHint = error.hint;
  if (error.detail !== undefined) target.dataset.appErrorDetail = serializeDetail(error.detail);
  target.dataset.lifecycle = 'error';
  if (status !== undefined) {
    status.textContent = `Engine error: ${error.code ?? 'unknown'}: ${error.hint ?? error.message}`;
  }
}

function serializeDetail(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
