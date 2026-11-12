import { encodePng } from '@forgeax/engine-image/png';
import { halfFloat } from '@forgeax/engine-math';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { linearChannelToSrgb, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { base64Bytes } from './helpers/forward-gtao-capture';
import { PHYSICAL_SKY_IBL_SIZE, verifyPhysicalSkyIbl } from './helpers/physical-sky-ibl';

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('lights diffuse and specular surfaces from raster physical sky IBL on %s', {
  timeout: 180_000,
}, async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = PHYSICAL_SKY_IBL_SIZE.width;
  canvas.height = PHYSICAL_SKY_IBL_SIZE.height;
  document.body.append(canvas);
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  let signalLoss: (() => void) | undefined;
  const created = await constructRuntimeRendererHost(canvas, {
    rhi: recorder.backend.rhi,
    rhiInstrumentation: {
      deviceLost: () =>
        new Promise((resolve) => {
          signalLoss = () =>
            resolve({ reason: 'unknown', message: 'host-injected sky IBL recovery' });
        }),
      resolveSurfaceDevice: (device) =>
        ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  if (!created.ok) {
    canvas.remove();
    (await recorder.dispose()).unwrap();
    throw created.error;
  }
  const save = (name: string, bytes: Uint8Array) =>
    commands.writeFile(
      `artifacts/webgl2-six/sky-ibl/${backend}-${name}`,
      base64Bytes(bytes),
      'base64',
    );
  try {
    expect(created.value.renderer.inspect().capabilities.backendKind).toBe(backend);
    await verifyPhysicalSkyIbl(
      created.value.renderer,
      recorder,
      save,
      async (name, capture) => {
        const rgba = new Uint8Array(capture.width * capture.height * 4),
          view = new DataView(
            capture.bytes.buffer,
            capture.bytes.byteOffset,
            capture.bytes.byteLength,
          );
        for (let y = 0; y < capture.height; y++)
          for (let x = 0; x < capture.width; x++)
            for (let c = 0; c < 4; c++)
              rgba[(y * capture.width + x) * 4 + c] =
                c === 3
                  ? 255
                  : Math.round(
                      linearChannelToSrgb(
                        Math.min(
                          1,
                          Math.max(
                            0,
                            halfFloat.f16ToF32(
                              view.getUint16(y * capture.bytesPerRow + x * 8 + c * 2, true),
                            ) / 5000,
                          ),
                        ),
                      ) * 255,
                    );
        await save(`${name}.png`, encodePng(capture.width, capture.height, rgba));
      },
      async () => {
        if (signalLoss === undefined) throw new Error('missing sky IBL host loss observer');
        signalLoss();
        for (
          let attempt = 0;
          attempt < 100 && created.value.renderer.state() !== 'device-lost';
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 0));
        expect(created.value.renderer.state()).toBe('device-lost');
        expect((await created.value.renderer.recover()).ok).toBe(true);
      },
    );
  } finally {
    expect((await created.value.renderer.dispose()).ok).toBe(true);
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
