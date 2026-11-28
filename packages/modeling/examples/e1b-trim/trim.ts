import { curvePoint } from '../../src/brep/curves.ts';
import { type IntersectionBranch, intersectSurfaces } from '../../src/brep/intersect.ts';
import { classifyOnFace, faceTrim } from '../../src/brep/trim-face.ts';
import { cutBranch } from '../../src/brep/trim-span.ts';
import type { Shape, Surface } from '../../src/brep/types.ts';
import { cylinderOnTop } from './sources.ts';

export interface TrimReport {
  readonly top: Shape;
  readonly side: Shape;
  readonly arcSamples: number;
  readonly inCount: number;
  readonly outCount: number;
  readonly onCount: number;
  readonly seamCuts: number;
  readonly spans: number;
  readonly topFace: number;
  readonly branch: IntersectionBranch;
}

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

/** Classify the intersection arc of the cylinder side with the box top, and count its span splits. */
export function classifyArc(): TrimReport {
  const built = cylinderOnTop();
  const topFace = built.top.faces.findIndex((f) => {
    const s = built.top.surfaces[f.surface];
    return s?.kind === 'plane' && Math.abs(s.frame.o[2] - 0.5) < 1e-9;
  });
  const sideFace = built.side.faces.findIndex(
    (f) => built.side.surfaces[f.surface]?.kind === 'cylinder',
  );
  const cyl: Surface = must(built.side.surfaces[must(built.side.faces[sideFace]).surface]);
  const plane: Surface = must(built.top.surfaces[must(built.top.faces[topFace]).surface]);
  const r = intersectSurfaces(cyl, plane, built.top.tol);
  if (!r.ok) throw new Error('intersect failed');
  const branch = must(r.value.branches[0]);
  const trim = faceTrim(built.top, topFace);
  const spans = cutBranch(cyl, plane, branch, built.top.tol);
  let inCount = 0;
  let outCount = 0;
  let onCount = 0;
  const n = 360;
  for (let i = 0; i < n; i++) {
    const t = branch.t0 + ((branch.t1 - branch.t0) * i) / n;
    const c = classifyOnFace(trim, curvePoint(branch.curve, t));
    if (c === 'in') inCount++;
    else if (c === 'out') outCount++;
    else onCount++;
  }
  return {
    top: built.top,
    side: built.side,
    arcSamples: n,
    inCount,
    outCount,
    onCount,
    seamCuts: spans.cuts.filter((c) => c.kind === 'u-seam').length,
    spans: spans.spans.length,
    topFace,
    branch,
  };
}
