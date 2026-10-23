import { expect, it } from 'vitest';
import { pipelineWarmupConcurrency } from '../pipeline-library';

it('keeps half of the logical processors busy with native warmup, within 4..16', () => {
  expect(pipelineWarmupConcurrency(undefined)).toBe(4);
  expect(pipelineWarmupConcurrency(Number.NaN)).toBe(4);
  expect(pipelineWarmupConcurrency(2)).toBe(4);
  expect(pipelineWarmupConcurrency(8)).toBe(4);
  expect(pipelineWarmupConcurrency(12)).toBe(6);
  expect(pipelineWarmupConcurrency(32)).toBe(16);
  expect(pipelineWarmupConcurrency(128)).toBe(16);
});
