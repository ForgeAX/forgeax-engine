import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { CHANNEL_CHARACTER_SIZE, verifyCharacterFill } from './lighting-channels-character.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('keeps character fill while removing it from the visible environment in both paths', {
  timeout: 300_000,
}, async () => {
  const target = offscreenCanvas(CHANNEL_CHARACTER_SIZE);
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
  const directory = 'artifacts/lighting-channels/dawn-character';
  mkdirSync(directory, { recursive: true });
  try {
    await verifyCharacterFill(host.renderer, recorder, (name, bytes) =>
      writeFileSync(`${directory}/${name}`, bytes),
    );
  } finally {
    renderValue(await host.renderer.dispose());
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
