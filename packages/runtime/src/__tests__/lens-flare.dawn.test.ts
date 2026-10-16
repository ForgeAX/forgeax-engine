import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyLensFlare } from './lens-flare.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
it('verifies lens flare ghosts, composite replay oracle and missing-bokeh falsifier on Dawn', {
  timeout: 180_000,
}, async () => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 128,
    height: 96,
    getContext: () => ({
      configure(options: GPUCanvasConfiguration) {
        target?.destroy();
        target = options.device.createTexture({
          size: [canvas.width, canvas.height],
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
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = 'artifacts/lens-flare/dawn';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyLensFlare(
      host.renderer,
      recorder,
      (name, bytes) => {
        writeFileSync(`${directory}/${name}`, bytes);
      },
      undefined,
      (width, height) => {
        canvas.width = width;
        canvas.height = height;
      },
    );
  } finally {
    renderValue(await host.renderer.dispose());
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
