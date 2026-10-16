import {
  createPreviewArtifactManifest,
  type PreviewArtifactManifest,
  type PreviewArtifactManifestValidation,
  type PreviewArtifactRole,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-tool-runtime';

export {
  createPreviewArtifactManifest,
  type PreviewArtifactIdentity,
  type PreviewArtifactKind,
  type PreviewArtifactManifest,
  type PreviewArtifactManifestEntry,
  type PreviewArtifactManifestValidation,
  type PreviewArtifactRole,
  validatePreviewArtifactManifest,
} from '@forgeax/engine-tool-runtime';

export interface AtomicPreviewPublisher {
  readonly stage: (manifest: PreviewArtifactManifest) => void;
  readonly publish: (
    requiredRoles: readonly PreviewArtifactRole[],
  ) => PreviewArtifactManifestValidation;
  readonly discard: () => void;
  readonly published: () => PreviewArtifactManifest | undefined;
}

/** In-memory atomic boundary shared by Browser, Dawn, and visible carriers. */
export function createAtomicPreviewPublisher(): AtomicPreviewPublisher {
  let staged: PreviewArtifactManifest | undefined;
  let committed: PreviewArtifactManifest | undefined;
  return {
    stage(manifest) {
      staged = createPreviewArtifactManifest(manifest);
    },
    publish(requiredRoles) {
      if (staged === undefined) {
        const invalid = validatePreviewArtifactManifest(
          { schemaVersion: '2.0.0', identity: undefined as never, artifacts: [] },
          requiredRoles,
        );
        if (invalid.ok) throw new Error('preview publisher rejected an empty stage');
        return invalid;
      }
      const validated = validatePreviewArtifactManifest(staged, requiredRoles);
      if (!validated.ok) {
        staged = undefined;
        return validated;
      }
      committed = validated.value;
      staged = undefined;
      return { ok: true, value: committed };
    },
    discard() {
      staged = undefined;
    },
    published: () => committed,
  };
}
