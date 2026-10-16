import { describe, expect, it } from 'vitest';
import { createCubeCaptureScheduler, selectCubeCaptureRenderables } from '../capture/scheduler';
import type { RenderTarget } from '../targets/contracts';

describe('CubeCamera graph contribution contract', () => {
  it('keeps Standard geometry and environment while excluding debug, UI, and self', () => {
    const target = {} as RenderTarget;
    const included = selectCubeCaptureRenderables(
      [
        { kind: 'opaque' },
        { kind: 'transparent' },
        { kind: 'environment' },
        { kind: 'debug' },
        { kind: 'ui' },
        { kind: 'opaque', target },
      ],
      target,
    );
    expect(included.map((entry) => entry.kind)).toEqual(['opaque', 'transparent', 'environment']);
  });

  it('does not promote a candidate until the graph submission completes all six faces', () => {
    const target = {} as RenderTarget;
    const scheduler = createCubeCaptureScheduler({ maxFacesPerFrame: 6 });
    expect(
      scheduler.request({
        target,
        position: [0, 0, 0],
        near: 0.1,
        far: 10,
        updateIntent: 'once',
        requestVersion: 1,
        faceBudget: 6,
      }).ok,
    ).toBe(true);
    scheduler.beginFrame();
    expect(scheduler.nextWork()).toHaveLength(6);
    expect(scheduler.completeSubmission(false).ok).toBe(false);
    expect(scheduler.inspect(target).activeGeneration).toBe(0);
    expect(scheduler.inspect(target).fallback).toBe('neutral');
  });
});
