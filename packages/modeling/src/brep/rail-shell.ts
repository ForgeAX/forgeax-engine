import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { modelingError } from '../errors';
import { domain, interpolate, loftSurface, type NurbsCurve, transpose } from '../nurbs';
import type { LoopEdge, ShapeAssembler } from './assembler';
import type { Frame, Shape } from './types';
import { dist3, type P2, type P3, sub3, unit3 } from './vec';

function lineEdge(asm: ShapeAssembler, a: P3, b: P3, cache: Map<string, number>): number {
  const va = asm.vertex(a);
  const vb = asm.vertex(b);
  const key = va < vb ? `${va}:${vb}` : `${vb}:${va}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const length = dist3(a, b);
  const curve = asm.curve({ kind: 'line', o: a, d: unit3(sub3(b, a)) });
  const edge = asm.edge(curve, 0, length);
  cache.set(key, edge);
  return edge;
}

/** The point of the frame's plane at local coordinates (x, y). */
export function placeOnFrame(frame: Frame, p: P2): P3 {
  return [
    frame.o[0] + frame.x[0] * p[0] + frame.y[0] * p[1],
    frame.o[1] + frame.x[1] * p[0] + frame.y[1] * p[1],
    frame.o[2] + frame.x[2] * p[0] + frame.y[2] * p[1],
  ];
}

export interface RailShellInput {
  readonly asm: ShapeAssembler;
  /** stationProfiles[station][ring][vertex]: corresponding polygon rings at every station. */
  readonly stationProfiles: readonly (readonly (readonly P3[])[])[];
  readonly startFrame: Frame;
  readonly endFrame: Frame;
  /** Strictly increasing rail parameters from 0 to 1, one per station. */
  readonly stationParams: readonly number[];
  /** Rail degree through the stations (1 gives ruled walls). */
  readonly pathDegree: number;
  /** Station 0 and the last station coincide: no caps. */
  readonly closed: boolean;
  readonly label: string;
  readonly role: string | undefined;
}

/**
 * Shared by sweep and loft: NURBS rails through corresponding ring vertices, ruled degree-1 walls between
 * neighbouring rails and planar caps on the first and last station (omitted when closed).
 */
export function buildRailShell(input: RailShellInput): Result<Shape, ModelingError> {
  const { asm, stationProfiles, startFrame, endFrame, stationParams, pathDegree, closed } = input;
  const rings = stationProfiles[0] as readonly (readonly P3[])[];
  const ringSizes = rings.map((ring) => ring.length);
  const firstStationProfile = stationProfiles[0] as readonly (readonly P3[])[];
  const lastStationProfile = stationProfiles[
    stationProfiles.length - 1
  ] as readonly (readonly P3[])[];
  const cache = new Map<string, number>();
  const profileEdges: number[][][] = [firstStationProfile, lastStationProfile].map((station) =>
    station.map((ring, ri) =>
      ring.map((p, i) => {
        const next = ring[(i + 1) % (ringSizes[ri] as number)] as P3;
        return lineEdge(asm, p, next, cache);
      }),
    ),
  );
  const railCurves: NurbsCurve[][] = [];
  for (let ri = 0; ri < rings.length; ri++) {
    railCurves.push([]);
    for (let pi = 0; pi < (ringSizes[ri] as number); pi++) {
      const points = stationProfiles
        .map((station) => (station[ri] as P3[])[pi] as P3)
        .map((p) => [p[0], p[1], p[2]] as [number, number, number]);
      const rail = interpolate(points, { degree: pathDegree, parameters: stationParams });
      if (!rail.ok) return rail;
      (railCurves[ri] as NurbsCurve[]).push(rail.value);
    }
  }

  const faces: number[] = [];
  const seamEdges = new Map<string, number>();
  const seamEdge = (ri: number, pi: number): number => {
    const key = `${ri}:${pi}`;
    const known = seamEdges.get(key);
    if (known !== undefined) return known;
    const rail = (railCurves[ri] as NurbsCurve[])[pi] as NurbsCurve;
    const curve = asm.curve({ kind: 'nurbs', curve: rail });
    const [lo, hi] = domain(rail);
    const edge = asm.edge(curve, lo, hi);
    seamEdges.set(key, edge);
    return edge;
  };
  for (let ri = 0; ri < rings.length; ri++) {
    const count = ringSizes[ri] as number;
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      const ruled = loftSurface(
        [
          (railCurves[ri] as NurbsCurve[])[i] as NurbsCurve,
          (railCurves[ri] as NurbsCurve[])[next] as NurbsCurve,
        ],
        {
          degree: 1,
          parameters: [0, 1],
        },
      );
      if (!ruled.ok) return ruled;
      const surfaceId = asm.surface({ kind: 'nurbs', surface: transpose(ruled.value) });

      const railI = (railCurves[ri] as NurbsCurve[])[i] as NurbsCurve;
      const railNext = (railCurves[ri] as NurbsCurve[])[next] as NurbsCurve;
      const [railLo, railHi] = domain(railI);
      const [railNextLo, railNextHi] = domain(railNext);
      const bottomLength = dist3(
        (firstStationProfile[ri] as readonly P3[])[i] as P3,
        (firstStationProfile[ri] as readonly P3[])[next] as P3,
      );
      const topLength = dist3(
        (lastStationProfile[ri] as P3[])[i] as P3,
        (lastStationProfile[ri] as P3[])[next] as P3,
      );
      const bottom = {
        edge: ((profileEdges[0] as number[][])[ri] as number[])[i] as number,
        pcurve: {
          kind: 'line' as const,
          o: [0, railLo] as P2,
          d: [(railHi - railLo) / bottomLength, 0] as P2,
        },
      };
      const right = {
        edge: seamEdge(ri, next),
        pcurve: {
          kind: 'line' as const,
          o: [1, railNextLo] as P2,
          d: [0, railNextHi - railNextLo] as P2,
        },
      };
      const top = {
        edge: ((profileEdges[1] as number[][])[ri] as number[])[i] as number,
        pcurve: {
          kind: 'line' as const,
          o: [0, railHi] as P2,
          d: [(railHi - railLo) / topLength, 0] as P2,
        },
      };
      const left = {
        edge: seamEdge(ri, i),
        pcurve: {
          kind: 'line' as const,
          o: [0, railLo] as P2,
          d: [0, railHi - railLo] as P2,
        },
      };
      const loop = asm.loop(surfaceId, [bottom, right, top, left], true);
      if (!loop.ok) return loop;
      faces.push(
        asm.face(surfaceId, [loop.value], false, `${input.label}.wall${ri}.${i}`, input.role ?? ''),
      );
    }
  }

  const cap = (
    stationIndex: number,
    frame: Frame,
    label: string,
  ): Result<number, ModelingError> => {
    const section = stationProfiles[stationIndex] as P3[][];
    const surfaceId = asm.surface({ kind: 'plane', frame });
    const loops: number[] = [];
    for (let ri = 0; ri < section.length; ri++) {
      const edgeIds = (profileEdges[stationIndex === 0 ? 0 : 1] as number[][])[ri] as number[];
      const specs: LoopEdge[] = edgeIds.map((edge) => ({ edge }));
      const loop = asm.loop(surfaceId, specs, ri === 0);
      if (!loop.ok) return loop;
      loops.push(loop.value);
    }
    return ok(
      asm.face(surfaceId, loops, stationIndex === 0, `${input.label}.${label}`, input.role ?? ''),
    );
  };
  if (!closed) {
    const bottom = cap(0, startFrame, 'start');
    if (!bottom.ok) return bottom;
    const top = cap(stationProfiles.length - 1, endFrame, 'end');
    if (!top.ok) return top;
    faces.push(bottom.value, top.value);
  }
  if (faces.length > 4096) {
    return err(
      modelingError('model-invalid-argument', 'a shell below the B-rep face limit', {
        brep: 'brep-bad-argument',
        reason: 'brep-limit',
      }),
    );
  }
  asm.shell(faces);
  return asm.finish();
}
