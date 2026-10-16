import { describe, expect, it } from 'vitest';
import {
  createVfxPreviewContribution,
  type VfxPreviewRequest,
  vfxPreviewDescriptor,
} from '../vfx.js';

const request: VfxPreviewRequest = {
  subject: { kind: 'ParticleEffectAsset', guid: 'vfx-001' },
  snapshot: { revision: 5, digest: 'sha256:vfx-snapshot' },
  binding: { guid: 'vfx-001', effectDigest: 'sha256:effect-program' },
  simulation: { seed: 17, deltaSeconds: 1 / 60, frames: 8 },
};

describe('vfx.preview canonical contract', () => {
  it('publishes a dedicated deterministic descriptor', () => {
    expect(vfxPreviewDescriptor.id).toBe('asset.vfx.preview');
    expect(vfxPreviewDescriptor.realm).toBe('engine');
    expect(vfxPreviewDescriptor.evidence).toEqual(['rhi-tape', 'png', 'profile-capture']);
  });

  it('requires a real effect binding and bounded deterministic timeline', () => {
    expect(
      vfxPreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, guid: 'other' },
      }),
    ).toMatchObject({ ok: false });
    expect(
      vfxPreviewDescriptor.argsSchema.parse({
        ...request,
        simulation: { ...request.simulation, deltaSeconds: 0, frames: 0 },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects disconnected compute/draw and non-deterministic output', async () => {
    const contribution = createVfxPreviewContribution(async () => ({
      ok: true,
      value: {
        subject: request.subject,
        snapshot: request.snapshot,
        report: {
          kind: 'vfx',
          bindingGuid: request.subject.guid,
          seed: request.simulation.seed,
          deltaSeconds: request.simulation.deltaSeconds,
          frames: request.simulation.frames,
          computeSteps: 0,
          drawCalls: 0,
          subjectOutputDigest: '',
          deterministicDigest: 'sha256:wrong',
          captureNonBlackPixels: 0,
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
