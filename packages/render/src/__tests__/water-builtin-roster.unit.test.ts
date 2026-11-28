import { expect, it } from 'vitest';
import { withBuiltinRenderFeatures } from '../features/builtins';
import { createWaterInfoFeature, WATER_INFO_FEATURE_IDENTITY } from '../water/water-info-feature';

it('constructs the complete Water roster at the shared source and renderer owner', () => {
  const info = createWaterInfoFeature();
  const requested = [info];
  const roster = withBuiltinRenderFeatures(requested);
  const identities = roster.map((feature) => feature.identity);
  expect(identities).toEqual(
    expect.arrayContaining([
      WATER_INFO_FEATURE_IDENTITY,
      'water-gpu-mesh',
      'water-advanced-producer',
      'water-fluid-simulation',
      'water-underwater-post-process',
      'forgeax.editor-assistance',
    ]),
  );
  expect(new Set(identities).size).toBe(identities.length);
  expect(roster.find((feature) => feature.identity === WATER_INFO_FEATURE_IDENTITY)).toBe(info);
  expect(requested).toEqual([info]);
  expect(identities.indexOf('water-gpu-mesh')).toBeGreaterThan(
    identities.indexOf(WATER_INFO_FEATURE_IDENTITY),
  );
  expect(identities.indexOf('water-advanced-producer')).toBeGreaterThan(
    identities.indexOf(WATER_INFO_FEATURE_IDENTITY),
  );
});
