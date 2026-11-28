// Feature-model generators for the baseline cases: three license-clean triangle meshes built with the
// kernel's own mesh pipeline (no downloaded assets). The committed JSON files in ./meshes are the case
// references; `gen-feature-meshes.ts` rewrites them from these builders.

import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { EvalMesh, Vec3 } from './mesh.ts';

type Tuple3 = [number, number, number];

function ensureLive(m: Model, what: string): void {
  if (m.poisoned !== undefined) throw new Error(`${what} failed: ${m.poisoned.message}`);
}

/** Triangulate a model and read it back as an eval mesh (shared vertex ids, loops in model order). */
export function triangleMesh(m: Model, what: string): EvalMesh {
  m.triangulate(sel.all());
  ensureLive(m, what);
  const mesh = m.editMesh;
  const index = new Map<number, number>();
  const positions: Vec3[] = [];
  const faces: number[][] = mesh.faces().map((f) =>
    mesh.faceVertices(f).map((v) => {
      let i = index.get(v);
      if (i === undefined) {
        i = positions.length;
        index.set(v, i);
        positions.push([...mesh.position(v)] as unknown as Tuple3);
      }
      return i;
    }),
  );
  return { positions, faces };
}

function cylinderAlong(
  m: Model,
  axis: 'x' | 'y' | 'z',
  radius: number,
  length: number,
  center: Vec3,
  segments: number,
): Model {
  const c = model();
  c.cylinder({
    radiusTop: radius,
    radiusBottom: radius,
    height: length,
    radialSegments: segments,
    center: [...center],
  });
  if (axis === 'z') c.rotate(sel.all(), 'x', 90, [...center]);
  else if (axis === 'x') c.rotate(sel.all(), 'z', 90, [...center]);
  ensureLive(c, 'cylinder tool');
  ensureLive(m, 'cylinder host');
  return c;
}

/**
 * F1 fandisk-style part: a stepped extrusion with a chamfer ridge, a filleted concave step
 * edge and a through hole (cylinder boolean). Sharp: ridge, step, hole rims; smooth: fillet.
 */
export function buildFandisk(): EvalMesh {
  const m = model();
  m.extrudePolygon({
    points: [
      [0, 0],
      [1, 0],
      [1, 0.28],
      [0.78, 0.5],
      [0.4, 0.5],
      [0.4, 0.8],
      [0, 0.8],
    ],
    depth: 0.6,
    label: 'body',
  });
  m.bevel(sel.edges.concave(), { width: 0.08, segments: 4 });
  const hole = cylinderAlong(m, 'z', 0.12, 1.0, [0.2, 0.55, 0.3], 32);
  m.difference(hole, {});
  return triangleMesh(m, 'F1 fandisk');
}

/** F2 flanged pipe tee: run with flanges, side branch with a flange, and bolt holes in the flanges. */
export function buildPipeTee(): EvalMesh {
  const m = model();
  const pipe = (label: string, r: number, h: number, c: [number, number, number]) =>
    m.cylinder({
      radiusTop: r,
      radiusBottom: r,
      height: h,
      radialSegments: 32,
      center: c,
      label,
    });
  pipe('run', 0.3, 2, [0, 0, 0]);
  pipe('top', 0.5, 0.12, [0, 0.94, 0]);
  m.union(sel.createdBy('top'), { label: 'run-top' });
  pipe('bottom', 0.5, 0.12, [0, -0.94, 0]);
  m.union(sel.createdBy('bottom'), { label: 'run-bottom' });
  pipe('branch', 0.22, 0.9, [0, 0, 0]);
  m.rotate(sel.createdBy('branch'), 'z', 90, [0, 0, 0]);
  m.translate(sel.createdBy('branch'), [0.55, 0, 0]);
  m.union(sel.createdBy('branch'), { label: 'tee' });
  pipe('bflange', 0.4, 0.1, [0, 0, 0]);
  m.rotate(sel.createdBy('bflange'), 'z', 90, [0, 0, 0]);
  m.translate(sel.createdBy('bflange'), [1.0, 0, 0]);
  m.union(sel.createdBy('bflange'), { label: 'branch-flange' });
  for (const [bx, bz] of [
    [0.4, 0],
    [-0.4, 0],
    [0, 0.4],
    [0, -0.4],
  ] as const)
    for (const y of [0.94, -0.94]) {
      const bolt = cylinderAlong(m, 'y', 0.05, 0.3, [bx, y, bz], 16);
      m.difference(bolt, {});
    }
  ensureLive(m, 'F2 pipe tee');
  return triangleMesh(m, 'F2 pipe tee');
}

/** F3 twisted bracket: a twisted L-section sweep with a vertical hole through the base, mixed crease angles. */
export function buildTwistedBracket(): EvalMesh {
  const m = model();
  const stations: Tuple3[] = [];
  for (let i = 0; i <= 8; i++) stations.push([0, 0, i / 8]);
  m.sweep({
    profile: [
      [0, 0],
      [0.4, 0],
      [0.4, 0.08],
      [0.08, 0.08],
      [0.08, 0.4],
      [0, 0.4],
    ],
    path: stations,
    twist: 60,
    sharpAngle: 20,
  });
  const hole = cylinderAlong(m, 'y', 0.04, 1, [0.27, 0.1, 0.5], 24);
  m.difference(hole, {});
  return triangleMesh(m, 'F3 twisted bracket');
}
