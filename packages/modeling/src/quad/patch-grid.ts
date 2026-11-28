import { acos } from '../brep/dmath-acos';
import { solveSideCounts } from '../brep/quad-counts';
import { layoutPatches, type PatchLayout } from './patch-layout';
import type { TriMesh } from './trimesh';

/**
 * Coons quad grids over the merged feature-only patch layout.
 *
 * Each patch boundary splits at its feature corners into four sides. A side shared by two patches is
 * one polyline with one sample count and one point list, so both neighbours reference identical
 * boundary vertices. Opposite sides of every four-sided patch are unioned (union-find) into classes;
 * each class takes the maximum count forced by its members. A patch that cannot be gridded is
 * reported as unmeshed with a reason and is never partially emitted.
 */

export interface PatchGridOptions {
  /** Target edge length of the grid; default is twice the mean mesh edge length. */
  readonly targetSize?: number;
  /** Feature threshold forwarded to layoutPatches. */
  readonly featureCos?: number;
}

export interface UnmeshedPatch {
  readonly patch: number;
  readonly detail: {
    readonly reason: string;
    readonly corners: number;
    readonly triangles: number;
  };
  /** Triangle ids of the patch, for highlighting in renders. */
  readonly triangles: readonly number[];
}

export interface PatchGridMetrics {
  readonly quads: number;
  readonly patches: number;
  /** Patches whose boundary does not have exactly four corners (merged-layout corner count). */
  readonly patchesNotFour: number;
  readonly gridded: number;
  readonly unmeshed: number;
  /** Edges on a side shared by two gridded patches that are not used exactly twice. Must be 0. */
  readonly openEdges: number;
  /** Quad edges used once that are not on a shared gridded side (mesh boundary or unmeshed neighbour). */
  readonly freeEdges: number;
  readonly minScaledJacobian: number;
  readonly invertedQuads: number;
  /** Percent of mesh surface area inside gridded patches. */
  readonly areaCoveredPct: number;
}

export interface PatchGrid {
  /** Quad vertices, x y z per vertex. */
  readonly positions: Float64Array;
  /** Four vertex ids per quad, consistently oriented with the patch loop. */
  readonly quads: Uint32Array;
  readonly unmeshed: readonly UnmeshedPatch[];
  readonly metrics: PatchGridMetrics;
  readonly layout: PatchLayout;
}

interface Side {
  /** Mesh vertex chain in canonical direction; endpoints are corners. */
  readonly chain: readonly number[];
  readonly length: number;
  count: number;
  readonly patches: number[];
}

interface SideRef {
  readonly id: number;
  /** True when the patch loop traverses the side in its canonical direction. */
  readonly forward: boolean;
}

function vertexPos(p: Float64Array, v: number): [number, number, number] {
  return [p[3 * v] as number, p[3 * v + 1] as number, p[3 * v + 2] as number];
}

function distance(p: Float64Array, a: number, b: number): number {
  const [ax, ay, az] = vertexPos(p, a);
  const [bx, by, bz] = vertexPos(p, b);
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function patchGrid(mesh: TriMesh, options: PatchGridOptions = {}): PatchGrid {
  const layout = layoutPatches(
    mesh,
    options.featureCos === undefined
      ? {}
      : { sharpDegrees: (acos(options.featureCos) * 180) / Math.PI },
  );
  const p = mesh.positions;
  const t = mesh.triangles;
  const triCount = t.length / 3;
  const vertCount = p.length / 3;
  const pairKey = (a: number, b: number): number => a * vertCount + b;
  const edgeKey = (a: number, b: number): number => (a < b ? pairKey(a, b) : pairKey(b, a));

  const featureSet = new Set<number>();
  for (const [a, b] of layout.featureEdges) featureSet.add(edgeKey(a, b));

  const halfEdgeOwner = new Map<number, number>();
  let edgeLengthSum = 0;
  let edgeTotal = 0;
  const seenEdge = new Set<number>();
  for (let f = 0; f < triCount; f++) {
    for (let k = 0; k < 3; k++) {
      const a = t[3 * f + k] as number;
      const b = t[3 * f + ((k + 1) % 3)] as number;
      halfEdgeOwner.set(pairKey(a, b), f);
      const e = edgeKey(a, b);
      if (seenEdge.has(e)) continue;
      seenEdge.add(e);
      edgeLengthSum += distance(p, a, b);
      edgeTotal++;
    }
  }
  const meanEdge = edgeTotal > 0 ? edgeLengthSum / edgeTotal : 1;
  const target = options.targetSize ?? 2 * meanEdge;

  const patchTris: number[][] = Array.from({ length: layout.patchCount }, () => []);
  for (let f = 0; f < triCount; f++) (patchTris[layout.patchOf[f] as number] as number[]).push(f);

  // Directed boundary half-edges per patch: a half-edge is boundary when its twin lies in another patch
  // or the edge is a feature edge.
  const boundaryNext: Map<number, number>[] = Array.from(
    { length: layout.patchCount },
    () => new Map(),
  );
  const pinched = new Uint8Array(layout.patchCount);
  for (let f = 0; f < triCount; f++) {
    const P = layout.patchOf[f] as number;
    for (let k = 0; k < 3; k++) {
      const a = t[3 * f + k] as number;
      const b = t[3 * f + ((k + 1) % 3)] as number;
      const twin = halfEdgeOwner.get(pairKey(b, a));
      const isBoundary =
        twin === undefined || layout.patchOf[twin] !== P || featureSet.has(edgeKey(a, b));
      if (!isBoundary) continue;
      const next = boundaryNext[P] as Map<number, number>;
      if (next.has(a)) pinched[P] = 1;
      next.set(a, b);
    }
  }

  // Loops per patch. A well-formed patch has exactly one closed loop.
  const loops: number[][][] = Array.from({ length: layout.patchCount }, () => []);
  const openChain = new Uint8Array(layout.patchCount);
  for (let P = 0; P < layout.patchCount; P++) {
    const next = boundaryNext[P] as Map<number, number>;
    const used = new Set<number>();
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const verts: number[] = [];
      let v = start;
      while (!used.has(v) && next.has(v)) {
        used.add(v);
        verts.push(v);
        v = next.get(v) as number;
      }
      if (v !== start) openChain[P] = 1;
      (loops[P] as number[][]).push(verts);
    }
  }

  const cornerSet = new Set<number>(layout.corners);
  const sides: Side[] = [];
  const sideByChain = new Map<string, number>();
  const patchSides: SideRef[][] = Array.from({ length: layout.patchCount }, () => []);
  const patchCorners = new Int32Array(layout.patchCount);
  for (let P = 0; P < layout.patchCount; P++) {
    const patchLoops = loops[P] as number[][];
    if (patchLoops.length !== 1 || openChain[P] || pinched[P]) continue;
    const verts = patchLoops[0] as number[];
    const cornerAt: number[] = [];
    verts.forEach((v, i) => {
      if (cornerSet.has(v)) cornerAt.push(i);
    });
    patchCorners[P] = cornerAt.length;
    if (cornerAt.length < 2) continue;
    for (let c = 0; c < cornerAt.length; c++) {
      const from = cornerAt[c] as number;
      const to = cornerAt[(c + 1) % cornerAt.length] as number;
      const seq: number[] = [];
      let i = from;
      for (;;) {
        seq.push(verts[i] as number);
        if (i === to && seq.length > 1) break;
        i = (i + 1) % verts.length;
      }
      const rev = [...seq].reverse();
      const fwdKey = seq.join(',');
      const bwdKey = rev.join(',');
      const forward = fwdKey <= bwdKey;
      const canonical = forward ? seq : rev;
      const canonKey = forward ? fwdKey : bwdKey;
      let id = sideByChain.get(canonKey);
      if (id === undefined) {
        let len = 0;
        for (let e = 0; e + 1 < canonical.length; e++) {
          len += distance(p, canonical[e] as number, canonical[e + 1] as number);
        }
        id = sides.length;
        sides.push({ chain: canonical, length: len, count: 1, patches: [] });
        sideByChain.set(canonKey, id);
      }
      (sides[id] as Side).patches.push(P);
      (patchSides[P] as SideRef[]).push({ id, forward });
    }
  }

  // Forced counts from length, then opposite sides of every four-sided patch share one count.
  const forced = sides.map((s) => Math.max(1, Math.round(s.length / target)));
  const oppositePairs: [number, number][] = [];
  for (let P = 0; P < layout.patchCount; P++) {
    const ps = patchSides[P] as SideRef[];
    if (ps.length !== 4) continue;
    oppositePairs.push([(ps[0] as SideRef).id, (ps[2] as SideRef).id]);
    oppositePairs.push([(ps[1] as SideRef).id, (ps[3] as SideRef).id]);
  }
  const solved = solveSideCounts(forced, oppositePairs);
  for (let i = 0; i < sides.length; i++) (sides[i] as Side).count = solved[i] as number;

  // Emit output vertices: corners once, side samples once per side.
  const positions: number[] = [];
  const cornerOut = new Map<number, number>();
  const sideIds = new Map<number, Uint32Array>();
  const emitCorner = (v: number): number => {
    let id = cornerOut.get(v);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(p[3 * v] as number, p[3 * v + 1] as number, p[3 * v + 2] as number);
      cornerOut.set(v, id);
    }
    return id;
  };
  const sampleSide = (id: number): Uint32Array => {
    const cached = sideIds.get(id);
    if (cached) return cached;
    const s = sides[id] as Side;
    const n = s.count;
    const cum: number[] = [0];
    for (let e = 0; e + 1 < s.chain.length; e++) {
      cum.push((cum[e] as number) + distance(p, s.chain[e] as number, s.chain[e + 1] as number));
    }
    const total = cum[cum.length - 1] as number;
    const out = new Uint32Array(n + 1);
    out[0] = emitCorner(s.chain[0] as number);
    out[n] = emitCorner(s.chain[s.chain.length - 1] as number);
    let seg = 0;
    for (let i = 1; i < n; i++) {
      const at = (total * i) / n;
      while (seg + 2 < cum.length && (cum[seg + 1] as number) < at) seg++;
      const a = s.chain[seg] as number;
      const b = s.chain[seg + 1] as number;
      const segLen = (cum[seg + 1] as number) - (cum[seg] as number);
      const w = segLen > 0 ? (at - (cum[seg] as number)) / segLen : 0;
      const pa = vertexPos(p, a);
      const pb = vertexPos(p, b);
      out[i] = positions.length / 3;
      positions.push(
        (pa[0] as number) + w * ((pb[0] as number) - (pa[0] as number)),
        (pa[1] as number) + w * ((pb[1] as number) - (pa[1] as number)),
        (pa[2] as number) + w * ((pb[2] as number) - (pa[2] as number)),
      );
    }
    sideIds.set(id, out);
    return out;
  };

  const quads: number[] = [];
  const unmeshed: UnmeshedPatch[] = [];
  const griddedPatch = new Uint8Array(layout.patchCount);
  const gridSides = new Set<number>();

  for (let P = 0; P < layout.patchCount; P++) {
    const tris = patchTris[P] as number[];
    const nCorners = patchCorners[P] as number;
    const ps = patchSides[P] as SideRef[];
    let reason: string | undefined;
    if (pinched[P]) reason = 'pinched-boundary';
    else if (openChain[P]) reason = 'open-boundary';
    else if ((loops[P] as number[][]).length !== 1) reason = 'holed-boundary';
    else if (nCorners !== 4) reason = `corners-${nCorners}`;
    else if (!ps.every((s) => (sides[s.id] as Side).patches.length >= 1)) reason = 'unsided';

    if (reason === undefined) {
      const boundary = new Set<number>((loops[P] as number[][])[0] as number[]);
      let interior = 0;
      const seen = new Set<number>();
      for (const f of tris)
        for (let k = 0; k < 3; k++) {
          const v = t[3 * f + k] as number;
          if (seen.has(v)) continue;
          seen.add(v);
          if (!boundary.has(v)) interior++;
        }
      if (interior === 0) reason = 'no-interior';
      else {
        // Loop order gives corners c0..c3 with sides: bottom c0->c1, right c1->c2, top c2->c3, left c3->c0.
        const oriented = ps.map((s) => {
          const pts = sampleSide(s.id);
          return s.forward ? pts : (Uint32Array.from(pts).reverse() as Uint32Array);
        });
        const bottom = oriented[0] as Uint32Array;
        const right = oriented[1] as Uint32Array;
        const top = oriented[2] as Uint32Array;
        const left = oriented[3] as Uint32Array;
        const nU = bottom.length - 1;
        const nV = right.length - 1;
        if (top.length - 1 !== nU || left.length - 1 !== nV) {
          reason = 'count-mismatch';
        } else {
          const at = (id: number): [number, number, number] => [
            positions[3 * id] as number,
            positions[3 * id + 1] as number,
            positions[3 * id + 2] as number,
          ];
          const c00 = at(bottom[0] as number);
          const c10 = at(bottom[nU] as number);
          const c11 = at(right[nV] as number);
          const c01 = at(left[0] as number);
          const grid: number[][] = [];
          for (let i = 0; i <= nU; i++) {
            const row: number[] = [];
            for (let j = 0; j <= nV; j++) {
              if (j === 0) row.push(bottom[i] as number);
              else if (i === nU) row.push(right[j] as number);
              else if (j === nV) row.push(top[nU - i] as number);
              else if (i === 0) row.push(left[nV - j] as number);
              else {
                const u = i / nU;
                const v = j / nV;
                const B = at(bottom[i] as number);
                const T = at(top[nU - i] as number);
                const L = at(left[nV - j] as number);
                const R = at(right[j] as number);
                const x = [0, 0, 0];
                for (let d = 0; d < 3; d++) {
                  const ruled =
                    (1 - v) * (B[d] as number) +
                    v * (T[d] as number) +
                    (1 - u) * (L[d] as number) +
                    u * (R[d] as number);
                  const bilinear =
                    (1 - u) * (1 - v) * (c00[d] as number) +
                    u * (1 - v) * (c10[d] as number) +
                    (1 - u) * v * (c01[d] as number) +
                    u * v * (c11[d] as number);
                  x[d] = ruled - bilinear;
                }
                row.push(positions.length / 3);
                positions.push(x[0] as number, x[1] as number, x[2] as number);
              }
            }
            grid.push(row);
          }
          for (let i = 0; i < nU; i++)
            for (let j = 0; j < nV; j++) {
              const a = (grid[i] as number[])[j] as number;
              const b = (grid[i + 1] as number[])[j] as number;
              const c = (grid[i + 1] as number[])[j + 1] as number;
              const d = (grid[i] as number[])[j + 1] as number;
              quads.push(a, b, c, d);
            }
          griddedPatch[P] = 1;
          for (const s of ps) gridSides.add(s.id);
        }
      }
    }
    if (griddedPatch[P] !== 1) {
      unmeshed.push({
        patch: P,
        detail: { reason: reason ?? 'count-mismatch', corners: nCorners, triangles: tris.length },
        triangles: tris,
      });
    }
  }

  const positionsOut = Float64Array.from(positions);
  const quadsOut = Uint32Array.from(quads);

  // Metrics, measured from the emitted quads.
  const useCount = new Map<number, number>();
  const edgeUse = (a: number, b: number): number => edgeKey(a, b);
  let minJ = Number.POSITIVE_INFINITY;
  let inverted = 0;
  const quadCount = quadsOut.length / 4;
  for (let f = 0; f < quadCount; f++) {
    const v = [0, 1, 2, 3].map((k) => quadsOut[4 * f + k] as number);
    for (let k = 0; k < 4; k++) {
      const e = edgeUse(v[k] as number, v[(k + 1) % 4] as number);
      useCount.set(e, (useCount.get(e) ?? 0) + 1);
    }
    const q = v.map((id) => vertexPos(positionsOut, id));
    const scaled = scaledJacobian(q as [number, number, number][]);
    minJ = Math.min(minJ, scaled);
    if (scaled <= 0) inverted++;
  }

  // Shared-side edges: consecutive sample pairs on sides referenced by two or more gridded patches.
  let openEdges = 0;
  const sharedEdges = new Set<number>();
  for (const id of gridSides) {
    const s = sides[id] as Side;
    const griddedUsers = s.patches.filter((P) => griddedPatch[P] === 1).length;
    if (griddedUsers < 2) continue;
    const pts = sideIds.get(id) as Uint32Array;
    for (let i = 0; i + 1 < pts.length; i++) {
      const e = edgeUse(pts[i] as number, pts[i + 1] as number);
      sharedEdges.add(e);
      if (useCount.get(e) !== 2) openEdges++;
    }
  }
  let freeEdges = 0;
  for (const [e, n] of useCount) if (n === 1 && !sharedEdges.has(e)) freeEdges++;

  let griddedArea = 0;
  let totalArea = 0;
  const patchArea = new Float64Array(layout.patchCount);
  for (let f = 0; f < triCount; f++) {
    const a = triangleArea(p, t[3 * f] as number, t[3 * f + 1] as number, t[3 * f + 2] as number);
    patchArea[layout.patchOf[f] as number] = (patchArea[layout.patchOf[f] as number] as number) + a;
    totalArea += a;
  }
  for (let P = 0; P < layout.patchCount; P++) {
    if (griddedPatch[P] === 1) griddedArea += patchArea[P] as number;
  }

  let patchesNotFour = 0;
  for (let P = 0; P < layout.patchCount; P++) if (patchCorners[P] !== 4) patchesNotFour++;

  return {
    positions: positionsOut,
    quads: quadsOut,
    unmeshed,
    layout,
    metrics: {
      quads: quadCount,
      patches: layout.patchCount,
      patchesNotFour,
      gridded: layout.patchCount - unmeshed.length,
      unmeshed: unmeshed.length,
      openEdges,
      freeEdges,
      minScaledJacobian: Number.isFinite(minJ) ? minJ : 0,
      invertedQuads: inverted,
      areaCoveredPct: totalArea > 0 ? (100 * griddedArea) / totalArea : 0,
    },
  };
}

function triangleArea(p: Float64Array, a: number, b: number, c: number): number {
  const A = vertexPos(p, a);
  const B = vertexPos(p, b);
  const C = vertexPos(p, c);
  const ux = B[0] - A[0];
  const uy = B[1] - A[1];
  const uz = B[2] - A[2];
  const vx = C[0] - A[0];
  const vy = C[1] - A[1];
  const vz = C[2] - A[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/**
 * Minimum corner Jacobian of a planar-ish quad, normalised by corner edge lengths and the mean normal.
 * Negative or zero means a fold at some corner.
 */
function scaledJacobian(q: [number, number, number][]): number {
  const sub = (
    x: [number, number, number],
    y: [number, number, number],
  ): [number, number, number] => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const cross = (
    x: [number, number, number],
    y: [number, number, number],
  ): [number, number, number] => [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  const len = (x: [number, number, number]) => Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
  const N = cross(
    sub(q[2] as [number, number, number], q[0] as [number, number, number]),
    sub(q[3] as [number, number, number], q[1] as [number, number, number]),
  );
  const nLen = len(N);
  let worst = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 4; k++) {
    const c = q[k] as [number, number, number];
    const e1 = sub(q[(k + 1) % 4] as [number, number, number], c);
    const e2 = sub(q[(k + 3) % 4] as [number, number, number], c);
    const l1 = len(e1);
    const l2 = len(e2);
    if (l1 === 0 || l2 === 0 || nLen === 0) return -1;
    const cr = cross(e1, e2);
    worst = Math.min(worst, (cr[0] * N[0] + cr[1] * N[1] + cr[2] * N[2]) / (l1 * l2 * nLen));
  }
  return worst;
}
