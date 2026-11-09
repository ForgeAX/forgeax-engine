import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyDecals } from './decals.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it('composes Forward decal color, normal and roughness and replays the actual frame on Dawn', {
  timeout: 180_000,
}, async () => {
  const target = offscreenCanvas(128);
  const recorder = attachRecorder(webgpu).unwrap();
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
  const directory = 'artifacts/webgl2-six/decals/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyDecals(
      created.value.renderer,
      recorder,
      (name, bytes) => {
        writeFileSync(`${directory}/${name}`, bytes);
      },
      60,
      'forward',
    );
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    target.destroy();
  }
});
