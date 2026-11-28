import type { ModelingError } from '../errors';
import { checkCurve, checkSurface } from '../nurbs';
import { tally } from './ops';
import { frameDefect } from './surfaces';
import { TOL_FLOOR } from './tolerance';
import { type BrepDetailCode, brepError, type Loop, type Shape } from './types';

export interface BrepIssue {
  readonly code: BrepDetailCode;
  readonly message: string;
  readonly ids: Readonly<Record<string, number>>;
}

function inRange(i: number, n: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < n;
}

const SURFACE_KINDS: ReadonlySet<string> = new Set([
  'plane',
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'nurbs',
]);
const CURVE_KINDS: ReadonlySet<string> = new Set(['line', 'circle', 'ellipse', 'nurbs']);
const PCURVE_KINDS: ReadonlySet<string> = new Set(['line', 'circle', 'nurbs']);
const DEPTH = 8;

/** True when a number anywhere inside `value` is not finite; typed arrays count, strings and booleans do not. */
function hasNonFinite(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') {
    tally('finiteChecks');
    return !Number.isFinite(value);
  }
  if (typeof value !== 'object' || value === null || depth > DEPTH) return false;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as ArrayLike<number>;
    for (let i = 0; i < view.length; i++) {
      tally('finiteChecks');
      if (!Number.isFinite(view[i])) return true;
    }
    return false;
  }
  for (const x of Object.values(value)) if (hasNonFinite(x, depth + 1)) return true;
  return false;
}

/** Field types and kinds, finiteness and frame sanity: everything later stages index into without guarding. */
function checkFields(shape: Shape, issues: BrepIssue[]): void {
  const bad = (message: string, ids: Record<string, number> = {}) =>
    issues.push({ code: 'brep-bad-argument', message, ids });
  const lists = [
    'vertices',
    'curves',
    'surfaces',
    'edges',
    'coedges',
    'loops',
    'faces',
    'shells',
  ] as const;
  for (const name of lists) {
    if (!Array.isArray(shape[name])) {
      bad(`${name} is an array`);
      return;
    }
  }
  if (
    !(Number.isFinite(shape.tol) && Number.isFinite(shape.maxTol)) ||
    shape.tol < TOL_FLOOR ||
    shape.maxTol < shape.tol
  ) {
    bad('finite tol >= 1e-9 and maxTol >= tol');
  }
  if (shape.shells.length === 0) bad('at least one shell');
  if (hasNonFinite(shape.vertices)) bad('finite vertex coordinates and tolerances');
  if (hasNonFinite(shape.curves)) bad('finite curve parameters');
  if (hasNonFinite(shape.surfaces)) bad('finite surface parameters');
  if (hasNonFinite(shape.edges)) bad('finite edge parameters');
  if (hasNonFinite(shape.coedges)) bad('finite pcurve parameters');
  shape.vertices.forEach((v, i) => {
    if (typeof v.tol !== 'number' || !(v.tol >= 0) || !Array.isArray(v.p) || v.p.length !== 3)
      bad('vertex p and tol', { vertex: i });
  });
  shape.edges.forEach((e, i) => {
    if (typeof e.tol !== 'number' || !(e.tol >= 0)) bad('edge tol', { edge: i });
  });
  shape.surfaces.forEach((surface, i) => {
    if (!SURFACE_KINDS.has(surface?.kind)) {
      bad('a known surface kind', { surface: i });
      return;
    }
    if (surface.kind === 'nurbs') {
      if (!checkSurface(surface.surface).ok) bad('a valid NURBS surface', { surface: i });
      return;
    }
    const defect = frameDefect(surface.frame);
    if (defect !== undefined)
      bad(`surface frame is right-handed orthonormal (${defect})`, { surface: i });
  });
  shape.curves.forEach((c, i) => {
    if (!CURVE_KINDS.has(c?.kind)) {
      bad('a known curve kind', { curve: i });
      return;
    }
    if (c.kind === 'circle' || c.kind === 'ellipse') {
      const defect = frameDefect(c.frame);
      if (defect !== undefined)
        bad(`curve frame is right-handed orthonormal (${defect})`, { curve: i });
    }
  });
  shape.coedges.forEach((c, i) => {
    if (!PCURVE_KINDS.has(c?.pcurve?.kind)) bad('a known pcurve kind', { coedge: i });
    else if (c.pcurve.kind === 'nurbs' && !checkCurve(c.pcurve.curve).ok)
      bad('a valid NURBS pcurve', { coedge: i });
  });
  shape.faces.forEach((f, i) => {
    if (typeof f.label !== 'string' || typeof f.role !== 'string')
      bad('string label and role', { face: i });
  });
}

function checkIndices(shape: Shape, issues: BrepIssue[]): void {
  const bad = (message: string, ids: Record<string, number>) =>
    issues.push({ code: 'brep-index-range', message, ids });
  shape.edges.forEach((e, i) => {
    if (
      (e.curve !== -1 && !inRange(e.curve, shape.curves.length)) ||
      !inRange(e.v0, shape.vertices.length) ||
      !inRange(e.v1, shape.vertices.length)
    ) {
      bad('edge indices inside their arrays', { edge: i });
    }
  });
  shape.coedges.forEach((c, i) => {
    if (!inRange(c.edge, shape.edges.length))
      bad('coedge edge inside the edge array', { coedge: i });
  });
  shape.loops.forEach((l, i) => {
    if (l.coedges.some((c) => !inRange(c, shape.coedges.length)))
      bad('loop coedges inside the coedge array', { loop: i });
  });
  shape.faces.forEach((f, i) => {
    if (
      !inRange(f.surface, shape.surfaces.length) ||
      f.loops.some((l) => !inRange(l, shape.loops.length))
    ) {
      bad('face surface and loops inside their arrays', { face: i });
    }
  });
  shape.shells.forEach((s, i) => {
    if (s.faces.some((f) => !inRange(f, shape.faces.length)))
      bad('shell faces inside the face array', { shell: i });
  });
}

/** Every face in exactly one shell, every loop in exactly one face, every coedge in exactly one loop, one outer loop per face. */
function checkOwnership(shape: Shape, issues: BrepIssue[]): void {
  const count = (n: number) => new Array<number>(n).fill(0);
  const inShell = count(shape.faces.length);
  for (const s of shape.shells) for (const f of s.faces) inShell[f] = (inShell[f] as number) + 1;
  inShell.forEach((n, face) => {
    if (n !== 1)
      issues.push({
        code: 'brep-edge-use',
        message: 'every face in exactly one shell',
        ids: { face, shells: n },
      });
  });
  const loopUses = count(shape.loops.length);
  shape.faces.forEach((f, face) => {
    let outer = 0;
    for (const l of f.loops) {
      loopUses[l] = (loopUses[l] as number) + 1;
      if ((shape.loops[l] as Loop).outer) outer++;
    }
    if (outer !== 1)
      issues.push({
        code: 'brep-orientation',
        message: 'exactly one outer loop per face',
        ids: { face, outer },
      });
  });
  loopUses.forEach((n, loop) => {
    if (n !== 1)
      issues.push({
        code: 'brep-loop-open',
        message: 'every loop used by exactly one face',
        ids: { loop, uses: n },
      });
  });
  const coedgeUses = count(shape.coedges.length);
  for (const l of shape.loops)
    for (const c of l.coedges) coedgeUses[c] = (coedgeUses[c] as number) + 1;
  coedgeUses.forEach((n, coedge) => {
    if (n > 1)
      issues.push({
        code: 'brep-edge-use',
        message: 'every coedge in at most one loop',
        ids: { coedge, uses: n },
      });
  });
}

/** Fields, indices and ownership: what every consumer indexes into without guarding; never throws. */
export function structureIssues(shape: Shape): BrepIssue[] {
  const issues: BrepIssue[] = [];
  try {
    checkFields(shape, issues);
    if (issues.length > 0) return issues;
    checkIndices(shape, issues);
    if (issues.length > 0) return issues;
    checkOwnership(shape, issues);
  } catch {
    issues.push({ code: 'brep-bad-argument', message: 'a well-formed Shape value', ids: {} });
  }
  return issues;
}

/** The first structural issue as a ModelingError, or `undefined` when the Shape is safe to index. */
export function structureError(shape: Shape): ModelingError | undefined {
  const first = structureIssues(shape)[0];
  return first === undefined ? undefined : brepError(first.code, first.message, first.ids);
}
