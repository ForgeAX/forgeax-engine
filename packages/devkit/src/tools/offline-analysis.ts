import {
  isPreviewArtifactRole,
  isToolEvidenceKind,
  type PreviewArtifactManifest,
  type PreviewArtifactRole,
  type ToolArtifactManifest,
  type ToolDomainFailure,
  type ToolEvidenceKind,
  validateArtifactManifest,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-tool-runtime';
import { completeCommand } from '../types.js';

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
      ? !required.every(isToolEvidenceKind)
        ? {
            ok: false as const,
            error: {
              code: 'tool-artifact-manifest-invalid',
              expected: 'requested evidence kinds to belong to the v1 artifact manifest',
              hint: 'Request one of rhi-tape, png, or profile-capture for a v1 manifest.',
              detail: { reason: 'unsupported required evidence kind' },
            },
          }
        : validateArtifactManifest(request.manifest, required)
      : validatePreviewArtifactManifest(request.manifest, required.filter(isPreviewArtifactRole));
  if (!validated.ok) return validated;
  const { identity, artifacts } = validated.value;
  return completeCommand({
    runId: identity.runId,
    captureId: identity.captureId,
    artifacts: artifacts.map(({ kind, digest }) => ({ kind, digest })),
  });
}
