import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { acquireDeviceGeneration, runRecoveryStep } from '../assembly/recovery/recovery-attempt';
import {
  createRecoveryContinuation,
  createRecoveryDeadline,
  createRendererLifecycle,
  createSingleFlight,
  RECOVERY_ADAPTER_DEADLINE_MS,
  RECOVERY_DEVICE_DEADLINE_MS,
  RECOVERY_PHASES,
  RECOVERY_TOTAL_DEADLINE_MS,
} from '../assembly/renderer-lifecycle';

describe('renderer recovery lifecycle', () => {
  it('exhausts the public lifecycle states and rejects illegal transitions', () => {
    const lifecycle = createRendererLifecycle();

    expect(lifecycle.state()).toBe('alive');
    expect(lifecycle.transition('device-lost')).toBe(true);
    expect(lifecycle.transition('recovering')).toBe(true);
    expect(lifecycle.transition('alive')).toBe(true);
    expect(lifecycle.transition('faulted')).toBe(true);
    expect(lifecycle.transition('alive')).toBe(false);
    expect(lifecycle.transition('device-lost')).toBe(false);
    expect(lifecycle.transition('disposed')).toBe(true);
    expect(lifecycle.transition('alive')).toBe(false);
    expect(lifecycle.states()).toEqual([
      'alive',
      'device-lost',
      'recovering',
      'faulted',
      'disposed',
    ]);
  });

  it('shares one recovery promise and one candidate for concurrent callers', async () => {
    let attempts = 0;
    let release: (() => void) | undefined;
    const flight = createSingleFlight(async () => {
      attempts += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { candidate: attempts };
    });

    const first = flight.run();
    const second = flight.run();
    expect(first).toBe(second);
    expect(flight.inFlight()).toBe(first);
    expect(attempts).toBe(1);

    release?.();
    await expect(first).resolves.toEqual({ candidate: 1 });
    expect(flight.inFlight()).toBeUndefined();
  });

  it('enforces the 20 second attempt and 10 second acquisition budgets', () => {
    const deadline = createRecoveryDeadline(1000);

    expect(deadline.totalDeadlineMs).toBe(RECOVERY_TOTAL_DEADLINE_MS);
    expect(deadline.adapterDeadlineMs).toBe(RECOVERY_ADAPTER_DEADLINE_MS);
    expect(deadline.deviceDeadlineMs).toBe(RECOVERY_DEVICE_DEADLINE_MS);
    expect(deadline.isValid('acquire-adapter', 10_999)).toBe(true);
    expect(deadline.isValid('acquire-adapter', 11_000)).toBe(false);
    expect(deadline.isValid('acquire-device', 11_000)).toBe(false);
    expect(deadline.isValid('compile-graph', 20_999)).toBe(true);
    expect(deadline.isValid('compile-graph', 21_000)).toBe(false);
    expect(RECOVERY_PHASES).toEqual([
      'quiesce',
      'acquire-adapter',
      'acquire-device',
      'rehydrate',
      'compile-graph',
      'publish',
      'cleanup',
    ]);
  });

  it('reports acquisition phases in their execution order', async () => {
    const phases: string[] = [];
    const result = await acquireDeviceGeneration(
      { rhi },
      {} as HTMLCanvasElement,
      undefined,
      undefined,
      (phase) => phases.push(phase),
    );

    expect(result.ok).toBe(true);
    expect(phases).toEqual(['acquire-adapter', 'acquire-device']);
  });

  it('invalidates late continuation and cleans the candidate exactly once', () => {
    let cleanupCount = 0;
    const continuation = createRecoveryContinuation(createRecoveryDeadline(0), () => {
      cleanupCount += 1;
    });

    expect(continuation.isValid('compile-graph', 19_999)).toBe(true);
    continuation.abandon(20_000);
    expect(continuation.isValid('compile-graph', 20_000)).toBe(false);
    continuation.cleanupOnce();
    continuation.cleanupOnce();
    expect(cleanupCount).toBe(1);
  });

  it('invalidates an async step on timeout before a late completion can write', async () => {
    let cleanupCount = 0;
    let lateWrites = 0;
    const startedAt = Date.now();
    const deadline = {
      startedAt,
      totalDeadlineMs: 1,
      adapterDeadlineMs: 1,
      deviceDeadlineMs: 1,
      deadlineAt: startedAt + 1,
      beginDeviceAcquisition: (_now: number) => undefined,
      isValid: (
        _phase:
          | 'quiesce'
          | 'acquire-adapter'
          | 'acquire-device'
          | 'rehydrate'
          | 'compile-graph'
          | 'publish'
          | 'cleanup',
        now: number,
      ) => now < startedAt + 1,
      elapsed: (now: number) => Math.max(0, now - startedAt),
    };
    const continuation = createRecoveryContinuation(deadline, () => {
      cleanupCount += 1;
    });

    const outcome = await runRecoveryStep(
      async (attemptToken) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (attemptToken?.isValid('compile-graph', Date.now())) lateWrites += 1;
        return ok(undefined);
      },
      'compile-graph',
      deadline,
      Date.now,
      continuation,
    );

    expect(outcome.kind).toBe('timeout');
    if (outcome.kind === 'timeout') expect(outcome.error.code).toBe('webgpu-runtime-error');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lateWrites).toBe(0);
    expect(cleanupCount).toBe(1);
  });
});
