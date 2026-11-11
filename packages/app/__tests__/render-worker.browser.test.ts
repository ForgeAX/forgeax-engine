import { cdp, commands, page } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    recordRenderWorkerEvidence(tier: string, evidence: unknown): Promise<void>;
    renderWorkerDevTools(action: 'open' | 'close', targetId: string): Promise<string | undefined>;
  }
}

import { type BrowserFrameCompleted, FORGEAX_FRAME_COMPLETED_EVENT } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';

const LIGHTWEIGHT = (import.meta as { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT?: string } }).env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const RECOVERY_ENTITIES = LIGHTWEIGHT ? 1000 : 10_000;

async function expectPicture(canvas: HTMLCanvasElement): Promise<void> {
  let ready = false;
  const onCompleted = (event: Event) => {
    if ((event as CustomEvent<BrowserFrameCompleted>).detail.presentation === 'ready') ready = true;
  };
  canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
  try {
    await expect.poll(() => ready, { timeout: 60_000 }).toBe(true);
  } finally {
    canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
  }
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (character) =>
    character.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const target = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = target.getContext('2d');
  if (context === null) throw new Error('Pixel decoder unavailable');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, target.width, target.height).data;
  let changed = 0;
  for (let index = 4; index < pixels.length; index += 4) {
    if (
      Math.abs((pixels[index] ?? 0) - (pixels[0] ?? 0)) +
        Math.abs((pixels[index + 1] ?? 0) - (pixels[1] ?? 0)) +
        Math.abs((pixels[index + 2] ?? 0) - (pixels[2] ?? 0)) >
      20
    )
      changed++;
  }
  expect(changed).toBeGreaterThan(100);
}

it.each([
  'terminate-render',
  'lose-device',
  'lose-device-with-resident-mesh',
])('preserves World and freezes simulation during known %s recovery and host canvas replacement', async (command) => {
  await page.viewport(800, 600);
  const before = await cdp().send('Target.getTargets');
  const initialTargets = new Set(
    before.targetInfos.map((target: { targetId: string }) => target.targetId),
  );
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  canvas.style.width = '128px';
  canvas.style.height = '128px';
  // Bound App's CSS-sized buffer too; width/height alone are only the initial buffer.
  canvas.setAttribute('data-forgeax-render-width-limit', String(canvas.width));
  canvas.setAttribute('data-forgeax-render-height-limit', String(canvas.height));
  document.body.append(canvas);
  const channel = new MessageChannel();
  const messages: { ticks: number; worldIdentity: string; command: string; error?: string; adapter?: Record<string, unknown>; meshReceipt?: { frameId: number; deviceGeneration: number } }[] = [];
  let devtoolsTarget: string | undefined;
  const lifecycle: { phase: string; epoch: number; ticks: number; worldIdentity: string }[] = [];
  const recoveryPingMs: number[] = [];
  let pingStarted: number | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  channel.port1.onmessage = (event) => {
    if (event.data.kind === 'render-lifecycle') {
      lifecycle.push(event.data);
      return;
    }
    messages.push(event.data);
    if (event.data.command === 'ping' && pingStarted !== undefined) {
      recoveryPingMs.push(performance.now() - pingStarted);
      pingStarted = undefined;
    }
  };
  channel.port1.start();
  const result = await createApp(
    canvas,
    {
      execution: {
        workers: { engine: true, render: true, kernels: false },
        bootstrap: new URL('./render-worker-bootstrap.ts', import.meta.url),
        bootstrapPort: channel.port2,
        bootstrapData: RECOVERY_ENTITIES,
        startupTimeoutMs: 90_000,
        frameTimeoutMs: 30_000,
      },
    },
    { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
  );
  if (!result.ok) throw result.error;
  const app = result.value;
  const execution = app.execution;
  if (execution === undefined) throw new Error('Execution control is missing');
  try {
    app.start().unwrap();
    await expect
      .poll(() => execution.report().render?.completedFrame, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expectPicture(canvas);
    const originalWorld = execution.report().world.identity;
    if (command === 'lose-device-with-resident-mesh') {
      const target = await cdp().send('Target.getTargetInfo');
      devtoolsTarget = await commands.renderWorkerDevTools('open', target.targetInfo.targetId);
      expect(devtoolsTarget).toBeDefined();
    }
    channel.port1.postMessage(command);
    await expect.poll(() => messages.length, { timeout: 30_000 }).toBe(1);
    expect(messages[0]?.error).toBeUndefined();
    if (command === 'lose-device-with-resident-mesh')
      expect(messages[0]?.meshReceipt?.frameId).toBeGreaterThan(0);
    const ticks = messages[0]?.ticks ?? Number.NaN;
    await expect.poll(() => execution.report().render?.epoch, { timeout: 40_000 }).toBe(2);
    // A silent Worker termination is detected by the original transport deadline.
    // Simulation remains independent before loss is known, then freezes through recovery.
    channel.port1.postMessage('ping');
    await expect.poll(() => messages.length, { timeout: 5000 }).toBe(2);
    expect(messages[1]?.ticks).toBeGreaterThanOrEqual(ticks);
    expect(messages[1]?.worldIdentity).toBe(originalWorld);
    heartbeat = setInterval(() => {
      if (pingStarted === undefined) {
        pingStarted = performance.now();
        channel.port1.postMessage('ping');
      }
    }, 25);
    await expect
      .poll(() => execution.report().render?.completedFrame, { timeout: 60_000 })
      .toBeGreaterThan(0);
    await expect.poll(() => lifecycle.filter((row) => row.epoch === 2).length).toBe(2);
    const lost = lifecycle.find((row) => row.phase === 'render-lost' && row.epoch === 2);
    const ready = lifecycle.find((row) => row.phase === 'render-ready' && row.epoch === 2);
    expect(lost?.ticks).toBeGreaterThanOrEqual(ticks);
    expect(ready?.ticks).toBeGreaterThanOrEqual(lost?.ticks ?? Number.NaN);
    expect(ready?.ticks).toBeLessThanOrEqual((lost?.ticks ?? Number.NaN) + 2);
    expect(lost?.worldIdentity).toBe(originalWorld);
    expect(ready?.worldIdentity).toBe(originalWorld);
    expect(execution.report().world.identity).toBe(originalWorld);
    expect(canvas.isConnected).toBe(false);
    expect(app.canvas?.isConnected).toBe(true);
    expect(app.lastError).toBeUndefined();
    if (app.canvas === undefined) throw new Error('Replacement canvas missing');
    if (command === 'lose-device-with-resident-mesh') {
      let completed = 0;
      const onCompleted = () => { completed++; };
      app.canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
      try {
        await expect.poll(() => completed, { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
      } finally {
        app.canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
      }
    }
    await expectPicture(app.canvas);
    clearInterval(heartbeat);
    await expect.poll(() => pingStarted, { timeout: 5000 }).toBeUndefined();
    expect(recoveryPingMs.length).toBeGreaterThan(0);
    await commands.recordRenderWorkerEvidence(command, {
      kind: 'render-worker-recovery',
      command,
      adapter: messages[0]?.adapter,
      meshReceipt: messages[0]?.meshReceipt,
      entities: RECOVERY_ENTITIES,
      samples: recoveryPingMs.length,
      pingMax: Math.max(...recoveryPingMs),
      rawPingMs: recoveryPingMs,
      report: execution.report(),
      lifecycle,
    });
  } catch (cause) {
    await commands.recordRenderWorkerEvidence(command, {
      kind: 'render-worker-recovery-failure',
      command,
      report: execution.report(),
    });
    throw cause;
  } finally {
    clearInterval(heartbeat);
    if (devtoolsTarget !== undefined)
      await commands.renderWorkerDevTools('close', devtoolsTarget).catch(() => {});
    await app.dispose();
    channel.port1.close();
    app.canvas?.remove();
    canvas.remove();
  }
  expect(execution.report().render?.state).toBe('stopped');
  await expect
    .poll(
      async () => {
        const targets = await cdp().send('Target.getTargets');
        return targets.targetInfos.filter(
          (target: { type: string; targetId: string }) =>
            target.type === 'worker' && !initialTargets.has(target.targetId),
        );
      },
      { timeout: 10_000 },
    )
    .toEqual([]);
}, 180_000);
