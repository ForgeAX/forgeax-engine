import { createApp } from '@forgeax/engine-app/browser';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

it('keeps WebGL2 available with the recorder in the actual Render Worker', async () => {
  expect((await navigator.gpu?.requestAdapter()) ?? null).toBeNull();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  canvas.style.cssText = 'width:64px;height:64px';
  document.body.append(canvas);
  let completed = 0;
  const observe = (event: Event) => {
    if ((event as CustomEvent).detail?.presentation === 'ready') completed++;
  };
  canvas.addEventListener('forgeax:frame-completed', observe);
  try {
    const created = await createApp(canvas, {
      execution: {
        workers: { engine: true, render: true, kernels: false },
        bootstrap: new URL('./webgl2-capture-bootstrap.ts', import.meta.url),
        diagnostics: { rhiCapture: true }, startupTimeoutMs: 90_000,
      },
    }, { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href });
    if (!created.ok) throw created.error;
    const app = created.value;
    try {
      app.start().unwrap();
      await expect.poll(() => completed, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
      expect(app.execution.report().workers.engine.enabled).toBe(true);
      expect(app.execution.report().workers.render.enabled).toBe(true);
      expect(app.execution.report().render?.capabilities).toMatchObject({
        backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false,
      });
      const captured = await app.remoteEval?.(`
        const result = await rhiCapture.captureFrame({snapshotTimeoutMs: 10000});
        if (!result.ok) throw result.error;
        return result.value.bytes;
      `);
      expect(captured).toBeInstanceOf(Uint8Array);
      const decoded = decodeTape(captured as Uint8Array);
      if (!decoded.ok) throw decoded.error;
      expect(buildFrameModel(decoded.value).works.length).toBeGreaterThan(0);
      expect(app.execution.report().fault).toBeNull();
    } finally { await app.dispose(); }
  } finally {
    canvas.removeEventListener('forgeax:frame-completed', observe);canvas.remove();
  }
}, 120_000);

async function displayPixels(canvas: HTMLCanvasElement) {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const encoded = typeof shot === 'string' ? shot : shot.base64;
  const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    const decoded = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = decoded.getContext('2d');
    if (!context) throw new Error('Pixel decoder required');
    context.drawImage(bitmap, 0, 0);
    return [...context.getImageData(0, 0, bitmap.width, bitmap.height).data];
  } finally { bitmap.close(); }
}

it('replaces the Render Worker after actual presentation GL loss and resumes completed pictures', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  canvas.style.cssText = 'width:64px;height:64px';
  document.body.append(canvas);
  const name = `webgl-context-loss-${crypto.randomUUID()}`;
  const channel = new BroadcastChannel(name);
  const messages: { kind: string; state?: string; backend?: string }[] = [];
  channel.onmessage = (event) => messages.push(event.data);
  const created = await createApp(canvas, {
    execution: {
      workers: { engine: true, render: true, kernels: false },
      bootstrap: new URL('./webgl2-loss-bootstrap.ts', import.meta.url),
      bootstrapData: name,
      diagnostics: { rhiCapture: true }, startupTimeoutMs: 90_000,
    },
  }, { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href });
  if (!created.ok) throw created.error;
  const app = created.value;
  try {
    app.start().unwrap();
    await expect.poll(() => app.execution.report().render?.completedFrame, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(60);
    await expect.poll(() => messages.filter((message) => message.kind === 'qualified').length, { timeout: 60_000 }).toBe(1);
    const before = app.execution.report();
    const epoch = before.render?.epoch ?? 0;
    const beforePixels = await displayPixels(canvas);
    expect(beforePixels.some((value, index) => index % 4 !== 3 && value > 40)).toBe(true);
    expect(before.render?.capabilities?.backendKind).toBe('wgpu-webgl2');
    channel.postMessage('lose');
    await expect.poll(() => messages.some((message) => message.kind === 'losing')).toBe(true);
    await expect.poll(() => app.execution.report().render?.epoch ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(epoch);
    await expect.poll(() => app.execution.report().render?.completedFrame, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(60);
    await expect.poll(() => messages.filter((message) => message.kind === 'qualified').length, { timeout: 60_000 }).toBe(2);
    if (!app.canvas) throw new Error('Replacement canvas required');
    expect(await displayPixels(app.canvas)).toEqual(beforePixels);
    expect(app.execution.report().world.identity).toBe(before.world.identity);
    expect(app.execution.report().fault).toBeNull();
    expect(messages.some((message) => message.state === 'device-lost')).toBe(true);
    expect(messages.filter((message) => message.kind === 'ready').length).toBeGreaterThanOrEqual(2);
    const captured = await app.remoteEval?.(`
      const result = await rhiCapture.captureFrame({snapshotTimeoutMs: 10000});
      if (!result.ok) throw result.error;
      return result.value.bytes;
    `);
    const decoded = decodeTape(captured as Uint8Array);
    if (!decoded.ok) throw decoded.error;
    expect(buildFrameModel(decoded.value).works.length).toBeGreaterThan(0);
  } finally {
    await app.dispose();
    channel.close();
    app.canvas?.remove();
    canvas.remove();
  }
}, 120_000);
