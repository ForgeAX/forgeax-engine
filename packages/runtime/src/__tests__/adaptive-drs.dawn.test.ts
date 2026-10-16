import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyAdaptiveDrs } from './adaptive-drs.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it.each([false, true])('adapts DRS with shared pass timing %s and verifies RHI Debug', {
  timeout: 240_000,
  retry: 0,
}, async (gpuPassTiming) => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 128,
    height: 128,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target = options.device.createTexture({
          size: [128, 128],
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
    {
      rhi: recorder.backend.rhi,
      ...(gpuPassTiming
        ? { gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 } }
        : {}),
    },
    { shaderManifestUrl: manifestUrl },
  );
  if (!result.ok) throw result.error;
  const renderer = result.value.renderer;
  const root = `artifacts/adaptive-drs/${gpuPassTiming ? 'dawn-pass-timing' : 'dawn'}`;
  mkdirSync(root, { recursive: true });
  try {
    await verifyAdaptiveDrs(renderer, recorder, (name, bytes) => {
      writeFileSync(`${root}/${name}`, bytes);
    });
  } finally {
    await renderer.dispose();
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
