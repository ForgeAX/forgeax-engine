import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { cos } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { dot, faceNormal, sub, type Tuple3 } from '../geom';
import { type EditMesh, NONE } from '../mesh';
import { quadPlanarity } from '../planar';
import { type CornerSource, type FaceRewrite, rewriteFaces } from '../rewrite';
import {
  constraintSegments,
  type FeatureConstraint,
  featureDeviation,
  protectedEdges,
} from './features';
import { type QuadQuality, qualityOf } from './quality';

export interface QuadRemeshOptions {
  readonly constraints?: readonly FeatureConstraint[];
  /** Dihedral angle in degrees above which an input edge is a sharp feature (default 30). */
  readonly sharpDegrees?: number;
  /** Largest angle in degrees between the two triangle normals of a pair (default 15). */
  readonly maxAngle?: number;
  /** Largest pair planarity over the longer diagonal (default 0.02). */
  readonly maxPlanarity?: number;
}

export interface QuadFaceProvenance {
  /** Output face id after compaction. */
  readonly face: number;
  /** Input face ids this output face came from: two for a quad pair, one otherwise. */
  readonly sources: readonly number[];
  /**
   * quad: a selected triangle pair merged into one quad. residual: a selected triangle no partner paired.
   * passthrough: a selected non-triangle carried unchanged, never a triangle left over.
   */
  readonly kind: 'quad' | 'residual' | 'passthrough';
}

export interface QuadRemeshReport {
  readonly quality: QuadQuality;
  readonly featureDeviation: {
    readonly max: number;
    readonly byConstraint: Readonly<Record<string, number>>;
  };
  readonly unresolvedFeatures: readonly string[];
  /** Selected triangles left unpaired: no partner passed the pairing gates. Input quads and n-gons are not counted. */
  readonly residualTriangles: number;
  readonly scope: 'selected-faces';
  readonly measuredFaces: number;
}

export interface QuadRemeshResult {
  readonly mesh: EditMesh;
  readonly provenance: readonly QuadFaceProvenance[];
  readonly report: QuadRemeshReport;
}

const DEFAULT_SHARP = 30;
const DEFAULT_ANGLE = 15;
const DEFAULT_PLANARITY = 0.02;
const STRAIGHT_CORNER = -0.9848;

interface Candidate {
  readonly score: number;
  readonly edge: number;
  readonly f: number;
  readonly g: number;
  readonly loop: CornerSource[];
}

/**
 * Pair selected triangles into quads across non-protected edges, then verify each constraint against the output.
 * A constraint the output cannot hold within its tolerance returns model-partial with the constraint ids.
 */
export function quadRemesh(
  input: EditMesh,
  faces: readonly number[],
  options: QuadRemeshOptions = {},
): Result<QuadRemeshResult, ModelingError> {
  const sharpDegrees = options.sharpDegrees ?? DEFAULT_SHARP;
  const maxAngle = options.maxAngle ?? DEFAULT_ANGLE;
  const maxPlanarity = options.maxPlanarity ?? DEFAULT_PLANARITY;
  if (!(sharpDegrees >= 0 && sharpDegrees < 180)) {
    return err(
      modelingError('model-invalid-argument', 'sharpDegrees is in [0, 180)', {
        sharpDegrees,
      }),
    );
  }
  if (!(maxAngle >= 0 && maxAngle < 90)) {
    return err(
      modelingError('model-invalid-argument', 'maxAngle is in [0, 90)', {
        maxAngle,
      }),
    );
  }
  if (!(maxPlanarity >= 0 && Number.isFinite(maxPlanarity))) {
    return err(
      modelingError('model-invalid-argument', 'maxPlanarity is finite and >= 0', { maxPlanarity }),
    );
  }
  for (const vertex of input.vertices()) {
    const point = input.position(vertex);
    for (let axis = 0; axis < point.length; axis++) {
      if (Number.isFinite(point[axis])) continue;
      return err(
        modelingError(
          'model-invalid-argument',
          'every input mesh vertex coordinate is finite',
          { vertex, axis, coordinate: point[axis] },
          'repair the first input vertex with a non-finite coordinate',
        ),
      );
    }
  }
  const constraints = options.constraints ?? [];
  const seen = new Set<string>();
  for (const c of constraints) {
    if (seen.has(c.id)) {
      return err(
        modelingError('model-invalid-argument', 'constraint ids are unique', {
          id: c.id,
        }),
      );
    }
    seen.add(c.id);
    if (
      !(c.tolerance > 0 && Number.isFinite(c.tolerance)) ||
      c.polyline.length < 2 ||
      c.polyline.some((point) => point.some((coordinate) => !Number.isFinite(coordinate)))
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a constraint has two or more points and tolerance > 0',
          {
            id: c.id,
          },
        ),
      );
    }
  }

  const selected = new Set(faces.filter((f) => input.isFaceAlive(f)));
  const protect = protectedEdges(input, sharpDegrees, constraints);
  const candidates = pairCandidates(input, selected, protect, maxAngle, maxPlanarity);
  candidates.sort((a, b) => a.score - b.score || a.edge - b.edge);

  const used = new Set<number>();
  const rewrites: FaceRewrite[] = [];
  const pairs: { loop: CornerSource[]; f: number; g: number }[] = [];
  for (const c of candidates) {
    if (used.has(c.f) || used.has(c.g)) continue;
    used.add(c.f);
    used.add(c.g);
    rewrites.push({ face: c.f, loops: [c.loop] }, { face: c.g, loops: [] });
    pairs.push({ loop: c.loop, f: c.f, g: c.g });
  }

  const out = input.clone();
  // rewriteFaces replaces each pair's first face with the quad (its only created face) and removes the second.
  const quadIds: number[] = [];
  if (rewrites.length > 0) {
    const done = rewriteFaces(out, rewrites);
    if (!done.ok) return done;
    for (const row of done.value) pushAll(quadIds, row);
  }
  const compacted = out.compact();
  const mesh = compacted.mesh;
  const outputOf = (f: number): number => compacted.faceMap[f] as number;

  const provenance: QuadFaceProvenance[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i] as { f: number; g: number };
    const created = quadIds[i];
    if (created === undefined) continue;
    provenance.push({
      face: outputOf(created),
      sources: [pair.f, pair.g],
      kind: 'quad',
    });
  }
  for (const f of selected) {
    if (used.has(f)) continue;
    const face = outputOf(f);
    const kind = mesh.faceHalves(face).length === 3 ? 'residual' : 'passthrough';
    provenance.push({ face, sources: [f], kind });
  }
  provenance.sort((a, b) => a.face - b.face);

  const selectedOutputFaces = provenance.map((entry) => entry.face);
  const deviation = featureDeviation(mesh, constraintSegments(constraints), selectedOutputFaces);
  const unresolved = [...new Set(deviation.unresolved)].sort();
  const report: QuadRemeshReport = {
    quality: qualityOf(mesh, selectedOutputFaces),
    featureDeviation: {
      max: deviation.max,
      byConstraint: deviation.byConstraint,
    },
    unresolvedFeatures: unresolved,
    residualTriangles: provenance.filter((entry) => entry.kind === 'residual').length,
    scope: 'selected-faces',
    measuredFaces: selectedOutputFaces.length,
  };
  if (unresolved.length > 0) {
    const reason = unresolvedReason(input, constraints, unresolved);
    return err(
      modelingError(
        'model-partial',
        'every constraint polyline is preserved in the quad output within its tolerance',
        { constraint: unresolved[0] as string, unresolvedFeatures: unresolved, reason },
        'loosen the tolerance or annotate a polyline that lies on the input surface',
      ),
    );
  }
  return ok({ mesh, provenance, report });
}

/**
 * Why a constraint is unresolved, decided against the input surface: a polyline the input does not hold within
 * tolerance is `feature-off-mesh`. One the input holds but the output does not is `feature-outside-selection`: the
 * selection excludes its faces, or the pairing merged away the input edge it follows.
 */
function unresolvedReason(
  input: EditMesh,
  constraints: readonly FeatureConstraint[],
  unresolved: readonly string[],
): 'feature-off-mesh' | 'feature-outside-selection' {
  const pending = constraintSegments(constraints.filter((c) => unresolved.includes(c.id)));
  const onInput = featureDeviation(input, pending);
  return onInput.unresolved.length > 0 ? 'feature-off-mesh' : 'feature-outside-selection';
}

function pairCandidates(
  mesh: EditMesh,
  selected: ReadonlySet<number>,
  protect: ReadonlySet<number>,
  maxAngle: number,
  maxPlanarity: number,
): Candidate[] {
  const minCos = cos((maxAngle * Math.PI) / 180);
  const candidates: Candidate[] = [];
  for (const f of [...selected].sort((x, y) => x - y)) {
    if (mesh.faceHalves(f).length !== 3) continue;
    for (const h of mesh.faceHalves(f)) {
      const g = mesh.hFace[h ^ 1] as number;
      if (g === NONE || g <= f || !selected.has(g)) continue;
      if (mesh.faceHalves(g).length !== 3) continue;
      if (protect.has(h >> 1)) continue;
      if (
        mesh.fMaterial[f] !== mesh.fMaterial[g] ||
        mesh.fLabel[f] !== mesh.fLabel[g] ||
        mesh.fRole[f] !== mesh.fRole[g] ||
        mesh.fFlags[f] !== mesh.fFlags[g] ||
        !sameFaceTags(mesh, f, g)
      )
        continue;
      if (!sameCornerLayout(mesh, f, g)) continue;
      if (!sameSharedCornerValues(mesh, f, g, h)) continue;
      const bend = dot(faceNormal(mesh, f), faceNormal(mesh, g));
      if (bend < minCos) continue;
      // h runs a -> b in f; the quad is a, (g's apex), b, (f's apex).
      const fApex = mesh.hNext[mesh.hNext[h] as number] as number;
      const gApex = mesh.hNext[mesh.hNext[h ^ 1] as number] as number;
      const loop: CornerSource[] = [
        { v: mesh.hVert[h] as number, corner: h },
        { v: mesh.hVert[gApex] as number, corner: gApex },
        {
          v: mesh.hVert[mesh.hNext[h] as number] as number,
          corner: mesh.hNext[h] as number,
        },
        { v: mesh.hVert[fApex] as number, corner: fApex },
      ];
      const p = loop.map((c) => mesh.position(c.v));
      if (!convexQuad(p)) continue;
      const planarity = quadPlanarity(p);
      if (planarity > maxPlanarity) continue;
      candidates.push({
        score: planarity + (1 - bend) + squareCorners(p) / 4,
        edge: h >> 1,
        f,
        g,
        loop,
      });
    }
  }
  return candidates;
}

/** Two faces may pair only when every channel has a value on the same corners of both (or on neither). */
function sameCornerLayout(mesh: EditMesh, f: number, g: number): boolean {
  const hf = mesh.faceHalves(f);
  const hg = mesh.faceHalves(g);
  for (const name of mesh.channels.keys()) {
    for (let i = 0; i < 3; i++) {
      const a = mesh.corner(name, hf[i] as number) !== undefined;
      const b = mesh.corner(name, hg[i] as number) !== undefined;
      if (a !== b) return false;
    }
  }
  return true;
}

function sameSharedCornerValues(mesh: EditMesh, f: number, g: number, shared: number): boolean {
  const a = mesh.hVert[shared] as number;
  const b = mesh.hVert[mesh.hNext[shared] as number] as number;
  for (const name of mesh.channels.keys()) {
    for (const vertex of [a, b]) {
      const hf = mesh.faceHalves(f).find((h) => mesh.hVert[h] === vertex) as number;
      const hg = mesh.faceHalves(g).find((h) => mesh.hVert[h] === vertex) as number;
      const first = mesh.corner(name, hf);
      const second = mesh.corner(name, hg);
      if ((first === undefined) !== (second === undefined)) return false;
      if (first !== undefined && second !== undefined) {
        for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) return false;
      }
    }
  }
  return true;
}

function sameFaceTags(mesh: EditMesh, f: number, g: number): boolean {
  for (let word = 0; word < mesh.tagWords; word++)
    if (mesh.fTags[f * mesh.tagWords + word] !== mesh.fTags[g * mesh.tagWords + word]) return false;
  return true;
}

function convexQuad(p: readonly Tuple3[]): boolean {
  const n = cross3(sub(p[2] as Tuple3, p[0] as Tuple3), sub(p[3] as Tuple3, p[1] as Tuple3));
  for (let i = 0; i < 4; i++) {
    const at = p[i] as Tuple3;
    const u = sub(p[(i + 1) % 4] as Tuple3, at);
    const w = sub(p[(i + 3) % 4] as Tuple3, at);
    if (dot(cross3(u, w), n) <= 0) return false;
    if (cornerCos(u, w) < STRAIGHT_CORNER) return false;
  }
  return true;
}

function squareCorners(p: readonly Tuple3[]): number {
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const at = p[i] as Tuple3;
    total += Math.abs(
      cornerCos(sub(p[(i + 1) % 4] as Tuple3, at), sub(p[(i + 3) % 4] as Tuple3, at)),
    );
  }
  return total;
}

function cornerCos(u: Tuple3, w: Tuple3): number {
  const l = Math.sqrt(dot(u, u)) * Math.sqrt(dot(w, w));
  return l > 0 ? dot(u, w) / l : -1;
}

function cross3(a: Tuple3, b: Tuple3): Tuple3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
