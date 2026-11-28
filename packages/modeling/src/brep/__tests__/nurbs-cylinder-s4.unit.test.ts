import type { Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../../errors';
import { booleanSolids } from '../boolean';
import { cylinder } from '../build';
import { measure } from '../measure';
import { closedHoleLoops } from '../nurbs-chain';
import { joinBranches } from '../query/stitch';
import { sweep } from '../sweep';
import { transformShape } from '../transform';
import { validate } from '../validate';

const must = <T>(r: Result<T, ModelingError>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const refusal = (r: Result<unknown, ModelingError>): ModelingError => {
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
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
const stub = () =>
  must(
    sweep({
      profile: sq,
      path: {
        kind: 'circle',
        frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        radius: 4,
      },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
const rod = (t: [number, number, number]) =>
  must(transformShape(must(cylinder({ radius: 0.12, height: 1 })), { rot: I, t }));

describe('NURBS x cylinder (S4)', () => {
  it('a cylinder missing the stub is admitted without a section', () => {
    const r = booleanSolids(stub(), rod([-3, -3, 0]), 'union');
    expect(r.ok ? '' : r.error.expected).not.toBe('a plane or cylinder faces');
  });

  it('unions a transverse rod through two NURBS walls with a valid shell and analytic volume', () => {
    const a = stub();
    const b = rod([3.2, 2.4, 0]);
    const r = booleanSolids(a, b, 'union');
    expect(r.ok).toBe(true);
    const union = must(r);
    expect(validate(union).ok).toBe(true);
    const va = must(measure(a)).volume;
    const vb = must(measure(b)).volume;
    const v = must(measure(union)).volume;
    expect(v).toBeGreaterThanOrEqual(Math.max(va, vb));
    expect(v).toBeLessThanOrEqual(va + vb);
    expect(v).toBeCloseTo(Math.PI / 2 + 0.02262, 3);
  });

  it('refuses a gap-over-tol chain and a measured partial by name', () => {
    const chains = joinBranches(
      [
        {
          closed: false,
          ends: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
        {
          closed: false,
          ends: [
            [1.5, 0, 0],
            [2, 0, 0],
          ],
        },
      ],
      1e-6,
    );
    const g = closedHoleLoops(chains, undefined);
    expect(g.ok).toBe(false);
    expect(refusal(g).detail).toMatchObject({
      brep: 'brep-ssi-unsupported',
      reason: 'gap-over-tol',
    });
    const p = closedHoleLoops([], 'brep-ssi-tangent');
    expect(refusal(p).detail).toMatchObject({ reason: 'partial:brep-ssi-tangent' });
  });

  it('accepts closed loops', () => {
    const chains = joinBranches(
      [
        {
          closed: true,
          ends: [
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
      ],
      1e-6,
    );
    const r = closedHoleLoops(chains, undefined);
    expect(r.ok).toBe(true);
    expect(must(r)).toEqual([0]);
  });
});
