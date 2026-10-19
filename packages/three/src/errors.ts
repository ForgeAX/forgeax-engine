import { err, type Result } from '@forgeax/engine-types';

export type ThreeCompatibilityErrorCode =
  | 'three-unsupported'
  | 'three-migration-required'
  | 'three-invalid-value'
  | 'renderer-not-ready'
  | 'renderer-disposed'
  | 'renderer-capture-busy';

export class ThreeCompatibilityError extends Error {
  readonly expected = 'a supported Three.js r184 input on the Forgeax compatibility renderer';
  readonly detail: { readonly subject: string; readonly uuid?: string };

  constructor(
    readonly code: ThreeCompatibilityErrorCode,
    subject: string,
    readonly hint: string,
    uuid?: string,
  ) {
    super(`${code}: ${subject}. ${hint}`);
    this.name = 'ThreeCompatibilityError';
    this.detail = Object.freeze({ subject, ...(uuid === undefined ? {} : { uuid }) });
  }
}

export function unsupported(
  subject: string,
  uuid?: string,
): Result<never, ThreeCompatibilityError> {
  return err(
    new ThreeCompatibilityError(
      'three-unsupported',
      subject,
      'This is an unimplemented compatibility feature. See the package compatibility status; exporting the source API does not establish renderer support.',
      uuid,
    ),
  );
}

/** Only the explicitly excluded custom-shader and native-WebGL boundary uses this error. */
export function migration(subject: string, uuid?: string): Result<never, ThreeCompatibilityError> {
  return err(
    new ThreeCompatibilityError(
      'three-migration-required',
      subject,
      'Port custom shaders to Forgeax material/WGSL authoring and native WebGL calls to RHI. Ordinary Three features remain compatibility obligations.',
      uuid,
    ),
  );
}

export function invalid(subject: string, uuid?: string): Result<never, ThreeCompatibilityError> {
  return err(
    new ThreeCompatibilityError(
      'three-invalid-value',
      subject,
      'Repair the named source value before rendering again.',
      uuid,
    ),
  );
}
