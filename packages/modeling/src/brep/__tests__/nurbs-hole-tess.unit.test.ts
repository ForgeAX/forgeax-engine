import type { Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../../errors';
import { meshVolume } from '../../geom';
import { booleanSolids } from '../boolean';
import { cylinder } from '../build';
import { measure } from '../measure';
import { sweep } from '../sweep';
import { tessellate } from '../tessellate';
import { transformShape } from '../transform';

const must = <T>(r: Result<T, ModelingError>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;
const sq = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [0.25, 0.25],
  [-0.25, 0.25],
] as const;

describe('NURBS wall with a cylinder hole tessellates', () => {
  it('meshes the rod-through-walls union with a closed, volume-correct mesh', () => {
    const stub = must(
      sweep({
        profile: sq,
        path: {
          kind: 'circle',
          frame: {
            o: [0, 0, 0],
            x: [1, 0, 0],
            y: [0, 1, 0],
            z: [0, 0, 1],
          },
          radius: 4,
        },
        xHint: [0, 0, 1],
        stations: 17,
        range: [0, Math.PI / 2],
      }),
    );
    const rod = must(
      transformShape(must(cylinder({ radius: 0.12, height: 1 })), {
        rot: I,
        t: [3.2, 2.4, 0],
      }),
    );
    const union = must(booleanSolids(stub, rod, 'union'));
    const exact = must(measure(union)).volume;

    const m = tessellate(union, { chord: 0.05 });
    expect(m.ok, m.ok ? '' : JSON.stringify(m.error)).toBe(true);
    if (!m.ok) return;
    const open = m.value.edges().filter((e) => m.value.isBoundaryEdge(e));
    expect(open).toHaveLength(0);
    expect(Math.abs(meshVolume(m.value) - exact) / exact).toBeLessThan(0.01);
  });
});
