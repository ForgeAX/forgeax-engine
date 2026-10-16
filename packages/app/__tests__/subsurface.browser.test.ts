import { createApp } from '@forgeax/engine-app/browser';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

async function image(canvas: HTMLCanvasElement, name: string): Promise<ImageData> {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true,
    path: `__screenshots__/subsurface-evidence/${name}.png` });
  const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const target = new OffscreenCanvas(bitmap.width, bitmap.height), context = target.getContext('2d');
  if (!context) throw new Error('Pixel decoder unavailable');
  context.drawImage(bitmap, 0, 0); bitmap.close();
  return context.getImageData(0, 0, target.width, target.height);
}
function difference(a: ImageData, b: ImageData): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0));
  return sum / (a.data.length * 255);
}

// Runtime owns rigid material numerics. Skin exercises material and joint
// publication together while retaining the pixel comparison between layouts.
it('publishes skinned Standard diffusion through both real Worker layouts', async () => {
  const mode = 'skin';
  await page.viewport(800, 600);
  const images: ImageData[] = [];
    for (const renderWorker of [false, true]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      canvas.style.width = canvas.style.height = '128px';
      document.body.append(canvas);
      const channel = new MessageChannel();
      const app = (await createApp(canvas, { execution: {
        workers: { engine: true, render: renderWorker, kernels: false },
        bootstrap: new URL('./subsurface-bootstrap.ts', import.meta.url), bootstrapData: mode,
        bootstrapPort: channel.port2, diagnostics: { rhiCapture: true }, startupTimeoutMs: 90_000,
      } }, { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href })).unwrap();
      const errors: unknown[] = [];
      app.onError((error) => errors.push(error));
      const completed = () => renderWorker ? (app.execution?.report().render?.completedFrame ?? 0)
        : (app.execution?.report().frame.completed ?? 0);
      const request = (command: string) => new Promise<{ acknowledgments: number; errors: readonly string[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SSS source did not respond')), 5000);
        channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
        channel.port1.postMessage(command);
      });
      const advance = async () => {
        const initial = completed();
        await expect.poll(completed, { timeout: 60_000 }).toBeGreaterThanOrEqual(initial + 60);
      };
      try {
        app.start().unwrap();
        await advance();
        const baseline = await image(canvas, `${mode}-${renderWorker}-zero`);
        await request('enable'); await advance();
        const active = await image(canvas, `${mode}-${renderWorker}-active`);
        expect(difference(baseline, active), 'published radius must change diffuse pixels').toBeGreaterThan(.001);
        images.push(active);
        const identity = app.execution?.report().world.identity;
        if (!app.remoteEval || identity == null) throw new Error('Missing public source inspection capability');
        const capture = await app.remoteEval(
          'const result = await rhiCapture.captureFrame(); if (!result.ok) throw result.error; return result.value.bytes;', identity);
        expect(capture).toBeInstanceOf(Uint8Array);
        const model = buildFrameModel(decodeTape(capture as Uint8Array).unwrap());
        expect(model.works.some((work) => work.pipeline.shaders.some(shader => shader.entryPoint === 'cs_subsurface')),
          'actual Renderer realm capture must contain diffusion work').toBe(true);
        await request('disable'); await advance();
        expect(difference(baseline, await image(canvas, `${mode}-${renderWorker}-disabled`))).toBeLessThanOrEqual(.005);
        await request('zero'); await advance();
        expect(difference(baseline, await image(canvas, `${mode}-${renderWorker}-restored`))).toBeLessThanOrEqual(.005);
        await request('enable'); await request('pose'); await advance();
        expect(difference(active, await image(canvas, `${mode}-${renderWorker}-posed`))).toBeGreaterThan(.001);
        expect((await request('inspect')).errors).toEqual([]);
        expect(errors).toEqual([]);
        expect(app.execution?.report().fault).toBeNull();
      } finally {
        await app.dispose(); channel.port1.close(); canvas.remove();
      }
    }
    expect(difference(images[0]!, images[1]!), 'co-located and split Renderer pixels').toBeLessThanOrEqual(.005);
}, 300_000);
