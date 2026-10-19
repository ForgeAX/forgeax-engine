import { expect, it } from 'vitest';
import { createArtifactRef, validateArtifactRefs, validateArtifactManifest } from '../src/artifacts.js';
import type { ArtifactRef } from '../src/types.js';
import type { ToolArtifactManifest } from '../src/artifacts.js';

it.each([
  { kind: 'unknown', digest: 'digest' },
  { kind: 'png', digest: '' },
  { kind: 'png', digest: 'digest', sizeBytes: -1 },
  { kind: 'receipt', digest: 'digest', mediaType: 7 },
])('uses the same artifact admission at construction and terminal validation: %j', (value) => {
  expect(() => createArtifactRef(value as ArtifactRef)).toThrow(TypeError);
  expect(validateArtifactRefs([value])).toBe(false);
});

it('rejects a manifest entry outside the evidence vocabulary', () => {
  const manifest = {
    schemaVersion: '1.0.0',
    identity: { runId: 'run', snapshotDigest: 'snapshot', stepId: 'step', frameId: 0, captureId: 'capture' },
    artifacts: [{ owner: 'test', kind: 'unknown', uri: '/a', digest: 'digest', byteLength: 1 }],
  } as unknown as ToolArtifactManifest;
  expect(validateArtifactManifest(manifest, []).ok).toBe(false);
});

it.each(['rhi-tape', 'profile-capture', 'png', 'tool-result', 'receipt'] as const)(
  'retains every supported artifact kind: %s', (kind) => {
    const artifact = createArtifactRef({ kind, digest: 'digest', uri: '/a', sizeBytes: 0 });
    expect(validateArtifactRefs([artifact])).toBe(true);
  },
);
