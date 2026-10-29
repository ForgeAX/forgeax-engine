import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh } from 'three';
import { expect, it } from 'vitest';
import { exportObject, geometryToMesh } from '../geometry';

it('preserves all static canonical attributes through import and export', () => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute(
    'tangent',
    new Float32BufferAttribute([0, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1], 4),
  );
  geometry.setAttribute(
    'color',
    new BufferAttribute(Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 0, 255), 3, true),
  );
  for (let set = 0; set < 8; set++) {
    const name = set === 0 ? 'uv' : set < 4 ? `uv${set}` : `TEXCOORD_${set}`;
    geometry.setAttribute(name, new Float32BufferAttribute([set, 0, set + 1, 0, set, 1], 2));
  }
  const mesh = geometryToMesh(geometry).unwrap();
  const output = exportObject([{ name: 'all attributes', mesh }], false).unwrap().children[0];
  expect(output).toBeInstanceOf(Mesh);
  if (!(output instanceof Mesh)) throw new Error('missing output mesh');
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const actual = output.geometry.getAttribute(name);
    expect(actual, name).toBeDefined();
    for (let vertex = 0; vertex < attribute.count; vertex++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        expect(
          actual.getComponent(vertex, component),
          `${name}/${vertex}/${component}`,
        ).toBeCloseTo(attribute.getComponent(vertex, component));
      }
    }
  }
  expect([...output.geometry.getAttribute('color').array]).toEqual([
    1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1,
  ]);
});

it('exports only the attributes the source mesh authored', () => {
  const mesh = {
    kind: 'mesh' as const,
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: Uint16Array.of(0, 1, 2),
    attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) },
    aabb: Float32Array.of(0, 0, 0, 1, 1, 0),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        topology: 'triangle-list' as const,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
  const output = exportObject([{ name: 'positions only', mesh }], false).unwrap().children[0];
  if (!(output instanceof Mesh)) throw new Error('missing output mesh');
  expect(Object.keys(output.geometry.attributes)).toEqual(['position']);
});
