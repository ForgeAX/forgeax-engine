/**
 * Per-Feature capture policy: decides which capture faces a render Feature
 * records into. Post effects stay `display-only`; scene-content Features
 * (GPU particles) declare `all`.
 */
export type CaptureFaceKind = 'planar' | 'probe' | 'cube';

export type RenderFeatureCapturePolicy =
  | 'display-only'
  | 'all'
  | { readonly faces: readonly CaptureFaceKind[] };

export const DEFAULT_CAPTURE_POLICY: RenderFeatureCapturePolicy = 'display-only';

export function featureRecordsInCapture(
  policy: RenderFeatureCapturePolicy | undefined,
  kind: CaptureFaceKind,
): boolean {
  const resolved = policy ?? DEFAULT_CAPTURE_POLICY;
  if (resolved === 'all') return true;
  if (resolved === 'display-only') return false;
  return resolved.faces.includes(kind);
}
