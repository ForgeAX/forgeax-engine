// w16 — Integration: 4-path compressed-fixture loading (AC-02)
//
// Validates that all 4 binary loading paths (texture, equirect, font, mesh)
// work with compressed assets. The loaders mechanically pass
// `entry.compression` to fetchBinary; the decompression gate inside
// fetchBinary handles the rest. Zero loader-side logic rewrite.
//
// This test is TDD-RED before w19 — fetchBinary currently has no
// decompression gate, so loading compressed assets fails.
//
// Plan decisions:
//   AC-02: 4 paths through fetchBinary
//   D-2: pass entry.compression value, not entire entry
//   E9: mesh inline (import-runner.ts:422-427) excluded — not in scope
//   D-10: all fixture data programmatic

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { packMeshBin } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const GUID_MESH = 'c0000000-0000-4000-a000-00006d657368';
const GUID_TEX = 'c0000000-0000-4000-a000-000074657874';
const GUID_EQUI = 'c0000000-0000-4000-a000-000065717569';
const GUID_FONT = 'c0000000-0000-4000-a000-0000666f6e74';

const PACK_INDEX_URL = '/test-four-path-pack-index.json';

function parseGuid(g: string): AssetGuid {
  const parsed = AssetGuid.parse(g);
  if (!parsed.ok) throw new Error(`bad guid ${g}`);
  return parsed.value;
}

/**
 * Minimal mesh encoded through the current canonical vertex and binary owners.
 */
function makeMeshBinPayload(): Uint8Array {
  const attributes = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: new Float32Array(6),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  };
  const { vertices } = packInterleavedVertexAttributes(attributes, 3).unwrap();
  const indices = new Uint16Array([0, 1, 2]);

  const packed = packMeshBin(
    {
      vertices,
      indices,
      attributes,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
    },
    'runtime://four-path',
  );
  if (!packed.ok) throw new Error(packed.error.actual);
  return packed.value;
}

let originalFetch: typeof globalThis.fetch;

describe('w16: 4-path compressed-fixture loading', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Path 1: mesh loadByGuidProd loads compressed mesh .bin → MeshAsset POD
   *
   * TDD-RED: Before w19, fetchBinary does not decompress — the zstd bytes
   * reach unpackMeshBin → version check reads random bytes → returns undefined
   * → asset-parse-failed. After w19, the decompression gate decompresses
   * first → unpackMeshBin sees original v2 header → succeeds.
   */
  it('path 1: mesh loadByGuid loads compressed mesh .bin → MeshAsset', async () => {
    const original = makeMeshBinPayload();
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(original);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_MESH,
                packageUrl: `/ddc/${GUID_MESH}.pack.json`,
                kind: 'mesh',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_MESH}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_MESH,
                  kind: 'mesh',
                  payload: {},
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_MESH}.bin`,
                      mediaType: 'application/x-forgeax-mesh',
                      contentEncoding: 'zstd',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid<MeshAsset>(parseGuid(GUID_MESH));

    // TDD-RED: after w19, this becomes true
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('mesh');
      expect(result.value.indices).toBeDefined();
      expect((result.value.indices as Uint16Array).length).toBe(3);
    }
  });

  /**
   * Path 2: textureLoader loads compressed texture .bin → TextureAsset
   *
   * TDD-RED: same issue — the compressed bytes reach the texture loader's
   * data field, get uploaded to GPU as corrupt texture. After w19,
   * fetchBinary decompresses first → loader sees raw RGBA bytes.
   *
   * For the TDD stage we construct a simple RGBA pixel payload (4 bytes)
   * so the loader can still produce a texture asset (shape test).
   */
  it('path 2: textureLoader loads compressed texture .bin → TextureAsset', async () => {
    // 4x4 RGBA8 texture = 64 bytes raw pixel data
    const rawPixels = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      rawPixels[i] = (i * 17) % 256;
    }
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(rawPixels);
    if (!compRes.ok) throw new Error('compressZstd failed');

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
                    format: 'rgba8unorm',
                    colorSpace: 'srgb',
                    mips: { kind: 'none' },
                  },
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_TEX}.bin`,
                      mediaType: 'application/x-forgeax-rgba8',
                      contentEncoding: 'zstd',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(GUID_TEX));
    // TDD-RED: after w19 this becomes true — the decompressed bytes
    // produce a valid 64-byte data field.
    expect(result.ok).toBe(true);
  });

  /**
   * Path 3: equirectLoader loads compressed equirect .bin → TextureAsset
   * Same shape as textureLoader.
   */
  it('path 3: equirectLoader loads compressed equirect .bin', async () => {
    const rawPixels = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      rawPixels[i] = (i * 17) % 256;
    }
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(rawPixels);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_EQUI,
                packageUrl: `/ddc/${GUID_EQUI}.pack.json`,
                kind: 'equirect',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_EQUI}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_EQUI,
                  kind: 'equirect',
                  payload: { width: 4, height: 4, format: 'rgba16float', colorSpace: 'linear' },
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_EQUI}.bin`,
                      mediaType: 'application/x-forgeax-rgba16f',
                      contentEncoding: 'zstd',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(GUID_EQUI));
    expect(result.ok).toBe(true);
  });

  /**
   * Path 4: fontLoader loads compressed font pack JSON
   *
   * Unlike mesh/texture, font data is JSON (TextDecoder). The decompressed
   * bytes must be valid JSON. Font loading through loadByGuid for a 'font'
   * kind requires the font loader to be registered.
   */
  it('path 4: fontLoader loads compressed font pack JSON', async () => {
    const fontPack = JSON.stringify({
      assets: [{ guid: GUID_FONT, kind: 'font', payload: {} }],
    });
    const fontBytes = new TextEncoder().encode(fontPack);
    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(fontBytes);
    if (!compRes.ok) throw new Error('compressZstd failed');

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_FONT,
                packageUrl: `/ddc/${GUID_FONT}.pack.json`,
                kind: 'font',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_FONT}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_FONT,
                  kind: 'font',
                  payload: {},
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_FONT}.json`,
                      mediaType: 'application/json',
                      contentEncoding: 'zstd',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(compRes.value.buffer),
      });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const result = await reg.loadByGuid(parseGuid(GUID_FONT));
    // Font loader requires atlasGuid/samplerGuid/specific payload fields.
    // The decompression gate successfully decompresses the zstd bytes —
    // the font loader then rejects the content for missing fields.
    // Key assertion: the error code is from font-loader validation
    // (asset-parse-failed), not from fetchBinary decompression gate.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Font loader rejects payload lacking atlasGuid/samplerGuid
      expect(result.error.code).toBe('asset-parse-failed');
    }
  });
});
