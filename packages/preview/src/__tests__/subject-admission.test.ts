import { describe, expect, it } from 'vitest';
import { executeMaterialPreview } from '../domains/material.js';
import { inspectMeshSubject } from '../domains/mesh.js';
import { resourcePreviewArgsSchema } from '../domains/subject.js';
import { inspectTextureSubject } from '../domains/texture.js';
import { inspectVfxSubject } from '../domains/vfx.js';
import { validateCanonicalKitReceipt } from '../kit/receipt.js';
import { CANONICAL_KIT_RECEIPT } from '../kit/receipt.test-fixtures.js';

describe('native preview object admission', () => {
  it('rejects an array carrying request fields', () => {
    expect(resourcePreviewArgsSchema.parse({ guid: 'asset' }).ok).toBe(true);
    expect(resourcePreviewArgsSchema.parse(Object.assign([], { guid: 'asset' })).ok).toBe(false);
  });

  it.each([
    ['mesh', inspectMeshSubject],
    ['texture', inspectTextureSubject],
    ['particle-effect', inspectVfxSubject],
  ] as const)('rejects an array carrying %s asset fields before inspection', (kind, inspect) => {
    expect(inspect({ guid: 'asset', asset: Object.assign([], { kind }) })).toMatchObject({
      ok: false,
      error: { code: 'resource-preview-kind-mismatch' },
    });
  });

  it('rejects a material array supplied by the native host', async () => {
    const result = await executeMaterialPreview(
      { guid: 'asset' },
      {
        runId: 'run',
        subject: {
          guid: 'asset',
          asset: Object.assign([], { kind: 'material' }) as unknown as Record<string, unknown>,
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'resource-preview-kind-mismatch' },
    });
  });

  it('rejects arrays carrying receipt records at every object boundary', () => {
    expect(validateCanonicalKitReceipt(Object.assign([], CANONICAL_KIT_RECEIPT)).ok).toBe(false);
    for (const field of ['source', 'recipe', 'cooked', 'package', 'transport'] as const) {
      expect(
        validateCanonicalKitReceipt({
          ...CANONICAL_KIT_RECEIPT,
          [field]: Object.assign([], CANONICAL_KIT_RECEIPT[field]),
        }).ok,
        field,
      ).toBe(false);
    }
    expect(
      validateCanonicalKitReceipt({
        ...CANONICAL_KIT_RECEIPT,
        recipe: {
          ...CANONICAL_KIT_RECEIPT.recipe,
          value: Object.assign([], CANONICAL_KIT_RECEIPT.recipe.value),
        },
      }).ok,
    ).toBe(false);
  });
});
