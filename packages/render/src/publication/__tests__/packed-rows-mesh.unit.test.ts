import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { copyAssetData } from '@forgeax/engine-assets-runtime/internal';
import {
  createBoxGeometry,
  deriveVertexLayoutProjection,
  interleavedMesh,
  prepareStaticMeshVertexStreams,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { prepareAssetPatch, publishAssetPatch } from '../asset-patch';
import { samePublishedMesh } from '../mesh';
import {
  attributeChannelBytes,
  isPackedRowsMesh,
  meshAttributeChannels,
  packedRowsEligible,
  packedRowsMeshError,
  trimToPackedRows,
} from '../packed-rows-mesh';
import { RenderPublicationReceiver } from '../receiver';

const box = (): MeshAsset => createBoxGeometry(1, 1, 1).unwrap();

function layout(mesh: MeshAsset): VertexLayoutProjection {
  return deriveVertexLayoutProjection(mesh.attributes);
}

it('trims an eligible static raster mesh to its rows without changing the layout', () => {
  const full = box();
  expect(packedRowsEligible(full)).toBe(true);
  const packed = trimToPackedRows(full, copyAssetData);
  expect(isPackedRowsMesh(packed)).toBe(true);
  expect(packedRowsMeshError(packed)).toBeUndefined();
  expect(Object.keys(packed.attributes)).toEqual(Object.keys(full.attributes));
  expect(attributeChannelBytes(packed)).toBe(0);
  expect(attributeChannelBytes(full)).toBeGreaterThan(0);
  const projected = layout(packed);
  expect(projected).toBe(layout(full));
  expect(projected.arrayStride).toBe(layout(full).arrayStride);
  // Owned row copies; the borrowed source is never mutated.
  expect(packed.vertices).not.toBe(full.vertices);
  expect(packed.vertices.buffer).not.toBe(full.vertices.buffer);
  expect(packed.vertices).toEqual(full.vertices);
  expect(packed.indices).toEqual(full.indices);
  expect(full.attributes.position?.byteLength).toBeGreaterThan(0);
  // The marker survives structured clone, the Worker transport.
  expect(isPackedRowsMesh(structuredClone(packed))).toBe(true);
});

it('rebuilds exact canonical channels from the rows on demand', () => {
  const full = box();
  const packed = trimToPackedRows(full, copyAssetData);
  const channels = meshAttributeChannels(packed);
  expect(channels).toEqual(full.attributes);
  expect(meshAttributeChannels(packed)).toEqual(channels);
  expect(meshAttributeChannels(packed)).not.toBe(channels);
  expect(meshAttributeChannels(full)).toBe(full.attributes);
});

it('keeps full channels for every mesh whose Render consumers read channel data', () => {
  const full = box();
  const ineligible: MeshAsset[] = [
    { ...full, submeshes: full.submeshes.map((s) => ({ ...s, topology: 'line-list' as const })) },
    { ...full, lods: [] } as unknown as MeshAsset,
    { ...full, morphWeights: new Float32Array(1) } as unknown as MeshAsset,
    { ...full, distanceField: {} } as unknown as MeshAsset,
    { ...full, cardLayout: {} } as unknown as MeshAsset,
    {
      ...full,
      attributes: { ...full.attributes, skinIndex: new Uint16Array(0) },
    } as unknown as MeshAsset,
    { ...full, vertices: new Float32Array(0) },
  ];
  for (const mesh of ineligible) expect(packedRowsEligible(mesh)).toBe(false);
});

it('rejects malformed packed-rows payloads explicitly', () => {
  const full = box();
  const packed = trimToPackedRows(full, copyAssetData);
  expect(packedRowsMeshError(full)).toBe('packed-rows marker');
  expect(
    packedRowsMeshError({
      ...packed,
      attributes: { ...packed.attributes, position: new Float32Array(3) },
    }),
  ).toBe('packed position requires an empty canonical layout declaration');
  expect(packedRowsMeshError({ ...packed, vertices: packed.vertices.subarray(0, 5) })).toMatch(
    /vertexCount|vertices.byteLength/,
  );
  expect(packedRowsMeshError({ ...packed, lods: [] })).toBeUndefined();
});

it('compares a packed-rows mesh with its full form by the rebuilt channel bytes', () => {
  const full = box();
  const packed = trimToPackedRows(full, copyAssetData);
  expect(samePublishedMesh(packed, full)).toBe(true);
  expect(samePublishedMesh(full, packed)).toBe(true);
  expect(samePublishedMesh(packed, structuredClone(packed))).toBe(true);
  const changedRows = trimToPackedRows(full, copyAssetData);
  changedRows.vertices[0] = (changedRows.vertices[0] ?? 0) + 1;
  expect(samePublishedMesh(changedRows, full)).toBe(false);
  const changedChannel = copyAssetData(full);
  (changedChannel.attributes.normal as Float32Array)[0] = 7;
  expect(samePublishedMesh(packed, changedChannel)).toBe(false);
  const { uv: _uv, ...fewer } = full.attributes;
  expect(samePublishedMesh(packed, { ...full, attributes: fewer })).toBe(false);
});

it('checks the full channel and packed bytes when a revision crosses static stream layouts', () => {
  const identity = { source: 'stream-layout', epoch: 1, meshHandle: 7 as never, revision: 1 };
  const receiver = new RenderPublicationReceiver(identity);
  try {
    const full = box();
    const rows = trimToPackedRows(full, copyAssetData);
    const streams = prepareStaticMeshVertexStreams(rows.vertices, layout(rows));
    if (streams === undefined) throw new Error('missing static streams');
    const split = {
      ...rows,
      attributeStorage: 'static-streams' as const,
      vertices: new Float32Array(streams.pack().buffer),
    };
    receiver.prepareMesh({ ...identity, mesh: split }).unwrap();
    for (const mesh of [rows, full]) {
      expect(receiver.prepareMesh({ ...identity, mesh }).ok).toBe(true);
      expect(samePublishedMesh(mesh, split)).toBe(true);
    }
    const inconsistent = copyAssetData(full);
    (inconsistent.attributes.uv as Float32Array)[0] = 0.25;
    expect(receiver.prepareMesh({ ...identity, mesh: inconsistent }).ok).toBe(false);
    expect(samePublishedMesh(inconsistent, split)).toBe(false);
    const changed = copyAssetData(rows);
    changed.vertices[changed.vertices.length - 1] = 7;
    expect(samePublishedMesh(split, changed)).toBe(false);
    expect(receiver.prepareMesh({ ...identity, mesh: rows }).ok).toBe(true);
  } finally {
    receiver.dispose();
  }
});

it('validates packed-rows payloads at the Render receiver and conflicts by content', () => {
  const identity = { source: 'packed-rows', epoch: 1 };
  const receiver = new RenderPublicationReceiver(identity);
  const full = box();
  const packed = trimToPackedRows(full, copyAssetData);
  const malformed = {
    ...packed,
    attributes: { ...packed.attributes, normal: new Float32Array(3) },
  };
  const rejected = receiver.prepareMesh({
    ...identity,
    meshHandle: 7 as never,
    revision: 1,
    mesh: malformed,
  });
  expect(rejected.ok).toBe(false);
  expect(String(rejected.ok ? '' : rejected.error.message)).toContain(
    'packed normal requires an empty canonical layout declaration',
  );
  const prepared = receiver
    .prepareMesh({ ...identity, meshHandle: 7 as never, revision: 1, mesh: packed })
    .unwrap();
  expect(isPackedRowsMesh(prepared.mesh)).toBe(true);
  // Same revision, full form with identical content: no conflict.
  expect(
    receiver.prepareMesh({ ...identity, meshHandle: 7 as never, revision: 1, mesh: full }).ok,
  ).toBe(true);
  const other = copyAssetData(full);
  (other.attributes.uv as Float32Array)[0] = 0.25;
  expect(
    receiver.prepareMesh({ ...identity, meshHandle: 7 as never, revision: 1, mesh: other }).ok,
  ).toBe(false);
  receiver.dispose();
});

it('applies paired row/channel patches from rows and rejects channel-only patches loudly', () => {
  const full = box();
  const packed = trimToPackedRows(full, copyAssetData);
  const projection = layout(full);
  const position = projection.attributes.find((entry) => entry.key === 'position');
  if (position === undefined) throw new Error('box has no position');
  const value = new Float32Array([9, 8, 7]);
  const bytes = new Uint8Array(value.buffer);
  const channelRange = {
    path: ['attributes', 'position'],
    byteOffset: 0,
    byteLength: 12,
    bytes,
  };
  const rowRange = {
    path: ['vertices'],
    byteOffset: position.offset,
    byteLength: 12,
    bytes,
  };
  const base = { handle: 1, base: 1, revision: 2, fields: {}, removed: [] };
  const before = meshAttributeChannels(packed);
  const paired = prepareAssetPatch(packed, { ...base, ranges: [channelRange, rowRange] }, false);
  paired.commit();
  const next = paired.value as MeshAsset;
  expect(isPackedRowsMesh(next)).toBe(true);
  expect(next.attributes.position?.byteLength).toBe(0);
  const nextPositions = meshAttributeChannels(next).position;
  if (!(nextPositions instanceof Float32Array)) throw new Error('Expected float32 positions');
  expect(Array.from(nextPositions.subarray(0, 3))).toEqual([9, 8, 7]);
  expect(meshAttributeChannels(packed)).not.toBe(before);
  expect(paired.change.ranges.map((range) => range.path.join('.'))).toEqual([
    'attributes.position',
    'vertices',
  ]);
  expect(() => prepareAssetPatch(packed, { ...base, ranges: [channelRange] }, false)).toThrow(
    /attribute range without its vertex rows on a packed-rows mesh/,
  );
  // Full meshes keep the existing channel write semantics.
  const fullPatch = prepareAssetPatch(full, { ...base, ranges: [channelRange, rowRange] }, true);
  fullPatch.commit();
  const fullPositions = (fullPatch.value as MeshAsset).attributes.position;
  if (!(fullPositions instanceof Float32Array)) throw new Error('Expected float32 positions');
  expect(Array.from(fullPositions.subarray(0, 3))).toEqual([9, 8, 7]);
});

it.each([
  false,
  true,
])('transports canonical edits into static stream ranges (retained=%s)', (retained) => {
  const rows = interleavedMesh(box());
  const projection = layout(rows),
    stride = projection.arrayStride;
  const plan = prepareStaticMeshVertexStreams(rows.vertices, projection);
  if (!plan) throw new Error('missing test streams');
  const current = {
    ...rows,
    attributeStorage: 'static-streams' as const,
    vertices: new Float32Array(plan.pack().buffer),
  };
  const expected = structuredClone(rows);
  const bytes = new Uint8Array(expected.vertices.buffer);
  const ranges = [
    { byteOffset: stride, rowBytes: 12, byteStride: stride, count: 5 },
    { byteOffset: stride - 2, rowBytes: 3 * stride + 6, byteStride: 3 * stride + 6, count: 1 },
    { byteOffset: 9, rowBytes: 6, byteStride: stride + 3, count: 4 },
  ].map(({ byteOffset, rowBytes, byteStride, count }, k) => {
    for (let i = 0; i < count; i++)
      bytes.fill(31 + k, byteOffset + i * byteStride, byteOffset + i * byteStride + rowBytes);
    return {
      path: ['vertices'],
      byteOffset,
      rowBytes,
      byteStride,
      byteLength: (count - 1) * byteStride + rowBytes,
    };
  });
  const change = {
    handle: 7 as never,
    stableKind: 'mesh' as const,
    removed: false,
    revision: 2,
    fields: [],
    ranges,
  };
  const patch = publishAssetPatch(expected, change, 1);
  if (!patch) throw new Error('missing test patch');
  const prepared = prepareAssetPatch(current, patch, retained);
  for (const range of patch.ranges) range.bytes.fill(0);
  expect(interleavedMesh(current).vertices).toEqual(rows.vertices);
  prepared.commit();
  const accepted = prepared.value as MeshAsset;
  expect(accepted.attributeStorage).toBe('static-streams');
  expect(new Uint8Array(interleavedMesh(accepted).vertices.buffer)).toEqual(bytes);
  expect(publishAssetPatch(accepted, change, 1)).toEqual(publishAssetPatch(expected, change, 1));
  if (retained) expect(interleavedMesh(current).vertices).toEqual(rows.vertices);
});

it('uses the same validated canonical rows in World and Render asset stores', () => {
  const assets = new AssetRegistry();
  const packed = trimToPackedRows(box(), copyAssetData);
  const handle = assets.create(packed).unwrap();
  const accepted = assets.read(handle).unwrap();
  expect(accepted.attributeStorage).toBe('interleaved');
  expect(Object.values(accepted.attributes).every((value) => value.byteLength === 0)).toBe(true);
  expect(meshAttributeChannels(accepted)).toEqual(meshAttributeChannels(packed));
  expect(
    assets.create({
      ...packed,
      attributes: { ...packed.attributes, position: new Float32Array(3) },
    }).ok,
  ).toBe(false);
  assets.dispose();
});
