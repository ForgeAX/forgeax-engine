import { nurbsCube, nurbsTube, obliqueCylinder } from '../../__tests__/trim-support';
import { box, cone, cylinder, extrude, revolve, sphere, torus } from '../../build';
import type { Shape } from '../../types';
import type { P3 } from '../../vec';
import { rng } from './oracle';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

export interface Specimen {
  readonly name: string;
  readonly shape: Shape;
}

/** Closed solids covering every analytic surface kind, trimmed and holed faces, and NURBS faces. */
export function specimens(): Specimen[] {
  return [
    { name: 'box', shape: must(box({ size: [2, 3, 4] })) },
    { name: 'cylinder', shape: must(cylinder({ radius: 1.5, height: 3 })) },
    { name: 'cone', shape: must(cone({ radius: 2, height: 3 })) },
    { name: 'sphere', shape: must(sphere({ radius: 1.2 })) },
    { name: 'torus', shape: must(torus({ major: 3, minor: 1 })) },
    {
      name: 'extrude-holed',
      shape: must(
        extrude({
          profile: [
            [0, 0],
            [4, 0],
            [4, 3],
            [0, 3],
          ],
          holes: [
            [
              [1, 1],
              [2, 1],
              [2, 2],
              [1, 2],
            ],
          ],
          depth: 2,
        }),
      ),
    },
    {
      name: 'revolve',
      shape: must(
        revolve({
          profile: [
            [0, 0],
            [2, 0],
            [2, 1],
            [1, 2],
            [0, 2],
          ],
        }),
      ),
    },
    { name: 'oblique-cylinder', shape: obliqueCylinder(2, 0.6) },
    { name: 'nurbs-cube', shape: nurbsCube(2) },
    { name: 'nurbs-tube', shape: nurbsTube(3) },
  ];
}

/** Probe points scattered through and around the bounding box of the shape's vertices. */
export function probes(shape: Shape, count: number, seed: number): P3[] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of shape.vertices)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i] as number, v.p[i] as number);
      hi[i] = Math.max(hi[i] as number, v.p[i] as number);
    }
  const next = rng(seed);
  const out: P3[] = [];
  for (let k = 0; k < count; k++) {
    const q = [0, 1, 2].map((i) => {
      const span = (hi[i] as number) - (lo[i] as number) || 1;
      return (lo[i] as number) - 0.6 * span + next() * 2.2 * span;
    });
    out.push([q[0] as number, q[1] as number, q[2] as number]);
  }
  return out;
}
