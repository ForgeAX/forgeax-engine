import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { verifyRuntimeTerrain } from '../../../render/src/__tests__/managed-terrain.gpu-fixture';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  base64Bytes,
  captureForwardGtaoLinearHdr,
  rgba16FloatPixel,
} from './helpers/forward-gtao-capture';

it.each([
  { backend: 'webgpu', encoding: 'weights' },
  { backend: 'webgpu', encoding: 'ids' },
  { backend: 'wgpu-webgl2', encoding: 'weights' },
  { backend: 'wgpu-webgl2', encoding: 'ids' },
] as const)('renders edited native Terrain on $backend ($encoding)', { timeout: 120_000 }, async ({
  backend,
  encoding,
}) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const recorder = attachRecorder(backend === 'webgpu' ? webgpu : wgpu).unwrap();
  const created = await constructRuntimeRendererHost(canvas, {
    rhi: recorder.backend.rhi,
    rhiInstrumentation: {
      resolveSurfaceDevice: (device) =>
        ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
    },
  });
  if (!created.ok) throw created.error;
  const host = created.value;
  let state = 0;
  let editFrameBase64: string | undefined;
  try {
    expect(host.renderer.inspect().capabilities.backendKind).toBe(backend);
    await verifyRuntimeTerrain(encoding, '/shaders/manifest.json', {
      renderer: host.debugDrawHost,
      captureWork: async (draw) => {
        if (backend === 'wgpu-webgl2' && state === 3) {
          const pending = recorder.captureFrame();
          (await recorder.frameBoundary()).unwrap();
          await draw();
          (await recorder.frameBoundary()).unwrap();
          const capturedFrame = await pending;
          if (capturedFrame.ok) editFrameBase64 = base64Bytes(capturedFrame.value.bytes);
          else
            await commands.writeFile(
              `artifacts/webgl2-six/terrain/${backend}-${encoding}-capture-error.json`,
              JSON.stringify(capturedFrame.error),
            );
        }
      },
      capture: async (draw) => {
        const captured = await captureForwardGtaoLinearHdr(host.renderer, draw);
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        const prefix = `artifacts/webgl2-six/terrain/${backend}-${encoding}-${state++}`;
        await commands.writeFile(
          `${prefix}.png`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
        const samples = [24, 40].map((x) => {
          if (captured.format === 'rgba16float')
            return Array.from(rgba16FloatPixel(captured, x, 32), (v) => v * 255);
          const at = 32 * captured.bytesPerRow + x * 4;
          const bytes = captured.bytes;
          return [
            bytes[at + (captured.format.startsWith('bgra') ? 2 : 0)] ?? 0,
            bytes[at + 1] ?? 0,
            bytes[at + (captured.format.startsWith('bgra') ? 0 : 2)] ?? 0,
          ];
        });
        if (editFrameBase64 !== undefined) {
          const phase = samples.every((sample) => (sample[2] ?? 0) > 150) ? 'after' : 'before';
          await commands.writeFile(
            `artifacts/webgl2-six/terrain/${backend}-${encoding}-material-edit-${phase}.rhitape`,
            editFrameBase64,
            'base64',
          );
          editFrameBase64 = undefined;
        }
        await commands.writeFile(
          `${prefix}.json`,
          JSON.stringify({
            receipt: captured.receipt,
            format: captured.format,
            samples,
            completedFrames: 60,
          }),
        );
        return samples;
      },
    });
  } finally {
    await host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
});
