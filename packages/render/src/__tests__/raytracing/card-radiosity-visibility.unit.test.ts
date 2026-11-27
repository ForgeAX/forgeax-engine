import { expect, it } from 'vitest';
import { executable } from '../../../../shader/src/__tests__/sdf-surface-root.fixture';
import { CARD_RADIOSITY_VISIBILITY_WGSL } from '../../raytracing/card-radiosity-kernels';
import { cardVisibilityCases } from './card-radiosity-visibility.fixture';

const known = executable<boolean>(
  CARD_RADIOSITY_VISIBILITY_WGSL,
  'cardProbeTransportKnown',
  'tag',
  {},
);
const tag = executable<number>(
  CARD_RADIOSITY_VISIBILITY_WGSL,
  'cardProbeTransportTag',
  'status,available',
  {},
);
const weight = executable<{ weight: number; available: number }>(
  CARD_RADIOSITY_VISIBILITY_WGSL,
  'cardProbeVisibilityWeight',
  'distance,hitDistance,tag,strength',
  {
    cardRadiosityFinite: Number.isFinite,
    cardProbeTransportKnown: known,
    CardProbeVisibility: (weight: number, available: number) => ({ weight, available }),
    clamp: (value: number, low: number, high: number) => Math.max(low, Math.min(value, high)),
  },
);

it('executes the production relative-distance weight with known black, unknown and the fixed .5 policy', () => {
  for (const row of cardVisibilityCases) {
    if (row.stratified) continue; // Actual forward/inverse bin selection is the GPU gate.
    const delta = row.target.map((value, axis) => value - (row.origin[axis] ?? NaN));
    const observed = weight(
      Math.hypot(...delta),
      row.distance,
      row.tag ?? tag(row.status, row.available),
      row.strength,
    );
    expect(observed.weight, row.name).toBeCloseTo(row.expected, 7);
    expect(observed.available, row.name).toBe(row.expectedAvailable ?? 1);
  }
  expect(weight(1, 0.25, 1, 0.5).available).toBe(0);
  expect(weight(1, NaN, 2, 0.5).available).toBe(0);
  expect(weight(Infinity, 1, 2, 0.5).available).toBe(0);
});

it('exposes the original plane-only leak without treating the soft or discretized estimator as exact visibility', () => {
  const old = (0 + 1) / 2;
  const occluded = weight(1, 0.25, 2, 0.5).weight;
  expect(old).toBe(0.5);
  expect((0 + occluded) / (1 + occluded)).toBe(0);
  const near = cardVisibilityCases.find((row) => row.physicalVisibility === 0);
  const offRay = cardVisibilityCases.find((row) => row.physicalVisibility === 1);
  if (!near || !offRay) throw Error('Required approximation limits absent');
  expect(weight(1, near.distance, 2, 0.5).weight).toBe(0.5);
  expect(weight(1, offRay.distance, 2, 0.5).weight).toBe(0);
  expect(near.physicalVisibility).toBe(0);
  expect(offRay.physicalVisibility).toBe(1);
});
