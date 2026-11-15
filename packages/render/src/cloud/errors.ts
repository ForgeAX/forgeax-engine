export type CloudAuthoringErrorCode =
  | 'cloud-material-invalid'
  | 'cloud-layer-invalid'
  | 'cloud-program-invalid'
  | 'cloud-dependency-invalid'
  | 'cloud-publication-stale';

export interface CloudAuthoringLocation {
  readonly guid: string;
  readonly source: string;
}

export interface CloudAuthoringError {
  readonly code: CloudAuthoringErrorCode;
  readonly detail: CloudAuthoringLocation & { readonly field: string; readonly reason: string };
}

export function cloudAuthoringError(
  code: CloudAuthoringErrorCode,
  location: CloudAuthoringLocation,
  field: string,
  reason: string,
): CloudAuthoringError {
  return { code, detail: { ...location, field, reason } };
}
