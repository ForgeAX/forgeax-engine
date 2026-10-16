import { expect, it } from 'vitest';
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
