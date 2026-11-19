import { describe, expect, it } from 'vitest';
import { EditMesh, edgeEnds, edgeKey, NONE } from '../mesh';

function quad(mesh: EditMesh): number[] {
  return [
    mesh.addVertex(0, 0, 0),
    mesh.addVertex(1, 0, 0),
    mesh.addVertex(1, 0, 1),
    mesh.addVertex(0, 0, 1),
  ];
}

describe('EditMesh half-edge core', () => {
  it('pairs half-edges so twin(h) = h ^ 1 and shares edges between adjacent faces', () => {
    const mesh = new EditMesh();
    const [a, b, c, d] = quad(mesh) as [number, number, number, number];
    const e = mesh.addVertex(2, 0, 0);
    const f = mesh.addVertex(2, 0, 1);
    expect(mesh.addFace([a, d, c, b]).ok).toBe(true);
    expect(mesh.addFace([b, c, f, e]).ok).toBe(true);
    expect(mesh.edgeCount).toBe(7);
    const h = mesh.findHalf(b, c);
    expect(h).not.toBe(NONE);
    expect(mesh.hVert[h ^ 1]).toBe(c);
    expect(mesh.hFace[h]).not.toBe(mesh.hFace[h ^ 1]);
  });

  it('rejects a face that reuses a directed edge (non-manifold or inconsistent orientation)', () => {
    const mesh = new EditMesh();
    const [a, b, c, d] = quad(mesh) as [number, number, number, number];
    expect(mesh.addFace([a, b, c, d]).ok).toBe(true);
    const again = mesh.addFace([a, b, c]);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('model-precondition');
    expect(mesh.faceCount).toBe(1);
  });

  it('rejects repeated vertices and short loops as degenerate', () => {
    const mesh = new EditMesh();
    const [a, b] = quad(mesh) as [number, number, number, number];
    const short = mesh.addFace([a, b]);
    expect(!short.ok && short.error.code).toBe('model-degenerate');
    const repeated = mesh.addFace([a, b, a]);
    expect(!repeated.ok && repeated.error.code).toBe('model-degenerate');
  });

  it('frees edges when both sides lose their faces and reuses ids deterministically', () => {
    const mesh = new EditMesh();
    const loop = quad(mesh);
    const face = mesh.addFace(loop);
    if (!face.ok) throw face.error;
    mesh.removeFace(face.value);
    expect(mesh.faceCount).toBe(0);
    expect(mesh.edgeCount).toBe(0);
    const again = mesh.addFace(loop);
    expect(again.ok && again.value).toBe(face.value);
    expect(mesh.isFaceAlive(face.value)).toBe(true);
  });

  it('compacts to a history-independent canonical mesh', () => {
    const edited = new EditMesh();
    const scratch = edited.addVertex(9, 9, 9);
    const loop = quad(edited);
    const first = edited.addFace(loop);
    if (!first.ok) throw first.error;
    edited.removeFace(first.value);
    edited.removeVertex(scratch);
    edited.addFace(loop);
    const fresh = new EditMesh();
    fresh.addFace(quad(fresh));
    const a = edited.compact().mesh;
    const b = fresh.compact().mesh;
    expect(Array.from(a.pos.subarray(0, 12))).toEqual(Array.from(b.pos.subarray(0, 12)));
    expect(Array.from(a.hVert.subarray(0, a.halfHighWater))).toEqual(
      Array.from(b.hVert.subarray(0, b.halfHighWater)),
    );
    expect(a.vertexCount).toBe(4);
  });

  it('grows tag storage beyond 32 tags', () => {
    const mesh = new EditMesh();
    const face = mesh.addFace(quad(mesh));
    if (!face.ok) throw face.error;
    for (let i = 0; i < 40; i++) mesh.addTag(face.value, mesh.tagIndex(`t${i}`, true));
    expect(mesh.tagWords).toBe(2);
    expect(mesh.hasTag(face.value, mesh.tagIndex('t39', false))).toBe(true);
    expect(mesh.hasTag(face.value, mesh.tagIndex('t0', false))).toBe(true);
  });
});

describe('edge keys and the vertex cap', () => {
  it('edgeEnds inverts edgeKey, smaller id first', () => {
    for (const [a, b] of [
      [0, 1],
      [7, 3],
      [(1 << 26) - 2, (1 << 26) - 1],
    ] as const) {
      expect(edgeEnds(edgeKey(a, b))).toEqual([Math.min(a, b), Math.max(a, b)]);
      expect(edgeKey(a, b)).toBe(edgeKey(b, a));
    }
  });

  it('refuses a vertex id that would alias another edge key', () => {
    const mesh = new EditMesh();
    mesh.vertexHighWater = 1 << 26;
    expect(() => mesh.addVertex(0, 0, 0)).toThrow(RangeError);
  });
});
