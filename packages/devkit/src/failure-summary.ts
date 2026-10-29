/** A coded failure link: a CommandError, a Pack failure or a nested cause. */
interface CodedFailure {
  readonly code: string;
  readonly expected?: unknown;
  readonly hint?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
  readonly cause?: unknown;
}

function codedCause(value: unknown): CodedFailure | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const cause = (value as { readonly cause?: unknown }).cause;
  if (cause === null || typeof cause !== 'object') return undefined;
  return typeof (cause as { readonly code?: unknown }).code === 'string'
    ? (cause as CodedFailure)
    : undefined;
}

/** Message of an uncoded tail cause (an Error or `{ message }`), if any. */
function tailMessage(owner: CodedFailure): string | undefined {
  const cause = owner.cause;
  if (cause instanceof Error) return cause.message;
  if (cause !== null && typeof cause === 'object') {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof owner.message === 'string' && owner.message !== '' ? owner.message : undefined;
}

/**
 * One line for a failure: a coded failure (a plain object or a coded Error),
 * an uncoded Error (its message) or any other value. A coded chain names every code and the innermost link's
 * expectation, hint, detail and message, because a wrapper code alone (or
 * `String(failure)`, which prints `[object Object]`) hides the real diagnostic.
 */
export function failureSummary(failure: unknown): string {
  if (
    failure === null ||
    typeof failure !== 'object' ||
    typeof (failure as { code?: unknown }).code !== 'string'
  ) {
    return failure instanceof Error ? failure.message : String(failure);
  }
  const error = failure as CodedFailure;
  const codes = [error.code];
  let owner = error;
  for (let cause = codedCause(owner); cause; cause = codedCause(owner)) {
    owner = cause;
    codes.push(owner.code);
  }
  const message = tailMessage(owner);
  if (owner === error && typeof error.hint === 'string' && message === undefined) {
    return `${error.code}: ${error.hint}`;
  }
  const parts = [
    typeof owner.expected === 'string' ? `expected ${owner.expected}` : undefined,
    typeof owner.hint === 'string' ? `hint: ${owner.hint}` : undefined,
  ];
  const detail = owner.detail === undefined ? '' : JSON.stringify(owner.detail);
  if (detail !== '' && detail !== '{}') parts.push(`detail: ${detail.slice(0, 2048)}`);
  if (message !== undefined) parts.push(`message: ${message.slice(0, 2048)}`);
  const body = parts.filter((part) => part !== undefined).join('; ');
  return body === '' ? codes.join(' <- ') : `${codes.join(' <- ')}: ${body}`;
}
