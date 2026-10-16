export type PreviewErrorCode =
  | 'preview-validation-failed'
  | 'preview-compile-failed'
  | 'preview-pipeline-incompatible'
  | 'preview-aborted'
  | 'preview-not-applicable';

export interface PreviewError {
  readonly code: PreviewErrorCode;
  readonly message: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: string;
  /** One-based source position when the compiler can provide it. */
  readonly line?: number;
  readonly column?: number;
}

/**
 * Closed preview recovery table. Callers branch on `code`, render `detail`,
 * and expose `hint`; no caller classifies errors from message text.
 */
export const previewErrorRecovery: Readonly<Record<PreviewErrorCode, string>> = {
  'preview-validation-failed': 'fix WGSL validation diagnostics, then Apply again',
  'preview-compile-failed': 'fix WGSL compiler diagnostics, then Apply again',
  'preview-pipeline-incompatible': 'select a compatible raster pipeline or reset the editor',
  'preview-aborted': 'keep the current selection and Apply again',
  'preview-not-applicable': 'select a complete raster stage in a WebGPU-capable host',
};

export function previewError(
  code: PreviewErrorCode,
  detail: string,
  hint: string,
  location?: { readonly line?: number; readonly column?: number },
): PreviewError {
  return {
    code,
    detail,
    hint,
    message: detail,
    expected: 'a viewer-private selected-raster shader preview',
    ...(location?.line === undefined ? {} : { line: location.line }),
    ...(location?.column === undefined ? {} : { column: location.column }),
  };
}

export function abortedPreviewError(detail = 'preview apply was cancelled'): PreviewError {
  return previewError('preview-aborted', detail, 'apply the current selection again');
}
