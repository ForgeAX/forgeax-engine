import { describe, expect, it } from 'vitest';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render.js';
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
});
