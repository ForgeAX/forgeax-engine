// image-importer-hdr-equirect.test.ts
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M1 / w1.
//
// TDD red->green: locks the .hdr arm of imageImporter producing an
// EquirectAsset POD (kind:'equirect', rgba16float 2D) for an 'equirect'
// sub-asset, instead of the prior TextureAsset (kind:'texture') for a
// 'texture' sub-asset. research F-10 + plan-strategy D-9; orchestrator
// adjudication: equirect produces a build-time .bin (2D rgba16float image).

import type {
  EquirectAsset,
  ImportContext,
  ImportedAsset,
  ImportSubAsset,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { imageImporter } from '../image-importer.js';

const HDR_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';

function unwrap(result: {
  readonly ok: boolean;
  readonly value?: { readonly assets: readonly ImportedAsset[] };
}): readonly ImportedAsset[] {
  return result.ok && result.value !== undefined ? result.value.assets : [];
}

function makeHdrFixture(width: number, height: number): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header);

  const hi = (width >> 8) & 0xff;
  const lo = width & 0xff;
  const prefix = new Uint8Array([0x02, 0x02, hi, lo]);

  const chRun = new Uint8Array([128 + width, 128]);
  const scanlineBytes = 4 + 4 * 2;
  const pixelBytes = new Uint8Array(height * scanlineBytes);

  for (let y = 0; y < height; y++) {
    let off = y * scanlineBytes;
    pixelBytes.set(prefix, off);
    off += 4;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
  }

  const total = new Uint8Array(headerBytes.length + pixelBytes.length);
  total.set(headerBytes);
  total.set(pixelBytes, headerBytes.length);
  return total;
}

function makeHdrCtx(
  source: string,
  bytes: Uint8Array,
  subAssets: readonly ImportSubAsset[],
  importSettings: Readonly<Record<string, unknown>> = {},
): ImportContext {
  return {
    source,
    readSource: async () => ({ ok: true, value: bytes }),
    readSibling: async () => ({ ok: true, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('decodeImage not used by imageImporter');
    },
    subAssets,
    importSettings,
  };
}

describe('imageImporter HDR arm produces EquirectAsset (w1)', () => {
  it('(a) .hdr + equirect sub-asset -> EquirectAsset POD kind:"equirect" + rgba16float', async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx('env.hdr', makeHdrFixture(width, height), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);

    const produced = unwrap(await imageImporter.import(ctx));
    expect(produced.length).toBe(1);
    const asset = produced[0];
    expect(asset?.guid).toBe(HDR_GUID);
    expect(asset?.kind).toBe('equirect');

    const payload = asset?.payload as EquirectAsset;
    expect(payload.kind).toBe('equirect');
    expect(payload.format).toBe('rgba16float');
    expect(payload.colorSpace).toBe('linear');
    expect(payload.width).toBe(width);
    expect(payload.height).toBe(height);
  });

  it('(b) byte length is width * height * 4 * 2 (rgba16f = 8 bytes/pixel)', async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx('env.hdr', makeHdrFixture(width, height), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);

    const produced = unwrap(await imageImporter.import(ctx));
    const payload = (produced[0] as { payload: EquirectAsset })?.payload;
    expect(payload.data.length).toBe(width * height * 4 * 2);
  });

  it('(c) a texture sub-asset with .hdr source is NOT folded (only equirect is)', async () => {
    const ctx = makeHdrCtx('env.hdr', makeHdrFixture(8, 4), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'texture' },
    ]);
    const produced = unwrap(await imageImporter.import(ctx));
    expect(produced.length).toBe(0);
  });

  it('(d) .hdr extension upper-case is still recognized via toLowerCase()', async () => {
    const ctx = makeHdrCtx('ENV.HDR', makeHdrFixture(8, 2), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);
    const produced = unwrap(await imageImporter.import(ctx));
    expect(produced.length).toBe(1);
    expect(produced[0]?.kind).toBe('equirect');
  });

  it('(e) returns a structured validation error for a corrupt .hdr source (invalid RGBE header)', async () => {
    const corrupt = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const ctx = makeHdrCtx('bad.hdr', corrupt, [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);
    const result = await imageImporter.import(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-validation-failed');
    expect(result.error.detail).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'image-conversion-decode-hdr' })],
    });
  });
});

// KTX2 magic identifier (first 12 bytes of every KTX 2.0 container). Used to
// assert the HDR encode arm produced a real UASTC-HDR KTX2, not raw f16.
const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe('imageImporter HDR equirect is never block-compressed (feat-20260707 fix)', () => {
  // An equirect is ALWAYS an IBL / skybox source: it drives equirect-to-cube /
  // irradiance / prefilter RENDER passes, and a BC6H (block-compressed) texture
  // is sample-only, never color-renderable. So the HDR arm never encodes an
  // equirect sub-asset -- it always ships raw rgba16float, regardless of the
  // requested compressionMode ('auto' / 'uastc' / 'none' all yield rgba16float).
  it("compressionMode:'auto' HDR equirect -> raw rgba16float (never a KTX2)", async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx(
      'env.hdr',
      makeHdrFixture(width, height),
      [{ guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
      { colorSpace: 'linear', mipmap: 'none', compressionMode: 'auto' },
    );

    const produced = unwrap(await imageImporter.import(ctx));
    const payload = (produced[0] as { payload: EquirectAsset })?.payload;
    // Raw rgba16float byte count (w*h*8) and NOT a KTX2 container.
    expect(payload.data.length).toBe(width * height * 4 * 2);
    expect(Array.from(payload.data.subarray(0, 12))).not.toEqual(Array.from(KTX2_IDENTIFIER));
    expect(payload.format).toBe('rgba16float');
  });

  it("explicit 'uastc' HDR equirect -> raw rgba16float (never a KTX2)", async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx(
      'env.hdr',
      makeHdrFixture(width, height),
      [{ guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
      { colorSpace: 'linear', mipmap: 'none', compressionMode: 'uastc' },
    );
    const produced = unwrap(await imageImporter.import(ctx));
    const payload = (produced[0] as { payload: EquirectAsset })?.payload;
    expect(payload.data.length).toBe(width * height * 4 * 2);
    expect(Array.from(payload.data.subarray(0, 12))).not.toEqual(Array.from(KTX2_IDENTIFIER));
  });

  it("compressionMode:'none' HDR equirect -> raw rgba16float .bin path", async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx(
      'env.hdr',
      makeHdrFixture(width, height),
      [{ guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
      { colorSpace: 'linear', mipmap: 'none', compressionMode: 'none' },
    );
    const produced = unwrap(await imageImporter.import(ctx));
    const payload = (produced[0] as { payload: EquirectAsset })?.payload;
    expect(payload.data.length).toBe(width * height * 4 * 2);
    expect(Array.from(payload.data.subarray(0, 12))).not.toEqual(Array.from(KTX2_IDENTIFIER));
  });

  it('AC-02: HDR equirect import is deterministic (double import byte-identical)', async () => {
    const mk = () =>
      makeHdrCtx(
        'env.hdr',
        makeHdrFixture(8, 4),
        [{ guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
        { colorSpace: 'linear', mipmap: 'none', compressionMode: 'auto' },
      );
    const a = (unwrap(await imageImporter.import(mk()))[0] as { payload: EquirectAsset }).payload
      .data;
    const b = (unwrap(await imageImporter.import(mk()))[0] as { payload: EquirectAsset }).payload
      .data;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
