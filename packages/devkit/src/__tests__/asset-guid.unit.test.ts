import { describe, expect, it } from 'vitest';
import { assetGuidCommand } from '../asset-guid.js';

const packageId = '019fb7ce-5200-7000-8000-000000000000';

describe('assetGuidCommand', () => {
  it('derives the guid a pack publishes for packageId and sourceKey', async () => {
    const result = await assetGuidCommand({ packageId, key: 'material/punk-smoke' });
    expect(result).toEqual({
      ok: true,
      value: {
        packageId,
        key: 'material/punk-smoke',
        guid: '067856ac-0cba-54c8-9a29-44de20a37a21',
      },
    });
  });

  it('rejects a malformed package id and an invalid key with structured errors', async () => {
    expect(await assetGuidCommand({ packageId: 'nope', key: 'a/b' })).toMatchObject({
      ok: false,
      error: { code: 'asset-guid-package-id-invalid' },
    });
    expect(await assetGuidCommand({ packageId, key: 'Not Valid' })).toMatchObject({
      ok: false,
      error: { detail: { key: 'Not Valid' } },
    });
    expect(await assetGuidCommand({ packageId })).toMatchObject({
      ok: false,
      error: { code: 'asset-guid-arguments-missing' },
    });
  });
});
