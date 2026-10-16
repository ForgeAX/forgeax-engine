import { describe, expect, it } from 'vitest';
import {
  createPreviewArtifactManifest,
  validatePreviewArtifactManifest,
  type PreviewArtifactManifest,
} from '../src/index.js';

const base: PreviewArtifactManifest = {
  schemaVersion: '2.0.0',
  identity: {
    runId: 'run-1',
    snapshotDigest: 'sha256:snapshot',
    subjectDigest: 'sha256:subject',
    presentationDigest: 'sha256:presentation',
    captureId: 'capture-1',
    frameId: 0,
  },
  artifacts: [
    {
      owner: 'report',
      kind: 'report',
      role: 'report',
      uri: 'file:///report.json',
      digest: 'sha256:report',
      byteLength: 1,
      mediaType: 'application/vnd.forgeax.resource-preview+json',
      derivedFrom: [],
    },
    {
      owner: 'rhi',
      kind: 'rhi-tape',
      role: 'rhi-tape',
      uri: 'file:///capture.tape',
      digest: 'sha256:tape',
      byteLength: 1,
      mediaType: 'application/vnd.forgeax.rhi-tape',
      derivedFrom: [],
    },
    {
      owner: 'capture',
      kind: 'png',
      role: 'capture',
      uri: 'file:///capture.png',
      digest: 'sha256:capture',
      byteLength: 1,
      mediaType: 'image/png',
      derivedFrom: ['sha256:tape'],
    },
    {
      owner: 'replay',
      kind: 'png',
      role: 'fresh-replay',
      uri: 'file:///replay.png',
      digest: 'sha256:replay',
      byteLength: 1,
      mediaType: 'image/png',
      derivedFrom: ['sha256:tape'],
    },
    {
      owner: 'profile',
      kind: 'profile-capture',
      role: 'profile-capture',
      uri: 'file:///profile.json',
      digest: 'sha256:profile',
      byteLength: 1,
      mediaType: 'application/vnd.forgeax.profile+json',
      derivedFrom: [],
    },
  ],
};

describe('resource preview manifest v2', () => {
  it('validates one six-identity lineage before publication', () => {
    const result = validatePreviewArtifactManifest(base, [
      'report',
      'rhi-tape',
      'capture',
      'fresh-replay',
      'profile-capture',
    ]);
    expect(result.ok).toBe(true);
    expect(createPreviewArtifactManifest(base).schemaVersion).toBe('2.0.0');
  });

  it.each([
    ['tampered digest', { artifacts: base.artifacts.slice(0, -1) }],
    ['stale snapshot', { identity: { ...base.identity, snapshotDigest: '' } }],
    ['partial staging', { artifacts: base.artifacts.filter((artifact) => artifact.role !== 'fresh-replay') }],
  ])('rejects %s before terminal publication', (_name, patch) => {
    const result = validatePreviewArtifactManifest(
      { ...base, ...patch },
      ['report', 'rhi-tape', 'capture', 'fresh-replay', 'profile-capture'],
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a v1 reader payload instead of replaying it', () => {
    const result = validatePreviewArtifactManifest(
      { ...base, schemaVersion: '1.0.0' as never },
      [],
    );
    expect(result.ok).toBe(false);
  });
});
