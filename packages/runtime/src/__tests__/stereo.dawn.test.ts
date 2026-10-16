import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { gbufferReplayIdentity, renderValue } from './standard-gbuffer-replay.fixture';
import { verifyStereo } from './stereo.fixture';

function fakeCanvas(size: { width: number; height: number }) {
  let texture: GPUTexture | undefined;
  const canvas = {
    ...size,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        texture?.destroy();
        texture = config.device.createTexture({
          size: [canvas.width, canvas.height],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      getCurrentTexture: () => texture,
      unconfigure() {},
    }),
  };
  return { canvas, destroy: () => texture?.destroy() };
}

it.each([
  'world',
  'publication',
] as const)('renders stereo eyes with Three.js disparity and validates Dawn replay through %s', {
  timeout: 180_000,
}, async (mode) => {
  const size = { width: 256, height: 128 };
  const { canvas, destroy } = fakeCanvas(size);
  const identity = { source: 'stereo', epoch: 1 };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        ssrIdentity: gbufferReplayIdentity,
        ...(mode === 'publication' ? { publicationSource: identity } : {}),
      },
      { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    ),
  );
  const directory = `artifacts/stereo/${mode === 'world' ? 'dawn' : 'publication-dawn'}`;
  mkdirSync(directory, { recursive: true });
  try {
    const summary = await verifyStereo(
      host.renderer,
      recorder,
      (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      size,
      mode === 'publication' ? { assets: host.assets, identity } : undefined,
      process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1' ? 16 : 60,
    );
    writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
  } finally {
    renderValue(await host.renderer.dispose());
    destroy();
    (await recorder.dispose()).unwrap();
  }
});
