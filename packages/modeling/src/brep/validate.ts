import { curvePoint, pcurvePoint } from './curves';
import { coedgeEnds, faceLoops, loopSignedArea, UV_TOL } from './faces';
import { measureVolume } from './measure-volume';
import { ringDefect } from './profile';
import { type BrepIssue, structureIssues } from './structure';
import { surfacePoint } from './surfaces';
import type { Coedge, Curve, Edge, Face, Loop, Shape, Surface, Vertex } from './types';
import { dist3, type P2 } from './vec';

export type { BrepIssue };

export interface ShellTopology {
  readonly vertices: number;
  readonly edges: number;
  readonly faces: number;
  readonly euler: number;
  readonly genus: number;
}

/** Exact solid facts, present only when the Shape validates. */
export interface SolidReport {
  readonly source: 'exact';
  readonly volume: number;
  /** Present only when a density option was supplied. */
  readonly mass?: number;
}

export interface ValidationOptions {
  /** Mass density; must be a finite number above 0. */
  readonly density?: number;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly issues: readonly BrepIssue[];
  /** Per shell; degenerate edges (poles, apexes) are not edges of the surface complex. */
  readonly shells: readonly ShellTopology[];
  readonly solid?: SolidReport;
}

const SAMPLES = 9;

/** Parameter tolerance for a NURBS pcurve domain against its edge. */
const DOMAIN_TOL = 1e-9;

function checkTolerance(shape: Shape, issues: BrepIssue[]): void {
  shape.vertices.forEach((v: Vertex, i) => {
    if (!(v.tol <= shape.maxTol))
      issues.push({
        code: 'brep-tol-exceeded',
        message: 'vertex tolerance <= maxTol',
        ids: { vertex: i },
      });
  });
  shape.edges.forEach((e: Edge, i) => {
    if (!(e.tol <= shape.maxTol))
      issues.push({
        code: 'brep-tol-exceeded',
        message: 'edge tolerance <= maxTol',
        ids: { edge: i },
      });
  });
}

function checkEdges(shape: Shape, issues: BrepIssue[]): void {
  shape.edges.forEach((e: Edge, i) => {
    const v0 = shape.vertices[e.v0] as Vertex;
    const v1 = shape.vertices[e.v1] as Vertex;
    if (e.curve < 0) {
      if (e.v0 !== e.v1)
        issues.push({
          code: 'brep-vertex-mismatch',
          message: 'a degenerate edge with one vertex',
          ids: { edge: i },
        });
      return;
    }
    const c = shape.curves[e.curve] as Curve;
    if (
      dist3(curvePoint(c, e.t0), v0.p) > Math.max(v0.tol, e.tol) ||
      dist3(curvePoint(c, e.t1), v1.p) > Math.max(v1.tol, e.tol)
    ) {
      issues.push({
        code: 'brep-vertex-mismatch',
        message: 'curve ends at the edge vertices',
        ids: { edge: i },
      });
    }
  });
}

function faceOfCoedge(shape: Shape): Map<number, number> {
  const owner = new Map<number, number>();
  shape.faces.forEach((f: Face, fi) => {
    for (const l of f.loops) for (const c of (shape.loops[l] as Loop).coedges) owner.set(c, fi);
  });
  return owner;
}

function checkCoedgeGeometry(
  shape: Shape,
  owner: ReadonlyMap<number, number>,
  issues: BrepIssue[],
): void {
  shape.coedges.forEach((co: Coedge, ci) => {
    const fi = owner.get(ci);
    if (fi === undefined) {
      issues.push({
        code: 'brep-loop-open',
        message: 'every coedge belongs to a face loop',
        ids: { coedge: ci },
      });
      return;
    }
    const e = shape.edges[co.edge] as Edge;
    const surface = shape.surfaces[(shape.faces[fi] as Face).surface] as Surface;
    if (co.pcurve.kind === 'nurbs') {
      const { degree, knots, points } = co.pcurve.curve;
      const lo = knots[degree];
      const hi = knots[points.length];
      if (
        lo === undefined ||
        hi === undefined ||
        Math.abs(lo - e.t0) > DOMAIN_TOL ||
        Math.abs(hi - e.t1) > DOMAIN_TOL
      ) {
        issues.push({
          code: 'brep-pcurve-mismatch',
          message: 'a NURBS pcurve spans the edge parameter range [t0, t1]',
          ids: { coedge: ci, edge: co.edge, face: fi },
        });
        return;
      }
    }
    for (let k = 0; k <= SAMPLES; k++) {
      const t = e.t0 + ((e.t1 - e.t0) * k) / SAMPLES;
      const [u, v] = pcurvePoint(co.pcurve, t);
      const q = surfacePoint(surface, u, v);
      const target =
        e.curve < 0
          ? (shape.vertices[e.v0] as Vertex).p
          : curvePoint(shape.curves[e.curve] as Curve, t);
      if (dist3(q, target) > Math.max(e.tol, shape.tol)) {
        issues.push({
          code: 'brep-pcurve-mismatch',
          message: 'surface(pcurve(t)) = curve(t)',
          ids: { coedge: ci, edge: co.edge, face: fi },
        });
        return;
      }
    }
  });
}

function checkLoops(shape: Shape, issues: BrepIssue[]): void {
  shape.loops.forEach((loop: Loop, li) => {
    const n = loop.coedges.length;
    if (n === 0) {
      issues.push({ code: 'brep-loop-open', message: 'a non-empty loop', ids: { loop: li } });
      return;
    }
    let open = false;
    for (let k = 0; k < n && !open; k++) {
      const a = shape.coedges[loop.coedges[k] as number] as Coedge;
      const b = shape.coedges[loop.coedges[(k + 1) % n] as number] as Coedge;
      const ea = shape.edges[a.edge] as Edge;
      const eb = shape.edges[b.edge] as Edge;
      const endVertex = a.reversed ? ea.v0 : ea.v1;
      const startVertex = b.reversed ? eb.v1 : eb.v0;
      if (endVertex !== startVertex) {
        const d = dist3(
          (shape.vertices[endVertex] as Vertex).p,
          (shape.vertices[startVertex] as Vertex).p,
        );
        if (d > shape.maxTol) open = true;
      }
      const ue = coedgeEnds(ea, a).end;
      const us = coedgeEnds(eb, b).start;
      if (Math.abs(ue[0] - us[0]) > UV_TOL || Math.abs(ue[1] - us[1]) > UV_TOL) open = true;
    }
    if (open) {
      issues.push({
        code: 'brep-loop-open',
        message: 'coedges head to tail in 3D and in (u, v)',
        ids: { loop: li },
      });
      return;
    }
    const area = loopSignedArea(shape, loop.coedges);
    if (loop.outer ? !(area > 0) : !(area < 0)) {
      issues.push({
        code: 'brep-orientation',
        message: loop.outer ? 'outer loop counter-clockwise' : 'inner loop clockwise',
        ids: { loop: li },
      });
    }
  });
}

const ARC_SAMPLES = 24;

/** A loop of a planar face as a closed polygon in (u, v): line ends, circle arcs sampled; degenerate edges skipped. */
function planarRing(shape: Shape, coedges: readonly number[]): P2[] {
  const ring: P2[] = [];
  for (const c of coedges) {
    const co = shape.coedges[c] as Coedge;
    const e = shape.edges[co.edge] as Edge;
    if (e.curve < 0) continue;
    const ta = co.reversed ? e.t1 : e.t0;
    const tb = co.reversed ? e.t0 : e.t1;
    const n = co.pcurve.kind === 'line' ? 1 : ARC_SAMPLES;
    for (let k = 0; k < n; k++) ring.push(pcurvePoint(co.pcurve, ta + ((tb - ta) * k) / n));
  }
  return ring;
}

/** A planar face's loops must not cross or touch each other or themselves, and holes must nest in the outer loop. */
function checkPlanarFaces(shape: Shape, issues: BrepIssue[]): void {
  shape.faces.forEach((f: Face, fi) => {
    if ((shape.surfaces[f.surface] as Surface).kind !== 'plane') return;
    const { outer, holes } = faceLoops(shape, fi);
    const rings = [outer, ...holes].map((l) => planarRing(shape, l));
    if (rings.some((r) => r.length < 3)) return;
    const defect = ringDefect(rings, shape.tol, 'face loop');
    if (defect !== undefined) {
      issues.push({
        code: 'brep-self-intersection',
        message: defect.expected,
        ids: { face: fi },
      });
    }
  });
}

function checkEdgeUses(
  shape: Shape,
  owner: ReadonlyMap<number, number>,
  issues: BrepIssue[],
): void {
  const uses = shape.edges.map(() => [] as boolean[]);
  shape.coedges.forEach((co: Coedge, ci) => {
    const fi = owner.get(ci);
    if (fi === undefined) return;
    (uses[co.edge] as boolean[]).push(co.reversed !== (shape.faces[fi] as Face).reversed);
  });
  shape.edges.forEach((e: Edge, i) => {
    const u = uses[i] as boolean[];
    const degenerate = e.curve < 0;
    const wanted = degenerate ? 1 : 2;
    if (u.length !== wanted || (!degenerate && u[0] === u[1])) {
      issues.push({
        code: 'brep-edge-use',
        message: degenerate
          ? 'a degenerate edge used once'
          : 'an edge used by two faces in opposite senses',
        ids: { edge: i, uses: u.length },
      });
    }
  });
}

function topology(shape: Shape): ShellTopology[] {
  return shape.shells.map((s) => {
    const vs = new Set<number>();
    const es = new Set<number>();
    let holes = 0;
    for (const f of s.faces) {
      for (const l of (shape.faces[f] as Face).loops) {
        if (!(shape.loops[l] as Loop).outer) holes++;
        for (const c of (shape.loops[l] as Loop).coedges) {
          const co = shape.coedges[c] as Coedge;
          const e = shape.edges[co.edge] as Edge;
          vs.add(e.v0);
          vs.add(e.v1);
          if (e.curve >= 0) es.add(co.edge);
        }
      }
    }
    const euler = vs.size - es.size + s.faces.length - holes;
    return {
      vertices: vs.size,
      edges: es.size,
      faces: s.faces.length,
      euler,
      genus: (2 - euler) / 2,
    };
  });
}

const settled = new WeakMap<Shape, ValidationReport>();

/** A Shape whose top level and tables are all frozen is an immutable value, so its report cannot go stale. */
function isImmutable(shape: Shape): boolean {
  return (
    Object.isFrozen(shape) &&
    Object.isFrozen(shape.vertices) &&
    Object.isFrozen(shape.curves) &&
    Object.isFrozen(shape.surfaces) &&
    Object.isFrozen(shape.edges) &&
    Object.isFrozen(shape.coedges) &&
    Object.isFrozen(shape.loops) &&
    Object.isFrozen(shape.faces) &&
    Object.isFrozen(shape.shells)
  );
}

/**
 * Structural and geometric consistency of a Shape; never throws. An immutable Shape is validated once: the
 * assembler validates every Shape it builds, so a kernel result passed back in as an operand is not re-measured.
 */
export function validate(shape: Shape, options?: ValidationOptions): ValidationReport {
  try {
    if (options !== undefined || shape === null || typeof shape !== 'object' || !isImmutable(shape))
      return validateShape(shape, options);
    const known = settled.get(shape);
    if (known !== undefined) return known;
    const report = validateShape(shape, options);
    settled.set(shape, report);
    return report;
  } catch {
    return {
      ok: false,
      issues: [{ code: 'brep-bad-argument', message: 'a well-formed Shape value', ids: {} }],
      shells: [],
    };
  }
}

function validateShape(shape: Shape, options?: ValidationOptions): ValidationReport {
  const density = options?.density;
  if (density !== undefined && !(Number.isFinite(density) && density > 0)) {
    return {
      ok: false,
      issues: [{ code: 'brep-bad-argument', message: 'a finite density above 0', ids: {} }],
      shells: [],
    };
  }
  const issues = structureIssues(shape);
  if (issues.length > 0) return { ok: false, issues, shells: [] };
  checkTolerance(shape, issues);
  checkEdges(shape, issues);
  const owner = faceOfCoedge(shape);
  checkCoedgeGeometry(shape, owner, issues);
  checkLoops(shape, issues);
  checkPlanarFaces(shape, issues);
  checkEdgeUses(shape, owner, issues);
  let solid: SolidReport | undefined;
  if (issues.length === 0) {
    const m = measureVolume(shape);
    if (m.ok) {
      m.value.shells.forEach((v, i) => {
        if (!(v > 0))
          issues.push({
            code: 'brep-orientation',
            message: 'a shell with positive enclosed volume',
            ids: { shell: i },
          });
      });
      if (issues.length === 0) {
        const volume = m.value.volume;
        solid = {
          source: 'exact',
          volume,
          ...(density === undefined ? {} : { mass: volume * density }),
        };
      }
    }
  }
  const report: ValidationReport = {
    ok: issues.length === 0,
    issues,
    shells: topology(shape),
  };
  return solid === undefined ? report : { ...report, solid };
}
