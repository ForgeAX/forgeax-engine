import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { CONTACT_SHADOW_SIZE } from './contact-shadow.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { verifyForwardContactShadow } from './helpers/forward-contact-shadow';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('preserves directional Forward contact shadow receiver and lighting isolation on Dawn', {
  timeout: 180_000,
}, async () => {
  const target = offscreenCanvas(CONTACT_SHADOW_SIZE);
  const created = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: webgpu.rhi },
    {
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest({ pointShadows: true })),
    },
  );
  if (!created.ok) {
    target.destroy();
    throw created.error;
  }
  try {
    await verifyForwardContactShadow(created.value.renderer, async () => {});
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    target.destroy();
  }
});
