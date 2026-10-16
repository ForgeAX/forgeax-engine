import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { Update } from '@forgeax/engine-ecs';
import { GAMEPAD_FEEDBACK_KEY, INPUT_SNAPSHOT_RESOURCE_KEY, type GamepadFeedback, type GamepadFeedbackResult, type InputSnapshot } from '@forgeax/engine-input';
import { expect, it } from 'vitest';

it.each([false, true])('transports ordered feedback through actual App/ECS with engine Worker=%s (native double)', async engine => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'getGamepads');
  const startedAt = performance.now();
  const calls: string[] = [];
  const timeline: { event: string; ms: number }[] = [];
  let pendingNative = 0;
  let pendingHighWater = 0;
  const settle = (event: string) => {
    pendingNative++;
    pendingHighWater = Math.max(pendingHighWater, pendingNative);
    timeline.push({ event, ms: performance.now() - startedAt });
    return Promise.resolve('complete').then(value => { pendingNative--; return value; });
  };
  const actuator = {
    effects: ['dual-rumble'],
    playEffect: (_: string, effect: { strongMagnitude: number }) => {
      calls.push(effect.strongMagnitude === 1 ? 'strong' : 'weak');
      return settle('play');
    },
    reset: () => { calls.push('stop'); return settle('reset'); },
  };
  const pad = { index: 0, id: 'injected contract controller', connected: true, mapping: 'standard', buttons: [], axes: [], vibrationActuator: actuator };
  const pads = Array.from({ length: 4 }, (_, index) => ({ ...pad, index, id: `injected contract controller ${index}` }));
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; document.body.append(canvas);
  const channel = new MessageChannel();
  const results: GamepadFeedbackResult[] = [];
  const loadFrames: { mode: string; targets: number; tickStart: number; producerMs: number }[] = [];
  channel.port1.onmessage = event => {
    if (event.data.kind === 'feedback-result') results.push(event.data.result);
    if (event.data.kind === 'load-frame') loadFrames.push(event.data);
  };
  let app: App | undefined;
  try {
    const created = await createApp(canvas, {
      silenceUnhandledErrors: true,
      execution: { bootstrap: new URL('./gamepad-feedback-bootstrap.ts', import.meta.url),
        workers: { engine, render: false, kernels: false }, bootstrapPort: channel.port2, startupTimeoutMs: 90_000 },
    }, { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href });
    app = created.unwrap();
    expect(app.execution.report().workers.engine.enabled).toBe(engine);
    if (!engine) {
      // Host execution bootstrap receives the same port; polling below also exercises the public resource.
      app.world.addSystem(Update, { name: 'host-feedback-results', queries: [], after: ['gamepad-feedback-browser-probe'],
        fn(world) {
          const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          expect(Object.isFrozen(snapshot.gamepad(0).feedbackTarget)).toBe(true);
          const feedback = world.getResource<GamepadFeedback>(GAMEPAD_FEEDBACK_KEY);
          results.push(...feedback.readResults());
        },
      }).unwrap();
    }
    app.start().unwrap();
    await expect.poll(() => results.length, { timeout: 90_000 }).toBe(3);
    expect(calls).toEqual(['strong', 'weak', 'stop']);
    expect(results.map(result => [result.id, result.status])).toEqual([[1, 'preempted'], [2, 'preempted'], [3, 'complete']]);
    await expect.poll(() => app.execution.report().frame.completed, { timeout: 90_000 }).toBeGreaterThanOrEqual(60);
    expect(app.lastError).toBeUndefined();
    const coldTimeline = timeline.slice();
    const samples: unknown[] = [];
    // Frozen software diagnostic: 10 warm-up + 60 measured Update intervals per
    // group. Actual App/Worker/Renderer cadence includes the native double;
    // producer CPU excludes Host input/dispatch. No mechanical or GPU-time claim.
    for (const targets of [1, 2, 4]) for (const mode of ['idle', 'event', 'burst']) {
      loadFrames.length = 0;
      const completedBefore = app.execution.report().frame.completed;
      channel.port1.postMessage({ kind: 'load', mode, targets });
      await expect.poll(() => loadFrames.filter(frame => frame.mode === mode && frame.targets === targets).length,
        { timeout: 90_000 }).toBeGreaterThanOrEqual(10);
      const nativeBefore = calls.length;
      await expect.poll(() => loadFrames.filter(frame => frame.mode === mode && frame.targets === targets).length,
        { timeout: 90_000 }).toBeGreaterThanOrEqual(71);
      channel.port1.postMessage({ kind: 'idle' });
      const measured = loadFrames.filter(frame => frame.mode === mode && frame.targets === targets).slice(10, 71);
      const intervals = measured.slice(1).map((frame, i) => frame.tickStart - measured[i].tickStart);
      const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)];
      samples.push({ mode, targets, completedFrames: app.execution.report().frame.completed - completedBefore,
        intervalP50Ms: percentile(intervals, 0.5), intervalP95Ms: percentile(intervals, 0.95),
        producerP50Ms: percentile(measured.slice(1).map(frame => frame.producerMs), 0.5),
        producerP95Ms: percentile(measured.slice(1).map(frame => frame.producerMs), 0.95), intervals,
        producerSamples: measured.slice(1).map(frame => frame.producerMs), nativeCalls: calls.length - nativeBefore });
      if (mode === 'idle') expect(calls.length - nativeBefore).toBe(0);
    }
    await expect.poll(() => pendingNative).toBe(0);
    expect(pendingHighWater).toBeLessThanOrEqual(32);
    expect(app.lastError).toBeUndefined();
    console.log('ROI20_APP_PERFORMANCE ' + JSON.stringify({ engineWorker: engine, physicalEvidence: false,
      coldTimeline, sampleCount: 60, warmup: 10, pendingHighWater, pendingAfter: pendingNative, samples }));
  } finally {
    if (app) { (await app.dispose()).unwrap(); app.canvas?.remove(); }
    channel.port1.close(); channel.port2.close(); canvas.remove();
    if (original) Object.defineProperty(navigator, 'getGamepads', original);
    else Reflect.deleteProperty(navigator, 'getGamepads');
  }
}, 180_000);

it('reports actual browser no-device input without attempting actuator output', () => {
  // Presence is recorded by the acceptance runner; this is independent of the native double above.
  expect(typeof navigator.getGamepads).toBe('function');
  const pads = navigator.getGamepads();
  expect(Array.isArray(pads)).toBe(true);
});
