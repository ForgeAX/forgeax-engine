import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { ok, type WaterSimulationRecipeAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { AssetRegistry } from '../../../assets-runtime/src/asset-registry';
import { createCatalogSource } from '../../../assets-runtime/src/catalog-source';
import { waterSimulationRecipeContribution } from '../asset-decoder';

const guid = '019ffa97-7000-7000-8000-000000000011';
const recipe: WaterSimulationRecipeAsset = {
  kind: 'water-simulation-recipe',
  system: 'water-advanced',
  configurationVersion: 1,
  enabledFeatures: ['oceanPatch'],
  materialGuids: [],
  textureGuids: [],
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
  },
};

it('prepares dispersive recipes without inventing an FFT noise texture dependency', () => {
  const reference = vi.fn(() => ok(1));
  const result = waterSimulationRecipeContribution.decoder.prepare?.(recipe, {
    reference,
  } as never);
  expect(result).toMatchObject({ ok: true });
  expect(reference).not.toHaveBeenCalled();
});

it('retains the UE FFT recipe noise texture dependency', () => {
  const noise = '019ffa97-7000-7000-8000-000000000013';
  const fft: WaterSimulationRecipeAsset = {
    ...recipe,
    textureGuids: [noise],
    oceanPatchConfig: {
      algorithm: 'ue-5.8.1-niagara-fft',
      windAngleDegrees: 180,
      windSpeedMPerSec: 0.55,
      noiseTextureGuid: noise,
      fftResolution: 128,
      domainLengthM: 2.5,
      normalDomainSizeM: 1.5,
      gravityMPerSec2: 9.8,
      phillipsAmplitude: 0.0003,
      windAlignment: 0,
      timeScale: 2.5,
      slosh: 1,
      chopHack: 5,
      twiddle: 'positive',
      normalization: 'none',
      normalRtFormat: 'rgba16float',
      gridMesh: null,
    },
  };
  const reference = vi.fn(() => ok(1));
  expect(
    waterSimulationRecipeContribution.decoder.prepare?.(fft, { reference } as never),
  ).toMatchObject({ ok: true });
  expect(reference).toHaveBeenCalledTimes(2);
  expect(reference).toHaveBeenNthCalledWith(1, noise, 'texture');
  expect(reference).toHaveBeenNthCalledWith(2, noise, 'texture');
});

it('loads and republishes a dependency-free dispersive recipe through a fresh real asset registry', async () => {
  const packageUrl = 'https://water.invalid/local.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath: 'local-water.pack',
    sourceRevision: 'cold-1',
    packageUrl,
    pack: {
      assets: [{ guid, kind: 'water-simulation-recipe', refs: [], artifacts: {}, payload: recipe }],
    },
  });
  for (let cold = 0; cold < 2; cold++) {
    const assets = new AssetRegistry();
    assets.installDecoder(
      waterSimulationRecipeContribution.kind,
      waterSimulationRecipeContribution.decoder,
    );
    assets.setCatalogSource(
      createCatalogSource({
        entries: [
          {
            guid,
            kind: 'water-simulation-recipe',
            packageUrl,
            sourcePath: 'local-water.pack',
            publication: publication.publication,
          },
        ],
        fetch: async () => new Response(JSON.stringify(publication.pack)),
      }),
    );
    try {
      const loaded = await assets.load(guid, waterSimulationRecipeContribution.kind);
      expect(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.error)).toBe(true);
      const handle = loaded.unwrap();
      expect(assets.read(handle).unwrap()).toEqual(recipe);
      expect(assets.create(recipe).ok).toBe(true);
      expect(assets.source(handle).unwrap()?.publication?.sourceRevision).toBe('cold-1');
      assets.release(handle);
    } finally {
      assets.dispose();
    }
  }
});
