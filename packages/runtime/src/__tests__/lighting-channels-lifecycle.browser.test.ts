import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { CHANNEL_SIZE } from './lighting-channels.fixture';
import { channelHostLoss, verifyChannelLifecycle } from './lighting-channels-lifecycle.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it('retains browser channel facts across mutations, World replacement and host recovery', {
  timeout: 300_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHANNEL_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const loss = channelHostLoss(recorder);
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: loss.instrumentation,
    }),
  );
  const save = async (name: string, bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await commands.writeFile(
      `artifacts/lighting-channels/browser-lifecycle/${name}`,
      btoa(binary),
      'base64',
    );
    if (name.endsWith('.rhitape')) {
      const shot = await page.elementLocator(canvas).screenshot({ base64: true });
      await commands.writeFile(
        `artifacts/lighting-channels/browser-lifecycle/${name.replace('.rhitape', '-display.png')}`,
        typeof shot === 'string' ? shot : shot.base64,
        'base64',
      );
    }
  };
  try {
    await verifyChannelLifecycle(host.renderer, recorder, loss, save);
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
