import { expect, it } from 'vitest';
import { EXECUTION_WORKERS } from '../index';

it('advertises independent worker policies', () => {
  expect(EXECUTION_WORKERS).toEqual(['engine', 'render', 'kernels']);
});
