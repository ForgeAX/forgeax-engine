import type { Result } from '@forgeax/engine-types';
import { box } from '../../src/brep/build';
import { sweep } from '../../src/brep/sweep';
import type { Shape } from '../../src/brep/types';
import type { P2, P3 } from '../../src/brep/vec';
import { cos, sin } from '../../src/dmath';
import type { ModelingError } from '../../src/errors';
import { interpolate, type NurbsCurve } from '../../src/nurbs';

const TAU = 2 * Math.PI;

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function ring(radius: number, count: number): P2[] {
  return Array.from({ length: count }, (_, i) => [
    radius * cos((TAU * i) / count),
    radius * sin((TAU * i) / count),
  ]);
}

function cablePath(points: readonly P3[]): NurbsCurve {
  return must(interpolate(
    points.map((p) => [...p]),
    { degree: 3 },
  ));
}

function terminal(origin: P3, size: P3, label: string): Shape {
  return must(box({ size, frame: { o: origin, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, label }));
}

export interface CableHarness {
  readonly parts: readonly Shape[];
  readonly cablePaths: readonly NurbsCurve[];
}

export function buildCableHarness(): CableHarness {
  const lanes = [
    { x: -1.6, bendX: -1.15, bendY: 0.1 },
    { x: 0, bendX: 0.15, bendY: 1.05 },
    { x: 1.6, bendX: 1.25, bendY: -0.75 },
  ] as const;
  const parts: Shape[] = [];
  const cablePaths: NurbsCurve[] = [];

  for (const [index, lane] of lanes.entries()) {
    const points: P3[] = [
      [lane.x, 0, 0],
      [lane.x, 0, 0.65],
      [lane.bendX, lane.bendY * 0.45, 1.55],
      [lane.bendX, lane.bendY, 2.55],
      [lane.bendX * 0.75, lane.bendY, 3.35],
      [lane.x, 0.2, 4.25],
      [lane.x, 0, 4.95],
      [lane.x, 0, 5.6],
    ];
    const path = cablePath(points);
    cablePaths.push(path);
    parts.push(
      must(
        sweep({
          profile: ring(0.24, 16),
          path: { kind: 'nurbs', curve: path },
          stations: 25,
          fitTolerance: 0.08,
          xHint: [1, 0, 0],
          label: `harness.cable${index}`,
          role: 'insulated-cable',
        }),
      ),
    );

    parts.push(
      terminal([lane.x, 0, -0.28], [0.9, 0.9, 0.56], `harness.connector${index}.lower`),
      terminal([lane.x, 0, -0.64], [1.12, 1.12, 0.12], `harness.flange${index}.lower`),
      terminal([lane.x, 0, 5.88], [0.9, 0.9, 0.56], `harness.connector${index}.upper`),
      terminal([lane.x, 0, 6.24], [1.12, 1.12, 0.12], `harness.flange${index}.upper`),
    );
  }

  return { parts, cablePaths };
}
