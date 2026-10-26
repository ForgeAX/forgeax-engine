import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { copyAssetData } from '@forgeax/engine-assets-runtime/internal';
import {
  createBoxGeometry,
  deriveVertexLayoutProjection,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { prepareAssetPatch } from '../asset-patch';
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
  expect(meshAttributeChannels(packed)).toBe(channels);
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
  ).toMatch(/position must be an empty float32 layout key/);
  expect(packedRowsMeshError({ ...packed, vertices: packed.vertices.subarray(0, 5) })).toMatch(
    /whole interleaved vertex rows/,
  );
  expect(packedRowsMeshError({ ...packed, lods: [] } as unknown as MeshAsset)).toMatch(
    /static raster triangle/,
  );
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
  expect(String(rejected.ok ? '' : rejected.error.message)).toMatch(/packed-rows/);
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
  expect(Array.from(meshAttributeChannels(next).position?.subarray(0, 3) ?? [])).toEqual([9, 8, 7]);
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
  expect(
    Array.from((fullPatch.value as MeshAsset).attributes.position?.subarray(0, 3) ?? []),
  ).toEqual([9, 8, 7]);
});

it('never admits the packed-rows form into a managed World asset store', () => {
  const assets = new AssetRegistry();
  const packed = trimToPackedRows(box(), copyAssetData);
  expect(assets.create(packed).ok).toBe(false);
  assets.dispose();
});
