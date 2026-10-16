import { createSphereGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import { generateMeshLods } from '../mesh-lod-generator.js';

const guid = (index: number) => {
  const parsed = AssetGuid.parse(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const levels = [
  { mesh: guid(1), triangleRatio: 0.5, screenCoverage: 0.5 },
  { mesh: guid(2), triangleRatio: 0.25, screenCoverage: 0.2 },
];
describe('automatic Mesh LOD production', () => {
  it('generates bounded, compact ordinary meshes without changing the source', async () => {
    const source = createSphereGeometry(1, 64, 32).unwrap();
    const before = source.vertices.slice();
    const generated = (await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap();
    expect(generated.root.lods).toEqual(
      levels.map(({ mesh, screenCoverage }) => ({ mesh, screenCoverage })),
    );
    expect(source.vertices).toEqual(before);
    expect(source.lods).toBeUndefined();
    for (const [index, mesh] of generated.meshes.entries()) {
      expect(required(mesh.indices).constructor).toBe(required(source.indices).constructor);
      expect(required(mesh.indices).length).toBeLessThanOrEqual(
        required(source.indices).length * required(levels[index]).triangleRatio,
      );
      expect(mesh.vertices.byteLength).toBeLessThan(source.vertices.byteLength);
      expect(mesh.materialSlots).toEqual(source.materialSlots);
      expect(required(generated.reports[index]).error).toBeLessThanOrEqual(0.02);
      expect(required(generated.reports[index]).targetReached).toBe(true);
    }
    expect((await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap()).toEqual(
      generated,
    );
  });
});
it.each([
  Uint16Array,
  Uint32Array,
])('keeps the whole chain in the source index format', async (IndexArray) => {
  const sphere = createSphereGeometry(1, 32, 16).unwrap();
  const source = { ...sphere, indices: IndexArray.from(required(sphere.indices)) };
  const result = (await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap();
  for (const mesh of [result.root, ...result.meshes])
    expect(mesh.indices).toBeInstanceOf(IndexArray);
});
it('indexes a nonindexed source and keeps a shared format throughout the chain', async () => {
  const { packInterleavedVertexAttributes } = await import('@forgeax/engine-geometry');
  const attributes = { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) };
  const { indices: _, ...nonindexed } = createSphereGeometry(1).unwrap();
  const source = {
    ...nonindexed,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, 3).unwrap().vertices,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 3,
        materialSlot: 0,
        topology: 'triangle-list' as const,
      },
    ],
  };
  const result = (await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap();
  for (const mesh of [result.root, ...result.meshes])
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
  expect('indices' in source).toBe(false);
  expect(result.reports.every((report) => !report.targetReached)).toBe(true);
});
it.each([NaN, Infinity, -0.01, 1.01])('rejects invalid error budget %s', async (maxError) => {
  expect(
    await generateMeshLods(createSphereGeometry(1).unwrap(), { levels, maxError }),
  ).toMatchObject({
    ok: false,
    error: { code: 'mesh-lod-generation-invalid' },
  });
});
it('rejects conflicting authored chains, malformed geometry, coverage, and ratios', async () => {
  const source = createSphereGeometry(1).unwrap();
  for (const mesh of [
    { ...source, lods: [{ mesh: guid(3), screenCoverage: 0.5 }] },
    { ...source, indices: new Uint32Array([0, 1, 99999]) },
    {
      ...source,
      submeshes: [{ ...required(source.submeshes[0]), topology: 'line-list' as const }],
    },
    { ...source, submeshes: [{ ...required(source.submeshes[0]), materialSlot: 1 }] },
  ])
    expect((await generateMeshLods(mesh, { levels, maxError: 0.01 })).ok).toBe(false);
  for (const changed of [
    [{ ...required(levels[0]), triangleRatio: 1 }],
    [{ ...required(levels[0]), triangleRatio: -1 }],
    [{ ...required(levels[0]), screenCoverage: 0 }],
    [required(levels[0]), { ...required(levels[1]), mesh: required(levels[0]).mesh }],
  ])
    expect((await generateMeshLods(source, { levels: changed, maxError: 0.01 })).ok).toBe(false);
});
it('preserves material partitions and all remapped attribute bytes', async () => {
  const { packInterleavedVertexAttributes } = await import('@forgeax/engine-geometry');
  const sphere = createSphereGeometry(1, 32, 16).unwrap();
  const count = (sphere.attributes.position as Float32Array).length / 3;
  const attributes = {
    ...sphere.attributes,
    uv1: (sphere.attributes.uv as Float32Array).slice(),
    color: new Float32Array(count * 4).fill(0.4),
  };
  const split = Math.floor(required(sphere.indices).length / 6) * 3;
  const source = {
    ...sphere,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    materialSlots: [
      { slotName: 'Front', sourceKey: 'front', defaultMaterial: guid(5) },
      { slotName: 'Back', sourceKey: 'back' },
    ],
    submeshes: [
      { ...required(sphere.submeshes[0]), indexCount: split },
      {
        ...required(sphere.submeshes[0]),
        indexOffset: split,
        indexCount: required(sphere.indices).length - split,
        materialSlot: 1,
      },
    ],
  };
  const result = (await generateMeshLods(source, { levels, maxError: 0.04 })).unwrap();
  for (const mesh of result.meshes) {
    expect(mesh.submeshes.map((s) => s.materialSlot)).toEqual([0, 1]);
    expect(mesh.materialSlots).toEqual(source.materialSlots);
    expect(required(mesh.submeshes[1]).indexOffset).toBe(required(mesh.submeshes[0]).indexCount);
    const oldPositions = source.attributes.position as Float32Array;
    const newPositions = mesh.attributes.position as Float32Array;
    for (let vertex = 0; vertex < newPositions.length / 3; vertex++) {
      let old = -1;
      for (let candidate = 0; candidate < count; candidate++) {
        if (
          oldPositions
            .subarray(candidate * 3, candidate * 3 + 3)
            .every((v, i) => v === newPositions[vertex * 3 + i])
        ) {
          old = candidate;
          break;
        }
      }
      expect(old).toBeGreaterThanOrEqual(0);
      expect((mesh.attributes.color as Float32Array)[vertex * 4]).toBeCloseTo(0.4);
      expect((mesh.attributes.uv1 as Float32Array).slice(vertex * 2, vertex * 2 + 2)).toEqual(
        (mesh.attributes.uv as Float32Array).slice(vertex * 2, vertex * 2 + 2),
      );
    }
  }
});
it('keeps deformation boundaries and remaps skin/morph streams including tangent W', async () => {
  const { packInterleavedVertexAttributes } = await import('@forgeax/engine-geometry');
  const sphere = createSphereGeometry(1, 32, 16).unwrap();
  const count = (sphere.attributes.position as Float32Array).length / 3;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) skinWeight[i * 4] = 1;
  const attributes = { ...sphere.attributes, skinIndex, skinWeight };
  const source = {
    ...sphere,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
    morphTargets: [
      {
        position: new Float32Array(count * 3).fill(0.1),
        tangent: new Float32Array(count * 4).fill(0.2),
      },
    ],
    morphWeights: new Float32Array([0.7]),
  };
  const result = (await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap();
  for (const [index, mesh] of result.meshes.entries()) {
    const vertices = required(result.reports[index]).vertexCount;
    expect(required(required(required(mesh.morphTargets)[0]).tangent).length).toBe(vertices * 4);
    expect(
      required(required(required(mesh.morphTargets)[0]).tangent).every(
        (value) => value === Math.fround(0.2),
      ),
    ).toBe(true);
    expect(mesh.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(mesh.morphWeights).toEqual(source.morphWeights);
    expect(required(mesh.indices).length).toBeLessThan(required(source.indices).length);
  }
  // Unique morph displacement at every vertex locks all candidate collapses.
  required(source.morphTargets[0]).position.forEach((_, i, stream) => {
    stream[i] = i;
  });
  const protectedResult = (await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap();
  expect(protectedResult.reports.every((report) => !report.targetReached)).toBe(true);
  expect(required(required(protectedResult.meshes[0]).indices).length).toBe(
    required(source.indices).length,
  );
});
it('does not relax the error budget when the requested target cannot be met', async () => {
  const source = createSphereGeometry(1, 32, 16).unwrap();
  const result = (await generateMeshLods(source, { levels, maxError: 0 })).unwrap();
  expect(required(result.reports[0]).targetReached).toBe(false);
  expect(result.reports.every((report) => report.error === 0)).toBe(true);
});

it('reports the whole-mesh ratio when a tiny material section retains its triangle', async () => {
  const { createPlaneGeometry, packInterleavedVertexAttributes } = await import(
    '@forgeax/engine-geometry'
  );
  const plane = createPlaneGeometry(2, 2, 4, 4).unwrap();
  const positions = plane.attributes.position as Float32Array;
  const count = positions.length / 3;
  const attributes = {
    position: Float32Array.from([...positions, 0.2, 0.2, 0, 0.3, 0.2, 0, 0.2, 0.3, 0]),
  };
  const indices = required(plane.indices);
  const source = {
    ...plane,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count + 3).unwrap().vertices,
    indices: Uint32Array.from([...indices, count, count + 1, count + 2]),
    materialSlots: [...plane.materialSlots, { slotName: 'Tiny', sourceKey: 'tiny' }],
    submeshes: [
      { ...required(plane.submeshes[0]), vertexCount: count + 3 },
      {
        ...required(plane.submeshes[0]),
        indexOffset: indices.length,
        indexCount: 3,
        vertexCount: count + 3,
        materialSlot: 1,
      },
    ],
  };
  const result = (
    await generateMeshLods(source, {
      levels: [{ ...required(levels[0]), triangleRatio: 0.7 }],
      maxError: 0.02,
    })
  ).unwrap();
  const report = required(result.reports[0]);
  expect(report.triangleCount).toBeLessThanOrEqual((source.indices.length / 3) * 0.7);
  expect(report.targetReached).toBe(true);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

it('preserves open boundaries and UV seams while reducing interior geometry', async () => {
  const { createPlaneGeometry } = await import('@forgeax/engine-geometry');
  const source = createPlaneGeometry(2, 2, 16, 16).unwrap();
  const result = (await generateMeshLods(source, { levels, maxError: 0.02 })).unwrap();
  const positions = source.attributes.position as Float32Array;
  for (const mesh of result.meshes) {
    const lower = mesh.attributes.position as Float32Array;
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      if (
        Math.abs(positions[vertex * 3] as number) !== 1 &&
        Math.abs(positions[vertex * 3 + 1] as number) !== 1
      )
        continue;
      const point = positions.slice(vertex * 3, vertex * 3 + 3);
      expect(
        Array.from({ length: lower.length / 3 }, (_, i) => i).some((i) =>
          point.every((value, c) => value === lower[i * 3 + c]),
        ),
      ).toBe(true);
    }
    expect(required(mesh.indices).length).toBeLessThan(required(source.indices).length);
  }
  const sphere = (
    await generateMeshLods(createSphereGeometry(1, 32, 16).unwrap(), { levels, maxError: 0.02 })
  ).unwrap();
  for (const mesh of sphere.meshes) {
    const uv = mesh.attributes.uv as Float32Array;
    expect(uv.some((v, i) => i % 2 === 0 && v === 0)).toBe(true);
    expect(uv.some((v, i) => i % 2 === 0 && v === 1)).toBe(true);
  }
});
