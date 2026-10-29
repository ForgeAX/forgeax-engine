import { type BrowserFrameCompleted, FORGEAX_FRAME_COMPLETED_EVENT } from '../src/browser-frame-signal';
import { createApp } from '@forgeax/engine-app/browser';
import { expect } from 'vitest';
import { page } from 'vitest/browser';

async function pixels(canvas: HTMLCanvasElement, name: string): Promise<ImageData> {
  const shot = await page
    .elementLocator(canvas)
    .screenshot({ base64: true, path: `__screenshots__/render-worker-evidence/${name}.png` });
  const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (c) =>
    c.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const target = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = target.getContext('2d');
  if (context === null) throw new Error('Pixel decoder unavailable');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, target.width, target.height);
}
function difference(a: ImageData, b: ImageData): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
  return sum / (a.data.length * 255);
}
export async function verifyRenderWorkerContent(mode: string): Promise<void> {
  await page.viewport(800, 600);
  const images: ImageData[][] = [];
  for (const tier of ['engine-worker', 'render-worker'] as const) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = (import.meta as { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT?: string } }).env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 64 : 128;
    canvas.style.width = canvas.style.height = '128px';
    // Bound App's CSS/DPR sizing too; width/height alone are only the initial buffer.
    canvas.setAttribute('data-forgeax-render-width-limit', String(canvas.width));
    canvas.setAttribute('data-forgeax-render-height-limit', String(canvas.height));
    document.body.append(canvas);
    const channel = new MessageChannel();
    const app = (
      await createApp(
        canvas,
        {
          execution: {
            workers: { engine: true, render: tier === 'render-worker', kernels: false },
            bootstrap: ['skin', 'morph', 'instances', 'points', 'lines'].includes(mode)
              ? new URL('./render-worker-geometry-bootstrap.ts', import.meta.url)
              : new URL('./render-worker-content-bootstrap.ts', import.meta.url),
            bootstrapData: mode,
            bootstrapPort: channel.port2,
            startupTimeoutMs: 90_000,
          },
        },
        { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
      )
    ).unwrap();
    const errors: unknown[] = [];
    app.onError((error) => errors.push(error));
    let readyFrames = 0;
    const onCompleted = (event: Event) => {
      const frame = (event as CustomEvent<BrowserFrameCompleted>).detail;
      if (frame.presentation === 'ready') readyFrames++;
    };
    // Execution counters include native preparation barriers. Only the App's
    // completed ready-picture signal qualifies the before/after pixel oracle.
    canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
    const completed = () => readyFrames;
    const request = (command: string) =>
      new Promise<{
        acknowledgments: number;
        errors: readonly string[];
        environmentReady?: boolean;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Source fixture did not respond')), 5000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        channel.port1.postMessage(command);
      });
    try {
      app.start().unwrap();
      await expect.poll(completed, { timeout: 60_000 }).toBeGreaterThan(5);
      if (mode === 'environment')
        await expect
          .poll(async () => (await request('inspect')).environmentReady, { timeout: 60_000 })
          .toBe(true);
      expect(canvas.width).toBeLessThanOrEqual(128);
      expect(canvas.height).toBeLessThanOrEqual(128);
      const before = await pixels(canvas, `${tier}-${mode}-before`);
      const initial = completed();
      await request('update');
      await expect.poll(completed, { timeout: 60_000 }).toBeGreaterThan(initial + 5);
      const after = await pixels(canvas, `${tier}-${mode}-after`);
      expect((await request('inspect')).errors, `${tier}:${mode}`).toEqual([]);
      expect(difference(before, after), `${tier}:${mode}`).toBeGreaterThan(0.003);
      if (mode === 'target') {
        // The blue cube is outside the display camera; only the target camera can see it.
        // Headed Vitest can scale its iframe; read the actual screenshot extent.
        const center =
          (Math.floor(before.height / 2) * before.width + Math.floor(before.width / 2)) * 4;
        expect(before.data[center + 2]).toBeGreaterThan((before.data[center] ?? 0) + 40);
        expect(after.data[center + 2]).toBeGreaterThan((after.data[center + 1] ?? 0) + 40);
      }
      await expect
        .poll(async () => (await request('inspect')).acknowledgments, {
          timeout: 120_000,
          interval: 100,
        })
        .toBeGreaterThanOrEqual(60);
      await expect.poll(completed,{timeout:60_000}).toBeGreaterThanOrEqual(60);
      if (tier === 'render-worker') {
        const epoch = app.execution?.report().render?.epoch ?? 0;
        const count = (await request('inspect')).acknowledgments;
        await request('recover');
        await expect
          .poll(() => app.execution?.report().render?.epoch ?? 0, { timeout: 60_000 })
          .toBeGreaterThan(epoch);
        await expect
          .poll(async () => (await request('inspect')).acknowledgments, { timeout: 60_000 })
          .toBeGreaterThan(count + 5);
        const currentCanvas = app.canvas;
        if (currentCanvas === undefined) throw new Error('Recovered canvas is missing');
        await expect
          .poll(
            async () => difference(after, await pixels(currentCanvas, `${tier}-${mode}-recovered`)),
            { timeout: 60_000, interval: 500, message: `${mode} recovery` },
          )
          .toBeLessThanOrEqual(0.005);
        expect((await request('inspect')).errors, `${mode} recovery`).toEqual([]);
      }
      expect(errors).toEqual([]);
      images.push([before, after]);
    } finally {
      const currentCanvas = app.canvas;
      canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
      await app.dispose();
      channel.port1.close();
      currentCanvas?.remove();
      canvas.remove();
    }
  }
  for (const index of [0, 1])
    expect(difference(images[0]![index]!, images[1]![index]!)).toBeLessThanOrEqual(0.005);
}
