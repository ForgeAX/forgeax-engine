import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { CHANNEL_SIZE } from './lighting-channels.fixture';
import { verifyChannelViews } from './lighting-channels-views.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it.each([
  'world',
  'publication',
] as const)('preserves lighting channels across browser independent views through %s', {
  timeout: 300_000,
}, async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHANNEL_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const identity = { source: 'lighting-channels-browser-views', epoch: 1 };
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      ...(mode === 'publication' ? { publicationSource: identity } : {}),
    }),
  );
  const save = async (name: string, bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await commands.writeFile(
      `artifacts/lighting-channels/browser-views-${mode}/${name}`,
      btoa(binary),
      'base64',
    );
  };
  try {
    await verifyChannelViews(
      host.renderer,
      recorder,
      save,
      mode === 'publication' ? { assets: host.assets, identity } : undefined,
    );
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
