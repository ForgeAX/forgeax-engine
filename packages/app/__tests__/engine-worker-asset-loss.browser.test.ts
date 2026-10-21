import { type ExecutionApp, subscribeBrowserFrameSubmitted } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    recordRenderWorkerEvidence(tier: string, evidence: unknown): Promise<void>;
  }
}

interface AssetEvidence {
  readonly kind: 'initial' | 'committed';
  readonly worldIdentity: string;
  readonly owner: string;
  readonly handle: number;
  readonly revision: number;
  readonly color: readonly number[];
}

async function fixture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  document.body.append(canvas);
  const channel = new MessageChannel();
  const messages: AssetEvidence[] = [];
  channel.port1.onmessage = (event) => messages.push(event.data);
  const submitted: number[] = [];
  const unsubscribe = subscribeBrowserFrameSubmitted(canvas, (frame) =>
    submitted.push(frame.frameId),
  );
  const NativeWorker = globalThis.Worker;
  let engineWorker: Worker | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name === 'forgeax-engine') engineWorker = this;
    }
  };
  let app: ExecutionApp;
  try {
    app = (
      await createApp(
        canvas,
        {
          silenceUnhandledErrors: true,
          execution: {
            workers: { engine: true, render: true, kernels: false },
            bootstrap: new URL('./engine-worker-asset-loss-bootstrap.ts', import.meta.url),
            bootstrapPort: channel.port2,
            startupTimeoutMs: 90_000,
          },
        },
        { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
      )
    ).unwrap();
  } finally {
    globalThis.Worker = NativeWorker;
  }
  if (engineWorker === undefined) throw new Error('Native Engine Worker was not created');
  return {
    app,
    canvas,
    channel,
    messages,
    submitted,
    engineWorker,
    async dispose() {
      const disposed = await app.dispose();
      unsubscribe();
      channel.port1.close();
      app.canvas?.remove();
      canvas.remove();
      return disposed;
    },
  };
}

async function bluePixel(canvas: HTMLCanvasElement): Promise<readonly number[]> {
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const binary = atob(typeof shot === 'string' ? shot : shot.base64);
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const target = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = target.getContext('2d');
  if (context === null) throw new Error('Pixel decoder unavailable');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const color = [
    ...context.getImageData(Math.floor(target.width / 2), Math.floor(target.height / 2), 1, 1).data,
  ];
  expect(color[0]).toBeLessThan(20);
  expect(color[2]).toBeGreaterThan(200);
  return color;
}

it('reports lost asset authority after an unpublished commit and starts a new identity without replaying it', async () => {
  expect(globalThis.crossOriginIsolated).toBe(true);
  await page.viewport(800, 600);
  const first = await fixture();
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    first.app.start().unwrap();
    await expect
      .poll(() => first.app.execution.report().render?.completedFrame, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(60);
    first.app.pause().unwrap();
    await expect
      .poll(
        () => {
          const render = first.app.execution.report().render;
          return render?.completedFrame === render?.submittedFrame;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const initial = first.messages.find((value) => value.kind === 'initial');
    if (initial === undefined) throw new Error('Initial owner identity unavailable');
    evidence.initial = initial;
    evidence.initialPixel = await bluePixel(first.canvas);
    const before = first.app.execution.report();
    const submitted = [...first.submitted];
    first.channel.port1.postMessage('commit-before-publication');
    first.app.resume().unwrap();
    await expect
      .poll(() => first.messages.find((value) => value.kind === 'committed'), { timeout: 10_000 })
      .toBeDefined();
    const committed = first.messages.find((value) => value.kind === 'committed');
    expect(committed).toMatchObject({
      owner: initial.owner,
      handle: initial.handle,
      color: [1, 0, 0, 1],
    });
    expect(committed?.revision).toBeGreaterThan(initial.revision);
    evidence.unpublishedCommit = committed;
    first.engineWorker.terminate();
    await expect
      .poll(() => first.app.execution.report().fault, { timeout: 15_000 })
      .toMatchObject({
        code: 'app-execution-deadline-exceeded',
        retryable: false,
      });
    const lost = first.app.execution.report();
    evidence.lost = lost;
    expect(first.submitted).toEqual(submitted);
    expect(lost.render?.completedFrame).toBe(before.render?.completedFrame);
    expect(lost.render?.epoch).toBe(before.render?.epoch);
    expect(lost.render?.state).toBe('failed');
    expect(lost.engine.health).toBe('faulted');
    expect(first.app.start().ok).toBe(false);
    expect((await first.app.execution.rebuild()).ok).toBe(false);
    if (first.app.remoteEval === undefined) throw new Error('Missing public inspection owner');
    const stale = await Promise.race([
      first.app.remoteEval('return assets.identity', initial.worldIdentity).then(
        () => 'accepted',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 1000)),
    ]);
    evidence.retiredInspection = stale;
    expect(stale).toBe('rejected');
    expect(lost.world.identity).toBeNull();
    expect(await first.dispose()).toMatchObject({
      ok: false,
      error: { code: 'app-execution-deadline-exceeded', detail: { phase: 'dispose' } },
    });

    second = await fixture();
    second.app.start().unwrap();
    await expect
      .poll(() => second?.app.execution.report().render?.completedFrame, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(60);
    const fresh = second.messages.find((value) => value.kind === 'initial');
    if (fresh === undefined || second.app.remoteEval === undefined)
      throw new Error('Replacement owner unavailable');
    expect(fresh.worldIdentity).not.toBe(initial.worldIdentity);
    expect(fresh.owner).not.toBe(initial.owner);
    expect(fresh.color).toEqual([0, 0, 1, 1]);
    // Handles are realm-local numbers; the old World/owner is part of a transported reference.
    await expect(
      second.app.remoteEval(
        `return assets.read(${initial.handle}).unwrap()`,
        initial.worldIdentity,
      ),
    ).rejects.toMatchObject({ code: 'live-world-stale' });
    expect(second.app.lastError).toBeUndefined();
    evidence.replacement = fresh;
    evidence.replacementPixel = await bluePixel(second.canvas);
    evidence.replacementExecution = second.app.execution.report();
    (await second.dispose()).unwrap();
    evidence.passed = true;
  } finally {
    evidence.disposal = await first.dispose();
    if (second !== undefined) evidence.replacementDisposal = await second.dispose();
    await commands.recordRenderWorkerEvidence('engine-owner-loss', evidence);
  }
}, 180_000);
