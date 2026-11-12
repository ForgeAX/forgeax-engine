import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';
import { expectContract, exported, faceSizes, sharpEdges, triangleSet } from './contract';

function handMesh(positions: number[], indices: number[], topology = 'triangle-list'): MeshAsset {
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
        vertexCount: positions.length / 3,
        topology,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  } as MeshAsset;
}

describe('lift', () => {
  it('round-trips an exported mesh: welded topology, hard edges, slots and corner values', () => {
    const source = model();
    source.box({ size: [1, 1, 1] });
    source.markSharp(sel.edges.dihedral('>', 40));
    source.assign(sel.facing('+y'), 'glow');
    source.uv.project({ mode: 'box', scale: 1 });
    const original = source.toMesh();
    if (!original.ok) throw original.error;

    const m = model();
    const op = m.lift(original.value.mesh, { label: 'scan', tag: 'scan' });
    expect(op.roles).toEqual({ face: 12, sharpEdges: 12, vertices: 8 });
    const report = m.validate();
    expect([report.closed, report.vertices]).toEqual([true, 8]);
    expect(report.volume).toBeCloseTo(1, 6);
    expect(m.count(sel.material('glow'))).toBe(2);
    expect(m.count(sel.createdBy('scan', 'face').and(sel.tag('scan')))).toBe(12);
    const again = m.toMesh();
    if (!again.ok) throw again.error;
    expect({ ...again.value.report, faces: 6 }).toEqual(original.value.report);
    expect(triangleSet(again.value.mesh)).toEqual(triangleSet(original.value.mesh));

    m.dissolve(sel.edges.dihedral('<', 1));
    expect(faceSizes(m.editMesh)).toEqual({ 4: 6 });
    expect(sharpEdges(m.editMesh)).toBe(12);
    expect(exported(m).attributes.uv).toEqual(original.value.mesh.attributes.uv);
    expectContract(m);
  });

  it('keeps smooth normals smooth and UV seams as corner values', () => {
    const source = model();
    source.sphere({ radius: 1, widthSegments: 12, heightSegments: 6 });
    source.uv.project({ mode: 'box', scale: 1 });
    const original = source.toMesh({ normals: { mode: 'smooth' } });
    if (!original.ok) throw original.error;
    const m = model();
    expect(m.lift(original.value.mesh).roles.sharpEdges).toBe(0);
    const again = m.toMesh({ normals: { mode: 'smooth' } });
    if (!again.ok) throw again.error;
    expect(again.value.report.gpuVertices).toBe(original.value.report.gpuVertices);
    expect(triangleSet(again.value.mesh)).toEqual(triangleSet(original.value.mesh));
  });

  it('detaches non-manifold triangles and skips collapsed ones, with a warning', () => {
    const mesh = handMesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0],
      [0, 1, 2, 1, 0, 3, 0, 1, 4, 5, 0, 1],
    );
    const m = model();
    const op = m.lift(mesh);
    expect(op.status).toBe('ok');
    expect(op.roles.face).toBe(3);
    expect(op.diagnostics?.[0]?.detail).toEqual({ detached: 1, collapsed: 1 });
    expect(m.validate().pass).toBe(true);
  });

  it('rejects unusable sources with structured errors', () => {
    const quantized = { ...handMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]) };
    const m1 = model();
    m1.lift({ ...quantized, attributes: { position: new Uint16Array(9) } });
    expect(m1.poisoned?.code).toBe('model-precondition');
    const m2 = model();
    m2.lift(handMesh([0, 0, 0, 1, 0, 0], [0, 1], 'line-list'));
    expect(m2.poisoned?.code).toBe('model-precondition');
    const m3 = model();
    m3.lift(handMesh([0, 0, 0, 1, 0, 0, 0, 0, 0], [0, 1, 2]));
    expect(m3.poisoned?.code).toBe('model-op-no-effect');
  });

  it('rejects out-of-range indices, submesh ranges and short attributes before mutating', () => {
    const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const index = model();
    const op = index.lift(handMesh(triangle, [0, 1, 7]));
    expect(op.error?.code).toBe('model-precondition');
    expect(op.error?.detail).toMatchObject({ index: 7, vertices: 3 });
    expect([index.editMesh.vertexCount, index.editMesh.faceCount]).toEqual([0, 0]);
    const range = model();
    const base = handMesh(triangle, [0, 1, 2]);
    range.lift({
      ...base,
      submeshes: [{ ...(base.submeshes[0] as MeshAsset['submeshes'][number]), indexCount: 6 }],
    });
    expect(range.poisoned?.detail).toMatchObject({ indexCount: 6, indices: 3 });
    const short = model();
    short.lift({ ...base, attributes: { ...base.attributes, uv: new Float32Array(4) } });
    expect(short.poisoned?.code).toBe('model-precondition');
    expect(short.poisoned?.detail).toMatchObject({ attribute: 'uv', length: 4, expected: 6 });
    expect(short.editMesh.vertexCount).toBe(0);
  });

  it('splits bowtie vertices into one vertex per corner fan, with a warning', () => {
    const m = model();
    const op = m.lift(
      handMesh([0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0], [0, 1, 2, 0, 3, 4]),
    );
    expect(op.status).toBe('ok');
    expect(op.diagnostics?.[0]?.detail).toEqual({ splitVertices: 1 });
    const mesh = m.editMesh;
    expect(mesh.vertexCount).toBe(6);
    const [a, b] = mesh.faces() as [number, number];
    expect(mesh.faceVertices(a).some((v) => mesh.faceVertices(b).includes(v))).toBe(false);
    expect(m.validate().pass).toBe(true);
  });
});
