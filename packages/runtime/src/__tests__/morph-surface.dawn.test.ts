import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { createForwardGtaoSceneDataConsumer } from './helpers/forward-gtao-scene-data';
import { MORPH_SURFACE_SIZE, verifyMorphSurface } from './helpers/morph-surface';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it.each([false, true])('feeds the GPU Morph surface to AO and SSR (skin=%s)', {
  timeout: 180_000,
}, async (skin) => {
  const surfaceNormal = createForwardGtaoSceneDataConsumer(MORPH_SURFACE_SIZE, MORPH_SURFACE_SIZE);
  const target = offscreenCanvas(MORPH_SURFACE_SIZE);
  const created = await constructRuntimeRendererHost(
    target.canvas,
    {
      rhi: webgpu.rhi,
      features: [surfaceNormal.feature],
      ssrIdentity: {
        sourceHead: 'fixture:morph-surface',
        sourceTree: 'fixture:morph-surface',
        lockSha256: 'fixture:morph-surface',
        buildSha256: 'fixture:morph-surface',
      },
    },
    {
      shaderManifestUrl: shaderManifestUrl(
        await buildEngineShaderTemplateManifest({ pointShadows: true }),
      ),
    },
  );
  if (!created.ok) throw created.error;
  try {
    await verifyMorphSurface(created.value, surfaceNormal, async () => {}, skin);
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    target.destroy();
  }
});
