import { expect, it, vi } from 'vitest';

it('creates distinct runtime owners in hosts without browser Crypto', async () => {
  vi.stubGlobal('crypto', undefined);
  try {
    const { AssetRecords } = await import('../internal/asset-records');
    const a = new AssetRecords(),
      b = new AssetRecords();
    expect(a.identity).not.toBe(b.identity);
    const first = a.adopt('fixture', { value: 1 }).unwrap();
    const second = b.adopt('fixture', { value: 2 }).unwrap();
    expect(first).not.toBe(second);
    expect(a.validate(second).ok).toBe(false);
    expect(b.validate(first).ok).toBe(false);
    a.dispose();
    b.dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});
