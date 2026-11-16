import { describe, expect, it } from 'vitest';
import {
  type RenderError,
  RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render.js';
import {
  PENDING_RENDER_FEATURE_ERROR_REPORT_INTERVAL_FRAMES,
  type PendingRenderFeatureErrorReport,
  reportPendingRenderFeatureErrors,
  shouldReportPendingRenderFeatureError,
} from '../features/error-reporting.js';

describe('pending render-feature error reporting', () => {
  it('reports the first failure, suppresses the hot-loop, and reopens the cooldown', () => {
    const lastReportedFrame = new Map<string, PendingRenderFeatureErrorReport>();
    expect(shouldReportPendingRenderFeatureError(lastReportedFrame, 'feature\0plan', 10)).toBe(
      true,
    );
    expect(shouldReportPendingRenderFeatureError(lastReportedFrame, 'feature\0plan', 11)).toBe(
      false,
    );
    expect(
      shouldReportPendingRenderFeatureError(
        lastReportedFrame,
        'feature\0plan',
        10 + PENDING_RENDER_FEATURE_ERROR_REPORT_INTERVAL_FRAMES,
      ),
    ).toBe(true);
  });
});

describe('changed render-feature failures', () => {
  it('reports a new cause immediately without flooding repeats', () => {
    const lastReportedFrame = new Map<string, PendingRenderFeatureErrorReport>();
    const reported: RenderError[] = [];
    const registry = { fire: (error: RenderError) => reported.push(error) };
    const failure = (message: string) =>
      new RenderFeatureStageFailedError('recovery', 0, 'plan', 'next-frame', new Error(message));
    reportPendingRenderFeatureErrors([failure('invalid-format')], 1, lastReportedFrame, registry);
    reportPendingRenderFeatureErrors([failure('invalid-format')], 2, lastReportedFrame, registry);
    reportPendingRenderFeatureErrors([failure('cycle')], 3, lastReportedFrame, registry);
    expect(reported).toHaveLength(2);
    reportPendingRenderFeatureErrors([failure('cycle')], 4, lastReportedFrame, registry);
    expect(reported).toHaveLength(2);
    expect(lastReportedFrame.size).toBe(1);
  });

  it('keeps retryable GPU program warmup silent and reports permanent preparation failures', () => {
    const lastReportedFrame = new Map<string, PendingRenderFeatureErrorReport>();
    const reported: RenderError[] = [];
    const registry = { fire: (error: RenderError) => reported.push(error) };
    const pending = new RenderFeaturePreparationFailedError(
      'warmup',
      0,
      'prepare-gpu-program',
      'pipeline',
      'program',
      'registry module pending',
      'next-frame',
    );
    const compileFailure = new RenderFeaturePreparationFailedError(
      'warmup',
      0,
      'prepare-gpu-program',
      'pipeline',
      'program',
      'shader-compile-failed',
      'renderer-recover',
    );
    const unavailable = new RenderFeaturePreparationFailedError(
      'warmup',
      0,
      'prepare-gpu-program',
      'pipeline',
      'program',
      'rhi-not-available: retired device',
      'renderer-recover',
    );

    reportPendingRenderFeatureErrors([pending], 1, lastReportedFrame, registry);
    expect(reported).toEqual([]);
    reportPendingRenderFeatureErrors([compileFailure], 2, lastReportedFrame, registry);
    reportPendingRenderFeatureErrors([unavailable], 3, lastReportedFrame, registry);
    expect(reported).toEqual([compileFailure, unavailable]);
  });
});
