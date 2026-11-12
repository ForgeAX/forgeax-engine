import { type FaceSelector, type Model, sel, type Tuple3 } from '@forgeax/engine-modeling';
import { decalBoxes } from './head-plan.ts';

/**
 * C-200 face plane checks (facet-plan.json `face`): the plane is the faceted front of the plan's face grid
 * (head.ts, tag `face-plane`), and its decal areas (the G7 eyes, mouth and blush) hold no pole
 * or fan. The brows are thin strokes under the fringe and carry no area check.
 */

/** Decal areas in the front view, [x0, y0, x1, y1] meters, on the face's front (z > FRONT). */
export type DecalBox = readonly [number, number, number, number];

/** Decal vertices count only in front of this z (the back of the head shares their x and y). */
const FRONT = 0.03;

/** The decal areas with an area check: eyes, mouth and blush (head-plan.ts decalBoxes). */
export function faceDecals(): Readonly<Record<string, DecalBox>> {
  return Object.fromEntries(Object.entries(decalBoxes()).filter(([k]) => !k.startsWith('brow')));
}

export function facePlane(): FaceSelector {
  return sel.tag('face-plane');
}

const inDecal = (p: readonly number[], boxes: readonly DecalBox[]) =>
  (p[2] as number) > FRONT && boxes.some(([x0, y0, x1, y1]) => (p[0] as number) >= x0 && (p[0] as number) <= x1 && (p[1] as number) >= y0 && (p[1] as number) <= y1);

/** Vertex valence (incident faces) over the whole mesh. */
function valences(m: Model): Map<number, number> {
  const mesh = m.editMesh;
  const val = new Map<number, number>();
  for (const f of mesh.faces()) for (const v of mesh.faceVertices(f)) val.set(v, (val.get(v) ?? 0) + 1);
  return val;
}

/** Margin around a decal box inside which valence 8 already counts as a pole (meters). */
const NEAR = 0.01;

/**
 * Poles and fans of the face plane (as badValence): vertices of valence 3 inside a decal area,
 * valence 8 or more within 10 mm of a decal area, and valence 9 or more anywhere on the plane
 * (valence-8 vertices sat 4 mm outside the eye box, so the decal-area check missed
 * them; the mirror seam's valence 8 away from the decals is the tiling's boundary tie).
 */
export function decalPoles(m: Model, plane: FaceSelector = facePlane()): { readonly position: Tuple3; readonly valence: number }[] {
  const mesh = m.editMesh;
  const boxes = Object.values(faceDecals());
  const near = boxes.map(([x0, y0, x1, y1]) => [x0 - NEAR, y0 - NEAR, x1 + NEAR, y1 + NEAR] as DecalBox);
  const val = valences(m);
  const vs = new Set(plane.evaluate(mesh).flatMap((f) => mesh.faceVertices(f)));
  return [...vs]
    .filter((v) => {
      const [n, p] = [val.get(v) as number, mesh.position(v)];
      return n >= 9 || (n <= 3 && inDecal(p, boxes)) || (n >= 8 && inDecal(p, near));
    })
    .map((v) => ({ position: mesh.position(v) as Tuple3, valence: val.get(v) as number }));
}

/**
 * Largest dihedral angle (degrees) over every edge whose midpoint lies inside a decal area, whatever
 * the faces' tags (a 28 deg crease on the face/skin border ran through the blush
 * while the plane-only fold check passed), with the edge midpoint.
 */
export function decalFolds(m: Model): { readonly edges: number; readonly maxDeg: number; readonly worst: Tuple3 } {
  const mesh = m.editMesh;
  const boxes = Object.values(faceDecals());
  let [edges, maxDeg, worst] = [0, 0, [0, 0, 0] as Tuple3];
  for (const e of sel.all().toEdges('contained').evaluate(mesh)) {
    const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v) as number[]);
    const mid = [0, 1, 2].map((i) => (a![i]! + b![i]!) / 2) as unknown as Tuple3;
    if (!inDecal(mid, boxes)) continue;
    edges++;
    const [n, k] = [faceNormal(m, mesh.hFace[e * 2] as number), faceNormal(m, mesh.hFace[e * 2 + 1] as number)];
    const deg = (Math.acos(Math.max(-1, Math.min(1, n[0] * k[0] + n[1] * k[1] + n[2] * k[2]))) * 180) / Math.PI;
    if (deg > maxDeg) [maxDeg, worst] = [deg, mid];
  }
  return { edges, maxDeg, worst };
}

/**
 * Largest dihedral angle (degrees) over the head's own edges below `top` (the neck: seam strip,
 * neck ring, throat and the turn into the under-jaw plane), with the edge midpoint. An edge on
 * the head's open border (against the collar or trunk) has one head face and does not count.
 */
export function neckFolds(m: Model, top: number): { readonly edges: number; readonly maxDeg: number; readonly worst: Tuple3 } {
  const mesh = m.editMesh;
  let [edges, maxDeg, worst] = [0, 0, [0, 0, 0] as Tuple3];
  for (const e of sel.tag('head').toEdges('contained').evaluate(mesh)) {
    const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v) as number[]);
    if (a![1]! > top || b![1]! > top) continue;
    edges++;
    const [n, k] = [faceNormal(m, mesh.hFace[e * 2] as number), faceNormal(m, mesh.hFace[e * 2 + 1] as number)];
    const deg = (Math.acos(Math.max(-1, Math.min(1, n[0] * k[0] + n[1] * k[1] + n[2] * k[2]))) * 180) / Math.PI;
    if (deg > maxDeg) [maxDeg, worst] = [deg, [0, 1, 2].map((i) => (a![i]! + b![i]!) / 2) as unknown as Tuple3];
  }
  return { edges, maxDeg, worst };
}

/** Smallest corner angle (degrees) over the triangles of a selection (head skin and seam: no sliver under 15 deg). */
export function minCornerAngle(m: Model, faces: FaceSelector): { readonly minDeg: number; readonly at: Tuple3 } {
  const mesh = m.editMesh;
  let [minDeg, at] = [180, [0, 0, 0] as Tuple3];
  for (const f of faces.evaluate(mesh)) {
    const p = mesh.faceVertices(f).map((v) => mesh.position(v) as number[]);
    for (let i = 0; i < p.length; i++) {
      const [o, a, b] = [p[i]!, p[(i + 1) % p.length]!, p[(i + p.length - 1) % p.length]!];
      const [u, w] = [a, b].map((q) => [0, 1, 2].map((j) => q[j]! - o[j]!));
      const c = (u![0]! * w![0]! + u![1]! * w![1]! + u![2]! * w![2]!) / (Math.hypot(...u!) * Math.hypot(...w!));
      const deg = (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
      if (deg < minDeg) [minDeg, at] = [deg, [0, 1, 2].map((j) => o[j]!) as unknown as Tuple3];
    }
  }
  return { minDeg, at };
}

/**
 * Face-plane faces over each decal area in the front view (the test's falsifier: the plane covers
 * every area; the decals are textures on its chart, so a flat facet may span one).
 */
export function decalFaces(m: Model, plane: FaceSelector): Readonly<Record<string, number>> {
  const mesh = m.editMesh;
  const faces = plane.evaluate(mesh).map((f) => mesh.faceVertices(f).map((v) => mesh.position(v)));
  const over = (pts: readonly (readonly number[])[], [x0, y0, x1, y1]: DecalBox) =>
    pts.some((p) => (p[2] as number) > FRONT) &&
    Math.min(...pts.map((p) => p[0] as number)) <= x1 &&
    Math.max(...pts.map((p) => p[0] as number)) >= x0 &&
    Math.min(...pts.map((p) => p[1] as number)) <= y1 &&
    Math.max(...pts.map((p) => p[1] as number)) >= y0;
  return Object.fromEntries(Object.entries(faceDecals()).map(([k, b]) => [k, faces.filter((pts) => over(pts, b)).length]));
}

/** Unit normal of a face from its first three corners (the plan's faces are triangles). */
function faceNormal(m: Model, f: number): Tuple3 {
  const [a, b, c] = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
  const [u, w] = [0, 1].map((k) => [0, 1, 2].map((i) => ((k === 0 ? b : c) as number[])[i]! - (a as number[])[i]!));
  const n = [u![1]! * w![2]! - u![2]! * w![1]!, u![2]! * w![0]! - u![0]! * w![2]!, u![0]! * w![1]! - u![1]! * w![0]!];
  const l = Math.hypot(...n);
  return [n[0]! / l, n[1]! / l, n[2]! / l];
}

/**
 * Face-plane fold check (no folds, interior max dihedral <= 20 deg;
 * the border stays sharp, which the G6 faceting test owns): the largest dihedral angle in degrees
 * over the edges between two face-plane faces, and the midpoint of that edge.
 */
export function facePlaneFolds(m: Model, plane: FaceSelector = facePlane()): { readonly interior: number; readonly maxDeg: number; readonly worst: Tuple3 } {
  const mesh = m.editMesh;
  const interior = plane.toEdges('contained').evaluate(mesh);
  let [maxDeg, worst] = [0, [0, 0, 0] as Tuple3];
  for (const e of interior) {
    const [n, k] = [faceNormal(m, mesh.hFace[e * 2] as number), faceNormal(m, mesh.hFace[e * 2 + 1] as number)];
    const deg = (Math.acos(Math.max(-1, Math.min(1, n[0] * k[0] + n[1] * k[1] + n[2] * k[2]))) * 180) / Math.PI;
    if (deg <= maxDeg) continue;
    const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v));
    [maxDeg, worst] = [deg, [0, 1, 2].map((i) => ((a as number[])[i]! + (b as number[])[i]!) / 2) as unknown as Tuple3];
  }
  return { interior: interior.length, maxDeg, worst };
}
