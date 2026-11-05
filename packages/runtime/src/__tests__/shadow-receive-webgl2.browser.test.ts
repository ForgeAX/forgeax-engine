import { encodePng } from '@forgeax/engine-image/png';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { loadRhiPack } from '../backend-selection';
import { verifyChannelShadows } from './lighting-channels-shadow.fixture';

it('applies object receive toggles to real WebGL2 directional and spot shadows', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(wgpu).unwrap();
  let host: Awaited<ReturnType<typeof constructRendererHost>> | undefined;
  try {
    host = await constructRendererHost(
      canvas,
      undefined,
      { shaderManifestUrl: '/shaders/manifest.json' },
      loadRhiPack(
        { ...recorder.backend },
        {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      ),
    );
    if (!host.ok) throw new Error(JSON.stringify(host.error));
    expect(host.value.renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    const save = async (name: string, bytes: Uint8Array) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await commands.writeFile(`artifacts/webgl2-basics/shadow/${name}`, btoa(binary), 'base64');
    };
    await verifyChannelShadows(
      host.value.renderer,
      recorder,
      async (name, tape, image, facts) => {
        await save(`${name}.rhitape`, tape.bytes);
        await save(`${name}.json`, new TextEncoder().encode(JSON.stringify(facts)));
        await save(`${name}-linear-luminance.f32`, new Uint8Array(image.buffer));
        const rgba = new Uint8Array(256 * 256 * 4);
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            const luminance = image[Math.floor(y / 4) * 64 + Math.floor(x / 4)] ?? 0;
            const value = Math.round(Math.max(0, Math.min(1, luminance * 4)) * 255);
            rgba.set([value, value, value, 255], (y * 256 + x) * 4);
          }
        await save(`${name}-linear.png`, encodePng(256, 256, rgba));
        const screenshot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `artifacts/webgl2-basics/shadow/${name}.png`,
          typeof screenshot === 'string' ? screenshot : screenshot.base64,
          'base64',
        );
      },
      { paths: ['forward'], kinds: ['directional', 'spot'], warmFrames: 60 },
    );
  } finally {
    if (host?.ok) await host.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    if (saved === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', saved);
    canvas.remove();
  }
}, 120_000);
