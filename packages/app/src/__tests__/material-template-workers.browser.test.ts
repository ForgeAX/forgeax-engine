import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { observeReadyPictures } from '../../__tests__/ready-picture-count';
import type {} from './material-template-worker.commands.js';

it('renders a source-only Pack material through the Engine and Render Workers', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  canvas.setAttribute('data-forgeax-render-width-limit', '128');
  canvas.setAttribute('data-forgeax-render-height-limit', '128');
  document.body.append(canvas);
  const channel = new MessageChannel();
  const observed: unknown[] = [];
  channel.port1.onmessage = (event) => observed.push(event.data);
  const app = (
    await createApp(
      canvas,
      {
        execution: {
          workers: { engine: true, render: true, kernels: false },
          bootstrap: new URL('./material-template-worker.bootstrap.ts', import.meta.url),
          bootstrapData: JSON.stringify(await commands.produceWorkerMaterialTemplate()),
          bootstrapPort: channel.port2,
          assetCatalog: { url: 'data:application/json,[]' },
          startupTimeoutMs: 90_000,
        },
      },
      { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
    )
  ).unwrap();
  const readyPictures = observeReadyPictures(canvas);
  try {
    app.start().unwrap();
    await expect.poll(() => readyPictures.count, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
    expect(observed).toContainEqual({ materialLoaded: true, hasReadyPrograms: false });
    const shot = await page.elementLocator(canvas).screenshot({ base64: true });
    const binary = atob(typeof shot === 'string' ? shot : shot.base64);
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(binary, (value) => value.charCodeAt(0))], { type: 'image/png' }),
    );
    const image = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = image.getContext('2d');
    if (context === null) throw new Error('Missing screenshot decoder');
    context.drawImage(bitmap, 0, 0);
    const color = context.getImageData(
      Math.floor(bitmap.width / 2),
      Math.floor(bitmap.height / 2),
      1,
      1,
    ).data;
    bitmap.close();
    expect(Array.from(color)).toEqual([255, 0, 0, 255]);
    expect(app.execution.report().fault).toBeNull();
  } finally {
    readyPictures.dispose();
    (await app.dispose()).unwrap();
    channel.port1.close();
    canvas.remove();
  }
}, 120_000);
