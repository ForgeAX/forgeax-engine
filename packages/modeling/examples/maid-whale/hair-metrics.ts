import { type FaceSelector, type Model, SurfaceQuery, sel } from '@forgeax/engine-modeling';
import { BANGS, CAP, fringeOuterEdge, fringeRoot } from './hair.ts';

/**
 * C-200 G4 measurements on the hair session: bang stand-off,
 * front locks, back-mass side depth, clump tips and ahoge size.
 */

function vertices(m: Model, faces: FaceSelector): (readonly number[])[] {
  return [...new Set(faces.evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))].map((v) => m.editMesh.position(v));
}

const labelled = (m: Model, prefix: string): string[] => m.inspect().labels.map((l) => l.label).filter((l) => l.startsWith(prefix));
const anyOf = (labels: readonly string[]): FaceSelector => labels.reduce((s, l) => s.or(sel.createdBy(l)), sel.createdBy('__none__'));

/** The cap's front over the forehead (the bangs): its vertices in front of the face. */
const forehead = (m: Model) => vertices(m, sel.tag('hair').and(sel.inBox([-0.11, 0.6, 0.05], [0.11, 0.8, 1], { by: 'centroid' })));

/** Furthest forward point of the bangs where they lie on the face, below y 0.755 (z; the face plane is at 0.125). */
export function bangsFront(m: Model): number {
  return Math.max(...forehead(m).filter((p) => (p[1] as number) < 0.755).map((p) => p[2] as number));
}

/** Front locks per side, each with its width and depth across its section at mid-height (y 0.5). */
export function locks(m: Model, side: 'l' | 'r'): { readonly width: number; readonly depth: number }[] {
  return labelled(m, `hair-lock-${side}`).map((l) => {
    const ps = vertices(m, sel.createdBy(l)).filter((p) => Math.abs((p[1] as number) - 0.5) < 0.02);
    const ext = (k: number) => Math.max(...ps.map((p) => p[k] as number)) - Math.min(...ps.map((p) => p[k] as number));
    const [a, b] = [ext(0), ext(2)];
    return { width: Math.max(a, b), depth: Math.min(a, b) };
  });
}

/** Side-view back edge of the hair at height `y`: the most negative z where a hair edge crosses the plane. */
export function backEdge(m: Model, y: number): number {
  let edge = Infinity;
  for (const f of sel.tag('hair').evaluate(m.editMesh)) {
    const ps = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
    for (let i = 0; i < ps.length; i++) {
      const [a, b] = [ps[i] as readonly number[], ps[(i + 1) % ps.length] as readonly number[]];
      const [ya, yb] = [a[1] as number, b[1] as number];
      if ((ya - y) * (yb - y) > 0 || ya === yb) continue;
      const t = (y - ya) / (yb - ya);
      edge = Math.min(edge, (a[2] as number) + ((b[2] as number) - (a[2] as number)) * t);
    }
  }
  return edge;
}

/** Pointed clump tips of the back mass. */
export function tipCount(m: Model): number {
  return labelled(m, 'hair-tip-').length;
}

/** Ahoge extents: width across (x) and depth (z). */
export function ahoge(m: Model): { readonly width: number; readonly depth: number } {
  const ps = vertices(m, anyOf(labelled(m, 'hair-ahoge')));
  const ext = (k: number) => Math.max(...ps.map((p) => p[k] as number)) - Math.min(...ps.map((p) => p[k] as number));
  return { width: ext(0), depth: ext(2) };
}

const span = (ps: readonly (readonly number[])[], k: number): [number, number] => [Math.min(...ps.map((p) => p[k] as number)), Math.max(...ps.map((p) => p[k] as number))];

/** Each bang clump's span across the forehead (between its grooves) and its vertices there. */
function clumps(m: Model): { readonly lo: number; readonly hi: number; readonly ps: (readonly number[])[] }[] {
  const all = forehead(m);
  return BANGS.ends.map((_, i) => {
    const [lo, hi] = [(BANGS.edges[i] as number) + 0.004, (BANGS.edges[i + 1] as number) - 0.004];
    return { lo, hi, ps: all.filter((p) => (p[0] as number) > lo - 0.02 && (p[0] as number) < hi + 0.02 && (p[1] as number) < 0.79) };
  });
}

/** the lowest point of each bang clump, left to right. */
export function bangEnds(m: Model): number[] {
  return clumps(m).map((c) => Math.min(...c.ps.filter((p) => (p[0] as number) > c.lo && (p[0] as number) < c.hi + 0.015).map((p) => p[1] as number)));
}

/** how far down the bangs cover the forehead: the highest of the lowest hair points across |x| <= 0.07. */
export function bangCoverage(m: Model): number {
  const all = forehead(m);
  let worst = -Infinity;
  for (let x = -0.07; x <= 0.07 + 1e-9; x += 0.005) {
    const near = all.filter((p) => Math.abs((p[0] as number) - x) < 0.004);
    worst = Math.max(worst, Math.min(...near.map((p) => p[1] as number)));
  }
  return worst;
}

/** The x extent where the edges of `faces` cross the plane at height `y`. */
function sliceX(m: Model, faces: FaceSelector, y: number): [number, number] {
  let [lo, hi] = [Infinity, -Infinity];
  for (const f of faces.evaluate(m.editMesh)) {
    const ps = m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v));
    for (let i = 0; i < ps.length; i++) {
      const [a, b] = [ps[i] as readonly number[], ps[(i + 1) % ps.length] as readonly number[]];
      const [ya, yb] = [a[1] as number, b[1] as number];
      if ((ya - y) * (yb - y) > 0 || ya === yb) continue;
      const x = (a[0] as number) + ((b[0] as number) - (a[0] as number)) * ((y - ya) / (yb - ya));
      [lo, hi] = [Math.min(lo, x), Math.max(hi, x)];
    }
  }
  return [lo, hi];
}

/**
 * the cap's raised clumps around the head at `polar` degrees off the crown: the
 * outer surface's distance from the head's centre at 72 azimuths, and the grooves between them.
 */
export function crownRidges(m: Model, center: readonly [number, number, number], polar = 40, prominence = 0.002): number {
  const q = SurfaceQuery.of(m.editMesh, sel.createdBy('hair-cap', 'layer').evaluate(m.editMesh));
  if (!q.ok) throw q.error;
  const f = (polar * Math.PI) / 180;
  const r = Array.from({ length: 72 }, (_, i) => {
    const a = (i * 5 * Math.PI) / 180;
    const d: [number, number, number] = [Math.sin(f) * Math.sin(a), Math.cos(f), Math.sin(f) * Math.cos(a)];
    const h = q.value.project([center[0] + d[0] * 0.4, center[1] + d[1] * 0.4, center[2] + d[2] * 0.4], [-d[0], -d[1], -d[2]], 0.6);
    return h === undefined ? Number.NaN : Math.hypot(h.point[0] - center[0], h.point[1] - center[1], h.point[2] - center[2]);
  });
  // Grooves between clumps: local minima `prominence` under the highest surface within 20
  // degrees on both sides (each clump is a raised band, so grooves count them around the head).
  let grooves = 0;
  for (let i = 0; i < 72; i++) {
    const v = r[i] as number;
    if (!(v <= (r[(i + 71) % 72] as number) && v < (r[(i + 1) % 72] as number))) continue;
    const high = (step: number) => Math.max(...[1, 2, 3, 4].map((k) => r[(i + step * k + 72) % 72] as number));
    if (Math.min(high(1), high(-1)) - v >= prominence) grooves++;
  }
  return grooves;
}

/** a side's joined mass, its locks, and the hair's outline across at y 0.5. */
export function sideMass(m: Model, side: 'l' | 'r'): { readonly mass: boolean; readonly locks: number; readonly outline: number } {
  const mass = labelled(m, `hair-side-${side}`).length === 1;
  const ps = vertices(m, sel.tag('hair')).filter((p) => Math.abs((p[1] as number) - 0.5) < 0.01);
  const xs = span(ps, 0);
  return { mass, locks: labelled(m, `hair-lock-${side}`).length, outline: side === 'l' ? xs[1] : -xs[0] };
}

/** each clump's width across its tip (y 0.75) and its tip's offset from its span's middle. */
export function bangTips(m: Model): { readonly width: number; readonly drift: number }[] {
  return clumps(m).map((c, i) => {
    const [a, b] = sliceX(m, sel.tag('hair').and(sel.inBox([c.lo, 0.6, 0.05], [c.hi, 0.8, 1], { by: 'centroid' })), 0.75);
    // Its tip lies within its span widened by its sweep.
    const reach = Math.abs(BANGS.sweep[i] as number) + 0.004;
    const low = c.ps.filter((p) => (p[0] as number) > c.lo - reach && (p[0] as number) < c.hi + reach).reduce((x, p) => ((p[1] as number) < (x[1] as number) ? p : x));
    return { width: b - a, drift: (low[0] as number) - (c.lo + c.hi) / 2 };
  });
}

/** the largest gap between the bangs' underside and the forehead skin (y 0.74-0.79). */
export function bangStandoff(m: Model): number {
  const skin = SurfaceQuery.of(m.editMesh, sel.createdBy('figure').and(sel.tag('head')).evaluate(m.editMesh));
  if (!skin.ok) throw skin.error;
  let worst = 0;
  for (const p of vertices(m, sel.createdBy('hair-cap-wall', 'inner').and(sel.inBox([-0.1, 0.74, 0.05], [0.1, 0.79, 1], { by: 'centroid' })))) {
    const h = skin.value.nearest(p as [number, number, number]);
    if (h !== undefined) worst = Math.max(worst, Math.hypot(h.point[0] - (p[0] as number), h.point[1] - (p[1] as number), h.point[2] - (p[2] as number)));
  }
  return worst;
}

/**
 * G6 fringe border (facet-plan.json bangs): the cap's rim around the fringe, where the cap's
 * outer wall (hair-cap) meets its inner wall (hair-cap-wall) in the tapered crease the opening
 * leaves, above the outer edges' ends. For each rim vertex: how far it stands proud of the
 * fringe's outer surface along the head's radius (meters, signed: proud positive; undefined
 * outside the fringe), and its distance in the forehead's (x, y) from the fringe's seams (root
 * line and outer edges).
 */
export function fringeCapBorder(m: Model): { readonly proud: number | undefined; readonly lateral: number; readonly at: readonly number[] }[] {
  const mesh = m.editMesh;
  const fringe = SurfaceQuery.of(mesh, sel.tag('hair-fringe').evaluate(mesh));
  if (!fringe.ok) throw fringe.error;
  const head = m.bounds(sel.tag('head').minus(sel.tag('hair')));
  if (!head.ok) throw head.error;
  const center = [(head.value.min[0] + head.value.max[0]) / 2, CAP.centerY, (head.value.min[2] + head.value.max[2]) / 2] as const;
  const [outer, inner] = [mesh.labelNames.indexOf('hair-cap'), mesh.labelNames.indexOf('hair-cap-wall')];
  const [left, right] = [fringeOuterEdge(0), fringeOuterEdge(1)];
  const bottom = Math.min(left[1][1], right[1][1]);
  // The seams as a polyline in (x, y): down the left edge, along the root, down the right edge.
  const seam: [number, number][] = [left[1], left[0]];
  for (let k = 1; k < 100; k++) {
    const x = left[0][0] + ((right[0][0] - left[0][0]) * k) / 100;
    seam.push([x, fringeRoot(x)]);
  }
  seam.push(right[0], right[1]);
  const lateral = (x: number, y: number) => {
    let best = Infinity;
    for (let i = 0; i + 1 < seam.length; i++) {
      const [a, b] = [seam[i] as [number, number], seam[i + 1] as [number, number]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t));
    }
    return best;
  };
  const rim = new Set<number>();
  for (const f of mesh.faces()) {
    if ((mesh.fLabel[f] as number) !== outer) continue;
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g < 0 || (mesh.fLabel[g] as number) !== inner) continue;
      for (const v of [mesh.hVert[h] as number, mesh.hVert[h ^ 1] as number]) {
        const p = mesh.position(v);
        if ((p[2] as number) > 0.03 && (p[1] as number) >= bottom && Math.abs(p[0] as number) < 0.14) rim.add(v);
      }
    }
  }
  return [...rim].map((v) => {
    const p = mesh.position(v) as readonly [number, number, number];
    const r = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
    const n = [(p[0] - center[0]) / r, (p[1] - center[1]) / r, (p[2] - center[2]) / r] as const;
    const hit = fringe.value.project([p[0] + n[0] * 0.03, p[1] + n[1] * 0.03, p[2] + n[2] * 0.03], [-n[0], -n[1], -n[2]], 0.035);
    const proud = hit === undefined ? undefined : (p[0] - hit.point[0]) * n[0] + (p[1] - hit.point[1]) * n[1] + (p[2] - hit.point[2]) * n[2];
    return { proud, lateral: lateral(p[0], p[1]), at: p };
  });
}
