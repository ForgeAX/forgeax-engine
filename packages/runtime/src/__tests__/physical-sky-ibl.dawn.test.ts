import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { PHYSICAL_SKY_IBL_SIZE, verifyPhysicalSkyIbl } from './helpers/physical-sky-ibl';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('qualifies raster physical sky IBL with frozen cube/filter generations on Dawn', {
  timeout: 180_000,
}, async () => {
  const target = offscreenCanvas(PHYSICAL_SKY_IBL_SIZE.width, PHYSICAL_SKY_IBL_SIZE.height),
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
  const directory = 'artifacts/webgl2-six/sky-ibl/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyPhysicalSkyIbl(
      created.value.renderer,
      recorder,
      async (name, bytes) => {
        writeFileSync(`${directory}/${name}`, bytes);
      },
      async () => {},
    );
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    target.destroy();
  }
});
