// w31 -- transcode fallback dispatch unit tests (AC-04, section 8 P3).
//
// `loadTextureAsset` grows a Basis arm (w34): when a catalog row's
// `compression` is a `basis-*` member, the loader parses the KTX2 container,
// picks a transcode target from `ctx.transcodeCaps` via the codec's pure
// `selectTranscodeTarget`, transcodes, and stamps `TextureAsset.format` with the
// chosen target. Degradation is silent but OBSERVABLE: with no compression cap
// the arm lands on `rgba8unorm[-srgb]` and `tex.format` reflects that reality
// (never a black texture -- section 8 P3).
//
// This test keeps the REAL `selectTranscodeTarget` (its priority chain is
// codec-w8's concern) and mocks only the container-parse + WASM-transcode seams
// (`parseKtx2` / `transcodeKtx2`), so it validates the LOADER's dispatch:
// caps + build-time model -> target -> `tex.format`.
//
// TDD-RED before w33 (LoadContext.transcodeCaps) + w34 (the Basis arm).
//
// Constraints (plan-tasks w31):
//   - no real transcoder WASM execution (mocked transcode echoes the target)
//   - no equirect fallback (w32 owns that)
//   - degradation is not an error (only corrupt payloads raise transcode-failed)

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { TranscodeCaps } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// Mock only the container-parse + WASM-transcode seams; keep the real
// selectTranscodeTarget / KTX2_IDENTIFIER / block-format table.
vi.mock('@forgeax/engine-codec', async (importActual) => {
  const actual = await importActual<typeof import('@forgeax/engine-codec')>();
  return {
    ...actual,
    // Basis colorModel echoed via header/dfd; the loader derives the model from
    // the catalog `compression` member, so the parsed shape only needs a valid
    // header + rawBytes.
    parseKtx2: vi.fn(async (bytes: Uint8Array) => ({
      ok: true as const,
      value: {
        header: {
          vkFormat: 0,
          typeSize: 1,
          pixelWidth: 4,
          pixelHeight: 4,
          pixelDepth: 0,
          layerCount: 0,
          faceCount: 1,
          levelCount: 1,
          supercompressionScheme: 1,
        },
        index: {
          dfdByteOffset: 0,
          dfdByteLength: 0,
          kvdByteOffset: 0,
          kvdByteLength: 0,
          sgdByteOffset: 0,
          sgdByteLength: 0,
        },
        levelIndex: [{ byteOffset: 0, byteLength: bytes.length, uncompressedByteLength: 0 }],
        dfd: null,
        kvEntries: [],
        sgd: null,
        rawBytes: bytes,
      },
    })),
    ktx2ColorSpace: vi.fn(() => mockedColorSpace),
    // Echo the requested target so tex.format == the selected transcode target.
    transcodeKtx2: vi.fn(async (_parsed: unknown, targetFormat: GPUTextureFormat) => ({
      ok: true as const,
      value: {
        format: targetFormat,
        width: 4,
        height: 4,
        mips: [{ level: 0, width: 4, height: 4, data: new Uint8Array(16) }],
      },
    })),
  };
});

const GUID_TEX = 'c0000000-0000-4000-a000-000074657874';
const PACK_INDEX_URL = '/test-transcode-fallback-pack-index.json';
let mockedColorSpace: 'srgb' | 'linear' = 'srgb';
// A minimal buffer whose first 12 bytes are the KTX2 identifier so the loader's
// magic dispatch enters the codec arm.
const KTX2_MAGIC = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

let originalFetch: typeof globalThis.fetch;

function wireFetch(
  compression: 'basis-uastc' | 'basis-etc1s',
  colorSpace: 'srgb' | 'linear',
): void {
  mockedColorSpace = colorSpace;
  globalThis.fetch = vi.fn().mockImplementation((input: string) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === PACK_INDEX_URL) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              guid: GUID_TEX,
              packageUrl: `/ddc/${GUID_TEX}.pack.json`,
              kind: 'texture',
            },
          ]),
      });
    }
    if (url === `/ddc/${GUID_TEX}.pack.json`) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: GUID_TEX,
                kind: 'texture',
                payload: {
                  shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
                  colorSpace,
                  mips: { kind: 'none' },
                },
                refs: [],
                artifacts: {
                  body: {
                    path: `${GUID_TEX}.ktx2`,
                    mediaType: 'image/ktx2',
                    assetCodec: {
                      name: 'basis',
                      container: 'ktx2',
                      profile: compression.slice(6),
                    },
                  },
                },
              },
            ],
          }),
      });
    }
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(KTX2_MAGIC.buffer) });
  }) as typeof globalThis.fetch;
}

async function loadFormat(
  caps: TranscodeCaps,
  compression: 'basis-uastc' | 'basis-etc1s',
  colorSpace: 'srgb' | 'linear' = 'srgb',
): Promise<{ ok: boolean; format?: GPUTextureFormat }> {
  wireFetch(compression, colorSpace);
  const reg = new AssetRegistry(makeMockShaderRegistry());
  reg.configurePackIndex(PACK_INDEX_URL);
  reg.setTranscodeCaps(caps);
  const result = await reg.loadByGuid(parseGuid(GUID_TEX));
  if (!result.ok) return { ok: false };
  return { ok: true, format: (result.value as { format: GPUTextureFormat }).format };
}

const NO_CAPS: TranscodeCaps = { bc: false, etc2: false, astc: false };
const BC_ONLY: TranscodeCaps = { bc: true, etc2: false, astc: false };

describe('loadTextureAsset -- transcode fallback dispatch (w31, AC-04)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('no cap -> rgba8unorm-srgb fallback, format field reflects reality', async () => {
    const out = await loadFormat(NO_CAPS, 'basis-uastc', 'srgb');
    expect(out.ok).toBe(true);
    expect(out.format).toBe('rgba8unorm-srgb');
  });

  it('no cap + linear -> rgba8unorm fallback', async () => {
    const out = await loadFormat(NO_CAPS, 'basis-etc1s', 'linear');
    expect(out.ok).toBe(true);
    expect(out.format).toBe('rgba8unorm');
  });

  it('bc-only -> BC7 target, format field is the block format', async () => {
    const out = await loadFormat(BC_ONLY, 'basis-uastc', 'srgb');
    expect(out.ok).toBe(true);
    expect(out.format).toBe('bc7-rgba-unorm-srgb');
  });

  it('bc-only linear -> bc7-rgba-unorm (no srgb suffix)', async () => {
    const out = await loadFormat(BC_ONLY, 'basis-etc1s', 'linear');
    expect(out.ok).toBe(true);
    expect(out.format).toBe('bc7-rgba-unorm');
  });

  it('every caps path loads without throwing (degradation is normal, not an error)', async () => {
    for (const caps of [NO_CAPS, BC_ONLY, { bc: false, etc2: true, astc: false }] as const) {
      const out = await loadFormat(caps, 'basis-uastc', 'srgb');
      expect(out.ok).toBe(true);
    }
  });
});
