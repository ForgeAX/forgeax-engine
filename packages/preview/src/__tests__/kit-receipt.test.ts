import { describe, expect, it } from 'vitest';
import { validateCanonicalKitReceipt } from '../kit/receipt.js';
import { CANONICAL_KIT_RECEIPT } from '../kit/receipt.test-fixtures.js';

describe('canonical preview kit receipt', () => {
  it('requires producer-owned source, recipe, cooked payload, and transport lineage', () => {
    const result = validateCanonicalKitReceipt(CANONICAL_KIT_RECEIPT);
    expect(result).toMatchObject({
      ok: true,
      value: { source: { guid: CANONICAL_KIT_RECEIPT.source.guid } },
    });
  });

  it.each([
    ['path-derived identity', { source: { ...CANONICAL_KIT_RECEIPT.source, digest: 'path:ddc' } }],
    ['project override', { package: { ...CANONICAL_KIT_RECEIPT.package, name: 'game-project' } }],
    ['missing cooked source', { cooked: { ...CANONICAL_KIT_RECEIPT.cooked, sourceDigest: '' } }],
  ])('rejects %s before renderer setup', (_label, override) => {
    const result = validateCanonicalKitReceipt({ ...CANONICAL_KIT_RECEIPT, ...override });
    expect(result).toMatchObject({ ok: false, error: { code: 'preview-kit-receipt-invalid' } });
  });
});
