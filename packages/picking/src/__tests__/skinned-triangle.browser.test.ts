import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../../../runtime/src/renderer-host';
import { renderValue, SKIN_PICK_SIZE, verifySkinnedPicking } from './skinned-triangle-gpu.fixture';

it('matches live Browser WebGPU skin pixels to exact picks and fresh RHI replay', {
  timeout: 240_000,
}, async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SKIN_PICK_SIZE;
  canvas.style.width = canvas.style.height = '512px';
  const surface = document.createElement('div');
  surface.style.cssText = 'position:relative;width:512px;height:512px;';
  surface.append(canvas);
  document.body.append(surface);
  const recorder = attachRecorder(webgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(canvas, { rhi: recorder.backend.rhi }),
  );
  const directory = 'artifacts/skinned-triangle-picking/browser';
  const save = async (name: string, bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
      let binary = '';
      const chunk = bytes.subarray(offset, offset + 1024 * 1024);
      for (let i = 0; i < chunk.length; i += 8192)
        binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      await commands.writeFile(`${directory}/${name}`, btoa(binary), {
        encoding: 'base64',
        flag: offset === 0 ? 'w' : 'a',
      });
    }
  };
  try {
    await verifySkinnedPicking(
      host.renderer,
      recorder,
      save,
      async (name, pixels) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
        const label = document.createElement('div');
        label.textContent = `${name} · ${pixels.length} exact triangle hits`;
        label.style.cssText =
          'position:absolute;top:12px;left:12px;color:white;background:#16202bcc;padding:6px;font:14px sans-serif;';
        overlay.append(label);
        for (const [x, y] of pixels) {
          const marker = document.createElement('span');
          marker.style.cssText = `position:absolute;left:${(x + 0.5) * 4}px;top:${(y + 0.5) * 4}px;width:5px;height:5px;transform:translate(-50%,-50%);border:1px solid white;border-radius:50%;background:#00cfa8;`;
          overlay.append(marker);
        }
        surface.append(overlay);
        await page
          .elementLocator(surface)
          .screenshot({ path: `../../../../${directory}/${name}.png`, save: true });
        overlay.remove();
      },
      'skin',
      (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
        .FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1',
    );
  } finally {
    await host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    surface.remove();
  }
});
