import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { DISPLAY_P3_SIZE } from './display-p3.fixture';
import {
  afterTonemapFixture,
  postEffectFixture,
  verifyAfterTonemapOutput,
  verifyEncodedPostEffects,
} from './encoded-post-effects.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderTemplateManifest());

it.each(['forward', 'deferred'] as const)('chains three encoded effects on Dawn %s', {
  timeout: 180_000,
}, async (renderPath) => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: DISPLAY_P3_SIZE,
    height: DISPLAY_P3_SIZE,
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
  const { features, state } = postEffectFixture();
  const afterTonemap = afterTonemapFixture();
  try {
    const host = renderValue(
      await constructRuntimeRendererHost(
        canvas,
        {
          features: [...features, ...afterTonemap.features],
          rhi: recorder.backend.rhi,
          standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath },
        },
        { shaderManifestUrl: manifest },
      ),
    );
    try {
      renderValue(await host.initialization);
      const directory = `artifacts/encoded-post-effects/dawn-${renderPath}`;
      mkdirSync(directory, { recursive: true });
      const save = (name: string, bytes: Uint8Array) =>
        writeFileSync(`${directory}/${name}`, bytes);
      await verifyEncodedPostEffects(host.renderer, recorder, state, save);
      await verifyAfterTonemapOutput(host.renderer, recorder, afterTonemap.state, save);
    } finally {
      renderValue(await host.renderer.dispose());
    }
  } finally {
    target?.destroy();
    (await recorder.dispose()).unwrap();
  }
});
