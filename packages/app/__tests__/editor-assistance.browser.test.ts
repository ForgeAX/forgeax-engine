import { serializableDetail } from '../src/execution/worker-error';
import { type BrowserFrameSubmitted, subscribeBrowserFrameSubmitted } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';

it.each([
  { engine: false, render: false },
  { engine: true, render: false },
  { engine: true, render: true },
])('renders fixed helper mesh assets and submitted handles with engine=$engine, render=$render', async ({ engine, render }) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  canvas.style.width = canvas.style.height = '96px';
  canvas.setAttribute('data-forgeax-render-width-limit', '96');
  canvas.setAttribute('data-forgeax-render-height-limit', '96');
  document.body.append(canvas);
  const channel = new MessageChannel();
  let source: { entity: number; worldIdentity: string; count: number } | undefined;
  channel.port1.onmessage = (event) => {
    if (event.data.kind === 'editor-source') source = event.data;
  };
  const submitted: BrowserFrameSubmitted[] = [];
  const unsubscribe = subscribeBrowserFrameSubmitted(canvas, (frame) => {
    submitted.push(frame);
    if (submitted.length > 4) submitted.shift();
  });
  const app = (
    await createApp(
      canvas,
      {
        silenceUnhandledErrors: true,
        execution: {
          workers: { engine, render, kernels: false },
          bootstrap: new URL('./editor-assistance-bootstrap.ts', import.meta.url),
          bootstrapPort: channel.port2,
          startupTimeoutMs: 90_000,
        },
      },
      { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
    )
  ).unwrap();
  const errors: unknown[] = [];
  const unsubscribeErrors = app.onError((error) => {
    if (errors.length < 4) errors.push(serializableDetail(error));
  });
  try {
    app.start().unwrap();
    try {
      await expect
        .poll(
          () =>
            source !== undefined &&
            submitted.some((frame) =>
              frame.editorAssistance?.views.some((view) =>
                view.hits.some((hit) => hit.action.entity === source?.entity),
              ),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
    } catch (cause) {
      const report = app.execution?.report();
      throw new Error(
        JSON.stringify({
          source,
          errors,
          fault: report?.fault,
          health: report?.health,
          render: report?.render,
          frame: report?.frame,
          lastError: app.lastError?.message,
          submitted: submitted.map((frame) => ({
            frameId: frame.frameId,
            presentation: frame.receipt?.presentation,
            editor: frame.editorAssistance?.views.map((view) => ({
              identity: view.identity,
              hits: view.hits.length,
            })),
          })),
        }),
        { cause },
      );
    }
    await expect
      .poll(() => canvas.forgeaxFrameProgress?.completed?.frameId ?? 0, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(60);
    const frame = [...submitted].reverse().find((frame) => frame.editorAssistance !== undefined);
    expect(source?.count).toBe(3);
    expect(frame?.editorAssistance?.sourceIdentity).toBe(source?.worldIdentity);
    expect(frame?.editorAssistance?.frameId).toBe(frame?.frameId);
    expect(frame?.editorAssistance?.deviceGeneration).toBe(frame?.deviceGeneration);
    const execution = app.execution;
    if (!execution) throw new Error('The execution report is required');
    expect(execution.report().workers.render.enabled).toBe(render);
    const shot = await page.elementLocator(canvas).screenshot({ base64: true });
    const encoded = typeof shot === 'string' ? shot : shot.base64;
    const bitmap = await createImageBitmap(
      new Blob([Uint8Array.from(atob(encoded), (x) => x.charCodeAt(0))], { type: 'image/png' }),
    );
    const decode = new OffscreenCanvas(bitmap.width, bitmap.height),
      context = decode.getContext('2d');
    if (!context) throw new Error('The screenshot decoder is required');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, decode.width, decode.height).data;
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if ((pixels[i] ?? 0) > 150 && (pixels[i + 1] ?? 0) < 80 && (pixels[i + 2] ?? 0) < 80) red++;
    expect(red).toBeGreaterThan(30);
    expect(errors).toEqual([]);
  } finally {
    unsubscribe();
    unsubscribeErrors();
    channel.port1.close();
    (await app.dispose()).unwrap();
    app.canvas?.remove();
    canvas.remove();
  }
}, 120_000);
