// asset-registry-hdr-equirect.test.ts
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M1 / w1.
//
// TDD red->green: locks the runtime equirectLoader loading an EquirectAsset
// POD from a Pack v2 asset-local rgba16float artifact.

import { equirectLoader, PACK_ARTIFACT_LOADERS } from '@forgeax/engine-assets-runtime';
import type { LoadContext, LoaderAsyncResult } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function mockCtx(binaries: Record<string, Uint8Array>): LoadContext {
  return {
    fetchBinary: async (url: string) => {
      const b = binaries[url];
      return b !== undefined
        ? { ok: true as const, value: b }
        : { ok: false as const, error: new Error(`no binary for ${url}`) };
    },
    resolveRef: async () => ({ ok: false as const, error: new Error('no ref') }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

describe('equirectLoader (w1)', () => {
  it('(a) PACK_ARTIFACT_LOADERS includes equirect after texture + font', () => {
    expect(PACK_ARTIFACT_LOADERS.map((l) => l.kind)).toContain('equirect');
  });

  it('(b) loads an EquirectAsset POD (kind:"equirect" + rgba16float) from .bin bytes', async () => {
    // rgba16float = 8 bytes per pixel; 2x2 = 32 bytes.
    const data = new Uint8Array(2 * 2 * 4 * 2).fill(0x3c);
    const input = {
      guid: '11111111-1111-4111-8111-111111111111',
      kind: 'equirect',
      payload: {
        kind: 'equirect',
        width: 2,
        height: 2,
        format: 'rgba16float',
        colorSpace: 'linear',
      },
      refs: [],
      artifacts: {
        body: {
          descriptor: { path: 'env.bin', mediaType: 'application/x-forgeax-rgba16f' },
          bytes: data,
        },
      },
    };
    if (equirectLoader.loadPack === undefined) throw new Error('equirect Pack loader is missing');
    const out = (await equirectLoader.loadPack(input, mockCtx({}))) as LoaderAsyncResult;
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value).toMatchObject({
        kind: 'equirect',
        width: 2,
        height: 2,
        format: 'rgba16float',
      });
    }
  });

  it('(c) fails when the source is not an imported .bin', async () => {
    if (equirectLoader.loadPack === undefined) throw new Error('equirect Pack loader is missing');
    const out = (await equirectLoader.loadPack(
      {
        guid: '11111111-1111-4111-8111-111111111111',
        kind: 'equirect',
        payload: { kind: 'equirect' },
        refs: [],
        artifacts: {},
      },
      mockCtx({}),
    )) as LoaderAsyncResult;
    expect(out.ok).toBe(false);
  });
});
