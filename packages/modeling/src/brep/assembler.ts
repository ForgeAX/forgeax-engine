import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { curvePoint, pcurveFor, pcurvePoint, shiftPCurve } from './curves';
import { coedgeEnds, coedgeGreen, UV_TOL } from './faces';
import { tally } from './ops';
import { type SurfaceDomain, surfaceDomain } from './surfaces';
import { resolveTolerance, type ToleranceOptions } from './tolerance';
import {
  brepError,
  type Coedge,
  type Curve,
  deepFreeze,
  type Edge,
  type Face,
  type Loop,
  type PCurve,
  type Shape,
  type Shell,
  type Surface,
  type Vertex,
} from './types';
import { validate } from './validate';
import { dist3, type P2, type P3 } from './vec';

function near(a: P2, b: P2): boolean {
  return Math.abs(a[0] - b[0]) <= UV_TOL && Math.abs(a[1] - b[1]) <= UV_TOL;
}

/**
 * One edge of a loop, in loop order. A degenerate edge (a pole or apex) cannot derive its pcurve
 * and carries the (u, v) displacement `span` of the loop's traversal across it.
 */
export interface LoopEdge {
  readonly edge: number;
  readonly span?: P2;
  /** An explicit parameter-space trim; required on a NURBS face, otherwise the closed form is derived. */
  readonly pcurve?: PCurve;
}

/**
 * Collects entities by index, derives the pcurve of each use in closed form, unwraps periodic
 * parameters along each loop, and returns a validated, frozen Shape.
 */
export class ShapeAssembler {
  readonly tol: number;
  readonly maxTol: number;
  private readonly vertices: Vertex[] = [];
  private readonly buckets = new Map<string, number[]>();
  private readonly curves: Curve[] = [];
  private readonly surfaces: Surface[] = [];
  private readonly edges: Edge[] = [];
  private readonly coedges: Coedge[] = [];
  private readonly loops: Loop[] = [];
  private readonly faces: Face[] = [];
  private readonly shells: Shell[] = [];

  private constructor(tol: number, maxTol: number) {
    this.tol = tol;
    this.maxTol = maxTol;
  }

  static create(diag: number, options?: ToleranceOptions): Result<ShapeAssembler, ModelingError> {
    const model = resolveTolerance(diag, options);
    if (!model.ok) return model;
    return ok(new ShapeAssembler(model.value.tol, model.value.maxTol));
  }

  surface(s: Surface): number {
    this.surfaces.push(s);
    return this.surfaces.length - 1;
  }

  curve(c: Curve): number {
    this.curves.push(c);
    return this.curves.length - 1;
  }

  vertex(p: P3): number {
    tally('vertexCalls');
    let best = -1;
    let bestDistance = this.tol;
    const cx = Math.floor(p[0] / this.tol);
    const cy = Math.floor(p[1] / this.tol);
    const cz = Math.floor(p[2] / this.tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (bucket === undefined) continue;
          for (const i of bucket) {
            tally('vertexProbes');
            const d = dist3((this.vertices[i] as Vertex).p, p);
            if (d < bestDistance || (d === bestDistance && i > best)) {
              best = i;
              bestDistance = d;
            }
          }
        }
      }
    }
    if (best >= 0) {
      const v = this.vertices[best] as Vertex;
      this.vertices[best] = { p: v.p, tol: Math.max(v.tol, bestDistance) };
      return best;
    }
    this.vertices.push({ p, tol: this.tol });
    const key = `${cx},${cy},${cz}`;
    const bucket = this.buckets.get(key);
    if (bucket === undefined) this.buckets.set(key, [this.vertices.length - 1]);
    else bucket.push(this.vertices.length - 1);
    return this.vertices.length - 1;
  }

  /** An edge over `[t0, t1]` of a curve; the end vertices are created or found at the curve ends. */
  edge(curve: number, t0: number, t1: number): number {
    const c = this.curves[curve] as Curve;
    const v0 = this.vertex(curvePoint(c, t0));
    const v1 = this.vertex(curvePoint(c, t1));
    this.edges.push({ curve, t0, t1, v0, v1, tol: this.tol });
    return this.edges.length - 1;
  }

  /** A pole or apex: one vertex, no curve, `t` in [0, 1]. */
  degenerateEdge(vertex: number): number {
    this.edges.push({ curve: -1, t0: 0, t1: 1, v0: vertex, v1: vertex, tol: this.tol });
    return this.edges.length - 1;
  }

  /**
   * Add a loop on `surface` from its edges in order. Each edge direction is found by searching
   * for the assignment that is head-to-tail in 3D and in (u, v) (periods are unwrapped), closes
   * exactly, and has the signed (u, v) area the loop kind requires.
   */
  loop(surface: number, edges: readonly LoopEdge[], outer: boolean): Result<number, ModelingError> {
    const s = this.surfaces[surface] as Surface;
    const domain = surfaceDomain(s);
    // Keyed by use: a periodic seam used twice may carry a different parameter-space image per use.
    const natural = new Map<LoopEdge, PCurve>();
    for (const spec of edges) {
      const edge = this.edges[spec.edge] as Edge;
      if (edge.curve < 0) continue;
      if (spec.pcurve !== undefined) {
        natural.set(spec, spec.pcurve);
        continue;
      }
      const derived = pcurveFor(s, this.curves[edge.curve] as Curve, edge.t0, edge.t1);
      if (!derived.ok) return derived;
      natural.set(spec, derived.value);
    }
    const first = edges[0];
    if (first === undefined || (this.edges[first.edge] as Edge).curve < 0) {
      return err(
        brepError('brep-bad-argument', 'a loop starting with a regular edge', { surface }),
      );
    }
    let found = this.search(domain, natural, edges, outer);
    if (found === undefined && edges.every((e) => e.span === undefined)) {
      found = this.search(domain, natural, edges.slice().reverse(), outer);
    }
    if (found === undefined) {
      return err(
        brepError('brep-loop-open', 'edges that chain head to tail and close in (u, v)', {
          surface,
          edge: first.edge,
        }),
      );
    }
    found = this.normalizePeriod(domain, found);
    const created: number[] = [];
    for (const c of found) {
      this.coedges.push(c);
      created.push(this.coedges.length - 1);
    }
    this.loops.push({ coedges: created, outer });
    return ok(this.loops.length - 1);
  }

  /** Shift a periodic loop by whole periods so its smallest (u, v) lies in [0, period). */
  private normalizePeriod(domain: SurfaceDomain, coedges: Coedge[]): Coedge[] {
    let minU = Infinity;
    let minV = Infinity;
    for (const c of coedges) {
      const { start } = coedgeEnds(this.edges[c.edge] as Edge, c);
      minU = Math.min(minU, start[0]);
      minV = Math.min(minV, start[1]);
    }
    const du =
      domain.uPeriod > 0 ? -Math.floor((minU + UV_TOL) / domain.uPeriod) * domain.uPeriod : 0;
    const dv =
      domain.vPeriod > 0 ? -Math.floor((minV + UV_TOL) / domain.vPeriod) * domain.vPeriod : 0;
    if (du === 0 && dv === 0) return coedges;
    return coedges.map((c) => ({ ...c, pcurve: shiftPCurve(c.pcurve, du, dv) }));
  }

  private search(
    domain: SurfaceDomain,
    natural: ReadonlyMap<LoopEdge, PCurve>,
    edges: readonly LoopEdge[],
    outer: boolean,
  ): Coedge[] | undefined {
    const n = edges.length;
    const acc: Coedge[] = [];
    const tried = new Array<number>(n + 1).fill(0);
    let startUv: P2 | undefined;
    let k = 0;
    while (true) {
      if (k === n) {
        const closed = this.closedLoop(acc, startUv as P2, outer);
        if (closed !== undefined) return closed;
        k -= 1;
        acc.pop();
        continue;
      }
      const spec = edges[k] as LoopEdge;
      const edge = this.edges[spec.edge] as Edge;
      const last = acc[acc.length - 1];
      const prevEnd =
        last === undefined ? undefined : coedgeEnds(this.edges[last.edge] as Edge, last).end;
      const prevVertex =
        last === undefined
          ? undefined
          : last.reversed
            ? (this.edges[last.edge] as Edge).v0
            : (this.edges[last.edge] as Edge).v1;
      const optionCount = edge.curve < 0 ? 1 : 2;
      let advanced = false;
      while ((tried[k] as number) < optionCount) {
        const reversed = tried[k] === 1;
        tried[k] = (tried[k] as number) + 1;
        const startVertex = reversed ? edge.v1 : edge.v0;
        if (prevVertex !== undefined && startVertex !== prevVertex) continue;
        let pcurve: PCurve;
        if (edge.curve < 0) {
          if (spec.span === undefined || prevEnd === undefined) {
            tried[k] = optionCount;
            break;
          }
          pcurve = { kind: 'line', o: prevEnd, d: spec.span };
        } else {
          pcurve = natural.get(spec) as PCurve;
          if (prevEnd !== undefined) {
            const ts = reversed ? edge.t1 : edge.t0;
            const s0 = pcurvePoint(pcurve, ts);
            const du =
              domain.uPeriod > 0
                ? Math.round((prevEnd[0] - s0[0]) / domain.uPeriod) * domain.uPeriod
                : 0;
            const dv =
              domain.vPeriod > 0
                ? Math.round((prevEnd[1] - s0[1]) / domain.vPeriod) * domain.vPeriod
                : 0;
            pcurve = shiftPCurve(pcurve, du, dv);
            if (!near(pcurvePoint(pcurve, ts), prevEnd)) continue;
          }
        }
        const coedge: Coedge = { edge: spec.edge, reversed, pcurve };
        if (k === 0) startUv = coedgeEnds(edge, coedge).start;
        acc.push(coedge);
        k += 1;
        tried[k] = 0;
        advanced = true;
        break;
      }
      if (!advanced) {
        if (k === 0) return undefined;
        k -= 1;
        acc.pop();
      }
    }
  }

  private closedLoop(acc: readonly Coedge[], startUv: P2, outer: boolean): Coedge[] | undefined {
    const head = acc[0] as Coedge;
    const last = acc[acc.length - 1] as Coedge;
    const e = this.edges[last.edge] as Edge;
    const h = this.edges[head.edge] as Edge;
    const endV = last.reversed ? e.v0 : e.v1;
    const startV = head.reversed ? h.v1 : h.v0;
    const end = coedgeEnds(e, last).end;
    if (endV !== startV || !near(end, startUv)) return undefined;
    let area = 0;
    for (const c of acc) area += coedgeGreen(this.edges[c.edge] as Edge, c);
    return outer ? (area > 0 ? [...acc] : undefined) : area < 0 ? [...acc] : undefined;
  }

  face(
    surface: number,
    loops: readonly number[],
    reversed: boolean,
    label: string,
    role = '',
  ): number {
    this.faces.push({ surface, loops, reversed, label, role });
    return this.faces.length - 1;
  }

  shell(faces: readonly number[]): void {
    this.shells.push({ faces });
  }

  /** Freeze and validate; the first validation issue becomes the error. */
  finish(): Result<Shape, ModelingError> {
    const shape: Shape = deepFreeze({
      tol: this.tol,
      maxTol: this.maxTol,
      vertices: this.vertices.slice(),
      curves: this.curves.slice(),
      surfaces: this.surfaces.slice(),
      edges: this.edges.slice(),
      coedges: this.coedges.slice(),
      loops: this.loops.slice(),
      faces: this.faces.slice(),
      shells: this.shells.slice(),
    });
    const report = validate(shape);
    const first = report.issues[0];
    if (first !== undefined) return err(brepError(first.code, first.message, first.ids));
    return ok(shape);
  }
}
