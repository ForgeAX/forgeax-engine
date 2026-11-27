import type { Asset, AssetRef } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { validateAssetReferences } from '../prepare-payload.js';

const recipeGuid = '019ffa97-7000-7000-8000-000000000011';
const noiseGuid = '019ffa97-7000-7000-8000-000000000012';
const recipe = {
  kind: 'water-simulation-recipe',
  system: 'water-advanced',
  configurationVersion: 2,
  enabledFeatures: ['oceanPatch'],
  materialGuids: [],
  textureGuids: [noiseGuid],
  oceanPatchConfig: {
    algorithm: 'mode-projected-gravity/1',
    fftResolution: 32,
    domainLengthM: 16,
    centerXZ: [0, 0],
    baseHeightM: 0,
    referenceDepthM: 4,
    gravityMPerSec2: 9.81,
    sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
    collisions: {
      kind: 'simple',
      collisionGroups: 0xffffffff,
      maxElements: 10,
      fieldStepM: 0.1,
      maximumFieldSamplesPerColumn: 128,
    },
    maximumIntervalSeconds: 0.2,
    boundary: { kind: 'periodic' },
    foam: { slopeThreshold: 0.1, emissionPerSecond: 1, decayPerSecond: 0.1 },
    normalRtFormat: 'rgba32float',
    gridMesh: null,
    visualNormalDetailFft: {
      noiseTextureGuid: noiseGuid,
      fftResolution: 64,
      domainLengthM: 64,
      normalDomainSizeM: 32,
      gravityMPerSec2: 9.81,
      phillipsAmplitude: 1,
      windAngleDegrees: 45,
      windSpeedMPerSec: 12,
      windAlignment: 4.5,
      timeScale: 1,
      slosh: 0.5,
      normalRtFormat: 'rgba32float',
    },
  },
} as unknown as Asset;

it('resolves the visual child noise through the ordinary recipe texture closure', () => {
  const references: readonly AssetRef[] = [{ guid: noiseGuid }];
  expect(
    validateAssetReferences(recipe, recipeGuid, references, (guid) =>
      guid === noiseGuid ? 'texture' : undefined,
    ),
  ).toBeUndefined();
});

it('rejects a missing or wrong-kind ordinary texture edge for the visual child', () => {
  expect(
    validateAssetReferences(recipe, recipeGuid, [], (guid) =>
      guid === noiseGuid ? 'texture' : undefined,
    ),
  ).toMatchObject({
    code: 'asset-parse-failed',
    detail: { dependencyGuid: noiseGuid, actualKind: 'missing-ref-edge' },
  });
  expect(
    validateAssetReferences(recipe, recipeGuid, [{ guid: noiseGuid }], () => 'material'),
  ).toMatchObject({
    code: 'asset-parse-failed',
    detail: { dependencyGuid: noiseGuid, expectedKind: 'texture', actualKind: 'material' },
  });
});

it('accepts both sampled texture kinds for the fluid impulse and requires its own reference edge', () => {
  const fluid = {
    kind: 'water-simulation-recipe',
    system: 'fluid-simulation',
    materialGuids: [],
    textureGuids: [],
    impulseNoiseGuid: noiseGuid,
  } as unknown as Asset;
  const references = [{ guid: noiseGuid }];
  for (const kind of ['texture', 'gpu-texture'])
    expect(validateAssetReferences(fluid, recipeGuid, references, () => kind)).toBeUndefined();
  expect(validateAssetReferences(fluid, recipeGuid, [], () => 'gpu-texture')).toMatchObject({
    code: 'asset-parse-failed',
    detail: { dependencyGuid: noiseGuid, actualKind: 'missing-ref-edge' },
  });
  expect(
    validateAssetReferences(fluid, recipeGuid, references, () => 'texture-generator'),
  ).toMatchObject({
    code: 'asset-parse-failed',
    detail: { dependencyGuid: noiseGuid, actualKind: 'texture-generator' },
  });
});
