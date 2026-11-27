import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifySmaa } from './smaa.fixture';

it.each([
  { name: 'webgpu', backend: webgpu },
  { name: 'wgpu-webgl2', backend: wgpu },
] as const)('verifies SMAA blending and stencil on $name', {
  timeout: 180_000,
}, async ({ name, backend }) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const portable = name === 'wgpu-webgl2';
  if (portable) Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  const recorder = attachRecorder(backend).unwrap();
  try {
    const host = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
    if (!host.ok) throw host.error;
    const result = host.value;
    try {
      const initialized = await result.initialization;
      if (!initialized.ok) throw initialized.error;
      expect(result.renderer.inspect().capabilities.backendKind).toBe(name);
      await verifySmaa(
        result.renderer,
        recorder,
        canvas,
        async (filename, bytes) => {
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          await commands.writeFile(
            `artifacts/smaa/browser-${name}/${filename}`,
            btoa(binary),
            'base64',
          );
        },
        import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60,
        !portable,
      );
    } finally {
      await result.renderer.dispose();
    }
  } finally {
    canvas.remove();
    (await recorder.dispose()).unwrap();
    if (portable) {
      if (descriptor !== undefined) Object.defineProperty(navigator, 'gpu', descriptor);
      else Reflect.deleteProperty(navigator, 'gpu');
    }
  }
});
