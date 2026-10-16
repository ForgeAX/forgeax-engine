import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyAdvancedModeling } from './advanced-modeling.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it('renders polygon holes, bevels and curved profiles with seeded fresh-device RHI replay', {
  timeout: 180000,
}, async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 256,
    height: 256,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [256, 256],
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
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        gpuPassTiming: { maxPassesPerFrame: 64, maxFramesInFlight: 2, retentionFrames: 8 },
      },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = 'artifacts/advanced-modeling/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyAdvancedModeling(
      host.renderer,
      recorder,
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 12 : 60,
    );
  } finally {
    renderValue(await host.renderer.dispose());
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
