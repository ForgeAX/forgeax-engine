import { describe, expect, it } from 'vitest';
import { executeMaterialPreview, materialSampledTextureBudgetFacts } from '../domains/material.js';
import {
  createMaterialPreviewContribution,
  type MaterialPreviewRequest,
  materialPreviewDescriptor,
} from '../material.js';
import { materialBindingFromPayload } from '../primitive.js';

const request: MaterialPreviewRequest = {
  subject: { kind: 'MaterialAsset', guid: 'mat-001' },
  snapshot: { revision: 7, digest: 'sha256:material-snapshot' },
  binding: {
    guid: 'mat-001',
    programDigest: 'sha256:program',
    bindings: ['baseColor', 'roughness', 'normal'],
  },
};

describe('material.preview canonical contract', () => {
  it('projects parameter bindings without treating module slots as draw defines', () => {
    expect(
      materialBindingFromPayload('mat-001', {
        kind: 'material',
        passes: [
          {
            name: 'forward',
            program: { module: 'game::material', moduleSlots: { FLAG: 'true' } },
          },
        ],
        parameters: [{ name: 'baseColor', type: 'color' }],
        values: { baseColor: [1, 1, 1, 1] },
      }),
    ).toEqual({
      guid: 'mat-001',
      programDigest: 'material-program:game::material',
      bindings: ['baseColor'],
    });
  });

  it('publishes a dedicated descriptor with subject evidence', () => {
    expect(materialPreviewDescriptor.id).toBe('asset.material.preview');
    expect(materialPreviewDescriptor.realm).toBe('engine');
    expect(materialPreviewDescriptor.evidence).toEqual(['rhi-tape', 'png', 'profile-capture']);
    expect(materialPreviewDescriptor.preview).toMatchObject({
      realm: 'engine',
      subject: { kind: 'MaterialAsset' },
      requiredEvidence: ['rhi-tape', 'png', 'profile-capture'],
    });
  });

  it('requires the requested MaterialAsset GUID and real program bindings', () => {
    expect(
      materialPreviewDescriptor.argsSchema.parse({ ...request, binding: { guid: 'other' } }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      materialPreviewDescriptor.argsSchema.parse({
        ...request,
        binding: { ...request.binding, bindings: [] },
      }),
    ).toMatchObject({ ok: false });
  });

  it('rejects fallback sphere, missing evidence, and non-background-only output', async () => {
    const contribution = createMaterialPreviewContribution(async () => ({
      ok: true,
      value: {
        subject: request.subject,
        snapshot: request.snapshot,
        report: {
          kind: 'material',
          bindingGuid: 'fallback-sphere',
          programDigest: request.binding.programDigest,
          backgroundNonBlackPixels: 0,
          subjectNonBlackPixels: 0,
          presentation: 'sphere-studio',
        },
        artifacts: [],
      },
    }));

    const terminal = await contribution.execute(request, {} as never);
    expect(terminal).toMatchObject({
      ok: false,
      error: { code: 'preview-subject-falsified' },
    });
  });
});

describe('material.preview sampled-texture budget', () => {
  const ownerFacts = {
    subjectDigest: 'sha256:subject',
    bindingsDigest: 'sha256:bindings',
    closureDigest: 'sha256:closure',
    sampledTextureLimit: 16,
    sampledTextureRequired: 21,
    sampledTextureTransmission: 'exceeded',
    sampledTextureConflicts: 'metallicTexture,roughnessTexture',
  };

  it('parses owner budget facts and ignores incomplete ones', () => {
    expect(materialSampledTextureBudgetFacts(ownerFacts)).toEqual({
      limit: 16,
      required: 21,
      transmission: 'exceeded',
      conflicts: ['metallicTexture', 'roughnessTexture'],
    });
    expect(
      materialSampledTextureBudgetFacts({ ...ownerFacts, sampledTextureConflicts: '' }),
    ).toMatchObject({ conflicts: [] });
    expect(
      materialSampledTextureBudgetFacts({ ...ownerFacts, sampledTextureTransmission: 'maybe' }),
    ).toBeUndefined();
    expect(materialSampledTextureBudgetFacts({ subjectDigest: 'sha256:subject' })).toBeUndefined();
  });

  it.each([
    [true, true],
    [false, true],
    [true, false],
  ])('checks Renderer and World readiness before the material oracle (%s, %s)', async (rendererReady, worldReady) => {
    const guid = 'mat-001';
    const result = await executeMaterialPreview({ guid } as never, {
      assets: {
        loadByGuid: async () => ({
          ok: true,
          value: {
            kind: 'material',
            passes: [{ name: 'forward', program: { module: 'forgeax::default-standard-pbr' } }],
          },
          ownerFacts,
        }),
      } as never,
      renderer: {
        rendererReady,
        worldReady,
        drawCalls: 1,
        nonBlackPixels: 100,
        observation: {
          subjectDigest: 'sha256:subject',
          program: 'forgeax::default-standard-pbr',
          pass: 'forward',
          bindingsDigest: 'sha256:bindings',
          closureDigest: 'sha256:closure',
        },
      } as never,
      runId: 'run-1',
    });
    if (!rendererReady || !worldReady) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'resource-preview-oracle-failed', detail: { phase: 'renderer' } },
      });
      return;
    }
    expect(result).toMatchObject({
      ok: true,
      value: {
        oracle: { status: 'passed' },
        sampledTextureBudget: { limit: 16, required: 21, transmission: 'exceeded' },
      },
    });
  });
});
