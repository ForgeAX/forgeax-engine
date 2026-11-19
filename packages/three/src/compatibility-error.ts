export type ThreeCompatibilityErrorCode =
  | 'three-unsupported'
  | 'three-migration-required'
  | 'three-invalid-value'
  | 'three-interop-invalid'
  | 'three-owner-failed'
  | 'renderer-not-ready'
  | 'renderer-disposed'
  | 'renderer-capture-busy';

export class ThreeCompatibilityError extends Error {
  readonly expected = 'a supported Three.js r187 input on the Forgeax compatibility renderer';
  readonly detail: { readonly subject: string; readonly uuid?: string };

  constructor(
    readonly code: ThreeCompatibilityErrorCode,
    subject: string,
    readonly hint: string,
    uuid?: string,
    cause?: unknown,
  ) {
    super(`${code}: ${subject}. ${hint}`, cause === undefined ? undefined : { cause });
    this.name = 'ThreeCompatibilityError';
    this.detail = Object.freeze({ subject, ...(uuid === undefined ? {} : { uuid }) });
  }
}

export function unsupportedError(subject: string, uuid?: string): ThreeCompatibilityError {
  return new ThreeCompatibilityError(
    'three-unsupported',
    subject,
    'This is an unimplemented compatibility feature. See the package compatibility status; exporting the source API does not establish renderer support.',
    uuid,
  );
}

export function invalidError(subject: string, uuid?: string): ThreeCompatibilityError {
  return new ThreeCompatibilityError(
    'three-invalid-value',
    subject,
    'Repair the named source value before rendering again.',
    uuid,
  );
}
