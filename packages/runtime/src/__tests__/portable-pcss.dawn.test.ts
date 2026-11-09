import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { PCSS_SIZE, verifyPortablePcss } from './helpers/portable-pcss';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('qualifies PCSS blocker-distance penumbra on Dawn', { timeout: 180_000 }, async () => {
  const target = offscreenCanvas(PCSS_SIZE),
    recorder = attachRecorder(webgpu).unwrap();
  const created = await constructRuntimeRendererHost(
    target.canvas,
    { rhi: recorder.backend.rhi },
    {
      shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest({ pointShadows: true })),
    },
  );
  if (!created.ok) {
    target.destroy();
    (await recorder.dispose()).unwrap();
    throw created.error;
  }
  const directory = 'artifacts/webgl2-six/pcss/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyPortablePcss(created.value.renderer, recorder, async (name, bytes) => {
      writeFileSync(`${directory}/${name}`, bytes);
    });
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    target.destroy();
  }
});
