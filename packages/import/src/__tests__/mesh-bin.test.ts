import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { packMeshBin } from '@forgeax/engine-import';
import { decodeMeshBinHeader } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it, vi } from 'vitest';

function buildPayload(vertexCount: number, extraUvCount: number, hasSkin: boolean) {
  const baseFpv = hasSkin ? 18 : 12;
  const fpv = baseFpv + extraUvCount * 2;
  const vertices = new Float32Array(vertexCount * fpv);
  const attributes: Record<string, unknown> = {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    tangent: new Float32Array(vertexCount * 4),
  };
  for (let set = 1; set <= extraUvCount; set++) {
    attributes[`uv${set}`] = new Float32Array(vertexCount * 2);
  }
  if (hasSkin) {
    attributes.skinIndex = new Uint16Array(vertexCount * 4);
    attributes.skinWeight = new Float32Array(vertexCount * 4);
  }
  return { vertices, indices: new Uint16Array([0, 1, 2]), attributes };
}

describe('mesh-bin v5 roundtrip contract', () => {
  it('keeps eight large morph targets out of numeric JSON metadata', () => {
    const payload = buildPayload(1024, 0, false);
    const targets = Array.from({ length: 8 }, () => ({
      position: new Float32Array(1024 * 3).fill(0.125),
      normal: new Float32Array(1024 * 3).fill(-0.25),
      tangent: new Float32Array(1024 * 4).fill(0.375),
    }));
    const bytes = packMeshBin({ ...payload, morphTargets: targets }, 'binary-morphs').unwrap();
    const header = decodeMeshBinHeader(bytes);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value.version).toBe(5);
    expect(header.value.jsonBytes).toBeLessThan(1024);
  });
  it('elides all-positive-zero morph streams while preserving channel presence', () => {
    const targets = Array.from({ length: 8 }, () => ({
      position: new Float32Array(3072),
      normal: new Float32Array(3072),
    }));
    const bytes = packMeshBin(
      { ...buildPayload(1024, 0, false), morphTargets: targets },
      'zero-morphs',
    ).unwrap();
    const header = decodeMeshBinHeader(bytes);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value.morphBytes).toBe(0);
    const metadata = JSON.parse(
      new TextDecoder().decode(
        bytes.subarray(80 + header.value.vertexBytes + header.value.indexBytes),
      ),
    );
    expect(metadata.morphTargetMasks).toEqual(Array(8).fill(27));
  });

  it('keeps a negative zero in the final scalar and still checks later non-finite values', () => {
    const position = new Float32Array(9);
    position[8] = -0;
    const bytes = packMeshBin(
      { ...buildPayload(3, 0, false), morphTargets: [{ position }] },
      'negative-zero',
    ).unwrap();
    const header = decodeMeshBinHeader(bytes);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value.morphBytes).toBe(36);
    expect(new DataView(bytes.buffer).getUint32(80 + header.value.vertexBytes + 32, true)).toBe(
      0x80000000,
    );
    position[0] = 1;
    for (const invalid of [NaN, Infinity]) {
      position[8] = invalid;
      expect(
        packMeshBin({ ...buildPayload(3, 0, false), morphTargets: [{ position }] }, 'non-finite')
          .ok,
      ).toBe(false);
    }
  });

  it('writes exact target-major morph bytes from private subviews', () => {
    const storage = new Float32Array(48);
    const position = storage.subarray(2, 11);
    const tangent = storage.subarray(14, 26);
    position.set([-0, 0.25, -0.75, 1, 2, 3, 4, 5, 6]);
    tangent.set(Array.from({ length: 12 }, (_, i) => (i - 4) / 7));
    const bytes = packMeshBin(
      { ...buildPayload(3, 0, false), morphTargets: [{ position }, { tangent }] },
      'subviews',
    ).unwrap();
    const header = decodeMeshBinHeader(bytes);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value.morphBytes).toBe(84);
    const expected = new Uint8Array(84);
    const view = new DataView(expected.buffer);
    [...position, ...tangent].forEach((value, i) => {
      view.setFloat32(i * 4, value, true);
    });
    const offset = 80 + header.value.vertexBytes;
    expect(bytes.subarray(offset, offset + 84)).toEqual(expected);
    const metadata = JSON.parse(
      new TextDecoder().decode(bytes.subarray(offset + 84 + header.value.indexBytes)),
    );
    expect(metadata.morphTargetMasks).toEqual([1, 4]);
    expect(metadata.morphTargets).toBeUndefined();
    storage.fill(0);
    expect(bytes.subarray(offset, offset + 84)).toEqual(expected);
  });
  it.each([
    new Float32Array(8),
    new Float32Array(9).fill(NaN),
    new Float32Array(9).fill(Infinity),
  ])('rejects invalid morph input before emitting bytes', (position) => {
    expect(
      packMeshBin({ ...buildPayload(3, 0, false), morphTargets: [{ position }] }, 'invalid').ok,
    ).toBe(false);
  });

  it.each([
    new Float32Array([NaN]),
    new Float32Array([Infinity]),
    new Float32Array(2),
  ])('rejects invalid morph weights before JSON encoding', (morphWeights) => {
    expect(
      packMeshBin(
        {
          ...buildPayload(3, 0, false),
          morphTargets: [{ position: new Float32Array(9) }],
          morphWeights,
        },
        'weights',
      ).ok,
    ).toBe(false);
  });
  it('matches independent little-endian wire bytes for mixed nonzero subviews', () => {
    const payload = buildPayload(3, 1, true);
    for (const [key, value] of Object.entries(payload.attributes)) {
      const original = value as Float32Array | Uint16Array;
      const storage =
        original instanceof Uint16Array
          ? new Uint16Array(original.length + 4)
          : new Float32Array(original.length + 4);
      const view = storage.subarray(2, 2 + original.length);
      for (let i = 0; i < view.length; i++)
        view[i] =
          original instanceof Uint16Array ? (i % 2 ? 65535 : i + 17) : i === 0 ? -0 : (i - 5) / 7;
      payload.attributes[key] = view;
    }
    const projection = deriveVertexLayoutProjection(payload.attributes);
    const expected = new Uint8Array(3 * projection.arrayStride);
    const wire = new DataView(expected.buffer);
    for (const entry of projection.attributes) {
      const values = payload.attributes[entry.key] as Float32Array | Uint16Array;
      const width = entry.format === 'uint16x4' ? 2 : 4;
      const components = entry.byteLength / width;
      for (let vertex = 0; vertex < 3; vertex++)
        for (let component = 0; component < components; component++) {
          const offset = vertex * projection.arrayStride + entry.offset + component * width;
          if (width === 2)
            wire.setUint16(offset, values[vertex * components + component] as number, true);
          else wire.setFloat32(offset, values[vertex * components + component] as number, true);
        }
    }
    new Uint8Array(payload.vertices.buffer).set(expected);
    const result = packMeshBin(payload, 'mixed-native-lanes').unwrap();
    expect(result.subarray(80, 80 + expected.length)).toEqual(expected);
  });

  it.skipIf(new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1)(
    'copies native scalar lanes without a DataView call per vertex component',
    () => {
      const write = vi.spyOn(DataView.prototype, 'setFloat32');
      try {
        expect(packMeshBin(buildPayload(1024, 1, true), 'large-native-mesh').ok).toBe(true);
        expect(write).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
      }
    },
  );
  it.each([
    [0, false, 1],
    [1, false, 2],
    [2, false, 3],
    [7, false, 8],
    [1, true, 2],
  ])('records canonical projection for %i extra UV sets and skin=%s', (extra, skin, uvSets) => {
    const result = packMeshBin(buildPayload(4, extra, skin), `gltf://mesh/${extra}/${skin}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = decodeMeshBinHeader(result.value, `gltf://mesh/${extra}/${skin}`);
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    expect(header.value.version).toBe(5);
    expect(header.value.projectionVersion).toBe(1);
    expect(header.value.vertexCount).toBe(4);
    expect(header.value.stride).toBe((skin ? 18 + extra * 2 : 12 + extra * 2) * 4);
    expect(header.value.mask).toBeGreaterThan(0);
    expect(uvSets).toBeGreaterThan(0);
  });

  it('stores canonical interleaved bytes and material refs as indexes', () => {
    const guid = '019d0000-0000-7000-8000-000000000005';
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) throw new Error('fixture guid must parse');
    const payload = {
      vertices: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {
        position: new Float32Array([1, 2, 3]),
        normal: new Float32Array([4, 5, 6]),
        uv: new Float32Array([7, 8]),
        tangent: new Float32Array([9, 10, 11, 12]),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 1,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        },
      ],
      materialSlots: [
        { slotName: 'Body', sourceKey: 'gltf:material:0', defaultMaterial: parsed.value },
      ],
    };
    const result = packMeshBin(payload, 'gltf://color', [guid]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = decodeMeshBinHeader(result.value, 'gltf://color');
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    const jsonOffset = 80 + header.value.vertexBytes + header.value.indexBytes;
    const json = new TextDecoder().decode(
      result.value.subarray(jsonOffset, jsonOffset + header.value.jsonBytes),
    );
    expect(JSON.parse(json).materialSlots).toEqual([
      { slotName: 'Body', sourceKey: 'gltf:material:0', defaultMaterialRef: 0 },
    ]);
    expect(json).not.toContain(guid);
    expect(Array.from(result.value.subarray(80, 80 + payload.vertices.byteLength))).toEqual(
      Array.from(new Uint8Array(payload.vertices.buffer)),
    );
  });

  it('stores lower-detail mesh refs and screen coverage in v4 metadata', () => {
    const lodGuid = '019d0000-0000-7000-8000-000000000006';
    const lod = AssetGuid.parse(lodGuid);
    if (!lod.ok) throw new Error('fixture guid must parse');
    const payload = {
      ...buildPayload(4, 0, false),
      lods: [{ mesh: lod.value, screenCoverage: 0.5 }],
      lodHysteresis: 0.08,
    };
    const result = packMeshBin(payload, 'gltf://lod-root', [lodGuid]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const header = decodeMeshBinHeader(result.value, 'gltf://lod-root');
    expect(header.ok).toBe(true);
    if (!header.ok) return;
    const jsonOffset = 80 + header.value.vertexBytes + header.value.indexBytes;
    const meta = JSON.parse(
      new TextDecoder().decode(
        result.value.subarray(jsonOffset, jsonOffset + header.value.jsonBytes),
      ),
    ) as { lods?: unknown; lodHysteresis?: unknown };
    expect(meta.lods).toEqual([{ meshRef: 0, screenCoverage: 0.5 }]);
    expect(meta.lodHysteresis).toBe(0.08);
  });

  it('fails closed when a lower-detail mesh ref is not enclosed by refs', () => {
    const lod = AssetGuid.parse('019d0000-0000-7000-8000-000000000007');
    if (!lod.ok) throw new Error('fixture guid must parse');
    const result = packMeshBin(
      { ...buildPayload(4, 0, false), lods: [{ mesh: lod.value, screenCoverage: 0.5 }] },
      'gltf://lod-missing-ref',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.actual).toContain('absent from refs');
  });

  it('rejects non-decreasing coverage and invalid hysteresis before cooking', () => {
    const first = AssetGuid.parse('019d0000-0000-7000-8000-000000000008');
    const second = AssetGuid.parse('019d0000-0000-7000-8000-000000000009');
    if (!first.ok || !second.ok) throw new Error('fixture guids must parse');
    const result = packMeshBin(
      {
        ...buildPayload(4, 0, false),
        lods: [
          { mesh: first.value, screenCoverage: 0.5 },
          { mesh: second.value, screenCoverage: 0.5 },
        ],
      },
      'gltf://lod-invalid-coverage',
      [AssetGuid.format(first.value), AssetGuid.format(second.value)],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.actual).toContain('strictly decreasing');

    const hysteresis = packMeshBin(
      {
        ...buildPayload(4, 0, false),
        lods: [{ mesh: first.value, screenCoverage: 0.5 }],
        lodHysteresis: 1,
      },
      'gltf://lod-invalid-hysteresis',
      [AssetGuid.format(first.value)],
    );
    expect(hysteresis.ok).toBe(false);
    if (!hysteresis.ok) expect(hysteresis.error.actual).toContain('lodHysteresis');
  });

  it('returns a closed error without bytes for invalid stride cardinality', () => {
    const payload = buildPayload(2, 0, false);
    const result = packMeshBin({ ...payload, vertexCount: 3 }, 'gltf://invalid');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sourceKey).toBe('gltf://invalid');
    expect(result.error.recovery).toContain('re-cook');
  });
});
