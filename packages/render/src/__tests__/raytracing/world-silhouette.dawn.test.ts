import { expect, it } from 'vitest';
import { runWorldSilhouetteCases } from './world-silhouette.fixture';

it('keeps nearest authored geometry through a rotated silhouette and its empty AABB corners', async () => {
  const result = await runWorldSilhouetteCases();
  expect(result.errors).toEqual([]);
  expect(result.cases).toHaveLength(3072);
  expect(result.aabbNegativeControlCaught).toBeGreaterThan(0);
  expect(
    result.surfaceFailures,
    'Every resolved World hit must identify an exact nearest primitive and its facing/normal',
  ).toBe(0);
  expect(
    result.worldFailures,
    'World must not treat near AABB occupancy as a nearer authored surface',
  ).toBe(0);
});

it('rejects a real wrong-facing producer even when its original distance gate is unchanged', async () => {
  const result = await runWorldSilhouetteCases(true);
  expect(result.errors).toEqual([]);
  expect(result.cases).toHaveLength(3072);
  expect(result.flipFacing).toBe(true);
  expect(result.resolved).toBeGreaterThan(0);
  expect(result.surfaceFailures).toBe(result.resolved);
  expect(result.cases.filter((row) => row.state[0] === 1).every((row) => row.worldCorrect)).toBe(
    true,
  );
});
