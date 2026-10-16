import { describe, expect, it } from 'vitest';
import {
  createMeshPreviewContribution,
  type MeshPreviewRequest,
  meshPreviewDescriptor,
} from '../mesh.js';

const request: MeshPreviewRequest = {
  subject: { kind: 'MeshAsset', guid: 'mesh-001' },
  snapshot: { revision: 3, digest: 'sha256:mesh-snapshot' },
  binding: {
    guid: 'mesh-001',
    vertexDigest: 'sha256:vertices',
    indexDigest: 'sha256:indices',
    submeshes: [
      { id: 'body', vertexCount: 24, indexCount: 36 },
      { id: 'detail', vertexCount: 12, indexCount: 18 },
    ],
    aabb: { min: [-2, -1, -3], max: [4, 5, 1] },
  },
};

describe('mesh.preview canonical contract', () => {
  it('publishes a dedicated descriptor for complete submesh presentation', () => {
    expect(meshPreviewDescriptor.id).toBe('asset.mesh.preview');
    expect(meshPreviewDescriptor.realm).toBe('engine');
    expect(meshPreviewDescriptor.evidence).toEqual(['rhi-tape', 'png', 'profile-capture']);
  });

  it('rejects a missing submesh or an unbound mesh GUID', () => {
    expect(
      meshPreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, guid: 'other' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      meshPreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, submeshes: [] },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects partial drawing and inverted AABB framing', async () => {
    const contribution = createMeshPreviewContribution(async () => ({
      ok: true,
      value: {
        subject: request.subject,
        snapshot: request.snapshot,
        report: {
          kind: 'mesh',
          bindingGuid: request.subject.guid,
          submeshCount: 1,
          expectedSubmeshCount: 2,
          vertexCount: 24,
          indexCount: 36,
          framing: 'inverted-aabb',
        },
        artifacts: [],
      },
    }));
    await expect(contribution.execute(request, {} as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'preview-subject-falsified' },
    });
  });
});
