import type { SnapshotRef } from '@forgeax/engine-tool-runtime';
import type { PreviewPresentation, PreviewSubject } from '../kit/presentation.js';
import type { PreviewArtifactManifestEntry } from './manifest.js';
import type { PreviewOracle } from './oracle.js';

export interface ResourcePreviewReport {
  readonly mediaType: 'application/vnd.forgeax.resource-preview+json';
  readonly schemaVersion: '1.0.0';
  readonly runId: string;
  readonly snapshot: SnapshotRef;
  readonly subject: PreviewSubject;
  readonly presentation: PreviewPresentation;
  readonly oracle: PreviewOracle;
  readonly artifacts: readonly PreviewArtifactManifestEntry[];
}

export function createResourcePreviewReport(
  input: Omit<ResourcePreviewReport, 'mediaType' | 'schemaVersion'>,
): ResourcePreviewReport {
  return {
    mediaType: 'application/vnd.forgeax.resource-preview+json',
    schemaVersion: '1.0.0',
    ...input,
    artifacts: input.artifacts.map((artifact) => ({
      ...artifact,
      derivedFrom: [...artifact.derivedFrom],
    })),
  };
}
