import { describe, expect, it } from 'vitest';
import type { PreviewArtifactManifest } from '../index.js';
import { createAtomicPreviewPublisher } from '../index.js';

const manifest: PreviewArtifactManifest = {
  schemaVersion: '2.0.0',
  identity: {
    runId: 'run',
    snapshotDigest: 'sha256:snapshot',
    subjectDigest: 'sha256:subject',
    presentationDigest: 'sha256:presentation',
    captureId: 'capture',
    frameId: 0,
  },
  artifacts: [
    {
      owner: 'report',
      kind: 'report',
      role: 'report',
      uri: 'report',
      digest: 'sha256:report',
      byteLength: 1,
      mediaType: 'application/vnd.forgeax.resource-preview+json',
      derivedFrom: [],
    },
  ],
};

describe('preview manifest publisher', () => {
  it('does not publish partial staging', () => {
    const publisher = createAtomicPreviewPublisher();
    publisher.stage(manifest);
    const result = publisher.publish(['report', 'fresh-replay']);
    expect(result.ok).toBe(false);
    expect(publisher.published()).toBeUndefined();
  });
});
