import { describe, expect, it } from 'vitest';
import { createImportProduct } from '../import-product.js';

describe('Import owner chain', () => {
  it('hands one complete terminal product to the next owner', () => {
    const result = createImportProduct({
      assets: [
        {
          guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
          kind: 'texture',
          payload: { kind: 'texture' },
          refs: [],
          artifacts: {},
        },
      ],
      sourceDependencies: ['hero.png'],
      refs: [],
      artifacts: {},
      receipts: [],
      diagnostics: [],
      sourceRevision: 'sha256:hero',
      sourceKey: 'hero/albedo',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        sourceRevision: 'sha256:hero',
        sourceKey: 'hero/albedo',
        refs: [],
        artifacts: {},
        receipts: [],
        diagnostics: [],
      });
    }
  });
});
