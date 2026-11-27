import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { DISPLAY_P3_SIZE } from './display-p3.fixture';
import {
  afterTonemapFixture,
  postEffectFixture,
  verifyAfterTonemapOutput,
  verifyEncodedPostEffects,
} from './encoded-post-effects.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

it.each([
  { name: 'webgpu', backend: webgpu, webgl2: false },
  { name: 'webgl2', backend: wgpu, webgl2: true },
] as const)('chains three encoded effects in the browser on $name', {
  timeout: 180_000,
}, async ({ name, backend, webgl2 }) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = DISPLAY_P3_SIZE;
  document.body.append(canvas);
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  if (webgl2) Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(backend).unwrap();
  const { features, state } = postEffectFixture();
  const afterTonemap = afterTonemapFixture();
  try {
    const { renderer, initialization } = renderValue(
      await constructRuntimeRendererHost(canvas, {
        features: [...features, ...afterTonemap.features],
        standardProfile: { ...DEFAULT_STANDARD_PROFILE },
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
      const save = async (filename: string, bytes: Uint8Array) => {
        let binary = '';
        for (let start = 0; start < bytes.length; start += 8192)
          binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        await commands.writeFile(
          `artifacts/encoded-post-effects/browser-${name}/${filename}`,
          btoa(binary),
          'base64',
        );
      };
      await verifyEncodedPostEffects(renderer, recorder, state, save);
      await verifyAfterTonemapOutput(renderer, recorder, afterTonemap.state, save, webgl2);
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
  }
});
