import {
  nurbsSegment,
  type ProfileSegment,
  revolveProfile,
} from '../../src/brep/revolve-profile.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { P2 } from '../../src/brep/vec.ts';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function free(points: readonly P2[]): ProfileSegment {
  return must(nurbsSegment(points, { degree: 3 })) as ProfileSegment;
}

/** Vase: the unit-test profile, a solid of revolution from the axis base to the axis mouth. */
export function vaseShape(): Shape {
  return must(
    revolveProfile({
      start: [0, 0],
      segments: [
        { kind: 'line', to: [0.4, 0] },
        free([
          [0.4, 0],
          [0.7, 0.6],
          [0.7, 1.2],
          [0.7, 1.8],
          [0.5, 2.4],
        ]),
        { kind: 'line', to: [0, 2.4] },
      ],
    }),
  );
}

/**
 * Bell: a closed off-axis section. Outer wall flares at the lip, rounds through the shoulder and
 * closes at the crown. The crown keeps a hole of radius 0.1 where a real bell carries its canon, since
 * a closed loop must keep every radius positive. The inner wall is hand-offset about 0.1 inside.
 */
export function bellShape(): Shape {
  return must(
    revolveProfile({
      start: [0.95, 0],
      segments: [
        free([
          [0.95, 0],
          [0.78, 0.25],
          [0.6, 0.8],
          [0.5, 1.3],
          [0.4, 1.8],
          [0.28, 2.12],
          [0.18, 2.22],
        ]),
        { kind: 'line', to: [0.1, 2.22] },
        free([
          [0.1, 2.22],
          [0.18, 2.12],
          [0.3, 1.8],
          [0.4, 1.3],
          [0.5, 0.8],
          [0.69, 0.25],
          [0.85, 0],
        ]),
        { kind: 'line', to: [0.95, 0] },
      ],
    }),
  );
}

/**
 * Pot: a solid of revolution mixing an arc (rounded base corner), a free-form wall, a short mixing
 * line at the shoulder and a lid seat, a recess at the top inside a raised rim.
 */
export function potShape(): Shape {
  return must(
    revolveProfile({
      start: [0, 0],
      segments: [
        { kind: 'line', to: [0.5, 0] },
        { kind: 'arc', to: [0.7, 0.2], center: [0.5, 0.2] },
        free([
          [0.7, 0.2],
          [0.77, 0.7],
          [0.8, 1.6],
        ]),
        { kind: 'line', to: [0.84, 1.9] },
        { kind: 'line', to: [0.84, 2.0] },
        { kind: 'line', to: [0.66, 2.0] },
        { kind: 'line', to: [0.66, 1.85] },
        { kind: 'line', to: [0, 1.85] },
      ],
    }),
  );
}
