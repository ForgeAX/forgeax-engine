import { encodePng } from '@forgeax/engine-image/png';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { halfToFloat } from './contact-shadow.fixture';
import { verifyPaged2d } from './paged-2d.fixture';

it.each([
  'sprite-fold',
  'sprite-instances',
  'instances',
  'tilemap',
] as const)('renders 512 %s elements through 60 WebGL2 frames, atlas edits and shrink', async (kind) => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  canvas.style.width = '768px';
  canvas.style.height = '384px';
  canvas.style.imageRendering = 'pixelated';
  document.body.append(canvas);
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(wgpu).unwrap();
  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>> | undefined;
  try {
    host = await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!host.ok) throw new Error(JSON.stringify(host.error));
    expect(host.value.renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    const save = async (name: string, bytes: Uint8Array) => {
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      await commands.writeFile(`artifacts/webgl2-basics/${kind}/${name}`, btoa(binary), 'base64');
    };
    await verifyPaged2d(
      host.value.renderer,
      host.value.assets,
      recorder,
      kind,
      async (name, tape, pixels) => {
        await save(`${name}.rhitape`, tape.bytes);
        await save(`${name}.rgba16f`, pixels);
        const view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        const rgba = new Uint8Array(512 * 256 * 4);
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 512; x++) {
            const source = (Math.floor(y / 4) * 128 + Math.floor(x / 4)) * 8;
            const output = (y * 512 + x) * 4;
            for (let channel = 0; channel < 3; channel++)
              rgba[output + channel] = Math.round(
                Math.max(0, Math.min(1, halfToFloat(view.getUint16(source + channel * 2, true)))) *
                  255,
              );
            rgba[output + 3] = 255;
          }
        await save(`${name}-linear.png`, encodePng(512, 256, rgba));
        const model = buildFrameModel(decodeTape(tape.bytes).unwrap());
        await save(`${name}.json`, new TextEncoder().encode(JSON.stringify(model)));
        const draws = model.works
          .filter((work) => work.kind === 'drawIndexed')
          .map((work) => work.drawCall as { instanceCount: number });
        if (name === 'frame-19' && kind !== 'tilemap')
          expect(draws.map((draw) => draw.instanceCount)).toEqual([128, 128, 128, 128]);
        if (name === 'frame-19' && kind === 'tilemap')
          expect(draws.map((draw) => draw.instanceCount)).toEqual([1]);
        if (name === 'frame-39' && kind === 'sprite-fold')
          expect(draws.map((draw) => draw.instanceCount)).toEqual([128, 1, 128, 128, 126, 1]);
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `artifacts/webgl2-basics/${kind}/${name}.png`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
      },
    );
  } finally {
    if (host?.ok) await host.value.renderer.dispose();
    (await recorder.dispose()).unwrap();
    if (saved === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', saved);
    canvas.remove();
  }
}, 120_000);
