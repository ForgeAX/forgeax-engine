import { mkdirSync, writeFileSync } from 'node:fs';
import type { StandardDiffuseGi } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());

it('rebuilds and consumes the Renderer depth pyramid across captured screen-probe frames', {
  timeout: 600_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      resolveSurfaceDevice: (device) =>
        ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  const directory = 'artifacts/screen-probe-barriers/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    const field = irradianceFieldGi({ resolution: 'half' });
    if (field.gather !== 'irradiance-field') throw new Error('expected irradiance field');
    const gi: StandardDiffuseGi = {
      gather: 'screen-probe',
      maxDistance: field.maxDistance,
      environment: field.environment,
      field: field.field,
      probes: {
        downsample: 8,
        adaptiveFraction: 0.5,
        importance: 'brdf',
        screenTrace: { maxSteps: 32, thickness: 0.02 },
        filterPasses: 2,
        shortRangeAo: 0,
        maxFrames: 10,
      },
    };
    h.setGi(gi);
    h.spawn(h.emitterMesh, h.emissive, [0, 0, 1]);
    await h.settle(16);
    const images = [];
    for (let frame = 0; frame < 3; frame++) {
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const image = await h.image();
      (await recorder.frameBoundary()).unwrap();
      const encoded = (await pending).unwrap();
      writeFileSync(`${directory}/frame-${frame}.rhitape`, encoded.bytes);
      const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
      images.push({ center: image.center, digest: encoded.digest, works: model.works.length });
      expect(image.center).toBeGreaterThan(0.05);
    }
    writeFileSync(
      `${directory}/result.json`,
      JSON.stringify({ images, inspection: h.renderer.inspect(), errors: h.errors }, null, 2),
    );
    expect(h.errors).toEqual([]);
  } finally {
    await h.dispose();
  }
});
