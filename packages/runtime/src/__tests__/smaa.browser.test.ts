import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import { verifySmaa } from './smaa.fixture';

it('verifies Smaa pixels and capture/replay through browser WebGPU', {
  timeout: 180_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const recorder = attachRecorder(webgpu).unwrap();
  const result = await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi });
  if (!result.ok) throw result.error;
  try {
    await verifySmaa(
      result.value.renderer,
      recorder,
      canvas,
      async (name, bytes) => {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await commands.writeFile(`artifacts/smaa/browser/${name}`, btoa(binary), 'base64');
      },
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 8 : 60,
    );
  } finally {
    await result.value.renderer.dispose();
    canvas.remove();
    (await recorder.dispose()).unwrap();
  }
});
