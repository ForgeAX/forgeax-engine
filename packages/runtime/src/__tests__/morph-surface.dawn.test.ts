import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { MORPH_SURFACE_SIZE, verifyMorphSurface } from './helpers/morph-surface';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it.each([false, true])('feeds the GPU Morph surface to AO and SSR (skin=%s)', {
  timeout: 180_000,
}, async (skin) => {
  const target = offscreenCanvas(MORPH_SURFACE_SIZE);
  const created = await constructRuntimeRendererHost(
    target.canvas,
    {
      rhi: webgpu.rhi,
      ssrIdentity: {
        sourceHead: 'fixture:morph-surface',
        sourceTree: 'fixture:morph-surface',
        lockSha256: 'fixture:morph-surface',
        buildSha256: 'fixture:morph-surface',
      },
    },
    {
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest({ pointShadows: true })),
    },
  );
  if (!created.ok) throw created.error;
  try {
    await verifyMorphSurface(created.value, async () => {}, skin);
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    target.destroy();
  }
});
