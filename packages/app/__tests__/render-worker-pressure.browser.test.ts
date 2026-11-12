import { commands } from 'vitest/browser';

declare module 'vitest/browser' {
  interface BrowserCommands {
    recordRenderWorkerEvidence(tier: string, evidence: unknown): Promise<void>;
  }
}

import { type BrowserFrameCompleted, type ExecutionRendererInspectionResult, FORGEAX_FRAME_COMPLETED_EVENT } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { expect, it } from 'vitest';
import { DEFAULT_RENDER_PIPELINE_CAPACITY } from '../src/execution/protocol';

const LIGHTWEIGHT = (import.meta as { env: { FORGEAX_BROWSER_CI_LIGHTWEIGHT?: string } }).env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
const PRESSURE_ENTITIES = LIGHTWEIGHT ? 1000 : 50_000;
const PING_SAMPLES = LIGHTWEIGHT ? 20 : 100;

it.each([
  'engine-worker',
  'render-worker',
] as const)('measures a changing scene with the full Renderer in %s', async (tier) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  // Bound App's CSS-sized buffer too; width/height alone are only the initial buffer.
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
  let presentationReady = false;
  const onCompleted = (event: Event) => {
    if ((event as CustomEvent<BrowserFrameCompleted>).detail.presentation === 'ready')
      presentationReady = true;
  };
  canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
  const completed = () =>
    tier === 'render-worker'
      ? (execution.report().render?.completedFrame ?? 0)
      : execution.report().frame.completed;
  app.onError((error) => errors.push(error));
  try {
    app.start().unwrap();
    // GPU-completed receipts can still be waiting for scene pipelines. Both
    // facts must hold within the original startup budget before measuring.
    await expect
      .poll(() => presentationReady && completed() > 1, { timeout: 90_000 })
      .toBe(true);
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
      // The default render pipeline admits this many sealed pictures before
      // GPU completion; the measured window must never exceed it.
      expect(
        (final.render?.submittedFrame ?? 0) - (final.render?.completedFrame ?? 0),
      ).toBeLessThanOrEqual(DEFAULT_RENDER_PIPELINE_CAPACITY);
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
    canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onCompleted);
    await app.dispose();
    channel.port1.close();
    app.canvas?.remove();
    canvas.remove();
  }
}, 180_000);
