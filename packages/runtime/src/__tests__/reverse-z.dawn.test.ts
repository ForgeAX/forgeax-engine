import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyReverseZ } from './reverse-z.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it('verifies Reverse-Z distant surface depth and real RHI Debug replay', {
  timeout: 120_000,
  retry: 0,
}, async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target = options.device.createTexture({
          size: [64, 64],
          format: options.format,
          usage: 0x11,
          viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const result = await constructRuntimeRendererHost(
    canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!result.ok) throw result.error;
  const renderer = result.value.renderer;
  const root = 'artifacts/reverse-z/dawn';
  mkdirSync(root, { recursive: true });
  try {
    await verifyReverseZ(
      renderer,
      recorder,
      (name, bytes) => {
        writeFileSync(`${root}/${name}`, bytes);
      },
      process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 8 : 60,
    );
  } finally {
    await renderer.dispose();
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
