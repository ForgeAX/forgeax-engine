// loader name survival through JSON roundtrip — AC-08 (feat-20260618 w20).
//
// Red-first: written before w15 wires entry.name -> registerPackage.
//
// dawn smoke walks the in-memory register path and skips the
// JSON.stringify -> fetch -> JSON.parse pack-body path (AGENTS.md smoke gate +
// memory typed-array-json-roundtrip-asymmetric-loader-contract). This test
// drives the prod loadByGuid path with a JSON-roundtripped pack-index so a name
// that does not survive the roundtrip is caught here.
//
// Coverage:
//   AC-08 sync  — two meshes sharing a .pack.json, each with a pack-index name;
//                 after loadByGuid (parseAssetPayload sync branch) resolveName
//                 returns each stored name.
//   AC-08 async — a texture in its own (single-asset) package; after loadByGuid
//                 (texture upstream async branch) resolveName preserves the
//                 explicit entry name. Without the entry -> Package wiring the
//                 texture would land in a null package and resolveName would be
//                 '' -- so the named result proves the async load path registered
//                 the package post-roundtrip.
//   FALSIFY     — the same pack with the entry name stripped degrades to
//                 basename(path), proving the assertion is name-sensitive (not
//                 a tautology). The FALSIFY block does not gate CI; it documents
//                 discriminating power.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

const MESH_A = '70000000-0000-4000-7000-000000000001';
const MESH_B = '70000000-0000-4000-7000-000000000002';
const TEX = '70000000-0000-4000-7000-0000000000aa';
const SHARED_PACK_URL = '/packs/char.pack.json';
const TEX_URL = '/assets/diffuse.pack.json';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

const MESH_PAYLOAD_A = {
  vertices: [
    -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 0, -0.5,
    0, 1, 0, 1, 1, 1, 0, 0, 1,
  ],
  indices: [0, 1, 2],
  attributes: {},
  submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
};
const MESH_PAYLOAD_B = {
  vertices: [
    0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1,
    1, 1, 0, 0,
  ],
  indices: [1, 0, 2],
  attributes: {},
  submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
};

function makeSharedPack(): unknown {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      { guid: MESH_A, kind: 'mesh', payload: MESH_PAYLOAD_A, refs: [], artifacts: {} },
      { guid: MESH_B, kind: 'mesh', payload: MESH_PAYLOAD_B, refs: [], artifacts: {} },
    ],
  };
}

const TEX_METADATA = {
  kind: 'texture',
  shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
  format: 'rgba8unorm',
  colorSpace: 'srgb',
  mips: { kind: 'none' },
};

// `includeNames=false` is the FALSIFY variant (entry.name stripped).
function makePackIndex(includeNames: boolean): unknown[] {
  const named = (n: string) => (includeNames ? { name: n } : {});
  return [
    {
      guid: MESH_A,
      packageUrl: SHARED_PACK_URL,
      kind: 'mesh',
      sourcePath: 'char.glb',
      ...named('Body'),
    },
    {
      guid: MESH_B,
      packageUrl: SHARED_PACK_URL,
      kind: 'mesh',
      sourcePath: 'char.glb',
      ...named('Head'),
    },
    {
      guid: TEX,
      packageUrl: TEX_URL,
      kind: 'texture',
      sourcePath: 'diffuse.png',
      ...named('Diffuse'),
    },
  ];
}

// Roundtrip every fetched body through JSON.stringify -> JSON.parse, mirroring
// the dev-server pack-body transport that dawn smoke skips.
function jsonRoundtrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function installFetch(includeNames: boolean): void {
  const packIndex = jsonRoundtrip(makePackIndex(includeNames));
  const sharedPack = jsonRoundtrip(makeSharedPack());
  const texBytes = new Uint8Array(1 * 1 * 4).fill(200);
  globalThis.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('pack-index.json')) {
      return new Response(JSON.stringify(packIndex), { status: 200 });
    }
    if (u === SHARED_PACK_URL) {
      return new Response(JSON.stringify(sharedPack), { status: 200 });
    }
    if (u === TEX_URL) {
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: TEX,
              kind: 'texture',
              payload: TEX_METADATA,
              refs: [],
              artifacts: {
                body: { path: 'diffuse.bin', mediaType: 'application/x-forgeax-rgba8' },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u === '/assets/diffuse.bin') {
      return new Response(texBytes, { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

describe('loader name survival (AC-08)', () => {
  let originalFetch: typeof globalThis.fetch | undefined;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sync branch: multi-asset mesh names survive the JSON roundtrip', async () => {
    installFetch(true);
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const rA = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_A));
    const rB = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_B));
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);

    expect(reg.resolveName(MESH_A)).toBe('Body');
    expect(reg.resolveName(MESH_B)).toBe('Head');
  });

  it('async branch: texture package resolves via the async load path post-roundtrip', async () => {
    installFetch(true);
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const r = await reg.loadByGuid(parseGuid(TEX));
    expect(r.ok).toBe(true);
    // An explicit entry name wins even for a single-asset package. The wiring
    // makes this name survive the async JSON-roundtrip path.
    expect(reg.resolveName(TEX)).toBe('Diffuse');
  });

  it('FALSIFY: stripped entry.name degrades to basename, proving name-sensitivity', async () => {
    installFetch(false);
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const rA = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_A));
    const rB = await reg.loadByGuid<TypesMeshAsset>(parseGuid(MESH_B));
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);

    // Multi-asset package with no stored names -> basename(cooked packageUrl),
    // NOT the original 'Body' / 'Head'. If the assertion still
    // saw 'Body', the name path would be a tautology.
    expect(reg.resolveName(MESH_A)).toBe('char.pack.json');
    expect(reg.resolveName(MESH_B)).toBe('char.pack.json');
  });
});
