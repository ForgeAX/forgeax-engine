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
  const manifest = shaderPublicationUrl(
    await buildEngineShaderTemplateManifest({ hdrpSsao: false }),
  );
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
  try {
    harness.setGi(undefined);
    for (let frame = 0; frame < 4; frame++) await harness.draw();
    const dark = await harness.image();
    harness.setGi(irradianceFieldGi());
    harness.spawn(harness.emitterMesh, harness.emissive, [0, 0, 1]);
    await harness.settle(32);
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
