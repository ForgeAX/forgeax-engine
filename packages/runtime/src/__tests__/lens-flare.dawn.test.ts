import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyLensFlare } from './lens-flare.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderTemplateManifest());
it.each([
  { renderPath: 'forward', portable: false, whiteBalance: false },
  { renderPath: 'deferred', portable: false, whiteBalance: false },
  { renderPath: 'forward', portable: true, whiteBalance: false },
  { renderPath: 'forward', portable: true, whiteBalance: true },
] as const)('verifies the optical contribution on Dawn ($renderPath, portable=$portable, whiteBalance=$whiteBalance)', {
  timeout: 180_000,
}, async ({ renderPath, portable, whiteBalance }) => {
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
      {
        rhi: recorder.backend.rhi,
        standardProfile: {
          ...DEFAULT_STANDARD_PROFILE,
          renderPath,
          outputContract: portable ? 'standard-output-v1' : 'standard-output-v2',
        },
      },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = `artifacts/lens-flare/dawn-${renderPath}${portable ? '-portable' : ''}${whiteBalance ? '-wb' : ''}`;
  mkdirSync(directory, { recursive: true });
  try {
    renderValue(await host.initialization);
    expect(host.renderer.inspect().profile).toMatchObject({
      renderPath,
      outputContract: portable ? 'standard-output-v1' : 'standard-output-v2',
    });
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
      { portable, whiteBalance },
    );
  } finally {
    renderValue(await host.renderer.dispose());
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
