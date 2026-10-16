import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import type { MaterialAsset } from '@forgeax/engine-types';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  CHANNEL_SIZE,
  type ChannelReceiver,
  verifyLightingChannels,
} from './lighting-channels.fixture';
import { channelHostLoss } from './lighting-channels-lifecycle.fixture';
import { prepareChannelPhysicalMaterial } from './lighting-channels-material.fixture';
import { verifyChannelReplay } from './lighting-channels-replay.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareChannelPhysicalMaterial(source: MaterialAsset): Promise<string>;
  }
}

export async function runChannelBrowserCase(
  mode: 'world' | 'publication',
  receiver: ChannelReceiver,
  path: 'forward' | 'deferred' | 'both',
) {
  const paths = path === 'both' ? (['forward', 'deferred'] as const) : [path];
  const progress = async (phase: string) =>
    commands.writeFile(
      `artifacts/lighting-channels/browser-${mode}-${receiver}/${path}-progress.json`,
      JSON.stringify({ phase, at: new Date().toISOString() }),
    );
  await progress('construct-host');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CHANNEL_SIZE;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const loss =
    mode === 'publication' && receiver === 'rigid' ? channelHostLoss(recorder) : undefined;
  const identity = { source: 'lighting-channels-browser', epoch: 1 };
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, {
      rhi: recorder.backend.rhi,
      ...(loss === undefined ? {} : { rhiInstrumentation: loss.instrumentation }),
      ...(mode === 'publication' ? { publicationSource: identity } : {}),
    }),
  );
  const devices: GPUDevice[] = [];
  await progress('host-ready');
  const save = async (name: string, bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await commands.writeFile(
      `artifacts/lighting-channels/browser-${mode}-${receiver}/${name}`,
      btoa(binary),
      'base64',
    );
  };
  try {
    const samples = await verifyLightingChannels(host.renderer, {
      receiver,
      paths,
      async preparePhysicalMaterial(source) {
        await prepareChannelPhysicalMaterial(
          host.assets,
          source,
          await commands.prepareChannelPhysicalMaterial(source),
        );
      },
      captureLights: ['directional'],
      ...(mode === 'publication' ? { publication: { assets: host.assets, identity } } : {}),
      recorder,
      ...(loss === undefined ? {} : { recover: () => loss.recover(host.renderer) }),
      async capture(name, tape, image) {
        await progress(`${name}:captured`);
        await save(`${name}.rhitape`, tape.bytes);
        await save(`${name}-live.luminance-f32`, new Uint8Array(image.buffer));
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await save(
          `${name}-display.png`,
          Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (c) =>
            c.charCodeAt(0),
          ),
        );
        const artifacts: [string, Uint8Array][] = [];
        await verifyChannelReplay(
          name,
          tape,
          image,
          devices,
          (file, bytes) => artifacts.push([file, bytes]),
          progress,
          receiver === 'physical',
        );
        await progress(`${name}:replay-and-falsifier-accepted`);
        for (const [file, bytes] of artifacts) await save(file, bytes);
      },
    });
    await save(`${path}-samples.json`, new TextEncoder().encode(JSON.stringify(samples, null, 2)));
  } finally {
    renderValue(await host.renderer.dispose());
    canvas.remove();
    (await recorder.dispose()).unwrap();
    for (const device of devices) device.destroy();
  }
}
