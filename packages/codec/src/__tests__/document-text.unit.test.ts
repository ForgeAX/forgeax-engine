import { decodeDocumentText } from '@forgeax/engine-codec';
import { compressZstd } from '@forgeax/engine-codec/encode';
import { describe, expect, it } from 'vitest';

const document = JSON.stringify({
  entries: [{ hash: 'a', wgsl: 'fn main() {}' }],
  label: '\u00e9',
});

describe('decodeDocumentText', () => {
  it('reads plain UTF-8 documents unchanged', async () => {
    const result = await decodeDocumentText(new TextEncoder().encode(document));
    expect(result).toEqual({ ok: true, value: document });
  });

  it('reads documents stored as one zstd frame', async () => {
    const compressed = await compressZstd(new TextEncoder().encode(document));
    if (!compressed.ok) throw new Error('compress failed');
    expect(await decodeDocumentText(compressed.value)).toEqual({ ok: true, value: document });
  });

  it('reports a corrupt zstd frame instead of returning partial text', async () => {
    const result = await decodeDocumentText(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0, 0]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('decompression-failed');
  });
});
