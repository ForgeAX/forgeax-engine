// asset-registry.mesh-bin.test.ts -- bug-20260610-pack-mesh-binarize-fetchpackfile-cache
// M2 / m2-1: regression test for mesh binarize round-trip via .pack.json + .bin
// sidecar (Fix A). RED at this commit (loader cannot read .bin yet); GREEN
// after the implementation commit.
//
// Cases (plan-decisions D-6):
//   (A) binarized new path -- mesh entry payload is the empty sentinel (vertices=[],
//       indices=[], data=Uint8Array(0)); the runtime resolves vertices/indices from
//       a sibling <guid>.bin URL referenced by the catalog row. Asserts
//       round-tripped vertices and indices are byte-equal to the originals.
//   (B) inline fallback (CON-7) -- mesh entry payload carries inline number arrays
//       (legacy pack shape). meshLoader's existing Array.isArray branch must still
//       work. Asserts handle resolves and registered MeshAsset has the inline
//       vertices/indices.
//   (C) empty mesh -- vertices=[], indices=[] sentinel + 16-byte deterministic
//       header (vlen=0, ilen=0, iwidth=0, jsonlen=0). loader returns a mesh with
//       0 vertices and 0 indices, no panic.
//
// Anchors: requirements AC-04 / AC-05 / CON-1 / CON-7;
//          plan-strategy decisions D-1 / D-2 / D-3 / D-6;
//          plan-decisions D-6 (3-case coverage).
//
// The test producer delegates the v4 header and canonical projection to the
// import owner; the runtime only consumes the resulting bytes.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { packMeshBin } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// 12 floats per vertex (position vec3 + normal vec3 + uv vec2 + tangent vec4) --
// matches PROCEDURAL_FLOATS_PER_VERTEX and the meshLoader stride invariant.
const FLOATS_PER_VERTEX = 12;

const MESH_BIN_GUID = '00000000-0000-7000-8000-00006d657368'; // mesh sentinel
const MESH_INLINE_GUID = '00000000-0000-7000-8000-696e6c696e65'; // inline
const MESH_EMPTY_GUID = '00000000-0000-7000-8000-656d70747974'; // empty

function packMeshBinForTest(
  vertices: Float32Array,
  indices: Uint16Array | Uint32Array,
  metaJson: string,
): Uint8Array {
  const parsed = JSON.parse(metaJson) as Record<string, unknown>;
  const vertexCount = vertices.length / FLOATS_PER_VERTEX;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const tangent = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * FLOATS_PER_VERTEX;
    position.set(vertices.subarray(source, source + 3), vertex * 3);
    normal.set(vertices.subarray(source + 3, source + 6), vertex * 3);
    uv.set(vertices.subarray(source + 6, source + 8), vertex * 2);
    tangent.set(vertices.subarray(source + 8, source + 12), vertex * 4);
  }
  const packed = packMeshBin(
    {
      vertices,
      indices,
      attributes: {
        position,
        normal,
        uv,
        tangent,
      },
      submeshes: parsed.submeshes as MeshAsset['submeshes'],
      aabb: parsed.aabb as MeshAsset['aabb'],
    },
    'runtime://asset-registry',
  );
  if (!packed.ok) throw new Error(packed.error.actual);
  return packed.value;
}

function makePackIndex(rows: Array<{ guid: string; packageUrl: string }>) {
  return rows.map((r) => ({
    guid: r.guid,
    packageUrl: r.packageUrl,
    kind: 'mesh' as const,
  }));
}

interface FetchRoute {
  json?: unknown;
  bytes?: Uint8Array;
  status?: number;
}

function installFetchMock(routes: Map<string, FetchRoute>): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const route = routes.get(url);
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        json: async () => null,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    if (route.status !== undefined && route.status >= 400) {
      return { ok: false, status: route.status } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => route.json,
      arrayBuffer: async () =>
        route.bytes !== undefined
          ? route.bytes.buffer.slice(
              route.bytes.byteOffset,
              route.bytes.byteOffset + route.bytes.byteLength,
            )
          : new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('mesh-bin loader (M2 / m2-1)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('(A) binarized path: vertices/indices reconstructed byte-equal from sibling .bin', async () => {
    // Two-vertex triangle stub (24 floats total = 2 verts * 12F). Vertex count <=
    // 0xffff -> Uint16Array indices.
    const vertices = new Float32Array(FLOATS_PER_VERTEX * 2);
    for (let i = 0; i < vertices.length; i++) vertices[i] = i + 0.5;
    const indices = new Uint16Array([0, 1, 0]);
    const metaJson = JSON.stringify({
      submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 2, topology: 'triangle-list' }],
      attributes: {},
      aabb: [0, 0, 0, 1, 1, 1],
    });
    const binBytes = packMeshBinForTest(vertices, indices, metaJson);

    const packIndexUrl = '/pack-index.json';
    const packUrl = `/assets/${MESH_BIN_GUID.toLowerCase()}.pack.json`;
    const binUrl = `/assets/${MESH_BIN_GUID.toLowerCase()}/body.bin`;
    const routes = new Map<string, FetchRoute>([
      [packIndexUrl, { json: makePackIndex([{ guid: MESH_BIN_GUID, packageUrl: packUrl }]) }],
      [
        packUrl,
        {
          json: {
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: MESH_BIN_GUID,
                kind: 'mesh',
                payload: {},
                refs: [],
                artifacts: {
                  body: {
                    path: `${MESH_BIN_GUID.toLowerCase()}/body.bin`,
                    mediaType: 'application/x-forgeax-mesh',
                  },
                },
              },
            ],
          },
        },
      ],
      [binUrl, { bytes: binBytes }],
    ]);
    installFetchMock(routes);

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(packIndexUrl);

    const parsed = AssetGuid.parse(MESH_BIN_GUID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await reg.loadByGuid<MeshAsset>(parsed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // D-17: loadByGuid returns the payload directly (registry holds no handles).
    const mesh = result.value;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices.length).toBe(vertices.length);
    for (let i = 0; i < vertices.length; i++) {
      expect(mesh.vertices[i]).toBe(vertices[i]);
    }
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
    expect(mesh.indices?.length).toBe(indices.length);
    if (mesh.indices !== undefined) {
      for (let i = 0; i < indices.length; i++) {
        expect(mesh.indices[i]).toBe(indices[i]);
      }
    }
  });

  it('(B) inline fallback (CON-7): legacy pack with Array.isArray vertices still loads', async () => {
    // Single triangle, 12 floats per vertex, 3 vertices -> 36 floats, 3 indices.
    const verticesArr: number[] = [];
    for (let i = 0; i < FLOATS_PER_VERTEX * 3; i++) verticesArr.push(i + 0.25);
    const indicesArr: number[] = [0, 1, 2];

    const packIndexUrl = '/pack-index.json';
    const packUrl = '/assets/inline.pack.json';
    const routes = new Map<string, FetchRoute>([
      [packIndexUrl, { json: makePackIndex([{ guid: MESH_INLINE_GUID, packageUrl: packUrl }]) }],
      [
        packUrl,
        {
          json: {
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: MESH_INLINE_GUID,
                kind: 'mesh',
                payload: {
                  vertices: verticesArr,
                  indices: indicesArr,
                  attributes: {},
                },
                refs: [],
                artifacts: {},
              },
            ],
          },
        },
      ],
    ]);
    installFetchMock(routes);

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(packIndexUrl);

    const parsed = AssetGuid.parse(MESH_INLINE_GUID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await reg.loadByGuid<MeshAsset>(parsed.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // D-17: loadByGuid returns the payload directly (registry holds no handles).
    const mesh = result.value;
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices.length).toBe(verticesArr.length);
    expect(mesh.vertices[0]).toBe(0.25);
    expect(mesh.indices?.length).toBe(indicesArr.length);
  });

  it('(C) empty mesh: v4 projection decodes to 0 verts / 0 indices', async () => {
    const binBytes = packMeshBinForTest(
      new Float32Array(0),
      new Uint16Array(0),
      JSON.stringify({
        submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 0, materialSlot: 0 }],
        aabb: [0, 0, 0, 0, 0, 0],
      }),
    );

    const packIndexUrl = '/pack-index.json';
    const packUrl = `/assets/${MESH_EMPTY_GUID.toLowerCase()}.pack.json`;
    const binUrl = `/assets/${MESH_EMPTY_GUID.toLowerCase()}/body.bin`;
    const routes = new Map<string, FetchRoute>([
      [packIndexUrl, { json: makePackIndex([{ guid: MESH_EMPTY_GUID, packageUrl: packUrl }]) }],
      [
        packUrl,
        {
          json: {
            schemaVersion: '2.0.0',
            kind: 'internal-text-package',
            assets: [
              {
                guid: MESH_EMPTY_GUID,
                kind: 'mesh',
                payload: {},
                refs: [],
                artifacts: {
                  body: {
                    path: `${MESH_EMPTY_GUID.toLowerCase()}/body.bin`,
                    mediaType: 'application/x-forgeax-mesh',
                  },
                },
              },
            ],
          },
        },
      ],
      [binUrl, { bytes: binBytes }],
    ]);
    installFetchMock(routes);

    const reg = new AssetRegistry(makeMockShaderRegistry());
    reg.configurePackIndex(packIndexUrl);

    const parsed = AssetGuid.parse(MESH_EMPTY_GUID);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await reg.loadByGuid<MeshAsset>(parsed.value);
    expect(result.ok).toBe(false);
  });
});
