import type { Result } from '@forgeax/engine-types';
import { sweep } from '../../src/brep/sweep';
import type { Shape } from '../../src/brep/types';
import type { P2, P3 } from '../../src/brep/vec';
import { cos, sin } from '../../src/dmath';
import type { ModelingError } from '../../src/errors';
import { interpolate } from '../../src/nurbs';

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

function helixPoints(radius: number, pitch: number, turns: number, perTurn: number): P3[] {
  const n = Math.round(turns * perTurn);
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (TAU * i) / perTurn;
    return [radius * cos(a), radius * sin(a), (pitch * i) / perTurn] as P3;
  });
}

/** A hollow helical spring tube, an S-bend square rail and a twisted ribbon on one plate. */
export function buildSweepShowcase(): readonly Shape[] {
  const helix = must(interpolate(helixPoints(2, 1.1, 2, 12).map((p) => [...p]), { degree: 3 }));
  const spring = must(
    sweep({
      profile: ring(0.32, 12),
      holes: [ring(0.16, 12)],
      path: { kind: 'nurbs', curve: helix },
      stations: 49,
      fitTolerance: 0.1,
      label: 'showcase.spring',
      role: 'hollow-spring',
    }),
  );
  const sBend = must(
    interpolate(
      [
        [5, -2, 0],
        [5, -1, 0.5],
        [5.9, 0, 1.4],
        [6.9, 1, 2.2],
        [7.2, 2, 3.4],
        [6.4, 2.6, 4.4],
        [5, 2.8, 5],
      ],
      { degree: 3 },
    ),
  );
  const rail = must(
    sweep({
      profile: [
        [-0.3, -0.3],
        [0.3, -0.3],
        [0.3, 0.3],
        [-0.3, 0.3],
      ],
      path: { kind: 'nurbs', curve: sBend },
      stations: 33,
      fitTolerance: 0.1,
      label: 'showcase.s-rail',
      role: 'rail',
    }),
  );
  const ribbonPath = must(
    interpolate(
      [
        [-5, -2, 0],
        [-5, -1, 1],
        [-5, 0, 2],
        [-5, 1, 3],
        [-5, 2, 4],
        [-5, 2.5, 5],
      ],
      { degree: 3 },
    ),
  );
  const ribbon = must(
    sweep({
      profile: [
        [-0.55, -0.1],
        [0.55, -0.1],
        [0.55, 0.1],
        [-0.55, 0.1],
      ],
      path: { kind: 'nurbs', curve: ribbonPath },
      twist: Math.PI,
      stations: 33,
      fitTolerance: 0.1,
      label: 'showcase.twist-ribbon',
      role: 'ribbon',
    }),
  );
  return [spring, rail, ribbon];
}
