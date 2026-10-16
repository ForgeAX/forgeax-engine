// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=9):
//   - packages/image/src/__tests__/decode-image-from-file.test.ts
//   - packages/image/src/__tests__/hdr-decoder.test.ts
//   - packages/image/src/__tests__/image-importer-bins.test.ts
//   - packages/image/src/__tests__/image-importer-hdr.test.ts
//   - packages/image/src/__tests__/image-importer.test.ts
//   - packages/image/src/__tests__/parse-image.test.ts
//   - packages/image/src/__tests__/reimport-reuse-meta.test.ts
//   - packages/image/src/__tests__/sub-asset-key.test.ts
//   - packages/image/src/__tests__/to-asset-pack.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImporterRegistry } from '@forgeax/engine-import';
import type {
  EquirectAsset,
  ImageMeta,
  ImportContext,
  ImportedAsset,
  ImportSubAsset,
  TextureAsset,
} from '@forgeax/engine-types';

function unwrap(result: {
  readonly ok: boolean;
  readonly value?: { readonly assets: readonly ImportedAsset[] };
}): readonly ImportedAsset[] {
  return result.ok && result.value !== undefined ? result.value.assets : [];
}

import { describe, expect, it } from 'vitest';
import { decodeImageFromFile } from '../decode-image-from-file.js';
import { decodeHdr } from '../hdr-decoder.js';
import { imageImporter } from '../image-importer.js';
import { parseImage } from '../parse-image.js';
import { type ExistingExternalAssetPackage, reimportReuseMeta } from '../reimport-reuse-meta.js';
import { subAssetKey, subAssetKeyEqual } from '../sub-asset-key.js';
import { toAssetPack } from '../to-asset-pack.js';
import { makeCorruptPng, makeJpg, makePng } from './make-fixture.js';

{
  // ─── from decode-image-from-file.test.ts ───

  function mkTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `engine-image-${prefix}-`));
    return dir;
  }

  function writeFixture(dir: string, name: string, bytes: Uint8Array): string {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  }

  function readBinDF(name: string): Uint8Array {
    switch (name) {
      case 'wood-1x1.png':
        return makePng(1, 1, [137, 96, 71, 255]);
      case 'jpg-2x2.jpg':
        return makeJpg(2, 2, [120, 80, 60, 255]);
      default:
        throw new Error(`unknown fixture: ${name}`);
    }
  }

  describe('decode-image-from-file.test.ts', () => {
    describe('decodeImageFromFile -- async file-system entry; sidecar stat is path (a) of three-way fallback (AC-17 a)', () => {
      it('returns image-meta-missing when sidecar absent (path a fallback)', async () => {
        const dir = mkTmpDir('meta-missing');
        try {
          const png = readBinDF('wood-1x1.png');
          const sourcePath = writeFixture(dir, 'wood.png', png);
          const r = await decodeImageFromFile(sourcePath);
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect(r.error.code).toBe('image-meta-missing');
          if (r.error.detail.code !== 'image-meta-missing') return;
          expect(r.error.detail.sourcePath).toBe(sourcePath);
          expect(r.error.detail.expectedSidecarPath).toBe(join(dir, 'wood.png.meta.json'));
          expect(r.error.hint).toContain('forgeax asset');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('distinguishes a missing source from a missing sidecar and recovers on the same path', async () => {
        const dir = mkTmpDir('staged-recovery');
        const sourcePath = join(dir, 'staged.png');
        const sidecarPath = `${sourcePath}.meta.json`;
        const png = readBinDF('wood-1x1.png');
        const meta = {
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'staged.png',
          importSettings: {
            colorSpace: 'linear',
            mipmap: 'none',
            addressMode: 'mirror-repeat',
            filterMode: 'nearest',
          },
          subAssets: [
            {
              guid: '01928000-7c00-7000-8000-000000000004',
              sourceIndex: 0,
              kind: 'texture',
            },
          ],
        };
        const sidecar = new TextEncoder().encode(JSON.stringify(meta));
        try {
          const bothMissing = await decodeImageFromFile(sourcePath);
          expect(bothMissing.ok).toBe(false);
          if (bothMissing.ok) return;
          expect(bothMissing.error.code).toBe('image-decode-failed');
          if (bothMissing.error.detail.code !== 'image-decode-failed') return;
          expect(bothMissing.error.detail.path).toBe(sourcePath);
          expect(bothMissing.error.detail.reason).toContain('failed to read source');

          writeFileSync(sourcePath, png);
          const sidecarMissing = await decodeImageFromFile(sourcePath);
          expect(sidecarMissing.ok).toBe(false);
          if (sidecarMissing.ok) return;
          expect(sidecarMissing.error.code).toBe('image-meta-missing');
          if (sidecarMissing.error.detail.code !== 'image-meta-missing') return;
          expect(sidecarMissing.error.detail.sourcePath).toBe(sourcePath);
          expect(sidecarMissing.error.detail.expectedSidecarPath).toBe(sidecarPath);

          writeFileSync(sidecarPath, sidecar);
          const recovered = await decodeImageFromFile(sourcePath);
          expect(recovered.ok).toBe(true);
          if (!recovered.ok) return;
          expect(recovered.value.decoded.width).toBe(1);
          expect(recovered.value.decoded.height).toBe(1);
          expect(recovered.value.decoded.mime).toBe('image/png');
          expect(recovered.value.decoded.colorSpace).toBe('linear');
          expect(recovered.value.decoded.mipmap).toBe(false);
          expect(recovered.value.meta).toEqual({
            guid: '01928000-7c00-7000-8000-000000000004',
            colorSpace: 'linear',
            mipmap: 'none',
            addressMode: 'mirror-repeat',
            filterMode: 'nearest',
          });
          expect(toAssetPack(recovered.value.meta)).toEqual({
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: '',
            importSettings: {
              colorSpace: 'linear',
              mipmap: 'none',
              addressMode: 'mirror-repeat',
              filterMode: 'nearest',
            },
            subAssets: [
              {
                guid: '01928000-7c00-7000-8000-000000000004',
                sourceIndex: 0,
                kind: 'texture',
              },
            ],
          });

          const repeat = await decodeImageFromFile(sourcePath);
          expect(repeat).toEqual(recovered);
          expect(readFileSync(sourcePath)).toEqual(Buffer.from(png));
          expect(readFileSync(sidecarPath)).toEqual(Buffer.from(sidecar));
        } finally {
          rmSync(dir, { recursive: true, force: true });
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('decodes a valid 1x1 PNG file when sidecar is present, returns DecodedImage + ImageMeta', async () => {
        const dir = mkTmpDir('happy-png');
        try {
          const png = readBinDF('wood-1x1.png');
          const sourcePath = writeFixture(dir, 'wood.png', png);
          const meta = {
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: 'wood.png',
            importSettings: {
              colorSpace: 'srgb',
              mipmap: 'auto',
              addressMode: 'repeat',
              filterMode: 'linear',
            },
            subAssets: [
              {
                guid: '01928000-7c00-7000-8000-000000000001',
                sourceIndex: 0,
                kind: 'texture',
              },
            ],
          };
          writeFixture(dir, 'wood.png.meta.json', new TextEncoder().encode(JSON.stringify(meta)));
          const r = await decodeImageFromFile(sourcePath);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.value.decoded.width).toBe(1);
          expect(r.value.decoded.height).toBe(1);
          expect(r.value.decoded.mime).toBe('image/png');
          expect(r.value.meta.colorSpace).toBe('srgb');
          expect(r.value.meta.mipmap).toBe('auto');
          expect(r.value.meta.addressMode).toBe('repeat');
          expect(r.value.meta.filterMode).toBe('linear');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('decodes a valid 2x2 JPG file with sidecar', async () => {
        const dir = mkTmpDir('happy-jpg');
        try {
          const jpg = readBinDF('jpg-2x2.jpg');
          const sourcePath = writeFixture(dir, 'small.jpg', jpg);
          const meta = {
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: 'small.jpg',
            importSettings: {
              colorSpace: 'linear',
              mipmap: 'none',
              addressMode: 'clamp-to-edge',
              filterMode: 'nearest',
            },
            subAssets: [
              {
                guid: '01928000-7c00-7000-8000-000000000002',
                sourceIndex: 0,
                kind: 'texture',
              },
            ],
          };
          writeFixture(dir, 'small.jpg.meta.json', new TextEncoder().encode(JSON.stringify(meta)));
          const r = await decodeImageFromFile(sourcePath);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.value.decoded.width).toBe(2);
          expect(r.value.decoded.height).toBe(2);
          expect(r.value.decoded.mime).toBe('image/jpeg');
          expect(r.value.meta.colorSpace).toBe('linear');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });

      it('returns image-format-unsupported when extension is not .jpg/.jpeg/.png', async () => {
        const dir = mkTmpDir('unsupported-ext');
        try {
          const png = readBinDF('wood-1x1.png');
          const sourcePath = writeFixture(dir, 'wood.webp', png);
          const meta = {
            schemaVersion: '1.0.0',
            kind: 'external-asset-package',
            importer: 'image',
            source: 'wood.webp',
            importSettings: {
              colorSpace: 'srgb',
              mipmap: 'auto',
              addressMode: 'repeat',
              filterMode: 'linear',
            },
            subAssets: [
              {
                guid: '01928000-7c00-7000-8000-000000000003',
                sourceIndex: 0,
                kind: 'texture',
              },
            ],
          };
          writeFixture(dir, 'wood.png.meta.json', new TextEncoder().encode(JSON.stringify(meta)));
          const r = await decodeImageFromFile(sourcePath);
          expect(r.ok).toBe(false);
          if (r.ok) return;
          expect(r.error.code).toBe('image-format-unsupported');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
}

{
  // ─── from hdr-decoder.test.ts ───

  function makeMinimalHdr(): Uint8Array {
    const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n';
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);
    const width = 8;
    const hi = (width >> 8) & 0xff;
    const lo = width & 0xff;
    const prefix = new Uint8Array([0x02, 0x02, hi, lo]);
    const chRun = new Uint8Array([128 + 8, 128]);
    const pixelBytes = new Uint8Array(4 + 4 * 2);
    let off = 0;
    pixelBytes.set(prefix, off);
    off += 4;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    const total = new Uint8Array(headerBytes.length + pixelBytes.length);
    total.set(headerBytes);
    total.set(pixelBytes, headerBytes.length);
    return total;
  }

  function makeBlackHdr(): Uint8Array {
    const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n';
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);
    const width = 8;
    const hi = (width >> 8) & 0xff;
    const lo = width & 0xff;
    const prefix = new Uint8Array([0x02, 0x02, hi, lo]);
    const chRun = new Uint8Array([128 + 8, 0]);
    const pixelBytes = new Uint8Array(4 + 4 * 2);
    let off = 0;
    pixelBytes.set(prefix, off);
    off += 4;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    const total = new Uint8Array(headerBytes.length + pixelBytes.length);
    total.set(headerBytes);
    total.set(pixelBytes, headerBytes.length);
    return total;
  }

  function makeOldRleHdr(): Uint8Array {
    const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n';
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);
    const scanline = new Uint8Array([
      0x02, 0x02, 0x00, 0x02, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80,
    ]);
    const total = new Uint8Array(headerBytes.length + scanline.length);
    total.set(headerBytes);
    total.set(scanline, headerBytes.length);
    return total;
  }

  function makeMultiScanlineHdr(): Uint8Array {
    const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 8\n';
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);
    const width = 8;
    const hi = (width >> 8) & 0xff;
    const lo = width & 0xff;
    const prefix = new Uint8Array([0x02, 0x02, hi, lo]);
    const chRun = new Uint8Array([128 + 8, 64]);
    const chExp = new Uint8Array([128 + 8, 128]);
    const sl = new Uint8Array(4 + 4 * 2);
    let off = 0;
    sl.set(prefix, off);
    off += 4;
    sl.set(chRun, off);
    off += 2;
    sl.set(chRun, off);
    off += 2;
    sl.set(chRun, off);
    off += 2;
    sl.set(chExp, off);
    const sl2 = new Uint8Array(sl);
    const total = new Uint8Array(headerBytes.length + sl.length + sl2.length);
    total.set(headerBytes);
    total.set(sl, headerBytes.length);
    total.set(sl2, headerBytes.length + sl.length);
    return total;
  }

  function makeCorruptRleHdr(): Uint8Array {
    const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n';
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);
    const prefix = new Uint8Array([0x02, 0x02, 0, 4]);
    const chRun = new Uint8Array([128 + 4, 128]);
    const scanline = new Uint8Array(4 + 4 * 2);
    let off = 0;
    scanline.set(prefix, off);
    off += 4;
    scanline.set(chRun, off);
    off += 2;
    scanline.set(chRun, off);
    off += 2;
    scanline.set(chRun, off);
    off += 2;
    scanline.set(chRun, off);
    const total = new Uint8Array(headerBytes.length + scanline.length);
    total.set(headerBytes);
    total.set(scanline, headerBytes.length);
    return total;
  }

  describe('hdr-decoder.test.ts', () => {
    describe('t8/t9 - Radiance RGBE (.hdr) decoder', () => {
      it('(a) valid .hdr header parses magic, resolution, and FORMAT', () => {
        const r = decodeHdr(makeMinimalHdr());
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.width).toBe(8);
          expect(r.value.height).toBe(1);
          expect(r.value.data.length).toBe(8 * 4);
        }
      });

      it('(b) new-RLE decode round-trip for single scanline', () => {
        const r = decodeHdr(makeMinimalHdr());
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.value.data;
          for (let i = 0; i < 8; i++) {
            expect(d[i * 4]).toBeCloseTo(128.5 / 256, 4);
            expect(d[i * 4 + 1]).toBeCloseTo(128.5 / 256, 4);
            expect(d[i * 4 + 2]).toBeCloseTo(128.5 / 256, 4);
            expect(d[i * 4 + 3]).toBe(1.0);
          }
        }
      });

      it('(c) RGBE-to-float decode math: E=0 edge case produces black', () => {
        const r = decodeHdr(makeBlackHdr());
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.value.data;
          for (let i = 0; i < 8; i++) {
            expect(d[i * 4]).toBe(0);
            expect(d[i * 4 + 1]).toBe(0);
            expect(d[i * 4 + 2]).toBe(0);
            expect(d[i * 4 + 3]).toBe(1.0);
          }
        }
      });

      it('(d) old-RLE scanline returns error (image-hdr-decode-failed)', () => {
        const r = decodeHdr(makeOldRleHdr());
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('image-hdr-decode-failed');
        }
      });

      it('(e) multi-scanline file decodes all rows to rgba float buffer', () => {
        const r = decodeHdr(makeMultiScanlineHdr());
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.width).toBe(8);
          expect(r.value.height).toBe(2);
          expect(r.value.data.length).toBe(8 * 2 * 4);
          expect(r.value.data[0]).toBeCloseTo(64.5 / 256, 4);
          expect(r.value.data[3]).toBe(1.0);
          expect(r.value.data[32]).toBeCloseTo(64.5 / 256, 4);
          expect(r.value.data[35]).toBe(1.0);
        }
      });

      it('(f) corrupted RLE (prefix width mismatch) returns error', () => {
        const r = decodeHdr(makeCorruptRleHdr());
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('image-hdr-decode-failed');
        }
      });

      it('(g) missing FORMAT line returns error', () => {
        const noFmt = new TextEncoder().encode('#?RADIANCE\n\n-Y 1 +X 8\n');
        const r = decodeHdr(noFmt);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('image-hdr-decode-failed');
      });

      it('(h) non-RADIANCE magic returns error', () => {
        const badMagic = new TextEncoder().encode('PNG\n\n-Y 1 +X 8\n');
        const r = decodeHdr(badMagic);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('image-hdr-decode-failed');
      });

      it('(i) literal RLE run (non-repeating) decodes correctly', () => {
        const header = '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n';
        const encoder = new TextEncoder();
        const headerBytes = encoder.encode(header);
        const width = 8;
        const hi = (width >> 8) & 0xff;
        const lo = width & 0xff;
        const prefix = new Uint8Array([0x02, 0x02, hi, lo]);

        const rCh = new Uint8Array([8, 200, 100, 50, 25, 150, 80, 10, 5]);
        const gCh = new Uint8Array([128 + 8, 128]);
        const bCh = new Uint8Array([128 + 8, 128]);
        const eCh = new Uint8Array([128 + 8, 128]);

        const pixelBytes = new Uint8Array(4 + 9 + 2 + 2 + 2);
        let off = 0;
        pixelBytes.set(prefix, off);
        off += 4;
        pixelBytes.set(rCh, off);
        off += 9;
        pixelBytes.set(gCh, off);
        off += 2;
        pixelBytes.set(bCh, off);
        off += 2;
        pixelBytes.set(eCh, off);

        const total = new Uint8Array(headerBytes.length + pixelBytes.length);
        total.set(headerBytes);
        total.set(pixelBytes, headerBytes.length);

        const r = decodeHdr(total);
        expect(r.ok).toBe(true);
        if (r.ok) {
          const d = r.value.data;
          expect(d[0]).toBeCloseTo(200.5 / 256, 4);
          expect(d[4]).toBeCloseTo(100.5 / 256, 4);
          expect(d[8]).toBeCloseTo(50.5 / 256, 4);
          expect(d[12]).toBeCloseTo(25.5 / 256, 4);
          expect(d[16]).toBeCloseTo(150.5 / 256, 4);
          expect(d[20]).toBeCloseTo(80.5 / 256, 4);
          expect(d[24]).toBeCloseTo(10.5 / 256, 4);
          expect(d[28]).toBeCloseTo(5.5 / 256, 4);
          for (let i = 0; i < 8; i++) {
            expect(d[i * 4 + 1]).toBeCloseTo(128.5 / 256, 4);
            expect(d[i * 4 + 2]).toBeCloseTo(128.5 / 256, 4);
            expect(d[i * 4 + 3]).toBe(1.0);
          }
        }
      });
    });
  });
}

{
  // ─── from image-importer-bins.test.ts ───

  const BINS_GUID = '019e3969-1d43-7610-8810-e80dbd491d90';

  function makeBinsCtx(
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

  describe('image-importer-bins.test.ts', () => {
    describe('imageImporter bins migration (w7)', () => {
      it('(a) imageImporter still produces ImportedAsset with payload shape (width/height/format/colorSpace)', async () => {
        const png = makePng(8, 4, [200, 100, 50, 255]);
        const ctx = makeBinsCtx(
          'tile.png',
          png,
          [{ guid: BINS_GUID, sourceIndex: 0, kind: 'texture' }],
          {
            colorSpace: 'srgb',
            mipmap: 'none',
          },
        );

        const produced = unwrap(await imageImporter.import(ctx));
        expect(produced.length).toBe(1);
        const asset = produced[0];
        expect(asset?.guid).toBe(BINS_GUID);
        expect(asset?.kind).toBe('texture');
        expect(asset?.refs).toEqual([]);

        const payload = asset?.payload as unknown as Record<string, unknown>;
        expect(payload.kind).toBe('texture');
        expect(payload.shape).toEqual({ viewDimension: '2d', extent: { width: 8, height: 4 } });
        expect(payload.format).toBe('rgba8unorm-srgb');
        expect(payload.colorSpace).toBe('srgb');
        expect(payload.data).toBeInstanceOf(Uint8Array);
        expect((payload.data as Uint8Array).length).toBe(8 * 4 * 4);
      });

      it('(a) the runner keeps texture bytes in the asset-local body', async () => {
        const png = makePng(8, 4, [200, 100, 50, 255]);
        const registry = new ImporterRegistry();
        registry.register(imageImporter);

        const { runImport } = await import('@forgeax/engine-import');

        const result = await runImport(
          {
            importer: 'image',
            source: 'tile.png',
            subAssets: [{ guid: BINS_GUID, sourceIndex: 0, kind: 'texture' }],
          },
          registry,
          {
            readSource: async () => ({ ok: true, value: png }),
          },
        );

        expect(result.ok).toBe(true);
        if (!result.ok || 'skipped' in result.value) {
          throw new Error('expected ok RunImportOk');
        }

        const { pack } = result.value;

        const packAsset = pack.assets.find((a) => a.guid === BINS_GUID);
        expect(packAsset).toBeDefined();
        const body = packAsset?.artifacts.body;
        expect(body).toBeDefined();
        expect(body?.mediaType).toBe('application/x-forgeax-rgba8');
        expect(body?.bytes).toBeInstanceOf(Uint8Array);
        expect((body?.bytes as Uint8Array).length).toBe(8 * 4 * 4);
        const packPayload = packAsset?.payload as unknown as Record<string, unknown>;
        expect(packPayload.data).toEqual(expect.any(Array));
      });
    });
  });
}

{
  // ─── from image-importer-hdr.test.ts ───

  const HDR_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';

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

  describe('image-importer-hdr.test.ts', () => {
    describe('imageImporter HDR arm', () => {
      it('imports a .hdr source and produces an EquirectAsset with rgba16float format', async () => {
        const width = 8;
        const height = 4;
        const hdr = makeHdrFixture(width, height);
        const ctx = makeHdrCtx('env.hdr', hdr, [
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

      it('produces correct byte length: width * height * 4 * 2 (rgba16f = 8 bytes per pixel)', async () => {
        const width = 8;
        const height = 4;
        const hdr = makeHdrFixture(width, height);
        const ctx = makeHdrCtx('env.hdr', hdr, [
          { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
        ]);

        const produced = unwrap(await imageImporter.import(ctx));
        const payload = (produced[0] as { payload: EquirectAsset })?.payload;
        expect(payload.data.length).toBe(width * height * 4 * 2);
      });

      it('a texture sub-asset with .hdr source is NOT folded (only equirect is)', async () => {
        const hdr = makeHdrFixture(8, 4);
        const ctx = makeHdrCtx('env.hdr', hdr, [
          { guid: HDR_GUID, sourceIndex: 0, kind: 'texture' },
        ]);
        const produced = unwrap(await imageImporter.import(ctx));
        expect(produced.length).toBe(0);
      });

      it('returns a structured validation error for a corrupt .hdr source (invalid RGBE header)', async () => {
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

    describe('imageImporter unknown extension fail-fast', () => {
      const dummyBytes = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

      it('.tga source still throws unsupported source extension', async () => {
        const ctx = makeHdrCtx('texture.tga', dummyBytes, [
          { guid: HDR_GUID, sourceIndex: 0, kind: 'texture' },
        ]);
        await expect(imageImporter.import(ctx)).rejects.toThrow('unsupported source extension');
      });

      it('.bmp source still throws unsupported source extension', async () => {
        const ctx = makeHdrCtx('texture.bmp', dummyBytes, [
          { guid: HDR_GUID, sourceIndex: 0, kind: 'texture' },
        ]);
        await expect(imageImporter.import(ctx)).rejects.toThrow('unsupported source extension');
      });

      it('source with no extension still throws unsupported source extension', async () => {
        const ctx = makeHdrCtx('texture', dummyBytes, [
          { guid: HDR_GUID, sourceIndex: 0, kind: 'texture' },
        ]);
        await expect(imageImporter.import(ctx)).rejects.toThrow('unsupported source extension');
      });

      it('source with .hdr extension (upper case) is still recognized via toLowerCase()', async () => {
        const hdr = makeHdrFixture(8, 2);
        const ctx = makeHdrCtx('ENV.HDR', hdr, [
          { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
        ]);
        const produced = unwrap(await imageImporter.import(ctx));
        expect(produced.length).toBe(1);
        expect(produced[0]?.guid).toBe(HDR_GUID);
      });
    });
  });
}

{
  // ─── from image-importer.test.ts ───

  const IMP_GUID = '019e3969-1d43-7610-8810-e80dbd491d90';

  function makeImpCtx(
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

  describe('image-importer.test.ts', () => {
    describe('imageImporter dispatch (AC-18)', () => {
      it('an ImporterRegistry resolves meta.importer="image" to imageImporter', () => {
        const registry = new ImporterRegistry();
        registry.register(imageImporter);
        const resolved = registry.get('image');
        expect(resolved).toBe(imageImporter);
        expect(resolved?.key).toBe('image');
        expect(typeof resolved?.import).toBe('function');
      });
    });

    describe('imageImporter end-to-end (AC-17)', () => {
      it('a synthetic PNG imports into a TextureAsset POD with the right shape', async () => {
        const png = makePng(8, 4, [200, 100, 50, 255]);
        const ctx = makeImpCtx(
          'tile.png',
          png,
          [{ guid: IMP_GUID, sourceIndex: 0, kind: 'texture' }],
          {
            colorSpace: 'srgb',
            mipmap: 'none',
          },
        );

        const produced = unwrap(await imageImporter.import(ctx));
        expect(produced.length).toBe(1);
        const asset = produced[0];
        expect(asset?.guid).toBe(IMP_GUID);
        expect(asset?.kind).toBe('texture');

        const payload = asset?.payload as TextureAsset;
        expect(payload.kind).toBe('texture');
        expect(payload.shape).toEqual({ viewDimension: '2d', extent: { width: 8, height: 4 } });
        expect(payload.format).toBe('rgba8unorm-srgb');
        expect(payload.colorSpace).toBe('srgb');
        expect(payload.data.length).toBe(8 * 4 * 4);
      });

      it('linear colorSpace folds to the non-srgb format', async () => {
        const png = makePng(2, 2, [10, 20, 30, 255]);
        const ctx = makeImpCtx(
          'normal.png',
          png,
          [{ guid: IMP_GUID, sourceIndex: 0, kind: 'texture' }],
          {
            colorSpace: 'linear',
            mipmap: 'none',
          },
        );
        const produced = unwrap(await imageImporter.import(ctx));
        const payload = produced[0]?.payload as TextureAsset;
        expect(payload.format).toBe('rgba8unorm');
        expect(payload.colorSpace).toBe('linear');
      });

      it('a non-texture sub-asset is not folded by the PNG/JPEG arm', async () => {
        const png = makePng(2, 2, [0, 0, 0, 255]);
        const ctx = makeImpCtx('env.png', png, [
          { guid: IMP_GUID, sourceIndex: 0, kind: 'equirect' },
        ]);
        const produced = unwrap(await imageImporter.import(ctx));
        expect(produced.length).toBe(0);
      });
    });
  });
}

{
  // ─── from parse-image.test.ts ───

  const FIXTURES: Record<string, () => Uint8Array> = {
    'wood-1x1.png': () => makePng(1, 1, [137, 96, 71, 255]),
    'jpg-2x2.jpg': () => makeJpg(2, 2, [120, 80, 60, 255]),
    'corrupt.png': () => makeCorruptPng(),
  };

  function readFixture(name: string): Uint8Array {
    const make = FIXTURES[name];
    if (!make) throw new Error(`unknown fixture: ${name}`);
    return make();
  }

  describe('parse-image.test.ts', () => {
    describe('parseImage -- pure function: bytes + mime -> Result<DecodedImage, ImageError>', () => {
      it('decodes a valid 1x1 PNG into a DecodedImage POD (charter P3 explicit success)', () => {
        const bytes = readFixture('wood-1x1.png');
        const r = parseImage(bytes, 'image/png');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.width).toBe(1);
        expect(r.value.height).toBe(1);
        expect(r.value.mime).toBe('image/png');
        expect(r.value.bytes).toBeInstanceOf(Uint8Array);
        expect(r.value.bytes.length).toBe(4);
      });

      it('decodes a valid 2x2 JPG into a DecodedImage POD', () => {
        const bytes = readFixture('jpg-2x2.jpg');
        const r = parseImage(bytes, 'image/jpeg');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.width).toBe(2);
        expect(r.value.height).toBe(2);
        expect(r.value.mime).toBe('image/jpeg');
        expect(r.value.bytes.length).toBe(16);
      });

      it('returns image-decode-failed on a corrupted PNG byte stream', () => {
        const bytes = readFixture('corrupt.png');
        const r = parseImage(bytes, 'image/png');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('image-decode-failed');
        expect(r.error.detail.code).toBe('image-decode-failed');
        if (r.error.detail.code !== 'image-decode-failed') return;
        expect(typeof r.error.detail.reason).toBe('string');
        expect(r.error.detail.reason.length).toBeGreaterThan(0);
      });

      it('returns image-format-unsupported for image/webp mime', () => {
        const bytes = readFixture('jpg-2x2.jpg');
        const r = parseImage(bytes, 'image/webp');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('image-format-unsupported');
        if (r.error.detail.code !== 'image-format-unsupported') return;
        expect(r.error.detail.actualMime).toBe('image/webp');
      });

      it('returns image-format-unsupported for image/gif mime', () => {
        const bytes = readFixture('jpg-2x2.jpg');
        const r = parseImage(bytes, 'image/gif');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('image-format-unsupported');
      });

      it('returns image-format-unsupported for image/bmp mime', () => {
        const bytes = readFixture('jpg-2x2.jpg');
        const r = parseImage(bytes, 'image/bmp');
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('image-format-unsupported');
      });

      it('returns image-dimension-out-of-bounds when width or height exceeds maxDimension', () => {
        const bytes = readFixture('jpg-2x2.jpg');
        const r = parseImage(bytes, 'image/jpeg', { maxDimension: 1 });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe('image-dimension-out-of-bounds');
        if (r.error.detail.code !== 'image-dimension-out-of-bounds') return;
        expect(r.error.detail.requested).toEqual({ width: 2, height: 2 });
        expect(r.error.detail.limit).toBe(1);
      });
    });
  });
}

{
  // ─── from reimport-reuse-meta.test.ts ───

  const STABLE_GUID = '01928000-7c00-7000-8000-000000000042';

  function existingMeta(): ExistingExternalAssetPackage {
    return {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood.png',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: 'auto',
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [
        {
          guid: STABLE_GUID,
          sourceIndex: 0,
          kind: 'texture',
        },
      ],
    };
  }

  describe('reimport-reuse-meta.test.ts', () => {
    describe('reimportReuseMeta -- two-phase matching (kind+name+idx -> kind+idx -> fresh v7) AC-16', () => {
      it('first pass (no existing meta): emits all-fresh subAssets[]', () => {
        const subs = reimportReuseMeta(undefined);
        expect(subs).toHaveLength(1);
        expect(subs[0]?.kind).toBe('texture');
        expect(subs[0]?.guid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });

      it('reimport with existing meta + identical sub-asset-key reuses GUID byte-for-byte (AC-16 byte-identical)', () => {
        const subs = reimportReuseMeta(existingMeta());
        expect(subs[0]?.guid).toBe(STABLE_GUID);
      });

      it('reimport with existing meta but different name still falls back via indexFallback (kind+idx phase 2)', () => {
        const meta: ExistingExternalAssetPackage = {
          ...existingMeta(),
          subAssets: [{ guid: STABLE_GUID, sourceIndex: 0, kind: 'texture' }],
        };
        const subs = reimportReuseMeta(meta);
        expect(subs[0]?.guid).toBe(STABLE_GUID);
      });

      it('reimport with existing meta but different kind generates a fresh GUID (no cross-kind reuse)', () => {
        const meta: ExistingExternalAssetPackage = {
          ...existingMeta(),
          subAssets: [{ guid: STABLE_GUID, sourceIndex: 0, kind: 'mesh' }],
        };
        const subs = reimportReuseMeta(meta);
        expect(subs[0]?.guid).not.toBe(STABLE_GUID);
        expect(subs[0]?.kind).toBe('texture');
      });

      it('two consecutive reimports of byte-identical bytes produce byte-identical subAssets[] JSON', () => {
        const a = JSON.stringify(reimportReuseMeta(existingMeta()));
        const b = JSON.stringify(reimportReuseMeta(existingMeta()));
        expect(a).toBe(b);
      });
    });
  });
}

{
  // ─── from sub-asset-key.test.ts ───

  describe('sub-asset-key.test.ts', () => {
    describe('subAssetKey -- shape mirrors gltf loader (kind, name?, indexFallback)', () => {
      it('emits kind="texture" + indexFallback="textures/0" for a single-image source (AC-14)', () => {
        const k = subAssetKey({ kind: 'texture', sourceIndex: 0 });
        expect(k.kind).toBe('texture');
        expect(k.indexFallback).toBe('textures/0');
        expect(k.name).toBeUndefined();
      });

      it('preserves the optional name field when supplied', () => {
        const k = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'wood-diffuse' });
        expect(k.name).toBe('wood-diffuse');
        expect(k.indexFallback).toBe('textures/0');
      });

      it('subAssetKeyEqual returns true for same (kind+name+idx) triple', () => {
        const a = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'wood' });
        const b = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'wood' });
        expect(subAssetKeyEqual(a, b)).toBe(true);
      });

      it('subAssetKeyEqual returns false when name differs', () => {
        const a = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'a' });
        const b = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'b' });
        expect(subAssetKeyEqual(a, b)).toBe(false);
      });

      it('subAssetKeyEqual returns false when sourceIndex differs (indexFallback path differs)', () => {
        const a = subAssetKey({ kind: 'texture', sourceIndex: 0 });
        const b = subAssetKey({ kind: 'texture', sourceIndex: 1 });
        expect(subAssetKeyEqual(a, b)).toBe(false);
      });

      it('subAssetKeyEqual returns false when kind differs (gltf vs image co-existence)', () => {
        const a = subAssetKey({ kind: 'texture', sourceIndex: 0 });
        const b = subAssetKey({ kind: 'mesh', sourceIndex: 0 });
        expect(subAssetKeyEqual(a, b)).toBe(false);
      });

      // P1: sub-asset-key interface shape invariant — kind is string-typed, not
      // restricted to 'image'. indexFallback formula uses `${kind}s/${sourceIndex}`
      // and must survive the kind value change from 'image' to 'texture'.
      it('P1: subAssetKey with kind="texture" produces indexFallback="textures/0"', () => {
        const k = subAssetKey({ kind: 'texture', sourceIndex: 0 });
        expect(k.kind).toBe('texture');
        expect(k.indexFallback).toBe('textures/0');
      });

      it('P1: subAssetKey with kind="texture" + name preserves name and indexFallback', () => {
        const k = subAssetKey({ kind: 'texture', sourceIndex: 1, name: 'atlas-msdf' });
        expect(k.kind).toBe('texture');
        expect(k.name).toBe('atlas-msdf');
        expect(k.indexFallback).toBe('textures/1');
      });

      it('P1: subAssetKeyEqual works with kind="texture" (same kind+name+idx)', () => {
        const a = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'diffuse' });
        const b = subAssetKey({ kind: 'texture', sourceIndex: 0, name: 'diffuse' });
        expect(subAssetKeyEqual(a, b)).toBe(true);
      });

      // subAssetKeyEqual cross-kind: 'texture' is not equal to 'font'.
      it('P1: subAssetKeyEqual distinguishes "texture" from "font"', () => {
        const a = subAssetKey({ kind: 'texture', sourceIndex: 0 });
        const b = subAssetKey({ kind: 'font', sourceIndex: 0 });
        expect(subAssetKeyEqual(a, b)).toBe(false);
      });
    });
  });
}

{
  // ─── from to-asset-pack.test.ts ───

  function makeTAPMeta(): ImageMeta {
    return {
      guid: '01928000-7c00-7000-8000-000000000010',
      colorSpace: 'srgb',
      mipmap: 'auto',
      addressMode: 'repeat',
      filterMode: 'linear',
    };
  }

  describe('to-asset-pack.test.ts', () => {
    describe('toAssetPack -- pure function: ImageMeta -> external-asset-package SubAsset list', () => {
      it('emits a single subAsset with kind="texture" + guid copied from meta', () => {
        const pack = toAssetPack(makeTAPMeta());
        expect(pack.subAssets).toHaveLength(1);
        expect(pack.subAssets[0]?.kind).toBe('texture');
        expect(pack.subAssets[0]?.guid).toBe('01928000-7c00-7000-8000-000000000010');
        expect(pack.subAssets[0]?.sourceIndex).toBe(0);
      });

      it('emits importSettings carrying the 4 free-form fields verbatim', () => {
        const pack = toAssetPack(makeTAPMeta());
        expect(pack.importSettings.colorSpace).toBe('srgb');
        expect(pack.importSettings.mipmap).toBe('auto');
        expect(pack.importSettings.addressMode).toBe('repeat');
        expect(pack.importSettings.filterMode).toBe('linear');
      });

      it('byte-stable JSON round-trip: stringify(toAssetPack(...)) is idempotent (AC-16)', () => {
        const a = JSON.stringify(toAssetPack(makeTAPMeta()));
        const b = JSON.stringify(toAssetPack(makeTAPMeta()));
        expect(a).toBe(b);
      });

      // P1: toAssetPack produces subAssets[].kind === 'texture' instead of 'image'.
      it('P1: emits subAssets[].kind = "texture" (not "image")', () => {
        const pack = toAssetPack(makeTAPMeta());
        expect(pack.subAssets).toHaveLength(1);
        expect(pack.subAssets[0]?.kind).toBe('texture');
        expect(pack.subAssets[0]?.guid).toBe('01928000-7c00-7000-8000-000000000010');
      });
    });
  });
}
