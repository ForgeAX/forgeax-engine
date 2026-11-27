import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  createIrradianceFieldHarness,
  irradianceFieldGi,
} from './renderer-irradiance-field.fixture';
import { shaderPublicationUrl } from './shader-manifest-url.fixture';

it('composites indirect light on a cooked scalar-specular Default GBuffer material', async () => {
  const began = performance.now();
  const mark = (stage: string) => {
    if (process.env.CI)
      console.error(
        '[default-gbuffer-gi]',
        JSON.stringify({ stage, elapsedMs: performance.now() - began }),
      );
  };
  const manifest = shaderPublicationUrl(
    await buildEngineShaderTemplateManifest({ hdrpSsao: false }),
  );
  mark('shader-manifest-ready');
  const harness = await createIrradianceFieldHarness({
    rhi,
    manifest,
    host: {
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: 'deferred',
        gbufferFormat: 'default',
      },
    },
  });
  mark('renderer-ready');
  try {
    harness.setGi(undefined);
    for (let frame = 0; frame < 4; frame++) await harness.draw();
    const dark = await harness.image();
    mark('direct-only-image');
    harness.setGi(irradianceFieldGi());
    harness.spawn(harness.emitterMesh, harness.emissive, [0, 0, 1]);
    mark('irradiance-field-start');
    await harness.settle(32);
    mark('irradiance-field-settled');
    const lit = await harness.image();
    expect(lit.center - dark.center).toBeGreaterThan(0.05);
    expect(harness.renderer.inspect().perFramePassNames).toEqual(
      expect.arrayContaining(['ray-receiver-normal', 'irradiance-field.gather']),
    );
    expect(harness.errors).toEqual([]);
  } finally {
    await harness.dispose();
  }
}, 900_000);
