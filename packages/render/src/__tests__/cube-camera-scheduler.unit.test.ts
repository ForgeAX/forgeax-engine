import { describe, expect, it } from 'vitest';
import { createCubeCaptureScheduler } from '../capture/scheduler';
import type { CubeCameraSnapshot } from '../render-contract';
import type { RenderTarget } from '../targets/contracts';

function request(target: RenderTarget, requestVersion = 1): CubeCameraSnapshot {
  return {
    target,
    position: [0, 0, 0],
    near: 0.1,
    far: 100,
    updateIntent: 'on-demand',
    requestVersion,
    faceBudget: 2,
  };
}

describe('CubeCamera capture scheduler', () => {
  it('spends a bounded face budget and promotes only after all faces submit', () => {
    const target = {} as RenderTarget;
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 2 });
    expect(scheduler.request(request(target)).ok).toBe(true);

    scheduler.beginFrame();
    expect(scheduler.nextWork()).toHaveLength(2);
    expect(scheduler.inspect(target).pendingFaces).toHaveLength(4);
    expect(scheduler.completeSubmission(true).ok).toBe(true);
    expect(scheduler.inspect(target).activeGeneration).toBe(0);

    scheduler.beginFrame();
    expect(scheduler.nextWork()).toHaveLength(2);
    expect(scheduler.completeSubmission(true).ok).toBe(true);
    expect(scheduler.inspect(target).pendingFaces).toHaveLength(2);
    scheduler.beginFrame();
    expect(scheduler.nextWork()).toHaveLength(2);
    expect(scheduler.completeSubmission(true).ok).toBe(true);
    expect(scheduler.inspect(target).pendingFaces).toEqual([]);
    expect(scheduler.inspect(target).activeGeneration).toBe(1);
  });

  it('rejects nested capture and does not publish a partial or failed candidate', () => {
    const target = {} as RenderTarget;
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 6 });
    expect(scheduler.request(request(target)).ok).toBe(true);
    scheduler.beginFrame();
    expect(scheduler.request(request(target, 2)).ok).toBe(false);
    expect(scheduler.nextWork()).toHaveLength(2);
    expect(scheduler.completeSubmission(false).ok).toBe(false);
    expect(scheduler.inspect(target).activeGeneration).toBe(0);
    expect(scheduler.inspect(target).pendingFaces).toEqual([]);
  });

  it('waits for the FrameReceipt completion before publishing the six-face candidate', async () => {
    const target = {} as RenderTarget;
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 6 });
    expect(scheduler.request({ ...request(target), faceBudget: 6 }).ok).toBe(true);
    scheduler.beginFrame();
    expect(scheduler.nextWork()).toHaveLength(6);

    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    expect(scheduler.completeSubmission(true, completion).ok).toBe(true);
    expect(scheduler.inspect(target).activeGeneration).toBe(0);
    resolveCompletion?.();
    await completion;
    await Promise.resolve();
    expect(scheduler.inspect(target).activeGeneration).toBe(1);
  });
});
