import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import { CHANNEL_SIZE } from './lighting-channels.fixture';
import { verifyChannelShadows } from './lighting-channels-shadow.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('keeps direct matching independent of directional, spot and point shadow casters', {
  timeout: 300_000,
}, async () => {
  const target = offscreenCanvas(CHANNEL_SIZE);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      target.canvas,
      { rhi: recorder.backend.rhi },
      {
        shaderManifestUrl: shaderManifestUrl(
          await buildEngineShaderManifest({ pointShadows: true }),
        ),
      },
    ),
  );
  const directory = 'artifacts/lighting-channels/dawn-shadow';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyChannelShadows(host.renderer, recorder, async (name, tape, image, facts) => {
      writeFileSync(`${directory}/${name}.rhitape`, tape.bytes);
      writeFileSync(`${directory}/${name}.png`, luminancePng(image, CHANNEL_SIZE));
      writeFileSync(
        `${directory}/${name}.json`,
        JSON.stringify({ digest: tape.digest, facts }, null, 2),
      );
    });
  } finally {
    renderValue(await host.renderer.dispose());
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
