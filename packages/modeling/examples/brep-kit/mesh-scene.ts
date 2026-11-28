// Mesh layers: shaded surfaces, silhouettes, and the quad edge network with singular vertices
// and per-element scaled-Jacobian colouring. Meshes arrive as EditMesh or plain polygon arrays.

import { triangulateLoop, type Tuple3 } from '../../src/geom.ts';
import { EDGE_SHARP, type EditMesh } from '../../src/mesh.ts';
import type { ViewBasis } from './camera.ts';
import {
  EDGE_STYLES,
  FACE_PALETTE,
  heatColor,
  NEUTRAL,
  paletteAt,
  valenceColor,
} from './colors.ts';
import type { RGB } from './image.ts';
import type { P3, Scene, SceneLine, SceneMarker, SceneTri } from './scene.ts';

/** A polygon mesh as plain arrays; `sharp` lists vertex pairs of feature edges. */
export interface PolyMesh {
  readonly positions: readonly P3[];
  readonly faces: readonly (readonly number[])[];
  readonly sharp?: readonly (readonly [number, number])[];
  /** Colour group per face (for example the source B-rep face), used by `colorBy: 'face'`. */
  readonly group?: readonly number[];
}

export function isEditMesh(m: EditMesh | PolyMesh): m is EditMesh {
  return typeof (m as EditMesh).faceVertices === 'function';
}

/** Compacts live vertices/faces of an EditMesh into arrays; EDGE_SHARP edges become `sharp`. */
export function polyMeshOf(mesh: EditMesh, groupOfLabel?: (label: string) => number): PolyMesh {
  const index = new Map<number, number>();
  const positions: P3[] = [];
  const faces: number[][] = [];
  const group: number[] = [];
  for (const f of mesh.faces()) {
    faces.push(
      mesh.faceVertices(f).map((v) => {
        let i = index.get(v);
        if (i === undefined) {
          i = positions.length;
          index.set(v, i);
          positions.push(mesh.position(v));
        }
        return i;
      }),
    );
    const label = mesh.labelNames[mesh.fLabel[f] as number] ?? '';
    group.push(groupOfLabel === undefined ? (mesh.fLabel[f] as number) : groupOfLabel(label));
  }
  const sharp: [number, number][] = [];
  for (const e of mesh.edges()) {
    if (((mesh.eFlags[e] as number) & EDGE_SHARP) === 0) continue;
    const [a, b] = mesh.edgeVertices(e);
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) sharp.push([ia, ib]);
  }
  return { positions, faces, sharp, group };
}

export function asPolyMesh(mesh: EditMesh | PolyMesh): PolyMesh {
  return isEditMesh(mesh) ? polyMeshOf(mesh) : mesh;
}

function sub(a: P3, b: P3): P3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: P3, b: P3): P3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: P3, b: P3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a: P3): number {
  return Math.sqrt(dot(a, a));
}

/** Newell normal of a polygon (area-weighted, unnormalised). */
function newell(pts: readonly P3[]): P3 {
  let n: P3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const c = cross(pts[i] as P3, pts[(i + 1) % pts.length] as P3);
    n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
  }
  return n;
}

/**
 * Scaled Jacobian of a polygon: the smallest corner sine of the angle between its two edges,
 * measured against the face normal (negative when a corner folds). Triangles are normalised so an
 * equilateral triangle scores 1. Degenerate faces score 0.
 */
export function scaledJacobian(pts: readonly P3[]): number {
  const n = newell(pts);
  const nl = norm(n);
  if (nl === 0) return 0;
  const unit: P3 = [n[0] / nl, n[1] / nl, n[2] / nl];
  let worst = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const prev = sub(pts[(i + pts.length - 1) % pts.length] as P3, pts[i] as P3);
    const next = sub(pts[(i + 1) % pts.length] as P3, pts[i] as P3);
    const denom = norm(prev) * norm(next);
    if (denom === 0) return 0;
    worst = Math.min(worst, dot(cross(next, prev), unit) / denom);
  }
  return pts.length === 3 ? (worst * 2) / Math.sqrt(3) : worst;
}

export interface MeshSurfaceOptions {
  /** 'part' paints one colour; 'face' cycles the palette by `group` (default 'part'). */
  readonly colorBy?: 'part' | 'face';
  readonly color?: RGB;
  /** Multiplies the colour; underlays use about 0.45. */
  readonly dim?: number;
}

function triangles(poly: PolyMesh, colorOf: (face: number) => RGB, unlit: boolean): SceneTri[] {
  const out: SceneTri[] = [];
  poly.faces.forEach((loop, f) => {
    const color = colorOf(f);
    // A fan from loop[0] folds back across a concave notch and emits triangles wound against the
    // face normal, which shade as back faces (dark patches on a dou's mouth walls). The kernel's
    // ear cutting keeps every triangle on the face's Newell side; the fan is only the fallback.
    const corners = loop.map((v) => [...(poly.positions[v] as P3)] as Tuple3);
    const ears = triangulateLoop(corners) ?? fanOf(corners.length);
    for (let t = 0; t + 2 < ears.length; t += 3)
      out.push({
        a: corners[ears[t] as number] as P3,
        b: corners[ears[t + 1] as number] as P3,
        c: corners[ears[t + 2] as number] as P3,
        color,
        ...(unlit ? { unlit: true } : {}),
      });
  });
  return out;
}

/** Index triples of a convex fan from corner 0: the fallback when no ear clip exists. */
function fanOf(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < n; i++) out.push(0, i, i + 1);
  return out;
}

export function meshSurface(
  mesh: EditMesh | PolyMesh,
  options: MeshSurfaceOptions = {},
): SceneTri[] {
  const poly = asPolyMesh(mesh);
  const dim = options.dim ?? 1;
  const base = options.color ?? NEUTRAL;
  const colorOf = (f: number): RGB => {
    const c = options.colorBy === 'face' ? paletteAt(FACE_PALETTE, poly.group?.[f] ?? f) : base;
    return [Math.round(c[0] * dim), Math.round(c[1] * dim), Math.round(c[2] * dim)];
  };
  return triangles(poly, colorOf, false);
}

/** Edges between a front-facing and a back-facing polygon, for one view. */
export function silhouetteLines(
  mesh: EditMesh | PolyMesh,
  basis: ViewBasis,
  color: RGB = [235, 238, 245],
): SceneLine[] {
  const poly = asPolyMesh(mesh);
  const facing = poly.faces.map((loop) =>
    dot(newell(loop.map((v) => poly.positions[v] as P3)), basis.toward),
  );
  const seen = new Map<string, number>();
  const out: SceneLine[] = [];
  poly.faces.forEach((loop, f) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const other = seen.get(key);
      if (other === undefined) {
        seen.set(key, f);
        continue;
      }
      const s1 = facing[f] as number;
      const s2 = facing[other] as number;
      if (s1 * s2 < 0)
        out.push({
          points: [poly.positions[a] as P3, poly.positions[b] as P3],
          color,
          width: 1.5,
          bias: 1.2,
        });
    }
  });
  return out;
}

export interface QuadStats {
  readonly faces: number;
  readonly quads: number;
  readonly triangles: number;
  readonly other: number;
  readonly jacobianMin: number;
  readonly jacobianMean: number;
  /** Interior vertices with valence other than 4, by valence. */
  readonly singular: Readonly<Record<number, number>>;
  readonly singularTotal: number;
  /** Valence-3 vertices where three sharp edges meet: expected on a box-like corner, so not counted as singular. */
  readonly featureCorners: number;
  readonly openEdges: number;
}

interface Topology {
  readonly valence: number[];
  readonly sharpDegree: number[];
  readonly boundaryVertex: boolean[];
  readonly openEdges: number;
}

function topology(poly: PolyMesh): Topology {
  const uses = new Map<string, { a: number; b: number; n: number }>();
  for (const loop of poly.faces)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const e = uses.get(key);
      if (e === undefined) uses.set(key, { a, b, n: 1 });
      else e.n++;
    }
  const valence = poly.positions.map(() => 0);
  const boundaryVertex = poly.positions.map(() => false);
  let openEdges = 0;
  for (const e of uses.values()) {
    valence[e.a] = (valence[e.a] as number) + 1;
    valence[e.b] = (valence[e.b] as number) + 1;
    if (e.n !== 2) {
      openEdges++;
      boundaryVertex[e.a] = true;
      boundaryVertex[e.b] = true;
    }
  }
  const sharpDegree = poly.positions.map(() => 0);
  for (const [a, b] of poly.sharp ?? []) {
    sharpDegree[a] = (sharpDegree[a] as number) + 1;
    sharpDegree[b] = (sharpDegree[b] as number) + 1;
  }
  return { valence, sharpDegree, boundaryVertex, openEdges };
}

function isFeatureCorner(topo: Topology, v: number): boolean {
  return topo.valence[v] === 3 && (topo.sharpDegree[v] as number) >= 3;
}

export function quadStats(mesh: EditMesh | PolyMesh): QuadStats {
  const poly = asPolyMesh(mesh);
  const topo = topology(poly);
  let quads = 0;
  let triangleCount = 0;
  let other = 0;
  let min = Infinity;
  let sum = 0;
  for (const loop of poly.faces) {
    if (loop.length === 4) quads++;
    else if (loop.length === 3) triangleCount++;
    else other++;
    const j = scaledJacobian(loop.map((v) => poly.positions[v] as P3));
    min = Math.min(min, j);
    sum += j;
  }
  const singular: Record<number, number> = {};
  let total = 0;
  let corners = 0;
  topo.valence.forEach((val, v) => {
    if (topo.boundaryVertex[v] === true || val === 4 || val === 0) return;
    if (isFeatureCorner(topo, v)) {
      corners++;
      return;
    }
    singular[val] = (singular[val] ?? 0) + 1;
    total++;
  });
  return {
    faces: poly.faces.length,
    quads,
    triangles: triangleCount,
    other,
    jacobianMin: poly.faces.length === 0 ? 0 : min,
    jacobianMean: poly.faces.length === 0 ? 0 : sum / poly.faces.length,
    singular,
    singularTotal: total,
    featureCorners: corners,
    openEdges: topo.openEdges,
  };
}

export interface NetworkOptions {
  /** Colour faces by scaled Jacobian (default) or paint them neutral. */
  readonly shading?: 'jacobian' | 'plain';
  readonly edgeColor?: RGB;
  readonly edgeWidth?: number;
  /** Draw singular-vertex markers (default true). */
  readonly singularities?: boolean;
  /** Feature corners (valence 3 where three sharp edges meet) are drawn as hollow grey rings instead of singularities. */
  readonly featureCorners?: boolean;
  readonly markerRadius?: number;
}

/** Quad edge network: surface, all edges, sharp/boundary edges accented, singular vertices marked. */
export function quadNetwork(mesh: EditMesh | PolyMesh, options: NetworkOptions = {}): Scene {
  const poly = asPolyMesh(mesh);
  const topo = topology(poly);
  const jacobian = options.shading !== 'plain';
  const sharpKeys = new Set<string>();
  for (const [a, b] of poly.sharp ?? []) sharpKeys.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  const colorOf = (f: number): RGB => {
    if (!jacobian) return [86, 94, 108];
    const loop = poly.faces[f] as readonly number[];
    // Triangles (quad-dominant leftovers) have no quad Jacobian: amber, not scored.
    if (loop.length === 3) return [255, 176, 0];
    return loop.length > 4
      ? [255, 0, 255]
      : heatColor(scaledJacobian(loop.map((v) => poly.positions[v] as P3)));
  };
  const tris = triangles(poly, colorOf, jacobian);
  const edgeColor = options.edgeColor ?? (jacobian ? [20, 24, 32] : [205, 212, 224]);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const loop of poly.faces)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const lines: SceneLine[] = [];
  for (const loop of poly.faces)
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const open = counts.get(key) !== 2;
      const sharp = sharpKeys.has(key);
      lines.push({
        points: [poly.positions[a] as P3, poly.positions[b] as P3],
        color: open ? EDGE_STYLES.boundary.color : sharp ? EDGE_STYLES.convex.color : edgeColor,
        width: open ? 2 : sharp ? 1.6 : (options.edgeWidth ?? 1),
        bias: open || sharp ? 1.2 : 1,
      });
    }
  const markers: SceneMarker[] = [];
  if (options.singularities !== false) {
    const radius = options.markerRadius ?? 4;
    topo.valence.forEach((val, v) => {
      if (topo.boundaryVertex[v] === true || val === 4 || val === 0) return;
      const p = poly.positions[v] as P3;
      const corner = options.featureCorners !== false && isFeatureCorner(topo, v);
      if (corner) markers.push({ p, color: [235, 235, 240], radius: radius * 0.8, ring: true });
      else markers.push({ p, color: valenceColor(val), radius });
    });
  }
  return { tris, lines, markers };
}
