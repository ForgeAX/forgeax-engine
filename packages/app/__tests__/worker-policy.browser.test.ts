import { expect, it } from 'vitest';
import { workerPolicyFixture as fixture } from './worker-policy.fixture';

it('honors slow kernel startup with default workers, seals ordered frames, and preserves kernels across render replacement', async () => {
  const frameCount = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 24 : 300;
  expect(globalThis.crossOriginIsolated).toBe(true);
  const f = await fixture('delayed-kernel');
  try {
    const app = f.result.unwrap();
    const before = app.execution.report();
    expect(before.workers).toMatchObject({
      engine: { requested: 'auto', enabled: true },
      render: { requested: 'auto', enabled: true },
      kernels: { requested: 'auto', enabled: true },
    });
    app.start().unwrap();
    await expect
      .poll(() => app.execution.report().render?.completedFrame, { timeout: 180_000 })
      .toBeGreaterThanOrEqual(frameCount);
    await expect
      .poll(() => f.values.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(frameCount);
    expect(f.sealedValues.length).toBeGreaterThanOrEqual(frameCount);
    const values = f.values.slice(0, frameCount);
    expect(values).toEqual(f.sealedValues.slice(0, frameCount));
    expect(new Set(values).size).toBe(frameCount);
    expect(values.every((value, index) => value > (values[index - 1] ?? 0))).toBe(true);
    const report = app.execution.report();
    expect(report.kernelDispatch.usedShared).toBe(true);
    expect(report.kernelDispatch.completed).toBeGreaterThan(0);
    expect(
      (report.render?.submittedFrame ?? 0) - (report.render?.completedFrame ?? 0),
    ).toBeLessThanOrEqual(2);
    f.channel.port1.postMessage('terminate-render');
    await expect
      .poll(() => app.execution.report().render?.epoch, { timeout: 90_000 })
      .toBeGreaterThan(1);
    await expect
      .poll(() => app.execution.report().render?.completedFrame, { timeout: 90_000 })
      .toBeGreaterThan(report.render?.submittedFrame ?? 0);
    expect(app.execution.report().world.identity).toBe(before.world.identity);
    expect(app.execution.report().kernelDispatch.usedShared).toBe(true);
    expect(app.lastError).toBeUndefined();
  } catch (cause) {
    throw new Error(
      `Worker policy frame/recovery failure: ${JSON.stringify({
        execution: f.result.ok ? f.result.value.execution.report() : null,
        feedbackCount: f.values.length,
      })}`,
      { cause },
    );
  } finally {
    await f.dispose();
  }
}, 300_000);

it('poisons partial shared writes with split rendering, then rebuilds both owners before admitting frames', async () => {
  expect(globalThis.crossOriginIsolated).toBe(true);
  const f = await fixture();
  try {
    const app = f.result.unwrap();
    app.start().unwrap();
    await expect
      .poll(() => app.execution.report().render?.completedFrame, { timeout: 90_000 })
      .toBeGreaterThanOrEqual(2);
    const identity = app.execution.report().world.identity;
    f.channel.port1.postMessage('poison-kernel');
    await expect
      .poll(() => app.execution.report().world.health, { timeout: 30_000 })
      .toBe('poisoned');
    expect(app.execution.report().fault?.partialWrite).toBe(true);
    const stopped = app.execution.report().frame.submitted;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.execution.report().frame.submitted).toBe(stopped);
    (await app.execution.rebuild()).unwrap();
    expect(app.execution.report().world.identity).not.toBe(identity);
    expect(app.execution.report().render?.state).toBe('alive');
    app.start().unwrap();
    await expect
      .poll(() => app.execution.report().kernelDispatch.usedShared, { timeout: 90_000 })
      .toBe(true);
    await expect
      .poll(() => app.execution.report().render?.completedFrame, { timeout: 90_000 })
      .toBeGreaterThan(0);
    expect(app.execution.report().world.health).toBe('healthy');
    const feedback = f.values.length;
    await expect.poll(() => f.values.length, { timeout: 10_000 }).toBeGreaterThan(feedback + 2);
  } finally {
    await f.dispose();
  }
}, 240_000);

it('rejects an invalid kernel module during auto startup before the source reports ready', async () => {
  expect(globalThis.crossOriginIsolated).toBe(true);
  const f = await fixture('invalid-kernel');
  try {
    expect(f.result.ok).toBe(false);
    if (f.result.ok) throw new Error('invalid kernel was accepted');
    expect(f.result.error).toMatchObject({ code: 'app-execution-bootstrap-failed' });
    expect(f.values).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 120_000);
