import { describe, expect, it } from 'vitest';
import { exportMesh } from '../finish';
import { EditMesh } from '../mesh';
import { model } from '../model';
import { sel } from '../selectors';
import { reweldTopology } from './export-topology-helper';

/**
 * K5-3 gates: `exportMesh(mesh, { checkTopology: true })` reports the source topology after
 * welding positions at distance 0, and the exported buffer re-welded the same way agrees.
 */

type Tuple3 = [number, number, number];
const CORNER_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

/** A mesh from positions and vertex loops (loops may share or duplicate vertices). */
function build(positions: readonly Tuple3[], loops: readonly (readonly number[])[]): EditMesh {
  const mesh = new EditMesh();
  const ids = positions.map((p) => mesh.addVertex(p[0], p[1], p[2]));
  for (const loop of loops) {
    const face = mesh.addFace(loop.map((i) => ids[i] as number));
    if (!face.ok) throw face.error;
    mesh.faceHalves(face.value).forEach((h, k) => {
      mesh.setCorner('uv0', h, CORNER_UV[k] as readonly [number, number]);
    });
  }
  return mesh;
}

function topologyOf(mesh: EditMesh) {
  const exported = exportMesh(mesh, { checkTopology: true });
  if (!exported.ok) throw exported.error;
  return exported.value;
}

function box(session = model(), center: Tuple3 = [0, 0, 0]) {
  session.box({ size: [1, 1, 1], center });
  return session;
}

function exportedTopology(session: ReturnType<typeof model>) {
  session.uv.project({ mode: 'box', scale: 1 });
  const out = session.toMesh({ checkTopology: true });
  if (!out.ok) throw out.error;
  return out.value;
}

describe('ExportReport.topology (K5-3)', () => {
  it('is absent unless checkTopology is set', () => {
    const m = box();
    m.uv.project({ mode: 'box', scale: 1 });
    const out = m.toMesh();
    if (!out.ok) throw out.error;
    expect(out.value.report.topology).toBeUndefined();
  });

  it('a closed box has no free or non-manifold edges and one component', () => {
    const { report, mesh } = exportedTopology(box());
    expect(report.topology).toEqual({ freeEdges: 0, nonManifoldEdges: 0, components: 1 });
    expect(reweldTopology(mesh)).toEqual(report.topology);
  });

  it('an open box reports its four boundary edges (mutant: one face deleted from the closed box)', () => {
    const m = box();
    m.delete(sel.facing('+y'));
    const { report, mesh } = exportedTopology(m);
    expect(report.topology?.freeEdges).toBe(4);
    expect(report.topology?.nonManifoldEdges).toBe(0);
    expect(reweldTopology(mesh)).toEqual(report.topology);
  });

  it('a seam open by one f32 step between coincident vertex sets reports free edges; bitwise-equal duplicates weld closed', () => {
    const strip = (x: number) =>
      build(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 1],
          [0, 0, 1],
          [x, 0, 0],
          [2, 0, 0],
          [2, 0, 1],
          [x, 0, 1],
        ],
        [
          [0, 1, 2, 3],
          [4, 5, 6, 7],
        ],
      );
    const welded = topologyOf(strip(1));
    expect(welded.report.topology).toEqual({ freeEdges: 6, nonManifoldEdges: 0, components: 1 });
    expect(reweldTopology(welded.mesh)).toEqual(welded.report.topology);
    const open = topologyOf(strip(1 + 1e-6));
    expect(open.report.topology).toEqual({ freeEdges: 8, nonManifoldEdges: 0, components: 2 });
    expect(reweldTopology(open.mesh)).toEqual(open.report.topology);
  });

  it('three faces on one edge are non-manifold even though each has its own vertices', () => {
    const fin = (z: number, y: number): Tuple3[] => [
      [0, 0, 0],
      [1, 0, 0],
      [0.5, y, z],
    ];
    const mesh = build(
      [...fin(0, 1), ...fin(1, 0.5), ...fin(-1, 0.5)],
      [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
      ],
    );
    const { report, mesh: asset } = topologyOf(mesh);
    expect(report.topology).toEqual({ freeEdges: 6, nonManifoldEdges: 1, components: 1 });
    expect(reweldTopology(asset)).toEqual(report.topology);
  });

  it('two disjoint boxes are two components; touching at one welded vertex is one', () => {
    const apart = box(box(), [3, 0, 0]);
    const { report, mesh } = exportedTopology(apart);
    expect(report.topology).toEqual({ freeEdges: 0, nonManifoldEdges: 0, components: 2 });
    expect(reweldTopology(mesh)).toEqual(report.topology);
    const touching = exportedTopology(box(box(), [1, 1, 1]));
    expect(touching.report.topology?.components).toBe(1);
    expect(reweldTopology(touching.mesh)).toEqual(touching.report.topology);
  });
});
