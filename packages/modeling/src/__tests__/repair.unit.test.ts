import { describe, expect, it } from 'vitest';
import { type EditMesh, NONE } from '../mesh';
import { model } from '../model';
import { type EdgeSelector, Selector, sel } from '../selectors';

const boundaryEdges = (mesh: EditMesh) => mesh.edges().filter((e) => mesh.isBoundaryEdge(e)).length;

/** Boundary edges whose ends both lie on y = `y`. */
function seamAt(y: number): EdgeSelector {
  return new Selector('edge', `seamAt(${y})`, (mesh) =>
    mesh
      .edges()
      .filter(
        (e) =>
          mesh.isBoundaryEdge(e) &&
          mesh.edgeVertices(e).every((v) => Math.abs((mesh.position(v)[1] as number) - y) < 1e-9),
      ),
  );
}

describe('cleanup.planar', () => {
  it('merges a triangulated box back into six quads and drops loop-cut vertices', () => {
    const m = model();
    m.box({ size: [1, 2, 3] });
    m.triangulate(sel.all());
    expect(m.inspect().faces).toBe(12);
    const r = m.cleanup.planar();
    expect(r.status).toBe('ok');
    expect(r.roles.mergedGroups).toBe(6);
    expect(m.inspect().faces).toBe(6);
    expect(m.validate().volume).toBeCloseTo(6, 12);
    const cut = model();
    cut.box({ size: [1, 1, 1] });
    cut.loopCut(sel.edges.parallel('y'), { cuts: 2 });
    expect(cut.inspect().vertices).toBe(16);
    cut.cleanup.planar();
    expect(cut.inspect()).toMatchObject({ faces: 6, vertices: 8 });
    expect(cut.cleanup.planar().error?.code).toBe('model-op-no-effect');
  });

  it('never merges across tags, author intent or corner discontinuities', () => {
    const tagged = model();
    tagged.box({ size: [1, 1, 1] });
    tagged.triangulate(sel.all());
    tagged.tag(sel.near([0.3, 0.5, 0.3], 1), 'decal');
    tagged.cleanup.planar();
    expect(tagged.count(sel.facing('+y'))).toBe(2);
    const sharp = model();
    sharp.box({ size: [1, 1, 1] });
    sharp.triangulate(sel.facing('+y'));
    sharp.markSharp(sel.facing('+y').toEdges('contained'));
    expect(sharp.cleanup.planar(sel.facing('+y')).error?.code).toBe('model-op-no-effect');
    const seams = model();
    seams.plane({ width: 2, height: 1, widthSegments: 2 });
    seams.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const left = sel.inBox([-1.1, -1, -1], [0.01, 1, 1]);
    const mesh = seams.editMesh;
    for (const f of left.evaluate(mesh)) {
      for (const h of mesh.faceHalves(f)) mesh.setCorner('uv0', h, [5, 5]);
    }
    expect(seams.cleanup.planar().error?.code).toBe('model-op-no-effect');
  });
});

describe('resolveTJunctions', () => {
  it('inserts the vertex a long edge passes so the seam closes', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 1, 0],
        [0, 1, 0],
      ],
    });
    m.polygon({
      points: [
        [0, 1, 0],
        [1, 1, 0],
        [1, 2, 0],
        [0, 2, 0],
      ],
    });
    m.polygon({
      points: [
        [1, 1, 0],
        [2, 1, 0],
        [2, 2, 0],
        [1, 2, 0],
      ],
    });
    m.weld({ distance: 1e-7 });
    const mesh = m.editMesh;
    const before = boundaryEdges(mesh);
    const r = m.resolveTJunctions();
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({});
    expect(r.repair).toMatchObject({ op: 'resolveTJunctions', changed: 1 });
    expect(r.repair?.sites[0]).toEqual({ at: [1, 1, 0], deviation: 0 });
    expect(boundaryEdges(mesh)).toBe(before - 3);
    expect(m.count(sel.all())).toBe(3);
    expect(
      sel
        .all()
        .evaluate(mesh)
        .some((f) => mesh.fLen[f] === 5),
    ).toBe(true);
    expect(m.resolveTJunctions().error?.code).toBe('model-op-no-effect');
  });

  it('interpolates corner values along the split edge', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 1, 0],
        [0, 1, 0],
      ],
    });
    m.polygon({
      points: [
        [0, 1, 0],
        [1, 1, 0],
        [1, 2, 0],
        [0, 2, 0],
      ],
    });
    m.polygon({
      points: [
        [1, 1, 0],
        [2, 1, 0],
        [2, 2, 0],
        [1, 2, 0],
      ],
    });
    m.weld({ distance: 1e-7 });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    m.resolveTJunctions();
    const mesh = m.editMesh;
    const big = mesh.faces().find((f) => mesh.fLen[f] === 5) as number;
    for (const h of mesh.faceHalves(big)) {
      const p = mesh.position(mesh.hVert[h] as number);
      const uv = mesh.corner('uv0', h) as Float32Array;
      expect(Math.abs((uv[0] as number) - p[0]) + Math.abs((uv[1] as number) - p[1])).toBeLessThan(
        1e-6,
      );
    }
  });
});

describe('resolveTJunctions report', () => {
  it('reports how far the host edge bends: a vertex 0.3 mm off its edge', () => {
    const m = model();
    m.polygon({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 1, 0],
        [0, 1, 0],
      ],
    });
    m.polygon({
      points: [
        [0, 1, 0],
        [1, 1.0003, 0],
        [1, 2, 0],
        [0, 2, 0],
      ],
    });
    m.polygon({
      points: [
        [1, 1.0003, 0],
        [2, 1, 0],
        [2, 2, 0],
        [1, 2, 0],
      ],
    });
    m.weld({ distance: 1e-7 });
    const r = m.resolveTJunctions({ distance: 0.0005 });
    expect(r.status, r.error?.message).toBe('ok');
    expect(r.repair).toMatchObject({ op: 'resolveTJunctions', changed: 1 });
    expect(r.repair?.sites).toHaveLength(1);
    expect(r.repair?.sites[0]?.deviation).toBeCloseTo(0.0003, 12);
    expect(r.repair?.sites[0]?.at).toEqual([1, 1.0003, 0]);
  });
});

describe('weldEdgeSequence', () => {
  it('stitches two facing open sequences with different vertex counts', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 2, center: [0, 0.5, 0] });
    m.plane({ width: 2, height: 1, widthSegments: 3, center: [0, 1.5, 0] });
    const mesh = m.editMesh;
    expect(boundaryEdges(mesh)).toBe(14);
    const r = m.weldEdgeSequence(seamAt(1));
    expect(r.status, r.error?.message).toBe('ok');
    expect(r.roles).toEqual({});
    expect(r.repair).toMatchObject({ op: 'weldEdgeSequence', changed: 5, inserted: 3 });
    expect(r.diagnostics).toBeUndefined();
    expect(boundaryEdges(mesh)).toBe(14 - 5);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    for (const e of mesh.edges()) {
      const [a, b] = mesh.edgeVertices(e);
      if (Math.abs(mesh.position(a)[1] - 1) < 1e-9 && Math.abs(mesh.position(b)[1] - 1) < 1e-9) {
        expect(mesh.hFace[e * 2]).not.toBe(NONE);
        expect(mesh.hFace[e * 2 + 1]).not.toBe(NONE);
      }
    }
  });

  it('reports half the gap as the move of each side', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 2, center: [0, 0.5, 0] });
    m.plane({ width: 2, height: 1, widthSegments: 2, center: [0, 1.502, 0] });
    const seam = new Selector('edge', 'seamBetween(1,1.002)', (mesh) =>
      mesh
        .edges()
        .filter(
          (e) =>
            mesh.isBoundaryEdge(e) &&
            mesh
              .edgeVertices(e)
              .every(
                (v) =>
                  (mesh.position(v)[1] as number) > 0.999 &&
                  (mesh.position(v)[1] as number) < 1.003,
              ),
        ),
    );
    const r = m.weldEdgeSequence(seam);
    expect(r.status, r.error?.message).toBe('ok');
    expect(r.repair).toMatchObject({ op: 'weldEdgeSequence', changed: 3, inserted: 0 });
    expect(r.repair?.sites).toHaveLength(3);
    expect(r.repair?.sites[0]?.deviation).toBeCloseTo(0.001, 12);
    expect(r.repair?.sites[0]?.at[1]).toBeCloseTo(1.001, 12);
  });

  it('closes a tube from two loops and rejects a single sequence or a wide gap', () => {
    const tube = model();
    tube.cylinder({
      radiusTop: 1,
      radiusBottom: 1,
      height: 1,
      radialSegments: 8,
      openEnded: true,
      center: [0, 0.5, 0],
    });
    tube.cylinder({
      radiusTop: 1,
      radiusBottom: 1,
      height: 1,
      radialSegments: 12,
      openEnded: true,
      center: [0, 1.5, 0],
    });
    const r = tube.weldEdgeSequence(seamAt(1));
    expect(r.status, r.error?.message).toBe('ok');
    expect(boundaryEdges(tube.editMesh)).toBe(8 + 12);
    const one = model();
    one.plane({ width: 2, height: 1, center: [0, 0.5, 0] });
    expect(one.weldEdgeSequence(seamAt(1)).error?.code).toBe('model-precondition');
    const apart = model();
    apart.plane({ width: 2, height: 1, center: [0, 0.5, 0] });
    apart.plane({ width: 2, height: 1, center: [0, 1.5, 0] });
    apart.translate(sel.inBox([-2, 0.99, -1], [2, 2.1, 1]), [0, 0, 0.5]);
    expect(apart.weldEdgeSequence(seamAt(1), { maxDistance: 0.1 }).error?.code).toBe(
      'model-precondition',
    );
    const interior = model();
    interior.box({ size: [1, 1, 1] });
    expect(interior.weldEdgeSequence(sel.edges.all()).error?.code).toBe('model-precondition');
  });
});

describe('cleanup.slivers (B11b R-2)', () => {
  it('a needle on an interior edge joins the face across; on a boundary it just goes', () => {
    const m = model();
    const mesh = m.editMesh;
    // Quad a b c d with a needle a -> e -> b under its edge a-b (e 0.02 mm below it).
    const [a, b, c, d, e] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0.3, -0.00002, 0],
    ].map((p) => mesh.addVertex(...(p as [number, number, number])));
    expect(mesh.addFace([a, b, c, d] as number[]).ok).toBe(true);
    expect(mesh.addFace([b, a, e] as number[]).ok).toBe(true);
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const r = m.cleanup.slivers(undefined, { width: 0.0001 });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({});
    expect(r.repair).toMatchObject({ op: 'cleanup.slivers', changed: 1, found: 1, keptCount: 0 });
    expect(r.repair?.sites[0]?.deviation).toBe(0);
    expect(r.diagnostics).toBeUndefined();
    expect(mesh.faceCount).toBe(1);
    expect(mesh.faceVertices(mesh.faces()[0] as number)).toHaveLength(5);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(m.toMesh().ok).toBe(true);
    // A needle with two apex vertices keeps their order along the edge.
    const two = model();
    const tm = two.editMesh;
    const [n0, n1, n2, n3, x1, x2] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0.7, -0.00002, 0],
      [0.3, -0.00003, 0],
    ].map((c) => tm.addVertex(...(c as [number, number, number])));
    expect(tm.addFace([n0, n1, n2, n3] as number[]).ok).toBe(true);
    expect(tm.addFace([n1, n0, x2, x1] as number[]).ok).toBe(true);
    expect(two.cleanup.slivers(undefined, { width: 0.0001 }).repair).toMatchObject({
      changed: 1,
    });
    expect(tm.faceVertices(tm.faces()[0] as number)).toEqual([n0, x2, x1, n1, n2, n3]);
    expect(two.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    // The same needle alone (its long edge on the boundary) is deleted.
    const lone = model();
    const lm = lone.editMesh;
    const ids = [
      [0, 0, 0],
      [1, 0, 0],
      [0.3, -0.00002, 0],
    ].map((p) => lm.addVertex(...(p as [number, number, number])));
    lm.addFace(ids);
    const q = lone.plane({ width: 1, height: 1, center: [0.5, 0.5, 0] });
    expect(q.status).toBe('ok');
    const gone = lone.cleanup.slivers(undefined, { width: 0.0001 });
    expect(gone.repair).toMatchObject({ changed: 1 });
    expect(gone.repair?.sites[0]?.deviation).toBeCloseTo(0.00002, 12);
  });

  it('an interior needle whose apex leaves the neighbour plane stays, so no face bends (S6a note)', () => {
    const m = model();
    const mesh = m.editMesh;
    // Needle b -> a -> e under the quad's edge a-b, its apex 0.05 mm out of the quad's
    // plane; a lower quad a-b-g-h shares its other two edges' ends, so the needle has
    // neighbours on every side (interior).
    const [a, b, c, d, e, g, h] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0.3, 0, 0.00005],
      [1, -1, 0],
      [0, -1, 0],
    ].map((p) => mesh.addVertex(...(p as [number, number, number])));
    mesh.addFace([a, b, c, d] as number[]);
    mesh.addFace([b, a, e] as number[]);
    mesh.addFace([a, h, g, b, e] as number[]);
    const r = m.cleanup.slivers(undefined, { width: 0.0001 });
    expect(r.status).toBe('ok');
    expect(r.roles).toEqual({});
    expect(r.repair).toMatchObject({ op: 'cleanup.slivers', changed: 0, found: 1, keptCount: 1 });
    expect(r.repair?.sites).toEqual([]);
    const warn = r.diagnostics?.find((x) => x.severity === 'warn' && x.message.includes('stay'));
    expect(warn).toBeDefined();
    expect(r.repair?.op === 'cleanup.slivers' ? r.repair.kept : []).toEqual(
      (warn?.detail as { at: unknown }).at,
    );
    expect(r.diagnostics).toHaveLength(1);
    expect(mesh.faceCount).toBe(3);
  });

  it('a needle on an open boundary goes even when its apex leaves the neighbour plane (S6a r7)', () => {
    const m = model();
    const mesh = m.editMesh;
    const [a, b, c, d, e] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0.3, 0, -0.00003],
    ].map((p) => mesh.addVertex(...(p as [number, number, number])));
    mesh.addFace([a, b, c, d] as number[]);
    mesh.addFace([b, a, e] as number[]);
    const r = m.cleanup.slivers(undefined, { width: 0.0001 });
    expect(r.repair).toMatchObject({ changed: 1 });
    expect(r.repair?.sites[0]?.deviation).toBeCloseTo(0.00003, 12);
    expect(mesh.faceCount).toBe(1);
    expect(mesh.vertexCount).toBe(4);
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('a collapsed strip reports how far its vertices moved to the survivor', () => {
    const m = model();
    const mesh = m.editMesh;
    const xs = [0, 1, 1.00005, 2];
    const ids = xs.flatMap((x) => [mesh.addVertex(x, 0, 0), mesh.addVertex(x, 1, 0)]);
    for (let i = 0; i < 3; i++) {
      const [a, b, c, d] = [ids[2 * i], ids[2 * i + 1], ids[2 * i + 3], ids[2 * i + 2]] as number[];
      expect(mesh.addFace([a, d, c, b] as number[]).ok).toBe(true);
    }
    const r = m.cleanup.slivers(undefined, { width: 0.0001 });
    expect(r.status, r.error?.message).toBe('ok');
    expect(r.repair).toMatchObject({ op: 'cleanup.slivers', changed: 1, found: 1, keptCount: 0 });
    expect(r.repair?.sites).toHaveLength(1);
    expect(r.repair?.sites[0]?.deviation).toBeCloseTo(0.000025, 12);
    expect(r.repair?.sites[0]?.at[0]).toBeCloseTo(1.000025, 12);
    expect(mesh.faceCount).toBe(2);
  });

  it('quiet turns finding nothing into an info', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const r = m.cleanup.slivers(undefined, { width: 0.001, quiet: true });
    expect(r.status).toBe('ok');
    expect(m.poisoned).toBeUndefined();
  });

  it('rejects a bad width; nothing narrower is no effect', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(m.cleanup.slivers(undefined, { width: 0 }).error?.code).toBe('model-invalid-argument');
    const n = model();
    n.box({ size: [1, 1, 1] });
    expect(n.cleanup.slivers(undefined, { width: 0.001 }).error?.code).toBe('model-op-no-effect');
  });
});
