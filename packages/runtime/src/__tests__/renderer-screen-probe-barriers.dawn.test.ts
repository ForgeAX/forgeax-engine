import { mkdirSync, writeFileSync } from 'node:fs';
import type { StandardDiffuseGi } from '@forgeax/engine-render';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('rebuilds and consumes the Renderer depth pyramid across captured screen-probe frames', {
  timeout: 600_000,
  // The complete Renderer exceeds the software adapter limit before the first capture.
  skip: process.env.FORGEAX_CI_CORE_VALIDATION === '1',
}, async () => {
  const manifest = shaderManifestUrl(await buildEngineShaderTemplateManifest());
  const recorder = attachRecorder(webgpu).unwrap();
  const h = await createIrradianceFieldHarness({
    rhi: recorder.backend.rhi,
    manifest,
    instrumentation: {
      resolveSurfaceDevice: (
        device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
      ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
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
      const history = model.works.filter((work) =>
        work.pipeline?.shaders.some((shader) => shader.entryPoint === 'copyDiffuseSceneHistory'),
      );
      const composite = model.works.filter((work) =>
        work.pipeline?.shaders.some(
          (shader) => shader.entryPoint === 'fs_ray_diffuse_reconstructed_replace',
        ),
      );
      // The default fixture explicitly enables radiosity. Its positive GPU
      // control must retain post-GI feedback, rather than dimming every mode.
      expect(history).toHaveLength(1);
      expect(composite).toHaveLength(1);
      const historyWork = history[0];
      const compositeWork = composite[0];
      if (historyWork === undefined || compositeWork === undefined)
        throw new Error('The actual frame must contain both history and diffuse composite');
      expect(historyWork.workIndex).toBeGreaterThan(compositeWork.workIndex);
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
