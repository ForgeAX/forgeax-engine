import {
  type PreviewArtifactManifest,
  type PreviewArtifactRole,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-preview';
import {
  type ToolArtifactManifest,
  type ToolDomainFailure,
  type ToolEvidenceKind,
  validateArtifactManifest,
} from '@forgeax/engine-tool-runtime';

export interface OfflineAnalysisRequest {
  readonly manifest: PreviewArtifactManifest | ToolArtifactManifest;
  readonly required?: readonly (PreviewArtifactRole | ToolEvidenceKind)[];
}

export interface OfflineAnalysisResult {
  readonly runId: string;
  readonly captureId: string;
  readonly artifacts: readonly { readonly kind: string; readonly digest: string }[];
}

export function analyzePreviewArtifacts(
  request: OfflineAnalysisRequest,
):
  | { readonly ok: true; readonly value: OfflineAnalysisResult }
  | { readonly ok: false; readonly error: ToolDomainFailure } {
  const required = request.required ?? [];
  const validated =
    request.manifest.schemaVersion === '1.0.0'
      ? required.some((kind) => kind !== 'rhi-tape' && kind !== 'png' && kind !== 'profile-capture')
        ? {
            ok: false as const,
            error: {
              code: 'tool-artifact-manifest-invalid',
              expected: 'requested evidence kinds to belong to the v1 artifact manifest',
              hint: 'Request one of rhi-tape, png, or profile-capture for a v1 manifest.',
              detail: { reason: 'unsupported required evidence kind' },
            },
          }
        : validateArtifactManifest(request.manifest, required as readonly ToolEvidenceKind[])
      : validatePreviewArtifactManifest(
          request.manifest,
          (request.required ?? []).filter(
            (role): role is PreviewArtifactRole =>
              role === 'report' ||
              role === 'rhi-tape' ||
              role === 'capture' ||
              role === 'fresh-replay' ||
              role === 'profile-capture' ||
              role === 'contact-sheet',
          ),
        );
  if (!validated.ok) return { ok: false, error: validated.error as ToolDomainFailure };
  return {
    ok: true,
    value: {
      runId: request.manifest.identity.runId,
      captureId: request.manifest.identity.captureId,
      artifacts: request.manifest.artifacts.map(({ kind, digest }) => ({ kind, digest })),
    },
  };
}
