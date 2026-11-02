import { type FaceSelector, type Model, SurfaceQuery, sel } from '@forgeax/engine-modeling';

/** C-200 G5 measurements: how closely an attachment sits on what it hangs on. */

/**
 * The smallest gap between a part and the surface it is seated on (0 = touching): over points
 * along every edge of each (`SEAT_SAMPLES` per edge, ends included) to the other's surface, both
 * ways, so a flat face resting on a ridge (a knot on a faceted lobe's crest) counts as touching.
 */
export function seatGap(m: Model, part: FaceSelector, seat: FaceSelector): number {
  const mesh = m.editMesh;
  const box = (faces: readonly number[]) => {
    const ps = faces.flatMap((f) => mesh.faceVertices(f).map((v) => mesh.position(v)));
    return [0, 1, 2].map((k) => [Math.min(...ps.map((p) => p[k] as number)), Math.max(...ps.map((p) => p[k] as number))] as const);
  };
  const [partFaces, seatFaces] = [part.evaluate(mesh), seat.evaluate(mesh)];
  // Only faces near the other part can hold its closest point (within the best vertex gap so far).
  const near = (faces: readonly number[], other: ReturnType<typeof box>, reach: number) =>
    faces.filter((f) => mesh.faceVertices(f).some((v) => mesh.position(v).every((x, k) => x >= (other[k] as readonly [number, number])[0] - reach && x <= (other[k] as readonly [number, number])[1] + reach)));
  const gapFrom = (from: readonly number[], onto: readonly number[]) => {
    const q = SurfaceQuery.of(mesh, onto);
    if (!q.ok) throw q.error;
    let gap = Infinity;
    for (const f of from) {
      const vs = mesh.faceVertices(f).map((v) => mesh.position(v));
      for (const [i, a] of vs.entries()) {
        const b = vs[(i + 1) % vs.length] as typeof a;
        for (let k = 0; k < SEAT_SAMPLES; k++) {
          const t = k / SEAT_SAMPLES;
          const p: [number, number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
          const h = q.value.nearest(p);
          if (h !== undefined) gap = Math.min(gap, Math.hypot(h.point[0] - p[0], h.point[1] - p[1], h.point[2] - p[2]));
        }
      }
    }
    return gap;
  };
  if (partFaces.length === 0 || seatFaces.length === 0) return Infinity;
  const reach = 0.02;
  return Math.min(gapFrom(near(partFaces, box(seatFaces), reach), seatFaces), gapFrom(near(seatFaces, box(partFaces), reach), partFaces));
}

/** Samples along each edge for seatGap. */
const SEAT_SAMPLES = 16;

/** The seats of the attachments: each part's tag and what it hangs on. */
export const SEATS: readonly (readonly [string, FaceSelector])[] = [
  ['bowtie', sel.tag('collar').or(sel.tag('apron-bib')).or(sel.tag('bodice'))],
  ['brooch', sel.tag('bowtie')],
  ['back-bow', sel.tag('waistband')],
  ['apron-ties', sel.tag('tie-seat')],
  ['headdress', sel.tag('hair').minus(sel.tag('headdress'))],
  ['fin-l', sel.tag('hair').minus(sel.tag('fin-l')).minus(sel.tag('headdress'))],
  ['fin-r', sel.tag('hair').minus(sel.tag('fin-r')).minus(sel.tag('headdress'))],
  ['ribbon-l', sel.tag('hair').or(sel.tag('headdress')).minus(sel.tag('ribbon-l'))],
  ['ribbon-r', sel.tag('hair').or(sel.tag('headdress')).minus(sel.tag('ribbon-r'))],
];

type Point = readonly [number, number, number];

/** The vertices of a part. */
export function partPoints(m: Model, part: FaceSelector): Point[] {
  return [...new Set(part.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))].map((v) => m.editMesh.position(v) as Point);
}


/** A part's extent along a unit direction. */
export function extentAlong(points: readonly Point[], dir: Point): number {
  const k = points.map((p) => p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2]);
  return Math.max(...k) - Math.min(...k);
}


/**
 * A flat part's section across its axis from `a` to `b`, over its vertices within the axis's
 * `[from, to]` fraction: [width in the plane with normal `normal`, thickness along it].
 */
export function lobeSection(m: Model, part: FaceSelector, a: Point, b: Point, normal: Point, from: number, to: number): [number, number] {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  const n = [normal[0] / nl, normal[1] / nl, normal[2] / nl] as const;
  const w = [n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]] as const;
  const wl = Math.hypot(w[0], w[1], w[2]);
  const pts = partPoints(m, part).filter((p) => {
    const k = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / len2;
    return k >= from && k <= to;
  });
  return [extentAlong(pts, [w[0] / wl, w[1] / wl, w[2] / wl]), extentAlong(pts, n)];
}

/** The mean distance from path station `i` of a tube's vertices nearest to it (its ring radius there). */
export function ringRadius(m: Model, part: FaceSelector, path: readonly Point[], i: number): number {
  const dist = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const ring = partPoints(m, part).filter((p) => path.every((q, j) => j === i || dist(p, q) >= dist(p, path[i] as Point)));
  return ring.reduce((a, p) => a + dist(p, path[i] as Point), 0) / ring.length;
}
