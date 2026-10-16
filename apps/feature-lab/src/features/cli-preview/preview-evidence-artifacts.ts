import {
  createAtomicPreviewPublisher,
  createMaterialPreviewContribution,
  type PreviewArtifactManifest,
  validatePreviewArtifactManifest,
} from '@forgeax/engine/preview';
import { createToolRuntime } from '@forgeax/engine/tool-runtime';
import { defineFeature } from '../../lab/feature';

type Entry = PreviewArtifactManifest['artifacts'][number];

function entry(
  role: Entry['role'],
  kind: Entry['kind'],
  derivedFrom: readonly string[] = [],
): Entry {
  return {
    owner: 'lab',
    kind,
    role,
    uri: `${role}.bin`,
    digest: `sha256:${role}`,
    byteLength: 16,
    mediaType: 'application/octet-stream',
    derivedFrom,
  };
}

const manifest: PreviewArtifactManifest = {
  schemaVersion: '2.0.0',
  identity: {
    runId: 'lab-run',
    snapshotDigest: 'sha256:snapshot',
    subjectDigest: 'sha256:subject',
    presentationDigest: 'sha256:presentation',
    captureId: 'capture-0001',
    frameId: 3,
  },
  artifacts: [
    entry('rhi-tape', 'rhi-tape'),
    entry('capture', 'png', ['sha256:rhi-tape']),
    entry('profile-capture', 'profile-capture'),
    entry('report', 'report', ['sha256:rhi-tape', 'sha256:capture', 'sha256:profile-capture']),
  ],
};

const REQUIRED = ['report', 'rhi-tape', 'capture', 'profile-capture'] as const;

function reason(result: ReturnType<typeof validatePreviewArtifactManifest>): string {
  if (result.ok) return 'ok';
  const detail = result.error.detail as { reason?: string };
  return `${result.error.code}: ${detail.reason ?? ''}`;
}

export default defineFeature({
  title: 'Preview evidence artifacts',
  catalog: 'Preview evidence artifacts',
  kind: 'headless',
  summary:
    'A manifest-v2 preview report binds RHI tape, PNG capture and profile-capture entries to one run/snapshot/subject/frame identity; the atomic publisher commits only a complete, internally consistent stage, and the default material preview refuses instead of synthesizing evidence.',
  expect:
    'a complete manifest validates; a missing role, a role/kind mismatch, a dangling derivedFrom and a v1 schema are tool-artifact-manifest-invalid; a partial stage never becomes published; the default material.preview terminal fails with preview-runtime-unavailable and zero artifacts.',
  async run(checks) {
    checks.equal(
      'complete manifest',
      reason(validatePreviewArtifactManifest(manifest, REQUIRED)),
      'ok',
    );
    const broken: [string, PreviewArtifactManifest, string][] = [
      [
        'missing required role',
        {
          ...manifest,
          artifacts: manifest.artifacts.filter(
            (a) => a.role !== 'profile-capture' && a.role !== 'report',
          ),
        },
        "missing required role 'report'",
      ],
      [
        'role/kind mismatch',
        { ...manifest, artifacts: [entry('capture', 'rhi-tape')] },
        "role 'capture' does not match kind 'rhi-tape'",
      ],
      [
        'dangling derivedFrom',
        { ...manifest, artifacts: [entry('report', 'report', ['sha256:gone'])] },
        "'report' derivedFrom references an unpublished artifact",
      ],
      [
        'v1 schema',
        { ...manifest, schemaVersion: '1.0.0' as never },
        'v1 manifest or unsupported schemaVersion',
      ],
    ];
    for (const [name, value, why] of broken) {
      checks.equal(
        name,
        reason(
          validatePreviewArtifactManifest(value, name === 'missing required role' ? REQUIRED : []),
        ),
        `tool-artifact-manifest-invalid: ${why}`,
      );
    }

    const publisher = createAtomicPreviewPublisher();
    publisher.stage({ ...manifest, artifacts: manifest.artifacts.slice(0, 1) });
    const partial = publisher.publish(REQUIRED);
    checks.ok(
      'partial stage refused',
      !partial.ok && publisher.published() === undefined,
      reason(partial),
    );
    publisher.stage(manifest);
    const committed = publisher.publish(REQUIRED);
    checks.equal(
      'complete stage published',
      publisher.published()?.identity.captureId,
      committed.ok ? 'capture-0001' : 'refused',
    );

    const material = createMaterialPreviewContribution();
    checks.equal('material descriptor id', material.descriptor.id, 'asset.material.preview');
    checks.equal(
      'material required evidence',
      [...material.descriptor.evidence].sort().join(','),
      'png,profile-capture,rhi-tape',
    );
    const terminal = await createToolRuntime([material]).run(material, {
      subject: { kind: 'MaterialAsset', guid: 'mat-001' },
      snapshot: { revision: 1, digest: 'sha256:mat' },
      binding: { guid: 'mat-001', programDigest: 'sha256:program', bindings: ['baseColor'] },
    }).terminal;
    const failure = terminal.outcome === 'failed' ? terminal.failure : undefined;
    const domain = (failure?.detail as { code?: string } | undefined)?.code;
    checks.ok(
      'default preview fails closed',
      failure !== undefined &&
        terminal.artifacts.length === 0 &&
        (domain === 'preview-runtime-unavailable' ||
          JSON.stringify(failure).includes('preview-runtime-unavailable')),
      JSON.stringify(failure).slice(0, 240),
    );
  },
});
