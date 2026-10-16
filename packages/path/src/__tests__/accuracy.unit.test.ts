import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
// @ts-expect-error Independent JS numerical oracle deliberately lives outside runtime source.
import { arcOracle } from '../../bench/oracle.mjs';
import { preparePath } from '../index';
import { definition } from './fixture';

it.each([
  0, 1, 2,
])('keeps closed uneven curves below 0.5 percent speed error for parameterization %s', (parameterization) => {
  const source = {
    ...definition([0, 0, 0, 0.2, 4, 0, 1, 4.2, 2, 7, 1, -1, 8, 0, 0]),
    closed: true,
    parameterization,
  };
  const reference = arcOracle(source);
  const prepared = preparePath(source, mat4.identity(mat4.create())).unwrap();
  const step = prepared.length / 240;
  let previous = 0,
    worst = 0,
    wrongPrevious = 0,
    wrongWorst = 0;
  for (let i = 1; i <= 240; i++) {
    const actual = reference.distance(prepared.parameterAtDistance(step * i));
    worst = Math.max(worst, Math.abs(actual - previous - step) / step);
    previous = actual;
    const wrong = reference.distance(i / 240);
    wrongWorst = Math.max(wrongWorst, Math.abs(wrong - wrongPrevious - step) / step);
    wrongPrevious = wrong;
  }
  expect(worst).toBeLessThanOrEqual(0.005);
  expect(wrongWorst).toBeGreaterThan(0.2);
});
