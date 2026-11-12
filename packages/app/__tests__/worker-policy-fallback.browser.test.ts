import { expect, it, vi } from 'vitest';
import { createApp } from '../src/browser';
import type { App, CreateAppOptions } from '../src/types';
import { workerPolicyFixture } from './worker-policy.fixture';

it('keeps rendering independent and executes kernels inline without cross-origin isolation', async () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
  const fixture = await workerPolicyFixture();
  try {
    const app = fixture.result.unwrap();
    expect(app.execution.report().workers).toMatchObject({
      engine: { enabled: true },
      render: { enabled: true },
      kernels: {
        enabled: false,
        reason: 'capability-unavailable',
        missingCapabilities: expect.arrayContaining(['crossOriginIsolated']),
      },
    });
    app.start().unwrap();
    await expect
      .poll(() => app.execution.report().render?.completedFrame, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(5);
    await expect.poll(() => fixture.values.length).toBeGreaterThanOrEqual(5);
    expect(fixture.sealedValues.length).toBeGreaterThanOrEqual(5);
    const values = fixture.values.slice(0, 5);
    expect(values).toEqual(fixture.sealedValues.slice(0, 5));
    expect(new Set(values).size).toBe(5);
    expect(values.every((value, index) => value > (values[index - 1] ?? 0))).toBe(true);
    expect(app.execution.report().kernelDispatch.usedShared).toBe(false);
    expect(app.lastError).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
}, 120_000);
it('uses Host WebGL2 when neither Worker rendering backend is available', {
  timeout: 120_000,
}, async () => {
  const nativeWorker = Worker;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  const urls: string[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  canvas.setAttribute('data-forgeax-render-width-limit', '64');
  canvas.setAttribute('data-forgeax-render-height-limit', '64');
  document.body.append(canvas);
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: { requestAdapter: async () => null },
  });
  vi.stubGlobal('Worker', class extends nativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      // Both Worker backends fail; the Host still has its real WebGL2 context.
      if (options === undefined) {
        const source = `Object.defineProperty(navigator,'gpu',{value:{requestAdapter:async()=>null}});Object.defineProperty(OffscreenCanvas.prototype,'getContext',{value:()=>null});importScripts(${JSON.stringify(String(url))});`;
        url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        urls.push(String(url));
      }
      super(url, options);
    }
  });
  let app: App | undefined;
  try {
    const options: CreateAppOptions = {
      execution: {
        bootstrap: new URL('./webgl2-capture-bootstrap.ts', import.meta.url),
        workers: { engine: 'auto', render: 'auto', kernels: false },
        startupTimeoutMs: 30_000,
      },
    };
    const result = await createApp(canvas, options, {
      shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href,
    });
    app = result.unwrap();
    expect(app.execution.report().workers).toMatchObject({
      engine: { enabled: false, missingCapabilities: ['workerWebGpu'] },
      render: { enabled: false, reason: 'engine-disabled' },
    });
    expect(app.renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    app.start().unwrap();
    const running = app;
    await expect.poll(() => running.execution.report().frame.completed, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(60);
    expect(app.lastError).toBeUndefined();
  } finally {
    try {
      if (app) (await app.dispose()).unwrap();
    } finally {
      vi.unstubAllGlobals();
      if (descriptor === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', descriptor);
      for (const url of urls) URL.revokeObjectURL(url);
      canvas.remove();
    }
  }
});
