import type { Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../../errors';
import { booleanSolids } from '../boolean';
import { box } from '../build';
import { sweep } from '../sweep';
import { transformShape } from '../transform';

const must = <T>(r: Result<T, ModelingError>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const refusal = (r: Result<unknown, ModelingError>): ModelingError => {
  if (r.ok) throw new Error('expected a refusal');
  return r.error;
};
const sq = (h: number) =>
  [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ] as const;
const frame = {
  o: [0, 0, 0],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const;
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;
const stub = () =>
  must(
    sweep({
      profile: sq(0.25),
      path: { kind: 'circle', frame, radius: 4 },
      xHint: [0, 0, 1],
      stations: 17,
      range: [0, Math.PI / 2],
    }),
  );
const plate = () =>
  must(
    transformShape(must(box({ size: [1, 0.3, 0.2] })), {
      rot: I,
      t: [4, 0.35, 0],
    }),
  );

describe('NURBS x plane boolean arm (S2b2)', () => {
  it('the union of the stub with the plate no longer refuses by name (volume gate in nurbs-boolean-union)', () => {
    const r = booleanSolids(stub(), plate(), 'union');
    expect(r.ok ? '' : r.error.expected).not.toBe('nurbs-assembly-pending');
    expect(r.ok ? '' : r.error.expected).not.toContain('cylinder');
  });

  it('the difference of the stub and the plate still refuses by name, not as a cylinder', () => {
    const r = booleanSolids(stub(), plate(), 'difference');
    expect(r.ok).toBe(false);
    const error = refusal(r);
    expect(error.detail?.brep).toBe('brep-ssi-unsupported');
    expect(error.expected).toBe('nurbs-assembly-pending');
    expect(error.expected).not.toContain('cylinder');
  });
});
