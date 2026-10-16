import { cdp, commands, page } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    recordRenderWorkerEvidence(tier: string, evidence: unknown): Promise<void>;
  }
}

import type { ExecutionRendererInspectionResult } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';

const LIGHTWEIGHT = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const RECOVERY_ENTITIES = LIGHTWEIGHT ? 1000 : 10_000;
const PRESSURE_ENTITIES = LIGHTWEIGHT ? 1000 : 50_000;
const PING_SAMPLES = LIGHTWEIGHT ? 20 : 100;

async function expectPicture(canvas: HTMLCanvasElement): Promise<void> {
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
  document.body.append(canvas);
  const channel = new MessageChannel();
  const messages: { ticks: number; worldIdentity: string; command: string }[] = [];
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
    channel.port1.postMessage(command);
    await expect.poll(() => messages.length, { timeout: 5000 }).toBe(1);
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
    await expectPicture(app.canvas);
    clearInterval(heartbeat);
    await expect.poll(() => pingStarted, { timeout: 5000 }).toBeUndefined();
    expect(recoveryPingMs.length).toBeGreaterThan(0);
    await commands.recordRenderWorkerEvidence(command, {
      kind: 'render-worker-recovery',
      command,
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

it.each([
  'engine-worker',
  'render-worker',
] as const)('measures a changing scene with the full Renderer in %s', async (tier) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  document.body.append(canvas);
  const channel = new MessageChannel();
  const app = (
    await createApp(
      canvas,
      {
        execution: {
          workers: { engine: true, render: tier === 'render-worker', kernels: false },
          bootstrap: new URL('./render-worker-bootstrap.ts', import.meta.url),
          bootstrapData: PRESSURE_ENTITIES,
          bootstrapPort: channel.port2,
          startupTimeoutMs: 90_000,
          frameTimeoutMs: 30_000,
        },
      },
      { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
    )
  ).unwrap();
  const execution = app.execution;
  if (execution === undefined) throw new Error('Missing execution owner');
  let lastTicks = 0;
  const samples: number[] = [];
  const errors: unknown[] = [];
  app.onError((error) => errors.push(error));
  try {
    app.start().unwrap();
    await expect
      .poll(
        () =>
          tier === 'render-worker'
            ? execution.report().render?.completedFrame
            : execution.report().frame.completed,
        { timeout: 90_000 },
      )
      .toBeGreaterThan(1);
    const request = (command: string): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Metrics deadline exceeded')), 30_000);
        channel.port1.onmessage = (event) => {
          clearTimeout(deadline);
          resolve(event.data);
        };
        channel.port1.postMessage(command);
      });
    const warmupTimings = await request('metrics');
    await request('reset-metrics');
    const initial = execution.report();
    const started = performance.now();
    const completed = () =>
      tier === 'render-worker'
        ? (execution.report().render?.completedFrame ?? 0)
        : execution.report().frame.completed;
    let previousCompleted = completed();
    let rendered = 0;
    for (let index = 0; index < PING_SAMPLES || rendered < 2; index++) {
      if (performance.now() - started > 90_000)
        throw new Error('Two pressure publications did not complete');
      await new Promise<void>((resolve, reject) => {
        const started = performance.now();
        const timeout = setTimeout(
          () => reject(new Error('Source ping deadline exceeded')),
          30_000,
        );
        channel.port1.onmessage = (event) => {
          clearTimeout(timeout);
          samples.push(performance.now() - started);
          expect(event.data.ticks).toBeGreaterThanOrEqual(lastTicks);
          lastTicks = event.data.ticks;
          resolve();
        };
        channel.port1.postMessage('ping');
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (completed() !== previousCompleted) {
        rendered++;
        previousCompleted = completed();
      }
    }
    expect(errors).toEqual([]);
    expect(lastTicks).toBeGreaterThan(1);
    const elapsedMs = performance.now() - started;
    const final = execution.report();
    if (tier === 'render-worker') {
      expect(final.frame.completed).toBeGreaterThan(initial.frame.completed);
      expect(
        (final.render?.submittedFrame ?? 0) - (final.render?.completedFrame ?? 0),
      ).toBeLessThanOrEqual(2);
    }
    const phaseTimings = await request('metrics');
    const rawPingMs = [...samples];
    samples.sort((a, b) => a - b);
    // Read after the original measurement window; this must not become timing work.
    const worldIdentity = execution.report().world.identity;
    if (!worldIdentity || app.remoteEval === undefined)
      throw new Error('Missing public eval owner');
    const rendererRead = (await app.remoteEval(
      'const inspection = await execution.inspectRenderer(); return { inspection, ownerKeys: typeof renderer === "undefined" ? null : Object.keys(renderer.inspect()).sort() };',
      worldIdentity,
    )) as { inspection: ExecutionRendererInspectionResult; ownerKeys: string[] | null };
    const inspection = rendererRead.inspection;
    if (!inspection.ok) throw inspection.error;
    expect(inspection.value.state).toBe('alive');
    expect(inspection.value.surface).toBe('available');
    expect(inspection.value.frame.frameId).toBeGreaterThan(0);
    expect(Number.isFinite(inspection.value.frame.deviceGeneration)).toBe(true);
    expect(inspection.value.frustumStats.total).toBeGreaterThan(0);
    expect(inspection.value.perFramePassNames.length).toBeGreaterThan(0);
    for (const field of [
      'profile',
      'capabilities',
      'renderScene',
      'ssrDependencies',
      'ssr',
      'meshMaterialBindings',
      'recoveryEvidence',
      'output',
      'observation',
    ])
      expect(inspection.value).toHaveProperty(field);
    if (tier === 'engine-worker')
      expect(Object.keys(inspection.value).sort()).toEqual(rendererRead.ownerKeys);
    else expect(rendererRead.ownerKeys).toBeNull();
    expect(() => JSON.stringify(inspection.value)).not.toThrow();
    expect(errors).toEqual([]);
    await commands.recordRenderWorkerEvidence(tier, {
      kind: 'render-publication-pressure',
      tier,
      entities: PRESSURE_ENTITIES,
      moving: 500,
      samples: samples.length,
      pingP50: samples[Math.floor(samples.length * 0.5)],
      pingP95: samples[Math.ceil(samples.length * 0.95) - 1],
      pingMax: samples.at(-1),
      rawPingMs,
      phaseTimings,
      warmupTimings,
      elapsedMs,
      initial,
      report: final,
      rendererRead,
    });
  } finally {
    await app.dispose();
    channel.port1.close();
    app.canvas?.remove();
    canvas.remove();
  }
}, 180_000);
