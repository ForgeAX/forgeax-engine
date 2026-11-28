import { err, ok, type Result } from '@forgeax/engine-types';

export { err, ok, type Result };

export type KernelErrorCode =
  | 'kernel-disposed'
  | 'kernel-device-lost'
  | 'kernel-handle-invalid'
  | 'kernel-handle-stale-generation'
  | 'kernel-handle-already-destroyed'
  | 'kernel-protocol-version-mismatch'
  | 'kernel-delta-base-mismatch'
  | 'kernel-delta-malformed'
  | 'kernel-command-stream-malformed'
  | 'kernel-pass-resource-conflict'
  | 'kernel-temp-texture-out-of-scope'
  | 'kernel-capability-unsupported'
  | 'kernel-budget-exceeded'
  | 'kernel-shader-compile-failed'
  | 'kernel-pipeline-create-failed'
  | 'kernel-surface-unavailable'
  | 'kernel-backend-runtime-error';

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly owner: string;
  readonly expected: string;
  readonly hint: string;
  readonly handle?: number;

  constructor(init: {
    readonly code: KernelErrorCode;
    readonly owner: string;
    readonly expected: string;
    readonly hint: string;
    readonly handle?: number;
  }) {
    super(`[${init.code}] (${init.owner}) expected ${init.expected}; ${init.hint}`);
    this.name = 'KernelError';
    this.code = init.code;
    this.owner = init.owner;
    this.expected = init.expected;
    this.hint = init.hint;
    if (init.handle !== undefined) this.handle = init.handle;
  }
}

export function kernelErr<T = never>(
  code: KernelErrorCode,
  owner: string,
  expected: string,
  hint: string,
  handle?: number,
): Result<T, KernelError> {
  return err(
    new KernelError({
      code,
      owner,
      expected,
      hint,
      ...(handle === undefined ? {} : { handle }),
    }),
  );
}

const KNOWN_CODES: ReadonlySet<string> = new Set<KernelErrorCode>([
  'kernel-disposed',
  'kernel-device-lost',
  'kernel-handle-invalid',
  'kernel-handle-stale-generation',
  'kernel-handle-already-destroyed',
  'kernel-protocol-version-mismatch',
  'kernel-delta-base-mismatch',
  'kernel-delta-malformed',
  'kernel-command-stream-malformed',
  'kernel-pass-resource-conflict',
  'kernel-temp-texture-out-of-scope',
  'kernel-capability-unsupported',
  'kernel-budget-exceeded',
  'kernel-shader-compile-failed',
  'kernel-pipeline-create-failed',
  'kernel-surface-unavailable',
  'kernel-backend-runtime-error',
]);

export function parseKernelErrorCode(raw: unknown): KernelErrorCode {
  if (typeof raw === 'string' && KNOWN_CODES.has(raw)) {
    return raw as KernelErrorCode;
  }
  return 'kernel-backend-runtime-error';
}
