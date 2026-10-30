import { createApp } from '@forgeax/engine-app/browser';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';

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
