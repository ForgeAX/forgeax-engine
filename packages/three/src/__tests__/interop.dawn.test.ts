import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { offscreenCanvas } from '../../../runtime/src/__tests__/hdr-evidence.fixture';
import { shaderManifestUrl } from '../../../runtime/src/__tests__/shader-manifest-url.fixture';
import { createInteropJourney } from './interop.fixture';
import { SIZE } from './render.fixture';

for (const kind of ['occlusion', 'shadows'] as const)
  it(`submits 60 mixed ${kind} frames and replays actual native commands`, {
    timeout: 120000,
  }, async () => {
    const target = offscreenCanvas(SIZE);
    const url = shaderManifestUrl(await buildEngineShaderTemplateManifest());
    const journey = await createInteropJourney(target.canvas as unknown as OffscreenCanvas, {
      shaderManifestUrl: url,
    });
    try {
      if (kind === 'occlusion') await journey.verifyOcclusion();
      else await journey.verifyShadows();
    } finally {
      await journey.dispose();
      target.destroy();
    }
  });
