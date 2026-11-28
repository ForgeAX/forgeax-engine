// M-QF5: the cross field of B-rep faces under a FeatureConstraintSet. Opt-in layer over `crossField`:
// it tessellates the shape once (sharing every edge's samples between faces), maps each constraint
// edge to mesh edges through those samples, and asks `crossField` for
//   - Dirichlet alignment: triangles beside an `align-tangent` edge are pinned to that edge, with the
//     B-rep (not a dihedral threshold) deciding which edges are features, so G1 chains stay smooth;
//   - a no-singularity zone: a band of triangles beside every loop that carries a hard constraint is
//     pinned to the loop-parallel direction, so no singularity can sit in it. The band must be
//     feasible (neighbouring pins agree mod 90 degrees) and the solved field is verified afterwards;
//     either failure is `model-partial` with a lane-specific `detail.reason`.

import { err, ok, type Result } from '@forgeax/engine-types';
import {
  deriveFeatureConstraints,
  type FeatureConstraint,
  type FeatureConstraintSet,
} from '../brep/feature-constraints';
import { type TessellateOptions, tessellateSampled } from '../brep/tessellate';
import type { Shape } from '../brep/types';
import { atan2 } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { triangulateLoop } from '../geom';
import type { EditMesh } from '../mesh';
import { type CrossFieldReport, crossField } from './cross-field';
import type { CrossField } from './field';
import {
  cross3,
  dot3,
  faceNormals,
  headOf,
  sub3,
  type TriMesh,
  type TriTopology,
  unit3,
  type Vec3,
  vec,
} from './trimesh';

export interface ConstrainedFieldOptions {
  readonly tessellate?: TessellateOptions;
  /** B-rep faces to mesh (default all). Mesh edges on the border of the selection are boundary features. */
  readonly faces?: readonly number[];
  /**
   * Half-width of the no-singularity zone, in median hard-loop segment lengths (default 2). A triangle
   * joins the zone when its centroid is that close to a hard loop and the loop reaches it without
   * crossing a feature edge; no singularity may lie that close, or on a vertex of a zone triangle. 0
   * turns the zone off (the M-QF5 falsifier).
   */
  readonly zoneWidth?: number;
  /** Largest disagreement, in degrees mod 90, between neighbouring zone pins (default 40, at most 45). */
  readonly maxPinJumpDegrees?: number;
}

export interface ConstrainedFieldReport {
  readonly cross: CrossFieldReport;
  /** Mesh edges (vertex pairs) taken from `align-tangent` constraints. */
  readonly alignedEdges: number;
  /** Segments of the loops that carry a hard constraint. */
  readonly hardSegments: number;
  /** Zone half-width in mesh units: `zoneWidth` times the median hard-loop segment length. */
  readonly zoneDistance: number;
  readonly zoneTriangles: number;
  /** Largest mod-90 disagreement between neighbouring pinned zone triangles, in degrees. */
  readonly maxPinJumpDegrees: number;
  /** Nonzero-index vertices of the solved field, and how many touch a zone triangle (always 0 on success). */
  readonly singularities: number;
  readonly singularitiesInZone: number;
}

export interface ConstrainedField {
  readonly field: CrossField;
  /** B-rep face of each triangle of `field.mesh`. */
  readonly faceOf: Uint32Array;
  /** 1 for triangles of the no-singularity zone, per triangle of `field.mesh`. */
  readonly zone: Uint8Array;
  /** Mesh-vertex pairs (ids of `field.mesh`) of the aligned feature edges and of the hard-loop segments. */
  readonly aligned: readonly (readonly [number, number])[];
  readonly hardLoops: readonly (readonly [number, number])[];
  readonly constraints: FeatureConstraintSet;
  readonly report: ConstrainedFieldReport;
}

interface Soup {
  readonly mesh: TriMesh;
  readonly faceOf: number[];
  readonly vertexOf: Map<number, number>;
}

function partial(reason: string, detail: Record<string, unknown>): ModelingError {
  return modelingError('model-partial', 'a feature-constrained cross field', { reason, ...detail });
}

/** Triangle soup of the selected B-rep faces; vertex ids are compacted in first-seen order. */
function soupOf(
  mesh: EditMesh,
  owner: readonly number[],
  keep: ReadonlySet<number> | null,
): Result<Soup, ModelingError> {
  const vertexOf = new Map<number, number>();
  const positions: number[] = [];
  const triangles: number[] = [];
  const faceOf: number[] = [];
  const id = (v: number): number => {
    let k = vertexOf.get(v);
    if (k === undefined) {
      k = vertexOf.size;
      vertexOf.set(v, k);
      const p = mesh.position(v);
      positions.push(p[0], p[1], p[2]);
    }
    return k;
  };
  for (const f of mesh.faces()) {
    const brepFace = owner[f] as number;
    if (keep !== null && !keep.has(brepFace)) continue;
    const loop = mesh.faceVertices(f);
    let corners = [0, 1, 2];
    if (loop.length !== 3) {
      const fan = triangulateLoop(loop.map((v) => mesh.position(v)));
      if (fan === undefined)
        return err(partial('face-not-triangulable', { face: brepFace, meshFace: f }));
      corners = fan;
    }
    for (let i = 0; i < corners.length; i += 3) {
      for (let k = 0; k < 3; k++) triangles.push(id(loop[corners[i + k] as number] as number));
      faceOf.push(brepFace);
    }
  }
  return ok({
    mesh: { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) },
    faceOf,
    vertexOf,
  });
}

interface Nearest {
  readonly distance: number;
  readonly tangent: Vec3;
  readonly length: number;
}

function nearestSegment(
  positions: Float64Array,
  segments: readonly (readonly [number, number])[],
  p: Vec3,
): Nearest {
  let best: Nearest = { distance: Infinity, tangent: [1, 0, 0], length: 0 };
  for (const [a, b] of segments) {
    const pa = vec(positions, a);
    const pb = vec(positions, b);
    const r = pointSegment(p, pa, pb);
    if (r.distance < best.distance) {
      const d = sub3(pa, pb);
      best = { ...r, length: Math.sqrt(dot3(d, d)) };
    }
  }
  return best;
}

const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

function pointSegment(p: Vec3, a: Vec3, b: Vec3): { distance: number; tangent: Vec3 } {
  const ab = sub3(b, a);
  const len2 = dot3(ab, ab);
  const t = len2 > 0 ? Math.min(1, Math.max(0, dot3(sub3(p, a), ab) / len2)) : 0;
  const d = sub3(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
  return { distance: Math.sqrt(dot3(d, d)), tangent: unit3(ab) };
}

/** The mesh-vertex pairs along the sampled B-rep edges of a constraint. */
function segmentsOf(
  constraint: FeatureConstraint,
  samples: ReadonlyMap<number, readonly number[]>,
  vertexOf: ReadonlyMap<number, number>,
): [number, number][] {
  const out: [number, number][] = [];
  for (const e of constraint.edges) {
    const s = samples.get(e);
    if (s === undefined) continue;
    for (let k = 0; k + 1 < s.length; k++) {
      const a = vertexOf.get(s[k] as number);
      const b = vertexOf.get(s[k + 1] as number);
      if (a !== undefined && b !== undefined && a !== b) out.push([a, b]);
    }
  }
  return out;
}

/** `v` with its normal part removed, normalized; null when nothing in-plane is left. */
function inPlane(v: Vec3, n: Vec3): Vec3 | null {
  const k = dot3(v, n);
  const flat: Vec3 = [v[0] - k * n[0], v[1] - k * n[1], v[2] - k * n[2]];
  const len = Math.sqrt(dot3(flat, flat));
  return len > 1e-9 ? [flat[0] / len, flat[1] / len, flat[2] / len] : null;
}

/** Angle between two directions of one tangent plane, mod 90 degrees, in [0, 45] degrees. */
function mod90Degrees(a: Vec3, b: Vec3, n: Vec3): number {
  const angle = atan2(dot3(cross3(a, b), n), dot3(a, b));
  const quarter = Math.PI / 2;
  const r = Math.abs(angle) % quarter;
  return ((r > quarter / 2 ? quarter - r : r) * 180) / Math.PI;
}

/**
 * The smoothest cross field on the selected faces of `shape` that is aligned to every `align-tangent`
 * constraint edge and has no singularity within `zoneWidth` median segment lengths of a hard loop.
 */
export function constrainedFaceField(
  shape: Shape,
  options: ConstrainedFieldOptions = {},
): Result<ConstrainedField, ModelingError> {
  const rings = options.zoneWidth ?? 2;
  const maxJump = options.maxPinJumpDegrees ?? 40;
  if (!(Number.isFinite(rings) && rings >= 0))
    return err(
      modelingError('model-invalid-argument', 'zoneWidth is a finite number >= 0', {
        reason: 'bad-zone-width',
        zoneWidth: rings,
      }),
    );
  if (!(maxJump > 0 && maxJump <= 45))
    return err(
      modelingError('model-invalid-argument', 'maxPinJumpDegrees in (0, 45]', {
        reason: 'bad-pin-jump',
        maxPinJumpDegrees: maxJump,
      }),
    );
  const set = deriveFeatureConstraints(shape);
  if (!set.ok) return set;
  const sampled = tessellateSampled(shape, options.tessellate);
  if (!sampled.ok) return sampled;
  let keep: ReadonlySet<number> | null = null;
  if (options.faces !== undefined) {
    for (const f of options.faces)
      if (!Number.isInteger(f) || f < 0 || f >= shape.faces.length)
        return err(
          modelingError('model-invalid-argument', 'faces are B-rep face ids', {
            reason: 'unknown-face',
            face: f,
          }),
        );
    keep = new Set(options.faces);
  }
  const soup = soupOf(sampled.value.mesh, sampled.value.owner, keep);
  if (!soup.ok) return soup;
  if (soup.value.faceOf.length === 0)
    return err(partial('no-faces', { faces: options.faces ?? 'all' }));

  const aligned: [number, number][] = [];
  const hard: [number, number][] = [];
  const alignedKeys = new Set<string>();
  const hardKeys = new Set<string>();
  for (const c of set.value.constraints) {
    const isAlign = c.kind === 'align-tangent';
    const isHardLoop = c.hard && c.origin === 'trim-loop';
    if (!isAlign && !isHardLoop) continue;
    for (const [a, b] of segmentsOf(c, sampled.value.samples, soup.value.vertexOf)) {
      if (isAlign && !alignedKeys.has(key(a, b))) {
        alignedKeys.add(key(a, b));
        aligned.push([a, b]);
      }
      if (isHardLoop && !hardKeys.has(key(a, b))) {
        hardKeys.add(key(a, b));
        hard.push([a, b]);
      }
    }
  }

  const input = soup.value.mesh;
  const inputVertices = input.positions.length / 3;
  const refinedFaceOf: number[] = [];
  const zoneOf: number[] = [];
  const addedOf: number[] = [];
  let maxPin = 0;
  const lengths = hard
    .map(([a, b]) => {
      const d = sub3(vec(input.positions, a), vec(input.positions, b));
      return Math.sqrt(dot3(d, d));
    })
    .sort((x, y) => x - y);
  const zoneDistance = rings * (lengths[Math.floor(lengths.length / 2)] ?? 0);
  const pins = (
    mesh: TriMesh,
    topology: TriTopology,
  ): Result<ReadonlyMap<number, Vec3>, ModelingError> => {
    // crossField splits a conflicted triangle in place into three that share a new centroid vertex.
    for (let t = 0, at = 0; t < soup.value.faceOf.length; t++) {
      const split = (mesh.triangles[3 * at + 2] as number) >= inputVertices;
      for (let k = 0; k < (split ? 3 : 1); k++) refinedFaceOf.push(soup.value.faceOf[t] as number);
      at += split ? 3 : 1;
    }
    const directions = new Map<number, Vec3>();
    if (hard.length === 0 || rings === 0) return ok(directions);
    const normals = faceNormals(mesh);
    const centroid = (t: number): Vec3 => {
      const c: Vec3 = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const p = vec(mesh.positions, mesh.triangles[3 * t + k] as number);
        c[0] += p[0] / 3;
        c[1] += p[1] / 3;
        c[2] += p[2] / 3;
      }
      return c;
    };
    const nearest = (t: number) => {
      const c = centroid(t);
      return nearestSegment(mesh.positions, hard, c);
    };
    const stop = new Set([...alignedKeys, ...hardKeys]);
    // A triangle that has a hard-loop edge is pinned by crossField to that edge; its target is that edge.
    const ownEdge = (t: number): Vec3 | null => {
      for (let k = 0; k < 3; k++) {
        const h = 3 * t + k;
        if (!hardKeys.has(key(mesh.triangles[h] as number, headOf(mesh, h)))) continue;
        return unit3(
          sub3(
            vec(mesh.positions, headOf(mesh, h)),
            vec(mesh.positions, mesh.triangles[h] as number),
          ),
        );
      }
      return null;
    };
    // Flood outwards from the loop, never across a feature edge, so the band cannot leak over a thin gap.
    const queue: number[] = [];
    const seen = new Uint8Array(topology.faceCount);
    for (let t = 0; t < topology.faceCount; t++)
      if (ownEdge(t) !== null) {
        seen[t] = 1;
        queue.push(t);
      }
    const targets = new Map<number, Vec3>();
    const free = new Set<number>();
    for (let q = 0; q < queue.length; q++) {
      const t = queue[q] as number;
      const own = ownEdge(t);
      if (own !== null) targets.set(t, own);
      else {
        const near = nearest(t);
        if (near.distance > zoneDistance) continue;
        targets.set(t, near.tangent);
        free.add(t);
      }
      for (let k = 0; k < 3; k++) {
        const o = topology.twin[3 * t + k] as number;
        if (o === -1) continue;
        const g = Math.floor(o / 3);
        if (seen[g] === 1) continue;
        if (stop.has(key(mesh.triangles[3 * t + k] as number, headOf(mesh, 3 * t + k)))) continue;
        seen[g] = 1;
        queue.push(g);
      }
    }
    for (const [t, tangent] of targets) {
      const d = inPlane(tangent, vec(normals, t));
      if (d === null)
        return err(partial('zone-pin-degenerate', { triangle: t, face: refinedFaceOf[t] }));
      targets.set(t, d);
      if (free.has(t)) directions.set(t, d);
    }
    for (let t = 0; t < topology.faceCount; t++) {
      zoneOf[t] = targets.has(t) ? 1 : 0;
      addedOf[t] = free.has(t) ? 1 : 0;
    }
    for (const [t, d] of targets)
      for (let k = 0; k < 3; k++) {
        const o = topology.twin[3 * t + k] as number;
        if (o === -1) continue;
        const g = Math.floor(o / 3);
        const e = targets.get(g);
        // Two triangles that both carry a loop edge are crossField's own Dirichlet pair; only pins we add are judged here.
        if (e === undefined || g < t || (!free.has(t) && !free.has(g))) continue;
        const n = vec(normals, t);
        const projected = inPlane(e, n);
        const jump = projected === null ? 45 : mod90Degrees(d, projected, n);
        if (jump > maxPin) maxPin = jump;
        if (jump > maxJump)
          return err(
            partial('no-singularity-zone-infeasible', {
              triangles: [t, g],
              faces: [refinedFaceOf[t], refinedFaceOf[g]],
              pinJumpDegrees: jump,
              maxPinJumpDegrees: maxJump,
            }),
          );
      }
    return ok(directions);
  };

  const solved = crossField(input, { sharpDegrees: 180, edges: aligned, pinTriangles: pins });
  if (!solved.ok) return solved;
  const { field, report } = solved.value;
  const triangles = field.mesh.triangles.length / 3;
  const zone = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t++) zone[t] = zoneOf[t] ?? 0;
  // A singularity is trapped when it lies within the zone distance of a hard loop, or on a vertex of a
  // triangle the zone itself pinned (loop-edge triangles are pinned by the loop, not by the zone).
  const inZone = new Uint8Array(field.mesh.positions.length / 3);
  for (let t = 0; t < triangles; t++)
    if (addedOf[t] === 1)
      for (let k = 0; k < 3; k++) inZone[field.mesh.triangles[3 * t + k] as number] = 1;
  const trapped =
    rings === 0
      ? []
      : field.singularities.filter(
          (sing) =>
            inZone[sing.at] === 1 ||
            nearestSegment(field.mesh.positions, hard, vec(field.mesh.positions, sing.at))
              .distance <= zoneDistance,
        );
  if (trapped.length > 0)
    return err(
      partial('singularity-in-zone', {
        vertices: trapped.map((s) => s.at),
        indices: trapped.map((s) => s.index),
      }),
    );
  return ok({
    field,
    faceOf: Uint32Array.from(refinedFaceOf),
    zone,
    aligned,
    hardLoops: hard,
    constraints: set.value,
    report: {
      cross: report,
      alignedEdges: aligned.length,
      hardSegments: hard.length,
      zoneDistance,
      zoneTriangles: zone.reduce((s, x) => s + x, 0),
      maxPinJumpDegrees: maxPin,
      singularities: field.singularities.length,
      singularitiesInZone: trapped.length,
    },
  });
}
