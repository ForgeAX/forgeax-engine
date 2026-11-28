import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { edgeUses } from './adjacency';
import { measureContinuity } from './continuity';
import { faceLoops, gridOf } from './faces';
import type { Coedge, Shape } from './types';

/**
 * What a quad layout must honour along a B-rep curve. The set is closed on purpose: a consumer switches on
 * `kind` only, never on `origin`.
 *
 * - `align-tangent`: the first row of quads runs along the curve, so the cross edges meet it at 90 degrees.
 * - `even-count`: the total sample count of the listed edges is even (a trimmed face pairs triangles into quads).
 * - `continue-across`: quad rows continue through the listed tangent-continuous edges into the neighbour face.
 */
export type ConstraintKind = 'align-tangent' | 'even-count' | 'continue-across';

/** Which B-rep fact produced the constraint; informational, for inspection and tests. */
export type ConstraintOrigin = 'trim-loop' | 'sharp-edge' | 'g1-chain';

export interface FeatureConstraint {
  /** Stable across runs: `<kind>:<origin>:<key>` built from B-rep ids. */
  readonly id: string;
  readonly kind: ConstraintKind;
  readonly origin: ConstraintOrigin;
  /**
   * B-rep edge ids; for a trim loop in loop order, degenerate (pole) edges left out. Every consumer samples these
   * edges once and publishes the same mesh ids to every face in `faces` (ring-id sharing).
   */
  readonly edges: readonly number[];
  /** Every face that uses one of `edges`, ascending. */
  readonly faces: readonly number[];
  /** Set for `trim-loop`: the loop index in `shape.loops`. */
  readonly loop?: number;
  /** Fail closed (`model-partial`) when unmet, instead of dropping the constraint. */
  readonly hard: boolean;
}

export interface FeatureConstraintSet {
  readonly constraints: readonly FeatureConstraint[];
  /** Faces whose boundary is trimmed: holes, or an outer loop that is not an iso-rectangle. */
  readonly trimmedFaces: readonly number[];
}

export function constraintsOfFace(set: FeatureConstraintSet, face: number): FeatureConstraint[] {
  return set.constraints.filter((c) => c.faces.includes(face));
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Derives the constraints from topology and surface kinds only (exact continuity grades from
 * `measureContinuity`, never a tessellation).
 */
export function deriveFeatureConstraints(
  shape: Shape,
): Result<FeatureConstraintSet, ModelingError> {
  const continuity = measureContinuity(shape);
  if (!continuity.ok) return err(continuity.error);
  const uses = edgeUses(shape);
  const facesOf = (edges: readonly number[]): number[] =>
    sortedUnique(edges.flatMap((e) => (uses[e] ?? []).map((u) => u.face)));
  const constraints: FeatureConstraint[] = [];
  const trimmedFaces: number[] = [];

  shape.faces.forEach((face, f) => {
    const { holes } = faceLoops(shape, f);
    if (holes.length === 0 && gridOf(shape, f).ok) return;
    trimmedFaces.push(f);
    for (const l of face.loops) {
      const edges = (shape.loops[l]?.coedges ?? [])
        .map((c) => (shape.coedges[c] as Coedge).edge)
        .filter((e) => (shape.edges[e]?.curve ?? -1) >= 0);
      if (edges.length === 0) continue;
      const base = {
        origin: 'trim-loop',
        edges,
        faces: facesOf(edges),
        loop: l,
      } as const;
      constraints.push({
        ...base,
        id: `align-tangent:trim-loop:f${f}:l${l}`,
        kind: 'align-tangent',
        hard: false,
      });
      constraints.push({
        ...base,
        id: `even-count:trim-loop:f${f}:l${l}`,
        kind: 'even-count',
        hard: true,
      });
    }
  });

  // A trim loop already aligns its edges on both faces; a sharp-edge constraint would only restate it.
  const looped = new Set(constraints.flatMap((c) => c.edges));
  const tangent: number[] = [];
  for (const c of continuity.value.edges) {
    if (c.seam) continue;
    if (c.grade === 'G0') {
      if (looped.has(c.edge)) continue;
      constraints.push({
        id: `align-tangent:sharp-edge:e${c.edge}`,
        kind: 'align-tangent',
        origin: 'sharp-edge',
        edges: [c.edge],
        faces: sortedUnique([...c.faces]),
        hard: false,
      });
    } else if (c.grade === 'G1' || c.grade === 'G2') tangent.push(c.edge);
  }
  for (const edges of chains(shape, tangent)) {
    constraints.push({
      id: `continue-across:g1-chain:e${edges[0]}`,
      kind: 'continue-across',
      origin: 'g1-chain',
      edges,
      faces: facesOf(edges),
      hard: false,
    });
  }
  constraints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ok({ constraints, trimmedFaces });
}

/** Tangent edges joined through vertices where exactly two of them meet; a junction of three or more ends a chain. */
function chains(shape: Shape, edges: readonly number[]): number[][] {
  const parent = new Map<number, number>(edges.map((e) => [e, e]));
  const find = (e: number): number => {
    let r = e;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  const at = new Map<number, number[]>();
  for (const e of edges) {
    const edge = shape.edges[e];
    if (edge === undefined) continue;
    for (const v of new Set([edge.v0, edge.v1])) at.set(v, [...(at.get(v) ?? []), e]);
  }
  for (const list of at.values()) {
    if (list.length === 2) parent.set(find(list[0] as number), find(list[1] as number));
  }
  const groups = new Map<number, number[]>();
  for (const e of [...edges].sort((a, b) => a - b)) {
    const r = find(e);
    groups.set(r, [...(groups.get(r) ?? []), e]);
  }
  return [...groups.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
}

export interface ConstraintInspection {
  readonly constraints: readonly FeatureConstraint[];
  readonly byKind: Readonly<Record<ConstraintKind, number>>;
  readonly byOrigin: Readonly<Record<ConstraintOrigin, number>>;
  readonly trimmedFaces: readonly number[];
}

/** A JSON-safe summary for AI callers: the derived set plus counts per kind and origin. */
export function inspectConstraints(shape: Shape): Result<ConstraintInspection, ModelingError> {
  const set = deriveFeatureConstraints(shape);
  if (!set.ok) return set;
  const byKind: Record<ConstraintKind, number> = {
    'align-tangent': 0,
    'even-count': 0,
    'continue-across': 0,
  };
  const byOrigin: Record<ConstraintOrigin, number> = {
    'trim-loop': 0,
    'sharp-edge': 0,
    'g1-chain': 0,
  };
  for (const c of set.value.constraints) {
    byKind[c.kind]++;
    byOrigin[c.origin]++;
  }
  return ok({
    constraints: set.value.constraints,
    byKind,
    byOrigin,
    trimmedFaces: set.value.trimmedFaces,
  });
}
