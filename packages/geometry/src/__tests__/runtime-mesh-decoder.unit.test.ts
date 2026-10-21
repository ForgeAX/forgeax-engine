import { cookMeshDistanceFieldProduct } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type ArtifactDescriptor,
  type AssetRuntimeArtifactDescriptor,
  type MeshAsset,
  ok,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { meshAssetDecoder } from '../assets/mesh-decoder';
import { createBoxGeometry } from '../box';
import { withMeshAabb } from '../mesh-aabb';
import { buildMeshCollision } from '../mesh-collision';
import { packMeshBin } from '../mesh-data';
import { packInterleavedVertexAttributes } from '../vertex-attribute-layout';

async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function decode(
  payload: unknown,
  artifacts: Readonly<Record<string, { descriptor: ArtifactDescriptor; bytes: Uint8Array }>> = {},
  refs: readonly string[] = [],
) {
  return meshAssetDecoder.decode({
    envelope: {
      guid: 'mesh-fixture',
      kind: 'mesh',
      payload: payload as MeshAsset,
      refs,
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([key, value]) => [
          key,
          {
            ...value.descriptor,
            contentEncoding: 'identity' as const,
            byteLength: value.bytes.byteLength,
          } as AssetRuntimeArtifactDescriptor,
        ]),
      ),
    },
    artifacts: {
      read: async (descriptor) => {
        const artifact = Object.values(artifacts).find(
          (value) => value.descriptor.path === descriptor.path,
        );
        if (artifact === undefined) throw new Error('unexpected artifact read');
        return ok(artifact.bytes);
      },
    },
    signal: new AbortController().signal,
  });
}

const meshBody = (bytes: Uint8Array) => ({
  body: {
    descriptor: {
      path: 'mesh.bin',
      mediaType: 'application/x-forgeax-mesh',
      assetCodec: { name: 'mesh-binary', version: '5' },
    },
    bytes,
  },
});

describe('Geometry runtime decoder', () => {
  it('decodes procedural descriptors and JSON geometry without a second runtime loader', async () => {
    expect((await decode({ geometry: 'procedural-cube' })).unwrap()).toEqual(
      createBoxGeometry(1, 1, 1).unwrap(),
    );
    const source = createBoxGeometry(1, 2, 3).unwrap();
    const json = JSON.parse(
      JSON.stringify(source, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
      ),
    );
    delete json.submeshes;
    const restored = (await decode(json)).unwrap();
    expect(restored.vertices).toEqual(source.vertices);
    expect(Array.from(restored.indices ?? [])).toEqual(Array.from(source.indices ?? []));
    expect(restored.attributes).toEqual(source.attributes);
    expect(restored.submeshes).toEqual(source.submeshes);
  });

  it('keeps empty meshes finite through JSON, binary and runtime bounds preparation', async () => {
    const source = createBoxGeometry(1, 1, 1).unwrap();
    const attributes = Object.fromEntries(
      Object.keys(source.attributes).map((key) => [key, new Float32Array(0)]),
    );
    const empty = {
      ...source,
      vertices: new Float32Array(0),
      indices: undefined,
      attributes,
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 0,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        },
      ],
      aabb: undefined,
    };
    const { indices: _, aabb: __, ...mesh } = empty;
    const bytes = packMeshBin(mesh, 'empty').unwrap();
    for (const loaded of [
      (await decode({ kind: 'mesh' }, meshBody(bytes))).unwrap(),
      (
        await decode(
          JSON.parse(
            JSON.stringify(mesh, (_key, value) =>
              ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
            ),
          ),
        )
      ).unwrap(),
    ]) {
      expect(loaded.vertices.length).toBe(0);
      expect(loaded.submeshes[0]?.vertexCount).toBe(0);
      expect(loaded.aabb).toEqual(new Float32Array(6));
      expect(withMeshAabb(mesh).aabb).toEqual(new Float32Array(6));
    }
  });

  it('retains skin streams and accepts an empty index array as vertex-only geometry', async () => {
    const source = createBoxGeometry(1, 1, 1).unwrap();
    const json = JSON.parse(
      JSON.stringify(source, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
      ),
    );
    json.indices = [];
    json.submeshes[0].indexCount = 0;
    const vertexOnly = (await decode(json)).unwrap();
    expect(vertexOnly.indices).toBeUndefined();
    expect(vertexOnly.submeshes[0]?.vertexCount).toBe(24);
    json.attributes.skinIndex = new Array(24 * 4).fill(0);
    json.attributes.skinWeight = Array.from({ length: 24 * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0));
    const attributes = {
      ...source.attributes,
      skinIndex: new Uint16Array(json.attributes.skinIndex),
      skinWeight: new Float32Array(json.attributes.skinWeight),
    };
    const skinned = {
      ...source,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, 24).unwrap().vertices,
    };
    const skinJson = JSON.parse(
      JSON.stringify(skinned, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
      ),
    );
    const loaded = (await decode(skinJson)).unwrap();
    expect(loaded.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(loaded.attributes.skinWeight).toEqual(new Float32Array(json.attributes.skinWeight));
  });

  it('preserves a single point as equal minimum and maximum bounds', async () => {
    const point = new Float32Array([3, -2, 7]);
    const mesh: MeshAsset = {
      kind: 'mesh',
      vertices: point,
      attributes: { position: point },
      submeshes: [
        { indexOffset: 0, indexCount: 0, vertexCount: 1, topology: 'point-list', materialSlot: 0 },
      ],
    };
    const binary = packMeshBin(mesh, 'point').unwrap();
    const json = JSON.parse(
      JSON.stringify(mesh, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
      ),
    );
    for (const loaded of [
      (await decode(json)).unwrap(),
      (await decode({ kind: 'mesh' }, meshBody(binary))).unwrap(),
    ]) {
      expect(loaded.aabb).toEqual(new Float32Array([3, -2, 7, 3, -2, 7]));
    }
  });

  it('retains collision, lower-detail references, authored attributes and hysteresis through binary and JSON transport', async () => {
    const lodGuid = '019d0000-0000-7000-8000-000000000008';
    const source = createBoxGeometry(1, 2, 3).unwrap();
    const lod = AssetGuid.parse(lodGuid);
    if (!lod.ok) throw new Error('fixture GUID');
    const mesh: MeshAsset = {
      ...source,
      collision: buildMeshCollision(source).unwrap(),
      lods: [{ mesh: lod.value, screenCoverage: 0.5 }],
      lodHysteresis: 0.2,
    };
    const binary = packMeshBin(mesh, 'mesh', [lodGuid]).unwrap();
    const loaded = (await decode({}, meshBody(binary), [lodGuid])).unwrap();
    expect(loaded).toMatchObject({
      collision: mesh.collision,
      lods: mesh.lods,
      lodHysteresis: 0.2,
    });
    expect(loaded.attributes).toEqual(mesh.attributes);
    expect((await decode({}, meshBody(binary), [])).ok).toBe(false);
    const json = JSON.parse(
      JSON.stringify({ ...mesh, lods: [{ mesh: lodGuid, screenCoverage: 0.5 }] }, (_key, value) =>
        ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
      ),
    );
    const restored = (await decode(json)).unwrap();
    expect({ ...restored, indices: undefined }).toEqual({ ...mesh, indices: undefined });
    expect(Array.from(restored.indices ?? [])).toEqual(Array.from(mesh.indices ?? []));
    expect((await decode({ ...mesh, collision: { positions: [], indices: [] } })).ok).toBe(false);
  });

  it('rejects two geometry sources, corrupt binaries and malformed inline attributes instead of dropping them', async () => {
    const source = createBoxGeometry(1, 2, 3).unwrap();
    const binary = packMeshBin(source, 'mesh').unwrap();
    for (const payload of [
      source,
      { indices: [] },
      { attributes: source.attributes },
      { aabb: source.aabb },
      { geometry: 'procedural-cube' },
    ]) {
      expect((await decode(payload, meshBody(binary))).ok).toBe(false);
    }
    expect((await decode({ ...source, geometry: 'procedural-cube' })).ok).toBe(false);
    for (const payload of [null, [], 3]) expect((await decode(payload)).ok).toBe(false);
    for (const bytes of [new Uint8Array([3, 0, 0]), new Uint8Array([...binary, 0])])
      expect(await decode({}, meshBody(bytes))).toMatchObject({
        ok: false,
        error: { code: 'asset-package-invalid' },
      });
    for (const patch of [
      { vertices: false },
      { indices: false },
      { attributes: { ...source.attributes, skinIndex: false } },
      { morphTargets: [{ unsupported: [1, 2, 3] }] },
      { lods: [{ mesh: 'invalid', screenCoverage: 0.5 }] },
      { lodHysteresis: 1 },
    ])
      expect((await decode({ ...source, ...patch })).ok, JSON.stringify(patch)).toBe(false);
  });

  it.each([
    0.5,
    { resolution: 12 },
  ])('retains verified distance-field identity for %j', async (sampling) => {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const product = await cookMeshDistanceFieldProduct(mesh, 'mesh-field', sampling, [0]);
    const field = product.artifacts['distance-field.bin'];
    if (field.assetCodec === undefined) throw new Error('missing field codec');
    const descriptor = {
      path: 'distance-field.bin',
      mediaType: field.mediaType,
      assetCodec: { ...field.assetCodec },
      integrity: {
        algorithm: 'sha256' as const,
        digest: await digest(field.bytes),
      },
    };
    const identity = structuredClone({
      assetCodec: descriptor.assetCodec,
      integrity: descriptor.integrity,
    });
    const artifacts = { 'distance-field.bin': { descriptor, bytes: field.bytes } };
    const pending = decode({ ...mesh, distanceField: product.payload }, artifacts);
    descriptor.integrity.digest = `sha256:${'0'.repeat(64)}`;
    descriptor.assetCodec.profile = 'changed-after-decode-started';
    expect((await pending).unwrap().distanceField?.artifact).toEqual(identity);
  });

  it('rejects incomplete, stale and differently sided distance-field products', async () => {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const product = await cookMeshDistanceFieldProduct(mesh, 'mesh-field', { resolution: 12 }, [0]);
    const field = product.artifacts['distance-field.bin'];
    if (field.assetCodec === undefined) throw new Error('missing field codec');
    const descriptor = {
      path: 'distance-field.bin',
      mediaType: field.mediaType,
      assetCodec: field.assetCodec,
      integrity: {
        algorithm: 'sha256' as const,
        digest: await digest(field.bytes),
      },
    };
    const artifacts = { 'distance-field.bin': { descriptor, bytes: field.bytes } };
    const payload = { ...mesh, distanceField: product.payload };
    expect((await decode(payload, artifacts)).unwrap().distanceField?.policy.kind).toBe(
      'signed-solid',
    );
    expect((await decode(payload)).ok).toBe(false);
    expect((await decode(mesh, artifacts)).ok).toBe(false);
    expect(
      (
        await decode(
          { ...createBoxGeometry(2, 1, 1).unwrap(), distanceField: product.payload },
          artifacts,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await decode({ ...mesh, distanceField: { sectionSidedness: [1] } }, artifacts)).ok,
    ).toBe(false);
    expect(
      (
        await decode(payload, {
          'distance-field.bin': {
            bytes: field.bytes,
            descriptor: {
              ...descriptor,
              assetCodec: { ...field.assetCodec, profile: 'sampled-visibility/5' },
            },
          },
        })
      ).ok,
    ).toBe(false);
    const { integrity: _, ...withoutIntegrity } = descriptor;
    expect(
      (
        await decode(payload, {
          'distance-field.bin': { bytes: field.bytes, descriptor: withoutIntegrity },
        })
      ).ok,
    ).toBe(false);
  });
});
