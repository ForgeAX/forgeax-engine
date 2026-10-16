import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginLearnRenderTestLifecycle,
  disposeLearnRenderTestApp,
  waitForLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';

interface LifecycleProbe {
  owner?: object;
  app?: {
    dispose(): Promise<unknown>;
    renderer: { dispose(): Promise<unknown> };
  };
  pendingDisposal?: Promise<void>;
}

let reflectionControls: HTMLDivElement | undefined;

beforeEach(() => {
  reflectionControls = document.createElement('div');
  reflectionControls.id = 'reflection-controls';
  reflectionControls.setAttribute('role', 'group');
  reflectionControls.setAttribute('aria-label', 'Reflection controls');
  document.body.appendChild(reflectionControls);
});

afterEach(() => {
  reflectionControls?.remove();
  reflectionControls = undefined;
});

onerrorGate('hello-ssr', () => import('../main.ts'));

describe('hello-ssr bootstrap rejection', () => {
  let canvas: HTMLCanvasElement | undefined;

  afterEach(async () => {
    if (canvas === undefined) return;
    try {
      await disposeLearnRenderTestApp(canvas, 5_000);
    } finally {
      canvas.remove();
      canvas = undefined;
    }
  });

  it('keeps a missing reflection-controls failure observable', async () => {
    reflectionControls?.remove();
    reflectionControls = undefined;
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);
    await beginLearnRenderTestLifecycle(canvas);

    const missingControlsEntry = '../main.ts?missing-reflection-controls';
    await import(/* @vite-ignore */ missingControlsEntry);
    await expect(waitForLearnRenderTestBootstrap(canvas, 25_000)).rejects.toThrow(
      'Reflection controls container is missing',
    );

    const lifecycle = (
      globalThis as typeof globalThis & {
        __forgeaxLearnRenderTestLifecycle?: LifecycleProbe;
      }
    ).__forgeaxLearnRenderTestLifecycle;
    expect(lifecycle?.owner).toBe(canvas);
    const app = lifecycle?.app;
    expect(app).toBeDefined();
    if (app === undefined) throw new Error('SSR bootstrap did not register its App owner');

    let appDisposeCalls = 0;
    const appDisposeResults: unknown[] = [];
    const disposeApp = app.dispose.bind(app);
    app.dispose = async () => {
      appDisposeCalls += 1;
      const result = await disposeApp();
      appDisposeResults.push(result);
      return result;
    };
    let rendererDisposeCalls = 0;
    const rendererDisposeResults: Array<Promise<unknown>> = [];
    const disposeRenderer = app.renderer.dispose.bind(app.renderer);
    app.renderer.dispose = () => {
      rendererDisposeCalls += 1;
      const result = disposeRenderer();
      rendererDisposeResults.push(result);
      return result;
    };

    await disposeLearnRenderTestApp(canvas, 5_000);
    const completedRendererDisposals = await Promise.all(rendererDisposeResults);
    expect(appDisposeCalls).toBe(1);
    expect(rendererDisposeCalls).toBeGreaterThan(0);
    expect(appDisposeResults).toHaveLength(1);
    expect(appDisposeResults[0]).toMatchObject({ ok: true });
    for (const result of completedRendererDisposals) expect(result).toMatchObject({ ok: true });
    expect(lifecycle?.owner).toBeUndefined();
    expect(lifecycle?.app).toBeUndefined();
    expect(lifecycle?.pendingDisposal).toBeUndefined();
  }, 30_000);
});
