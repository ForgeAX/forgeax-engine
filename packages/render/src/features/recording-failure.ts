import { type RenderError, RenderFeatureDrawRecordingFailedError } from '../errors/render';

/** Preserve the owner error event before aborting an encoded intent. */
export function throwFeatureRecordingFailure(
  failure: unknown,
  featureIdentity: string,
  order: number,
  name: string,
  field: 'pipeline' | 'bindings',
  reportError: ((error: RenderError) => void) | undefined,
): never {
  const error =
    failure instanceof Error && typeof (failure as Partial<RenderError>).code === 'string'
      ? (failure as RenderError)
      : new RenderFeatureDrawRecordingFailedError(
          featureIdentity,
          order,
          name,
          field,
          'backend-recording-failed',
          failure instanceof Error ? failure.message : String(failure),
          'renderer-recover',
        );
  reportError?.(error);
  throw error;
}
