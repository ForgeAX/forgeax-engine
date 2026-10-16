// w15 — TDD: fetchBinary decompress gate unit test
//
// Validates the fetchBinary decompression gate by loading assets through the
// AssetRegistry's loadByGuid with catalog entries carrying compression metadata.
//
// This test is intentionally RED before w19 because the current fetchBinary
// signature is `fetchBinary(url: string)` — it does NOT accept opts with
// `compression`, and there is no decompression gate inside makeLoadContext.
// After w19 implements the extended signature + decompression gate, all 4
// scenarios turn GREEN.
//
// Plan decisions:
//   D-2: fetchBinary signature extended to `fetchBinary(url, opts?)`
//   AC-02: single decompression gate inside fetchBinary
//   AC-14: backward compat = missing opts = passthrough
//   research Finding 2: 4 call sites at L1036/1100/1124/3905

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { packMeshBin } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// Stable non-colliding GUIDs for test assets.
const GUID_ZSTD = 'b0000000-0000-4000-a000-0000636f6465';
const GUID_NONE = 'b0000000-0000-4000-a000-00006e6f6e65';
const GUID_LEGACY = 'b0000000-0000-4000-a000-00006c656761';

const PACK_INDEX_URL = '/test-pack-index.json';

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
    'runtime://fetch-binary',
  );
  if (!packed.ok) throw new Error(packed.error.actual);
  return packed.value;
}

let originalFetch: typeof globalThis.fetch;

/**
 * All 4 scenarios:
 *
 * Before w19 (RED state): fetchBinary(url) has no decompression gate.
 *   - Scenario 1 (zstd): compressed bytes → unpackMeshBin sees zstd → FAILS
 *     → expect `result.ok === true` | currently `false` → TEST FAILS (RED)
 *   - Scenario 2 (none): uncompressed bytes → pass-through → succeess (green now)
 *   - Scenario 3 (legacy): no compression → pass-through → success (green now)
 *   - Scenario 4 (corrupt): corrupt bytes + compression='zstd' → codec error
 *     → expect `result.error.code === 'asset-parse-failed'` → RED until gate wired
 *
 * After w19: decompression gate wired, all 4 scenarios green.
 */
describe('w15: fetchBinary decompress gate', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // --- Scenario 1: zstd compression → asset loads (TDD-RED now, GREEN after w19) ---
  it('scenario 1: compression=zstd loads asset via decompress gate (TDD-RED: gate not yet wired)', async () => {
    const original = makeMeshBinPayload();

    const { compressZstd } = await import('@forgeax/engine-codec/encode');
    const compRes = await compressZstd(original);
    if (!compRes.ok) throw new Error('compressZstd failed for test fixture');
    const zstdBytes = compRes.value;

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_ZSTD,
                packageUrl: `/ddc/${GUID_ZSTD}.pack.json`,
                kind: 'mesh',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_ZSTD}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_ZSTD,
                  kind: 'mesh',
                  payload: {},
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_ZSTD}.bin`,
                      mediaType: 'application/x-forgeax-mesh',
                      contentEncoding: 'zstd',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(zstdBytes.buffer) });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const guid = parseGuid(GUID_ZSTD);
    const result = await reg.loadByGuid<MeshAsset>(guid);

    // TDD assertion — before w19, this EXPECTS success but the system FAILS
    // because fetchBinary doesn't decompress zstd bytes.
    // This assertion is currently RED.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('mesh');
    }
  });

  // --- Scenario 2: compression=none → pass-through ---
  it('scenario 2: compression=none passes bytes through as-is', async () => {
    const original = makeMeshBinPayload();

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_NONE,
                packageUrl: `/ddc/${GUID_NONE}.pack.json`,
                kind: 'mesh',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_NONE}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_NONE,
                  kind: 'mesh',
                  payload: {},
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_NONE}.bin`,
                      mediaType: 'application/x-forgeax-mesh',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(original.buffer) });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const guid = parseGuid(GUID_NONE);
    const result = await reg.loadByGuid<MeshAsset>(guid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('mesh');
    }
  });

  // --- Scenario 3: missing compression (backward compat) → pass-through ---
  it('scenario 3: missing compression (backward compat) passes bytes through', async () => {
    const original = makeMeshBinPayload();

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_LEGACY,
                packageUrl: `/ddc/${GUID_LEGACY}.pack.json`,
                kind: 'mesh',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_LEGACY}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_LEGACY,
                  kind: 'mesh',
                  payload: {},
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_LEGACY}.bin`,
                      mediaType: 'application/x-forgeax-mesh',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(original.buffer) });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const guid = parseGuid(GUID_LEGACY);
    const result = await reg.loadByGuid<MeshAsset>(guid);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('mesh');
    }
  });

  // --- Scenario 4: decompressZstd failure → asset-parse-failed (TDD-RED now, GREEN after w19) ---
  it('scenario 4: decompressZstd failure propagates as asset-parse-failed (TDD-RED: gate not yet wired)', async () => {
    const corrupt = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);

    globalThis.fetch = vi.fn().mockImplementation((input: string) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === PACK_INDEX_URL) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                guid: GUID_ZSTD,
                packageUrl: `/ddc/${GUID_ZSTD}.pack.json`,
                kind: 'mesh',
              },
            ]),
        });
      }
      if (url === `/ddc/${GUID_ZSTD}.pack.json`) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              schemaVersion: '2.0.0',
              kind: 'internal-text-package',
              assets: [
                {
                  guid: GUID_ZSTD,
                  kind: 'mesh',
                  payload: {},
                  refs: [],
                  artifacts: {
                    body: {
                      path: `${GUID_ZSTD}.bin`,
                      mediaType: 'application/x-forgeax-mesh',
                      contentEncoding: 'zstd',
                    },
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(corrupt.buffer) });
    }) as typeof globalThis.fetch;

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(PACK_INDEX_URL);

    const guid = parseGuid(GUID_ZSTD);
    const result = await reg.loadByGuid<MeshAsset>(guid);

    // The artifact boundary reports codec failures with its dedicated
    // structured error code rather than collapsing them into asset parsing.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('asset-artifact-decode-failed');
    }
  });
});
