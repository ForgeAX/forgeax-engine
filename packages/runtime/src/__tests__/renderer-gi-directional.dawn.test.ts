import { Materials } from '@forgeax/engine-render';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { boxFormFactor, quadratureBox } from './gi-scene-area.fixture';
import { sceneSphere } from './gi-scene-curved.fixture';
import {
  DIRECTIONAL_ALBEDO,
  DIRECTIONAL_SOURCES,
  directionalGi,
  directionalSources,
  ellipsoidReference,
  poseDirectionalReceiver,
} from './gi-scene-directional.fixture';
import { sceneValue } from './gi-scene-value.fixture';
import {
  averageFrames,
  channelMeans,
  percentile,
  type SceneImage,
  sceneHarness,
  visibleSupport,
} from './gi-scenes.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const mesh = await sceneSphere();

function directionalWindowMetrics(
  image: SceneImage,
  reference: SceneImage,
  pixels: number[],
  expected: number[],
) {
  const observed = channelMeans(image, pixels);
  return {
    observed,
    relative: observed.map(
      (value, channel) =>
        Math.abs(value - sceneValue(expected[channel])) / sceneValue(expected[channel]),
    ),
    pixelP95: expected.map((value, channel) =>
      percentile(
        pixels.map(
          (pixel) =>
            Math.abs(
              sceneValue(image.rgb[pixel * 3 + channel]) -
                sceneValue(reference.rgb[pixel * 3 + channel]),
            ) / Math.max(value, 0.005),
        ),
        0.95,
      ),
    ),
    visibleSupport: visibleSupport(image),
  };
}

function expectDirectionalWindow(
  metrics: ReturnType<typeof directionalWindowMetrics>,
  label: string,
): void {
  for (const value of metrics.relative) expect(value, `${label}:channel mean`).toBeLessThan(0.1);
  for (const value of metrics.pixelP95) expect(value, `${label}:pixel P95`).toBeLessThan(0.2);
  expect(metrics.visibleSupport.missing, `${label}:support`).toBe(0);
}
for (const mode of ['field', 'screen'] as const)
  for (const shape of ['sphere', 'ellipsoid'] as const) {
    it(`retains directional red/blue area illumination on a transformed ${shape} ${mode}`, {
      timeout: 600_000,
    }, async () => {
      const h = await sceneHarness(manifest, `directional-${shape}-${mode}`);
      try {
        const handle = testAssets(h.world).create(mesh).unwrap();
        const material = await h.publish(
          Materials.standard({ baseColor: [...DIRECTIONAL_ALBEDO, 1], roughness: 1, specular: 0 }),
        );
        const entity = h.spawn(handle, material, [0, 0, -3]);
        poseDirectionalReceiver(h, entity, shape);
        await directionalSources(h);
        const reference = ellipsoidReference(shape),
          pixels = reference.receivers.map((r) => r.pixel);
        const numericalErrors = reference.receivers.flatMap((r) =>
          DIRECTIONAL_SOURCES.map((s) =>
            Math.abs(boxFormFactor(r.point, r.normal, s) - quadratureBox(r.point, r.normal, s, 64)),
          ),
        );
        h.save('reference.f32', new Uint8Array(reference.rgb.buffer));
        h.save('reference-receivers.json', reference.receivers);
        h.setGi(undefined);
        await h.draw();
        const direct = await h.image('direct');
        h.setGi(directionalGi(mode));
        await h.settle(96);
        if (
          process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native' &&
          process.env.FORGEAX_WGPU_NATIVE_RAY_QUERY === 'on'
        ) {
          const inspection = h.inspection();
          expect(
            'field' in inspection
              ? inspection.field?.traversal
              : 'traversal' in inspection && inspection.traversal,
          ).toBe('ray-query');
        }
        const image = await averageFrames(h, 'gi', 8);
        const truth = { rgb: reference.rgb, width: image.width, height: image.height };
        const expected = channelMeans(truth, pixels),
          observed = channelMeans(image, pixels);
        const relative = observed.map(
          (v, c) => Math.abs(v - sceneValue(expected[c])) / sceneValue(expected[c]),
        );
        const pixelP95 = expected.map((v, c) =>
          percentile(
            pixels.map(
              (p) =>
                Math.abs(sceneValue(image.rgb[p * 3 + c]) - sceneValue(reference.rgb[p * 3 + c])) /
                Math.max(v, 0.005),
            ),
            0.95,
          ),
        );
        h.save('result.json', {
          mode,
          shape,
          scale: reference.scale,
          rotation: reference.rotation,
          sources: DIRECTIONAL_SOURCES,
          albedo: DIRECTIONAL_ALBEDO,
          pixels: pixels.length,
          expected,
          observed,
          relative,
          pixelP95,
          direct: channelMeans(direct, pixels),
          quadratureMaxError: Math.max(...numericalErrors),
          visibleSupport: visibleSupport(image),
          oracle:
            'Analytic ellipsoid primary intersections and inverse-transpose quadric gradients, hemisphere-clipped finite-source polygon integrals independently checked at every ROI point by 64x64 area quadrature. The raster sphere is tessellated; grazing/silhouette pixels are excluded. No Engine GI/math or shader reads enter the reference.',
          tolerance: { channelRelative: 0.1, pixelP95: 0.2 },
        });
        expect(pixels.length).toBeGreaterThan(100);
        expect(Math.max(...numericalErrors)).toBeLessThan(2e-5);
        for (const value of channelMeans(direct, pixels)) expect(value).toBeLessThan(1e-5);
        // Preselected consecutive eight-frame windows expose phase-dependent
        // errors without increasing rays/probe or the eight-frame history cap.
        // Save each window before checking it, including any failing image.
        const windows = [directionalWindowMetrics(image, truth, pixels, expected)];
        for (let window = 1; window < 8; window++) {
          const next = await averageFrames(h, `gi-phase-${window}`, 8);
          windows.push(directionalWindowMetrics(next, truth, pixels, expected));
          h.save('phase-windows.json', {
            framesPerWindow: 8,
            windows,
            tolerance: { channelRelative: 0.1, pixelP95: 0.2 },
          });
        }
        for (const [window, metrics] of windows.entries())
          expectDirectionalWindow(metrics, `${shape}:${mode}:window-${window}`);
        expect(h.errors).toEqual([]);
        if (process.env.FORGEAX_GI_CAPTURE_ACCEPTANCE === '1')
          await h.captureAcceptance(mode === 'screen' ? 'distributionPoint' : undefined);
      } catch (error) {
        await h.recordFailure(error);
        throw error;
      } finally {
        await h.dispose();
      }
    });
  }
