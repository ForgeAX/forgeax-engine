import { AssetError, type MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createBoxGeometry,
  createEdgesGeometry,
  createPlaneGeometry,
  createWireframeGeometry,
} from '../index.js';

function triangleMesh(): MeshAsset {
  const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    kind: 'mesh',
    vertices: position,
    attributes: { position },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount: 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'source' }],
  };
}

function firstSubmesh(mesh: MeshAsset) {
  const submesh = mesh.submeshes[0];
  if (submesh === undefined) throw new Error('test mesh must have a submesh');
  return submesh;
}

function expectParseFailure(result: ReturnType<typeof createWireframeGeometry>, field: string) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AssetError);
  expect(result.error.code).toBe('asset-parse-failed');
  expect(result.error.detail).toMatchObject({ field });
  expect(result.error.detail).toHaveProperty('value');
  expect(result.error.detail).toHaveProperty('reason');
}

describe('Geometry edge factories input contract', () => {
  it('exposes both factories with valid indexed and non-indexed inputs', () => {
    const nonIndexed = triangleMesh();
    const indexed: MeshAsset = {
      ...nonIndexed,
      vertices: new Float32Array(0),
      indices: new Uint16Array([0, 1, 2]),
      submeshes: [{ ...firstSubmesh(nonIndexed), indexCount: 3 }],
    };

    expect(createWireframeGeometry(nonIndexed).ok).toBe(true);
    expect(createEdgesGeometry(nonIndexed).ok).toBe(true);
    expect(createWireframeGeometry(indexed).ok).toBe(true);
    expect(createEdgesGeometry(indexed, 1).ok).toBe(true);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    181,
  ])('rejects threshold %s with structured detail', (threshold) => {
    const result = createEdgesGeometry(triangleMesh(), threshold);
    expectParseFailure(result, 'thresholdAngleDegrees');
  });

  it('rejects malformed position storage, cardinality, and finite values', () => {
    const wrongStorage = {
      ...triangleMesh(),
      attributes: { position: new Uint16Array([0, 0, 0]) },
    } as unknown as MeshAsset;
    expectParseFailure(createWireframeGeometry(wrongStorage), 'attributes.position');

    const wrongCardinality = {
      ...triangleMesh(),
      attributes: { position: new Float32Array([0, 0]) },
    } as unknown as MeshAsset;
    expectParseFailure(createWireframeGeometry(wrongCardinality), 'attributes.position');

    const nonFinite = {
      ...triangleMesh(),
      attributes: { position: new Float32Array([0, 0, 0, 1, 0, 0, Number.NaN, 1, 0]) },
    } as unknown as MeshAsset;
    expectParseFailure(createWireframeGeometry(nonFinite), 'attributes.position');
  });

  it('rejects non-triangle topology, invalid ranges, indices, and non-indexed shape', () => {
    const source = triangleMesh();
    expectParseFailure(
      createWireframeGeometry({
        ...source,
        submeshes: [{ ...firstSubmesh(source), topology: 'line-list' }],
      }),
      'submeshes[0].topology',
    );
    expectParseFailure(
      createWireframeGeometry({
        ...source,
        submeshes: [{ ...firstSubmesh(source), vertexCount: 2 }],
      }),
      'submeshes[0].vertexCount',
    );

    const indexed: MeshAsset = {
      ...source,
      indices: new Uint16Array([0, 1, 3]),
      submeshes: [{ ...firstSubmesh(source), indexCount: 3 }],
    };
    expectParseFailure(createWireframeGeometry(indexed), 'indices[2]');

    const nonIndexedMultiple: MeshAsset = {
      ...source,
      submeshes: [firstSubmesh(source), firstSubmesh(source)],
    };
    expectParseFailure(createWireframeGeometry(nonIndexedMultiple), 'submeshes');
  });
});

function unwrap(result: ReturnType<typeof createWireframeGeometry>): MeshAsset {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

function indexedMesh(positions: number[], indices: number[]): MeshAsset {
  const position = new Float32Array(positions);
  return {
    kind: 'mesh',
    vertices: position,
    attributes: { position },
    indices: new Uint32Array(indices),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: position.length / 3,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'source' }],
  };
}

function squareMesh(): MeshAsset {
  return indexedMesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
}

function edgeCount(mesh: MeshAsset): number {
  return mesh.submeshes[0]?.vertexCount === undefined ? 0 : mesh.submeshes[0].vertexCount / 2;
}

function vertexBytes(mesh: MeshAsset): number[] {
  return Array.from(
    new Uint8Array(mesh.vertices.buffer, mesh.vertices.byteOffset, mesh.vertices.byteLength),
  );
}

function emittedPositions(mesh: MeshAsset): number[] {
  const position = mesh.attributes.position;
  if (!(position instanceof Float32Array)) throw new Error('expected float32 output positions');
  return Array.from(position);
}

function expectLineCarrier(mesh: MeshAsset, expectedEdges: number): void {
  expect(mesh.kind).toBe('mesh');
  expect(mesh.indices).toBeUndefined();
  expect(mesh.materialSlots).toEqual([{ slotName: 'Default' }]);
  expect(mesh.submeshes).toEqual([
    {
      indexOffset: 0,
      indexCount: 0,
      vertexCount: expectedEdges * 2,
      topology: 'line-list',
      materialSlot: 0,
    },
  ]);
  expect(mesh.vertices.length).toBe(expectedEdges * 2 * 12);
  expect(mesh.attributes.position).toBeInstanceOf(Float32Array);
  expect(mesh.attributes.normal).toBeInstanceOf(Float32Array);
  expect(mesh.attributes.uv).toBeInstanceOf(Float32Array);
  expect(mesh.attributes.tangent).toBeInstanceOf(Float32Array);
  expect(mesh.attributes.normal).toHaveLength(expectedEdges * 2 * 3);
  expect(mesh.attributes.uv).toHaveLength(expectedEdges * 2 * 2);
  expect(mesh.attributes.tangent).toHaveLength(expectedEdges * 2 * 4);
  expect(Array.from(mesh.attributes.normal as Float32Array).every((value) => value === 0)).toBe(
    true,
  );
  expect(Array.from(mesh.attributes.uv as Float32Array).every((value) => value === 0)).toBe(true);
  expect(Array.from(mesh.attributes.tangent as Float32Array).every((value) => value === 0)).toBe(
    true,
  );
}

describe('Geometry edge factories deterministic carriers', () => {
  it('emits all unique box edges and keeps subdivided plane diagonals', () => {
    const box = unwrap(createWireframeGeometry(unwrap(createBoxGeometry(1, 1, 1))));
    expectLineCarrier(box, 18);
    const boxSource = unwrap(createBoxGeometry(1, 1, 1));
    expect(edgeCount(unwrap(createEdgesGeometry(boxSource)))).toBe(12);

    const plane = unwrap(createWireframeGeometry(unwrap(createPlaneGeometry(2, 2, 2, 2))));
    expectLineCarrier(plane, 16);
    const planeSource = unwrap(createPlaneGeometry(2, 2, 2, 2));
    expect(edgeCount(unwrap(createEdgesGeometry(planeSource)))).toBe(8);
  });

  it('uses the edge threshold to include or exclude a coplanar diagonal', () => {
    const source = squareMesh();
    expect(edgeCount(unwrap(createWireframeGeometry(source)))).toBe(5);
    expect(edgeCount(unwrap(createEdgesGeometry(source)))).toBe(4);
    expect(edgeCount(unwrap(createEdgesGeometry(source, 0)))).toBe(5);
    expect(edgeCount(unwrap(createEdgesGeometry(source, 180)))).toBe(4);
  });

  it('keeps a ninety-degree crease at threshold 90 but not at 91 degrees', () => {
    const source = indexedMesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2, 1, 0, 3]);
    expect(edgeCount(unwrap(createEdgesGeometry(source, 90)))).toBe(5);
    expect(edgeCount(unwrap(createEdgesGeometry(source, 91)))).toBe(4);
  });

  it('welds duplicate seams and chooses the minimum exact representative', () => {
    const source = indexedMesh(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0.00004, 0, 0, 1.00004, 1, 0, 0, 1, 0],
      [0, 1, 2, 3, 4, 5],
    );
    const result = unwrap(createEdgesGeometry(source));
    expect(edgeCount(result)).toBe(4);
    expect(emittedPositions(result)).not.toContain(0.00004);
    expect(emittedPositions(result)).not.toContain(1.00004);
  });

  it('always keeps non-manifold edges', () => {
    const source = indexedMesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0],
      [0, 1, 2, 1, 0, 3, 0, 1, 4],
    );
    expect(edgeCount(unwrap(createEdgesGeometry(source)))).toBe(7);
  });

  it('skips zero-area faces and zero-length edges without NaN or output fallback', () => {
    const mixed = indexedMesh([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 1, 1, 2, 3]);
    const output = unwrap(createEdgesGeometry(mixed));
    expect(edgeCount(output)).toBe(3);
    expect(emittedPositions(output).every(Number.isFinite)).toBe(true);

    const empty = unwrap(createEdgesGeometry(indexedMesh([0, 0, 0], [0, 0, 0])));
    expectLineCarrier(empty, 0);
    expect(Array.from(empty.aabb ?? [])).toEqual([
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
  });

  it('packs canonical bytes, derives AABB from emitted endpoints, and preserves source data', () => {
    const source = squareMesh();
    const sourcePositions = Array.from(source.attributes.position as Float32Array);
    const sourceIndices = Array.from(source.indices ?? []);
    const output = unwrap(createWireframeGeometry(source));
    expectLineCarrier(output, 5);
    expect(Array.from(source.attributes.position as Float32Array)).toEqual(sourcePositions);
    expect(Array.from(source.indices ?? [])).toEqual(sourceIndices);

    const position = output.attributes.position as Float32Array;
    expect(Array.from(output.aabb ?? [])).toEqual([0, 0, 0, 1, 1, 0]);
    for (let vertex = 0; vertex < position.length / 3; vertex += 1) {
      const base = vertex * 12;
      expect(Array.from(output.vertices.slice(base, base + 3))).toEqual(
        Array.from(position.slice(vertex * 3, vertex * 3 + 3)),
      );
    }
  });

  it('is byte-stable across repeated/default-explicit/indexed-non-indexed/permuted inputs', () => {
    const indexed = squareMesh();
    const nonIndexed: MeshAsset = {
      kind: 'mesh',
      vertices: new Float32Array(0),
      attributes: {
        position: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 6,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'source' }],
    };
    const permuted = indexedMesh(
      Array.from(indexed.attributes.position as Float32Array),
      [0, 2, 3, 0, 1, 2],
    );
    const first = unwrap(createWireframeGeometry(indexed));
    const repeated = unwrap(createWireframeGeometry(indexed));
    const firstEdges = unwrap(createEdgesGeometry(indexed));
    const repeatedEdges = unwrap(createEdgesGeometry(indexed));
    const explicitEdges = unwrap(createEdgesGeometry(indexed, 1));
    const nonIndexedOutput = unwrap(createWireframeGeometry(nonIndexed));
    const permutedOutput = unwrap(createWireframeGeometry(permuted));
    expect(vertexBytes(repeated)).toEqual(vertexBytes(first));
    expect(vertexBytes(repeatedEdges)).toEqual(vertexBytes(firstEdges));
    expect(vertexBytes(explicitEdges)).toEqual(vertexBytes(firstEdges));
    expect(vertexBytes(nonIndexedOutput)).toEqual(vertexBytes(first));
    expect(vertexBytes(permutedOutput)).toEqual(vertexBytes(first));
    expect(emittedPositions(repeated)).toEqual(emittedPositions(first));
    expect(Array.from(repeated.aabb ?? [])).toEqual(Array.from(first.aabb ?? []));
  });
});
