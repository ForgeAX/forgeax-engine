/** Closed error code vocabulary of the engine-agnostic modeling kernel. */
export type KernelErrorCode =
  | 'kernel-invalid-argument'
  | 'kernel-invalid-handle'
  | 'kernel-invalid-value'
  | 'kernel-precondition'
  | 'kernel-degenerate'
  | 'kernel-selection-empty'
  | 'kernel-selection-cardinality'
  | 'kernel-work-budget'
  | 'kernel-cancelled'
  | 'kernel-capability-unavailable'
  | 'kernel-internal'
  | 'kernel-op-no-effect';

export const KERNEL_ERROR_CODES: readonly KernelErrorCode[] = [
  'kernel-invalid-argument',
  'kernel-invalid-handle',
  'kernel-invalid-value',
  'kernel-precondition',
  'kernel-degenerate',
  'kernel-selection-empty',
  'kernel-selection-cardinality',
  'kernel-work-budget',
  'kernel-cancelled',
  'kernel-capability-unavailable',
  'kernel-internal',
  'kernel-op-no-effect',
];

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly field: string;
  readonly reason: string;

  constructor(code: KernelErrorCode, field: string, reason: string) {
    super(`[KernelError ${code}] ${field}: ${reason}`);
    this.name = 'KernelError';
    this.code = code;
    this.field = field;
    this.reason = reason;
  }
}

export type KernelResult<T, E = KernelError> =
  | { readonly ok: true; readonly value: T; unwrap(): T }
  | { readonly ok: false; readonly error: E; unwrap(): never };

export function ok<T>(value: T): KernelResult<T, never> {
  return {
    ok: true,
    value,
    unwrap: () => value,
  };
}

export function err<E>(error: E): KernelResult<never, E> {
  return {
    ok: false,
    error,
    unwrap: () => {
      throw error;
    },
  };
}

export function errorCodeFromId(id: number): KernelErrorCode {
  return KERNEL_ERROR_CODES[id - 1] ?? 'kernel-internal';
}
