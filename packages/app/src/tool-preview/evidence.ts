import {
  type ArtifactRef,
  createArtifactRef,
  type PreviewArtifactManifest,
  type PreviewArtifactRole,
  type SnapshotRef,
  snapshotStaleError,
  type ToolRuntimeError,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-tool-runtime';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { ToolPreviewTrace } from './recipe';

export interface ToolPreviewEvidence {
  readonly trace: ToolPreviewTrace;
  readonly artifacts: readonly ArtifactRef[];
  readonly manifest?: PreviewArtifactManifest;
}

export function joinToolPreviewEvidence(input: {
  readonly trace: ToolPreviewTrace;
  readonly manifest: PreviewArtifactManifest;
  readonly required: readonly PreviewArtifactRole[];
}): Result<ToolPreviewEvidence, ToolRuntimeError> {
  const validated = validatePreviewArtifactManifest(input.manifest, input.required);
  if (!validated.ok) return err(validated.error);
  const artifacts = input.manifest.artifacts.map((artifact) =>
    createArtifactRef({
      kind:
        artifact.kind === 'report' || artifact.kind === 'contact-sheet'
          ? 'tool-result'
          : artifact.kind,
      digest: artifact.digest,
      uri: artifact.uri,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.byteLength,
    }),
  );
  return ok({ trace: input.trace, artifacts, manifest: input.manifest });
}

export function createToolPreviewEvidence(
  trace: ToolPreviewTrace,
  artifacts: readonly ArtifactRef[],
): ToolPreviewEvidence {
  return { trace, artifacts: [...artifacts] };
}

export function joinResourcePreviewEvidence(input: {
  readonly snapshot: SnapshotRef;
  readonly manifest: PreviewArtifactManifest;
  readonly requiredRoles: readonly PreviewArtifactRole[];
}): Result<PreviewArtifactManifest, ToolRuntimeError> {
  if (input.manifest.identity.snapshotDigest !== input.snapshot.digest) {
    return err(snapshotStaleError(input.snapshot.digest, input.manifest.identity.snapshotDigest));
  }
  const validated = validatePreviewArtifactManifest(input.manifest, input.requiredRoles);
  return validated.ok ? ok(validated.value) : err(validated.error);
}
