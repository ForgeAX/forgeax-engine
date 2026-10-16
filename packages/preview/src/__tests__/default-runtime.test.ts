import { describe, expect, it } from 'vitest';
import {
  createMaterialPreviewContribution,
  createMeshPreviewContribution,
  createTexturePreviewContribution,
  createVfxPreviewContribution,
} from '../index.js';

const context = { runId: 'default-runtime', signal: new AbortController().signal } as never;

describe('canonical preview defaults', () => {
  it('fails closed without a Project GUID PreviewHost instead of synthesizing evidence', async () => {
    const requests = [
      {
        contribution: createMaterialPreviewContribution(),
        args: {
          subject: { kind: 'MaterialAsset', guid: 'mat-001' },
          snapshot: { revision: 1, digest: 'sha256:mat' },
          binding: { guid: 'mat-001', programDigest: 'sha256:program', bindings: ['baseColor'] },
        },
      },
      {
        contribution: createMeshPreviewContribution(),
        args: {
          subject: { kind: 'MeshAsset', guid: 'mesh-001' },
          snapshot: { revision: 1, digest: 'sha256:mesh' },
          binding: {
            guid: 'mesh-001',
            vertexDigest: 'sha256:v',
            indexDigest: 'sha256:i',
            submeshes: [{ id: 'body', vertexCount: 3, indexCount: 3 }],
            aabb: { min: [0, 0, 0], max: [1, 1, 1] },
          },
        },
      },
      {
        contribution: createVfxPreviewContribution(),
        args: {
          subject: { kind: 'ParticleEffectAsset', guid: 'vfx-001' },
          snapshot: { revision: 1, digest: 'sha256:vfx' },
          binding: { guid: 'vfx-001', effectDigest: 'sha256:effect' },
          simulation: { seed: 1, deltaSeconds: 1 / 60, frames: 1 },
        },
      },
      {
        contribution: createTexturePreviewContribution(),
        args: {
          subject: { kind: 'TextureAsset', guid: 'texture-001' },
          snapshot: { revision: 1, digest: 'sha256:texture' },
          binding: {
            guid: 'texture-001',
            width: 1,
            height: 1,
            format: 'rgba8unorm',
            colorSpace: 'srgb',
            alpha: true,
            mipLevels: 1,
            channels: 4,
          },
        },
      },
    ] as const;

    for (const request of requests) {
      await expect(
        request.contribution.execute(request.args as never, context),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'preview-runtime-unavailable',
          detail: { subjectGuid: request.args.subject.guid },
        },
      });
    }
  });
});
