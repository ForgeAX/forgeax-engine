import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifyLensFlare } from './lens-flare.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it.each([
  { name: 'webgpu', backend: webgpu, webgl2: false },
  { name: 'webgl2', backend: wgpu, webgl2: true },
] as const)('verifies the same Bloom and Lens Flare pixels on $name', {
  timeout: 240_000,
}, async ({ name, backend, webgl2 }) => {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 96;
  const replayCanvas = document.createElement('canvas');
  document.body.append(canvas, replayCanvas);
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  if (webgl2) Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(backend).unwrap();
  try {
    const { renderer, initialization } = renderValue(
      await constructRuntimeRendererHost(canvas, {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      }),
    );
    try {
      renderValue(await initialization);
      expect(renderer.inspect().capabilities.compute).toBe(!webgl2);
      await verifyLensFlare(
        renderer,
        recorder,
        async (filename, bytes) => {
          let binary = '';
          for (let start = 0; start < bytes.length; start += 8192)
            binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
          await commands.writeFile(
            `artifacts/lens-flare/browser-${name}/${filename}`,
            btoa(binary),
            'base64',
          );
        },
        undefined,
        (width, height) => {
          canvas.width = width;
          canvas.height = height;
        },
        { backend, ...(webgl2 ? { replayCanvas, portable: true } : {}) },
      );
    } finally {
      renderValue(await renderer.dispose());
    }
  } finally {
    (await recorder.dispose()).unwrap();
    if (webgl2) {
      if (descriptor) Object.defineProperty(navigator, 'gpu', descriptor);
      else Reflect.deleteProperty(navigator, 'gpu');
    }
    canvas.remove();
    replayCanvas.remove();
  }
});
