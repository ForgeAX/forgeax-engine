import { err, type Result } from '@forgeax/engine-types';
import { invalidError, ThreeCompatibilityError, unsupportedError } from './compatibility-error';

export { ThreeCompatibilityError, type ThreeCompatibilityErrorCode } from './compatibility-error';

export function unsupported(
  subject: string,
  uuid?: string,
): Result<never, ThreeCompatibilityError> {
  return err(unsupportedError(subject, uuid));
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
  return err(invalidError(subject, uuid));
}
