import { type BrowserFrameSubmitted, subscribeBrowserFrameSubmitted } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import { computeDisplayScreenRay } from '../../picking/src/display-picking';

async function fixture(
  data: { stallMs?: number; cleanupMs?: number; fail?: boolean; holdFirstCompletion?: boolean },
  tier: 'render-worker' | 'engine-worker' = 'render-worker',
) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  const channel = new MessageChannel();
  const witness = new BroadcastChannel(crypto.randomUUID());
  const messages: { kind: string; tick?: number; value?: { tick: number; marker: number } }[] = [];
  witness.onmessage = (event) => messages.push(event.data);
  channel.port1.onmessage = (event) => messages.push(event.data);
  const app = (
    await createApp(
      canvas,
      {
        silenceUnhandledErrors: true,
        execution: {
          workers: { engine: true, render: tier === 'render-worker', kernels: false },
          bootstrap: new URL('./render-worker-contract-bootstrap.ts', import.meta.url),
          bootstrapData: { ...data, cleanupChannel: witness.name },
          bootstrapPort: channel.port2,
          startupTimeoutMs: 90_000,
        },
      },
      { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
    )
  ).unwrap();
  const submitted: BrowserFrameSubmitted[] = [];
  const unsubscribe = subscribeBrowserFrameSubmitted(canvas, (frame) => submitted.push(frame));
  return {
    app,
    canvas,
    channel,
    messages,
    submitted,
    releaseFirstFrame() {
      witness.postMessage({ kind: 'release-first-frame' });
    },
    async dispose() {
      const result = await app.dispose();
      unsubscribe();
      witness.close();
      channel.port1.close();
      app.canvas?.remove();
      canvas.remove();
      return result;
    },
  };
}

it('submits and executes two frames before the oldest receipt retires without admitting a third', async () => {
  const f = await fixture({ holdFirstCompletion: true });
  try {
    f.app.start().unwrap();
    await expect
      .poll(() => f.messages.filter((row) => row.kind === 'sealed').length, { timeout: 30_000 })
      .toBe(2);
    await expect
      .poll(() => f.submitted.map((frame) => frame.frameId), { timeout: 10_000 })
      .toEqual([1, 2]);
    await expect
      .poll(() => f.messages.filter((row) => row.kind === 'gpu-completed').map((row) => row.tick), {
        timeout: 30_000,
      })
      .toEqual([1, 2]);
    // The second real GPU frame is done, but the older composite receipt is held.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.app.execution?.report().frame.completed).toBe(2);
    expect(f.app.execution?.report().render?.completedFrame).toBe(0);
    expect(f.messages.filter((row) => row.kind === 'sealed').map((row) => row.tick)).toEqual([
      1, 2,
    ]);
    f.app.pause().unwrap();
    f.releaseFirstFrame();
    await expect
      .poll(() => f.app.execution?.report().render?.completedFrame, { timeout: 30_000 })
      .toBe(2);
    expect(f.app.lastError).toBeUndefined();
    f.app.resume().unwrap();
    await expect
      .poll(() => f.app.execution?.report().render?.completedFrame, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(4);
    f.app.pause().unwrap();
    expect(f.submitted.slice(0, 4).map((frame) => frame.frameId)).toEqual([1, 2, 3, 4]);
    expect(f.app.lastError).toBeUndefined();
  } finally {
    f.releaseFirstFrame();
    (await f.dispose()).unwrap();
  }
}, 90_000);

it('overlaps exactly one sealed successor, stays responsive beyond the admission timeout, and drains cleanup', async () => {
  const f = await fixture({ stallMs: 3000, cleanupMs: 50 });
  try {
    f.app.start().unwrap();
    await expect
      .poll(() => f.messages.filter((row) => row.kind === 'sealed').length, { timeout: 30_000 })
      .toBe(2);
    expect(f.app.execution?.report().render?.completedFrame).toBe(0);
    f.channel.port1.postMessage('mutate-sealed-source');
    await expect.poll(() => f.messages.some((row) => row.kind === 'mutated')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(f.app.execution?.report().frame.completed).toBe(2);
    expect(f.messages.filter((row) => row.kind === 'sealed').map((row) => row.tick)).toEqual([
      1, 2,
    ]);
    expect(f.app.lastError).toBeUndefined();
    expect(f.app.execution?.report().render?.completedFrame).toBe(0);
    f.app.pause().unwrap();
    await expect
      .poll(() => f.messages.find((row) => row.kind === 'feedback' && row.value?.tick === 2), {
        timeout: 30_000,
      })
      .toMatchObject({ value: { tick: 2, marker: 2 } });
    expect(f.messages.filter((row) => row.kind === 'sealed')).toHaveLength(2);
    f.app.resume().unwrap();
    await expect
      .poll(() => f.app.execution?.report().render?.completedFrame, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3);
    f.app.pause().unwrap();
    const report = f.app.execution?.report();
    expect(
      (report?.frame.submitted ?? 0) - (report?.render?.completedFrame ?? 0),
    ).toBeLessThanOrEqual(2);
    expect(f.submitted.slice(0, 3).map((frame) => frame.frameId)).toEqual([1, 2, 3]);
    if (f.app.remoteEval === undefined) throw new Error('Missing public eval owner');
    const pending = f.app.remoteEval('await new Promise(() => {})');
    const rejected = pending.catch((cause: unknown) => cause);
    (await f.app.dispose()).unwrap();
    expect(await rejected).toBeInstanceOf(Error);
    await expect.poll(() => f.messages.some((row) => row.kind === 'cleanup-completed')).toBe(true);
  } finally {
    (await f.dispose()).unwrap();
  }
}, 90_000);

it.each([
  'engine-worker',
  'render-worker',
] as const)('returns the submitted picture mapping through %s', async (tier) => {
  const f = await fixture({}, tier);
  try {
    f.app.start().unwrap();
    await expect.poll(() => f.submitted.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const frame = f.submitted[0];
    expect(frame?.graphGeneration).toBeGreaterThan(0);
    expect(frame?.barrelDistortion).toMatchObject({ width: 64, height: 64 });
    // Picking must use the transported picture even with a different live World.
    expect(
      computeDisplayScreenRay(new World(), 0 as never, 32, 32, frame?.barrelDistortion, 64, 64),
    ).toBeDefined();
  } finally {
    (await f.dispose()).unwrap();
  }
}, 90_000);

it('preserves a deterministic producer error without replacing the Render Worker', async () => {
  const f = await fixture({ fail: true });
  try {
    f.app.start().unwrap();
    await expect
      .poll(() => f.app.execution?.report().fault, { timeout: 30_000 })
      .toMatchObject({
        code: 'fixture-contract-invalid',
        expected: 'valid fixture data',
        hint: 'repair the fixture producer',
        detail: {
          stage: 'draw',
          cause: { subject: 'fixture' },
          publication: { epoch: 1, revision: 1, frameId: 1 },
        },
      });
    expect(f.app.execution?.report().render?.epoch).toBe(1);
  } finally {
    (await f.dispose()).unwrap();
  }
}, 90_000);

it.each([
  'source',
  'render',
] as const)('reports forced termination when %s cleanup exceeds its deadline', async (owner) => {
  const f = await fixture(owner === 'source' ? { cleanupMs: 15_000 } : { stallMs: 15_000 });
  try {
    if (owner === 'render') {
      f.app.start().unwrap();
      await expect
        .poll(() => f.messages.filter((row) => row.kind === 'sealed').length, { timeout: 30_000 })
        .toBe(2);
    }
    const result = await f.app.dispose();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'app-execution-deadline-exceeded',
        detail: { phase: 'dispose', timeoutMs: owner === 'source' ? 10_000 : 5_000 },
      },
    });
    expect(f.messages.some((row) => row.kind === 'cleanup-started')).toBe(true);
    if (owner === 'source')
      expect(f.messages.some((row) => row.kind === 'cleanup-completed')).toBe(false);
    else
      await expect
        .poll(() => f.messages.some((row) => row.kind === 'cleanup-completed'))
        .toBe(true);
  } finally {
    await f.dispose();
  }
}, 90_000);
