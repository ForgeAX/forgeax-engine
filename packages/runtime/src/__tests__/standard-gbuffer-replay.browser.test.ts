import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  gbufferReplayIdentity,
  renderValue,
  verifyStandardGBufferReplay,
} from './standard-gbuffer-replay.fixture';

it('captures and replays packed GBuffer, HDR, SSAO and SSR through Browser WebGPU', {
  // Four lossless captures, native shader reconstruction and per-work readbacks
  // retain the existing case and process deadlines.
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      ssrIdentity: gbufferReplayIdentity,
    }),
  );
  try {
    await verifyStandardGBufferReplay(host.renderer, host.assets, recorder, async (name, bytes) => {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      await commands.writeFile(
        `artifacts/ue-gbuffer-verification/rhi-debug/browser/${name}`,
        btoa(binary),
        'base64',
      );
    });
  } finally {
    renderValue(await host.renderer.dispose());
    host.assets.dispose();
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
