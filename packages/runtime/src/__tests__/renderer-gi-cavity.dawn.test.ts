import { Materials } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { sceneValue } from './gi-scene-value.fixture';
import {
  channelMeans,
  percentile,
  type SceneHarness,
  sceneGi,
  sceneHarness,
  visibleSupport,
} from './gi-scenes.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const emission = [0.08, 0.04, 0.12] as const;
const reflectance = 0.5;

async function closedCavity(h: SceneHarness) {
  const material = await h.publish(
    Materials.standard({
      baseColor: [reflectance, reflectance, reflectance, 1],
      specular: 0,
      roughness: 1,
      emissive: [...emission],
      emissiveIntensity: 1,
    }),
  );
  const walls = [
    { size: [0.25, 4.5, 4.5], position: [-2.125, 0, -4] },
    { size: [0.25, 4.5, 4.5], position: [2.125, 0, -4] },
    { size: [4.5, 0.25, 4.5], position: [0, -2.125, -4] },
    { size: [4.5, 0.25, 4.5], position: [0, 2.125, -4] },
    { size: [4.5, 4.5, 0.25], position: [0, 0, -6.125] },
    { size: [4.5, 4.5, 0.25], position: [0, 0, -1.875] },
  ] as const;
  for (const wall of walls)
    h.spawn(await h.slab(wall.size[0], wall.size[1], wall.size[2]), material, wall.position);
  h.world.set(h.camera, Transform, { pos: [0, 0, -4] }).unwrap();
  return walls;
}

function cavityGi(mode: 'field' | 'screen', radiosity: boolean) {
  const gi = sceneGi(mode, {
    environment: [0, 0, 0],
    radiosity,
    probeSpacing: 0.5,
    raysPerProbe: 128,
    probeBudget: 4096,
  });
  return {
    ...gi,
    field: {
      ...gi.field,
      region: {
        ...gi.field.region,
        maxInstances: 8,
        maxFieldBytes: 4 * 1024 * 1024,
        grid: {
          ...gi.field.region.grid,
          origin: [-3, -3, -7] as const,
          dimensions: [25, 25, 25] as const,
          spacing: 0.25,
        },
      },
    },
  };
}

for (const mode of ['field', 'screen'] as const) {
  it(`converges a closed emissive Lambertian cavity to its geometric series ${mode}`, {
    timeout: 600_000,
  }, async () => {
    const h = await sceneHarness(manifest, `cavity-${mode}`);
    try {
      const walls = await closedCavity(h);
      h.setGi(undefined);
      h.world.update(1 / 60).unwrap();
      propagateTransforms(h.world).unwrap();
      await completeReadyFrame(() => renderValue(h.submit()));
      const direct = await h.image('direct');
      expect(direct.covered?.every((value) => value === 1)).toBe(true);
      h.setGi(cavityGi(mode, false));
      await h.settle(64);
      const singleBounce = await h.image('single-bounce');
      h.setGi(cavityGi(mode, true));
      await h.settle(0);
      const timeline = [];
      for (let frame = 0; frame <= 128; frame++) {
        if ([0, 1, 2, 4, 8, 16, 32, 64, 96, 128].includes(frame)) {
          const image = await h.image(`radiosity-${frame}`);
          timeline.push({
            frame: frame + 1,
            mean: channelMeans(image, [...sceneValue(image.covered).keys()]),
          });
        } else await h.draw();
      }
      const final = await h.image('multi-bounce');
      const pixels = [...sceneValue(final.covered).keys()];
      const expected = emission.map((value) => value / (1 - reflectance));
      const observed = channelMeans(final, pixels);
      const relative = observed.map(
        (value, c) => Math.abs(value - sceneValue(expected[c])) / sceneValue(expected[c]),
      );
      const pixelP95 = expected.map((value, c) =>
        percentile(
          pixels.map((p) => Math.abs(sceneValue(final.rgb[p * 3 + c]) - value) / value),
          0.95,
        ),
      );
      h.save('result.json', {
        mode,
        walls,
        emission,
        reflectance,
        environment: [0, 0, 0],
        direct: channelMeans(direct, pixels),
        singleBounce: channelMeans(singleBounce, pixels),
        expectedSingleBounce: emission.map((value) => value * (1 + reflectance)),
        observed,
        expected,
        relative,
        pixelP95,
        timeline,
        visibleSupport: visibleSupport(final),
        oracle:
          'Every ray remains in a closed six-wall cavity with identical Lambertian rho and emission Le. L=Le+rho*L, hence Le/(1-rho); no SDF, Cards, probes or engine shader reads enter the oracle.',
        tolerance: { relativeMean: 0.05, pixelP95: 0.08 },
      });
      for (const [channel, value] of channelMeans(direct, pixels).entries())
        expect(
          Math.abs(value - sceneValue(emission[channel])) / sceneValue(emission[channel]),
        ).toBeLessThan(0.005);
      for (const [channel, value] of channelMeans(singleBounce, pixels).entries()) {
        const expectedSingle = sceneValue(emission[channel]) * (1 + reflectance);
        expect(Math.abs(value - expectedSingle) / expectedSingle).toBeLessThan(0.02);
      }
      for (const value of relative) expect(value).toBeLessThan(0.05);
      for (const value of pixelP95) expect(value).toBeLessThan(0.08);
      expect(visibleSupport(final).missing).toBe(0);
      expect(h.errors).toEqual([]);
    } catch (error) {
      await h.recordFailure(error);
      throw error;
    } finally {
      await h.dispose();
    }
  });
}
