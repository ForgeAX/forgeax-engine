import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import type {} from '../../../render/src/__tests__/texture-generators.commands';
import { observeReadyPictures } from '../../__tests__/ready-picture-count';
import localBootstrap from './gpu-texture-worker-bootstrap';

async function color(canvas: HTMLCanvasElement) {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const binary = atob(typeof shot === 'string' ? shot : shot.base64);
  const bitmap = await createImageBitmap(
    new Blob([Uint8Array.from(binary, (value) => value.charCodeAt(0))], { type: 'image/png' }),
  );
  const image = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = image.getContext('2d');
  if (!context) throw new Error('Missing screenshot decoder');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return Array.from(
    context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data,
  );
}

it('transports GPU-only texture recipes through real Engine and Render Workers and updates their pixels', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  canvas.setAttribute('data-forgeax-render-width-limit', '128');
  canvas.setAttribute('data-forgeax-render-height-limit', '128');
  document.body.append(canvas);
  const channel = new MessageChannel();
  const messages: { ready?: boolean; updated?: boolean; cpuPixels: boolean }[] = [];
  channel.port1.onmessage = (event) => messages.push(event.data);
  const result = await createApp(
    canvas,
    {
      execution: {
        workers: { engine: true, render: true, kernels: false },
        localBootstrap: () => {
          throw new Error('Host-only bootstrap must not run for Engine Workers');
        },
        assetCatalog: { url: 'data:application/json,[]' },
        bootstrap: new URL('./gpu-texture-worker-bootstrap.ts', import.meta.url),
        bootstrapData: JSON.stringify(await commands.prepareTextureGeneratorPrograms()),
        bootstrapPort: channel.port2,
        startupTimeoutMs: 90_000,
      },
    },
    { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
  );
  if (!result.ok) throw new Error(JSON.stringify({ startup: result.error, messages }));
  const app = result.value;
  const readyPictures = observeReadyPictures(canvas);
  try {
    app.start().unwrap();
    await expect.poll(() => readyPictures.count, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
    expect(messages).toContainEqual({ ready: true, cpuPixels: false });
    const initial = await color(canvas);
    expect(initial[0]).toBeGreaterThan(240);
    expect(initial[1]).toBeLessThan(10);
    expect(initial[2]).toBeGreaterThan(100);
    channel.port1.postMessage('wear');
    await expect
      .poll(() => messages.some((value) => value.updated), { timeout: 10_000 })
      .toBe(true);
    await expect
      .poll(async () => (await color(canvas))[1], { timeout: 15_000 })
      .toBeGreaterThan(175);
    expect(messages).toContainEqual({ updated: true, cpuPixels: false });
    expect(app.execution.report().fault).toBeNull();
  } finally {
    readyPictures.dispose();
    (await app.dispose()).unwrap();
    channel.port1.close();
    canvas.remove();
  }
}, 120_000);

// A URL which cannot be imported proves the local entry stayed in its native module graph.
it('samples GPU textures for 60 completed local frames using the native bootstrap entry', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  document.body.append(canvas);
  const frames = new Set<number>();
  canvas.addEventListener('forgeax:frame-completed', (event) => {
    const receipt = (event as CustomEvent).detail;
    if (receipt.presentation === 'ready') frames.add(receipt.frameId);
  });
  const channel = new MessageChannel();
  const messages: { ready?: boolean; updated?: boolean; cpuPixels: boolean }[] = [];
  channel.port1.onmessage = (event) => messages.push(event.data);
  const result = await createApp(
    canvas,
    {
      execution: {
        workers: { engine: false, render: false, kernels: false },
        bootstrap: new URL('/must-not-import-native-bootstrap.mjs', location.href),
        localBootstrap,
        assetCatalog: { url: 'data:application/json,[]' },
        bootstrapData: JSON.stringify(await commands.prepareTextureGeneratorPrograms()),
        bootstrapPort: channel.port2,
      },
    },
    { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
  );
  if (!result.ok) throw result.error;
  const app = result.value;
  try {
    app.start().unwrap();
    await expect.poll(() => frames.size, { timeout: 60000 }).toBeGreaterThanOrEqual(60);
    expect(messages).toContainEqual({ ready: true, cpuPixels: false });
    const initial = await color(canvas);
    expect(initial[0]).toBeGreaterThan(240);
    expect(initial[1]).toBeLessThan(10);
    channel.port1.postMessage('wear');
    await expect
      .poll(async () => (await color(canvas))[1], { timeout: 15000 })
      .toBeGreaterThan(175);
    expect(messages).toContainEqual({ updated: true, cpuPixels: false });
    expect(app.execution.report().fault).toBeNull();
  } finally {
    (await app.dispose()).unwrap();
    channel.port1.close();
    canvas.remove();
  }
}, 120000);
