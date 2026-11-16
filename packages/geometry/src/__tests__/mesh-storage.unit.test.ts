import { assert, expect, it } from 'vitest';
import { createBoxGeometry } from '../box';
import { packMeshBin, prepareMeshData } from '../mesh-data';
import { copyMeshAttribute, interleavedMesh, meshAttributeWindow } from '../mesh-storage';
import { packInterleavedVertexAttributes } from '../vertex-attribute-layout';

it('keeps transferable declarations independent and rejects empty views retaining large storage', () => {
  const full = createBoxGeometry(1, 1, 1).unwrap();
  const first = interleavedMesh(full),
    second = interleavedMesh(full);
  const declaration = first.attributes.position;
  assert(declaration instanceof Float32Array);
  structuredClone(first.attributes, { transfer: [declaration.buffer as ArrayBuffer] });
  expect(() => structuredClone(second.attributes)).not.toThrow();
  const hidden = new Float32Array(new ArrayBuffer(1_048_576), 0, 0);
  expect(
    prepareMeshData(
      { ...second, attributes: { ...second.attributes, position: hidden } },
      'hidden-backing',
    ).ok,
  ).toBe(false);
});

it('admits a single interleaved runtime representation without retaining canonical channels', () => {
  const full = createBoxGeometry(1, 1, 1).unwrap();
  const packed = interleavedMesh(full);
  expect(packed.vertices).toBe(full.vertices);
  expect(Object.values(packed.attributes).every((value) => value.byteLength === 0)).toBe(true);
  expect(prepareMeshData(packed, 'single-storage').ok).toBe(true);
  expect(packMeshBin(packed).unwrap()).toEqual(packMeshBin(full).unwrap());
  for (const key of ['position', 'normal', 'uv', 'tangent'] as const)
    expect(copyMeshAttribute(packed, key)).toEqual(full.attributes[key]);
  const position = meshAttributeWindow(packed, 'position');
  assert(position);
  expect(position.data.buffer).toBe(full.vertices.buffer);
  expect(position.stride).toBe(12);
  expect(position.count).toBe(24);
});

it('preserves mixed integer skin rows, signed zero and nonzero source offsets', () => {
  const attributes = {
    position: new Float32Array([-0, 2, 3, 4, 5, 6]),
    skinIndex: new Uint16Array([65535, 65535, 3, 4, 7, 8, 9, 10]),
    skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]),
  };
  const rows = packInterleavedVertexAttributes(attributes, 2).unwrap().vertices;
  const backing = new Float32Array(rows.length + 8);
  new Uint8Array(backing.buffer, 16, rows.byteLength).set(new Uint8Array(rows.buffer));
  const mesh = interleavedMesh({
    kind: 'mesh' as const,
    vertices: backing.subarray(4, 4 + rows.length),
    attributes,
    indices: new Uint16Array([0, 1]),
    submeshes: [{ indexOffset: 0, indexCount: 2, materialSlot: 0, topology: 'line-list' as const }],
    materialSlots: [{ slotName: 'line' }],
  });
  expect(prepareMeshData(mesh, 'skin').ok).toBe(true);
  expect(copyMeshAttribute(mesh, 'skinIndex')).toEqual(attributes.skinIndex);
  expect(Object.is(copyMeshAttribute(mesh, 'position')?.[0], -0)).toBe(true);
  const out = new Float32Array(10).subarray(2, 8);
  expect(copyMeshAttribute(mesh, 'position', out)).toBe(out);
  expect(out).toEqual(attributes.position);
  expect(() => copyMeshAttribute(mesh, 'position', new Uint16Array(6))).toThrow(RangeError);
});

it('rejects forged declarations and nonfinite float channels without interpreting integer lanes as floats', () => {
  const full = createBoxGeometry(1, 1, 1).unwrap();
  expect(prepareMeshData({ ...full, attributeStorage: 'interleaved' }, 'forged').ok).toBe(false);
  const mesh = interleavedMesh(full);
  const vertices = mesh.vertices.slice();
  vertices[0] = NaN;
  expect(prepareMeshData({ ...mesh, vertices }, 'nan').ok).toBe(false);
});
