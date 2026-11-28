import { err, type Result } from '@forgeax/engine-types';
import { maxOf } from '../arrays';
import { hypot3 } from '../dmath';
import type { ModelingError } from '../errors';
import { modelingError } from '../errors';
import { curvePoint, domain, interpolate, type NurbsCurve } from '../nurbs';
import { ShapeAssembler } from './assembler';
import { area2, isPointList, type RingDefect, ringDefect, windPolygon } from './profile';
import { buildRailShell, placeOnFrame } from './rail-shell';
import { frameDefect } from './surfaces';
import type { ToleranceOptions } from './tolerance';
import type { Frame, Shape } from './types';
import { dist3, dot3, type P2, type P3, sub3 } from './vec';

export interface LoftSection {
  /** Closed polygonal outline in the frame's xy plane; any vertex count. */
  readonly profile: readonly P2[];
  /** Through holes; every section must have the same number of holes, matched by position in the list. */
  readonly holes?: readonly (readonly P2[])[];
  /** Placement; z must point along the loft direction (towards the next section). */
  readonly frame: Frame;
}

export interface LoftOptions extends ToleranceOptions {
  /** Two or more sections in order along the loft. */
  readonly sections: readonly LoftSection[];
  /** `ruled`: straight rails between consecutive sections; `smooth` (default): one NURBS rail through all. */
  readonly mode?: 'ruled' | 'smooth';
  /** Vertices per ring after resampling by arc length (default: the largest ring size, at least 3). */
  readonly samples?: number;
  readonly label?: string;
  readonly role?: string;
}

const GAPS_SAMPLED = 8;
const MAX_SAMPLES = 256;

function bad(expected: string, detail: Record<string, unknown> = {}): Result<never, ModelingError> {
  return err(
    modelingError('model-invalid-argument', expected, { brep: 'brep-bad-argument', ...detail }),
  );
}

function partial(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-partial', expected, detail));
}

/** `n` points at equal arc length along the closed ring, starting at its first vertex. */
function resampleRing(ring: readonly P2[], n: number): P2[] {
  if (ring.length === n) return ring.slice();
  const lengths = ring.map((p, i) => {
    const q = ring[(i + 1) % ring.length] as P2;
    return Math.sqrt((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]));
  });
  const total = lengths.reduce((a, b) => a + b, 0);
  const out: P2[] = [];
  let edge = 0;
  let edgeStart = 0;
  for (let k = 0; k < n; k++) {
    const s = (total * k) / n;
    while (edge < ring.length - 1 && edgeStart + (lengths[edge] as number) < s) {
      edgeStart += lengths[edge] as number;
      edge++;
    }
    const p = ring[edge] as P2;
    const q = ring[(edge + 1) % ring.length] as P2;
    const u = (s - edgeStart) / (lengths[edge] as number);
    out.push([p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u]);
  }
  return out;
}

/** Cyclic shift of `ring` that brings it closest (sum of squared distances) to `target`. */
function alignedTo(ring: readonly P3[], target: readonly P3[]): P3[] {
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift < ring.length; shift++) {
    let cost = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[(i + shift) % ring.length] as P3;
      const q = target[i] as P3;
      cost +=
        (p[0] - q[0]) * (p[0] - q[0]) +
        (p[1] - q[1]) * (p[1] - q[1]) +
        (p[2] - q[2]) * (p[2] - q[2]);
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = shift;
    }
  }
  return ring.map((_, i) => ring[(i + best) % ring.length] as P3);
}

/** An in-between ring that flips orientation has folded through itself even if it is simple. */
function orientationDefect(rings: readonly (readonly P2[])[]): RingDefect | undefined {
  for (let ri = 0; ri < rings.length; ri++) {
    const a = area2(rings[ri] as P2[]);
    if (ri === 0 ? !(a > 0) : !(a < 0)) {
      return { reason: 'flipped-ring', expected: 'consistently wound rings', ids: { ring: ri } };
    }
  }
  return undefined;
}

function toLocal(frame: Frame, p: P3): P2 {
  const d = sub3(p, frame.o);
  return [dot3(d, frame.x), dot3(d, frame.y)];
}

/**
 * Lofts planar polygonal sections (optionally with holes and different vertex counts) into one solid:
 * rings are resampled to a common vertex count by arc length, cyclically aligned section to section, joined
 * by NURBS rails (ruled or one smooth interpolant) with ruled walls, and capped at both ends. Sampled
 * in-between sections must remain valid planar regions, otherwise the loft fails closed with `model-partial`;
 * this is a sampled check, not a certified global self-intersection test.
 */
export function loft(options: LoftOptions): Result<Shape, ModelingError> {
  const sections = options.sections;
  if (!Array.isArray(sections) || sections.length < 2) {
    return bad('at least two loft sections', { reason: 'too-few-sections' });
  }
  const mode = options.mode ?? 'smooth';
  if (mode !== 'ruled' && mode !== 'smooth') return bad('mode ruled or smooth', { mode });
  const holeCount = (sections[0] as LoftSection).holes?.length ?? 0;
  let largest = 3;
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si] as LoftSection;
    const holes = section.holes ?? [];
    if (!isPointList(section.profile, 3) || area2(section.profile) === 0) {
      return bad('a non-degenerate polygonal profile with at least 3 finite points', {
        section: si,
      });
    }
    if (!Array.isArray(holes) || holes.some((h) => !isPointList(h, 3) || area2(h) === 0)) {
      return bad('holes that are non-degenerate polygonal rings', { section: si });
    }
    if (holes.length !== holeCount) {
      return partial('the same number of holes in every section', {
        reason: 'hole-count-mismatch',
        section: si,
        holes: holes.length,
        expected: holeCount,
      });
    }
    const defect = section.frame === undefined ? 'missing-frame' : frameDefect(section.frame);
    if (defect !== undefined)
      return bad('an orthonormal right-handed section frame', { reason: defect, section: si });
    largest = Math.max(largest, section.profile.length, maxOf(holes.map((h) => h.length)));
  }
  for (let si = 0; si + 1 < sections.length; si++) {
    const a = (sections[si] as LoftSection).frame;
    const b = (sections[si + 1] as LoftSection).frame;
    const travel = sub3(b.o, a.o);
    if (!(dot3(travel, a.z) > 0) || !(dot3(travel, b.z) > 0)) {
      return bad('section frames whose z axis points towards the next section', {
        reason: 'section-order',
        section: si,
      });
    }
  }
  const samples = options.samples ?? largest;
  if (!Number.isInteger(samples) || samples < 3 || samples > MAX_SAMPLES) {
    return bad(`an integer sample count from 3 through ${MAX_SAMPLES}`, { samples });
  }

  const ringCount = holeCount + 1;
  const stationProfiles: P3[][][] = [];
  const local: P2[][][] = [];
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si] as LoftSection;
    const rings2 = [
      windPolygon(section.profile, true),
      ...(section.holes ?? []).map((h) => windPolygon(h, false)),
    ].map((ring) => resampleRing(ring, samples));
    local.push(rings2);
    const previous = stationProfiles[si - 1];
    stationProfiles.push(
      rings2.map((ring, ri) => {
        const placed = ring.map((p) => placeOnFrame(section.frame, p));
        return previous === undefined ? placed : alignedTo(placed, previous[ri] as P3[]);
      }),
    );
  }

  const all = stationProfiles.flatMap((station) => station.flat());
  let lo = all[0] as P3;
  let hi = lo;
  for (const p of all) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  const made = ShapeAssembler.create(hypot3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), options);
  if (!made.ok) return made;
  const asm = made.value;
  for (let si = 0; si < sections.length; si++) {
    const defect = ringDefect(local[si] as P2[][], asm.tol, 'section');
    if (defect !== undefined)
      return bad(defect.expected, { reason: defect.reason, section: si, ...defect.ids });
  }
  if (samples * ringCount * (sections.length + 2) > 4096) {
    return bad('a loft below the B-rep face and edge limits', { reason: 'brep-limit' });
  }

  const origins = sections.map((s) => (s as LoftSection).frame.o);
  const chord = [0];
  for (let i = 1; i < origins.length; i++) {
    chord.push((chord[i - 1] as number) + dist3(origins[i - 1] as P3, origins[i] as P3));
  }
  const total = chord[chord.length - 1] as number;
  const stationParams = chord.map((c) => c / total);
  const pathDegree = mode === 'ruled' ? 1 : Math.min(3, sections.length - 1);

  const rails: NurbsCurve[][] = [];
  for (let ri = 0; ri < ringCount; ri++) {
    const ringRails: NurbsCurve[] = [];
    for (let pi = 0; pi < samples; pi++) {
      const points = stationProfiles.map(
        (station) => (station[ri] as P3[])[pi]?.slice() as [number, number, number],
      );
      const rail = interpolate(points, { degree: pathDegree, parameters: stationParams });
      if (!rail.ok) return rail;
      ringRails.push(rail.value);
    }
    rails.push(ringRails);
  }

  for (let si = 0; si + 1 < sections.length; si++) {
    for (let g = 1; g <= GAPS_SAMPLED; g++) {
      const u = g / (GAPS_SAMPLED + 1);
      const t = (stationParams[si] as number) * (1 - u) + (stationParams[si + 1] as number) * u;
      const frame = (sections[u < 0.5 ? si : si + 1] as LoftSection).frame;
      const rings2 = rails.map((ringRails) =>
        ringRails.map((rail) => {
          const [d0, d1] = domain(rail);
          return toLocal(frame, curvePoint(rail, d0 + (d1 - d0) * t) as P3);
        }),
      );
      const defect = ringDefect(rings2, asm.tol, 'in-between section') ?? orientationDefect(rings2);
      if (defect !== undefined) {
        return partial('in-between sections that stay valid planar regions', {
          reason: 'loft-self-intersection',
          between: si,
          at: u,
          cause: defect.reason,
        });
      }
    }
  }

  return buildRailShell({
    asm,
    stationProfiles,
    startFrame: (sections[0] as LoftSection).frame,
    endFrame: (sections[sections.length - 1] as LoftSection).frame,
    stationParams,
    pathDegree,
    closed: false,
    label: options.label ?? 'loft',
    role: options.role,
  });
}
