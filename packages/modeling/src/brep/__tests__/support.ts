import type { ModelingError } from '../../errors';
import type { EditMesh } from '../../mesh';
import { box, cone, cylinder, extrude, revolve, sphere, torus } from '../build';
import type { Shape } from '../types';

export interface Primitive {
  readonly name: string;
  readonly shape: Shape;
  readonly area: number;
  readonly volume: number;
  readonly euler: number;
  readonly genus: number;
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: ModelingError }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const PI = Math.PI;
const SQ = Math.sqrt;

/** Primitives with closed-form area, volume and topology, each derived by hand from its definition. */
export function primitives(): Primitive[] {
  return [
    {
      name: 'box',
      shape: must(box({ size: [2, 3, 4] })),
      area: 2 * (2 * 3 + 2 * 4 + 3 * 4),
      volume: 24,
      euler: 2,
      genus: 0,
    },
    {
      name: 'cylinder',
      shape: must(cylinder({ radius: 1.5, height: 3 })),
      area: 2 * PI * 1.5 * 3 + 2 * PI * 2.25,
      volume: PI * 2.25 * 3,
      euler: 2,
      genus: 0,
    },
    {
      name: 'cone',
      shape: must(cone({ radius: 2, height: 3 })),
      area: 2 * PI * SQ(13) + 4 * PI,
      volume: (PI * 4 * 3) / 3,
      euler: 2,
      genus: 0,
    },
    {
      name: 'sphere',
      shape: must(sphere({ radius: 2 })),
      area: 16 * PI,
      volume: (32 * PI) / 3,
      euler: 2,
      genus: 0,
    },
    {
      name: 'torus',
      shape: must(torus({ major: 3, minor: 1 })),
      area: 4 * PI * PI * 3,
      volume: 2 * PI * PI * 3,
      euler: 0,
      genus: 1,
    },
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
      area: 2 * 11 + (14 + 4) * 2,
      volume: 22,
      euler: 0,
      genus: 1,
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
      area: 4 * PI + 4 * PI + 3 * SQ(2) * PI + PI,
      volume: 4 * PI + (7 * PI) / 3,
      euler: 2,
      genus: 0,
    },
  ];
}

export function boundaryEdges(mesh: EditMesh): number {
  let n = 0;
  for (const e of mesh.edges()) if (mesh.hFace[e * 2] === -1 || mesh.hFace[e * 2 + 1] === -1) n++;
  return n;
}

export function meshEuler(mesh: EditMesh): number {
  return mesh.vertexCount - mesh.edgeCount + mesh.faceCount;
}
