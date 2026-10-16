import { createProfiler, type ProfileFrameToken } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import { RENDER_PHASE_CATALOG } from '../render-contract';

function start(profiler: ReturnType<typeof createProfiler>) {
  const result = profiler.startCapture({ frameLimit: 2, eventLimit: 16 });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function finish(profiler: ReturnType<typeof createProfiler>) {
  const session = profiler.activeSession();
  if (session === undefined) throw new Error('capture is not active');
  const result = session.finish();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('Render profiler phase integration', () => {
  it('joins an App token to a Render-only frame without a second capture', () => {
    const profiler = createProfiler({
      phaseCatalog: { app: ['frame-total'], render: RENDER_PHASE_CATALOG },
    });
    const session = start(profiler);
    const token: ProfileFrameToken = { captureId: session.captureId, frameId: 1 };

    expect(session.beginFrame(token.frameId).ok).toBe(true);
    expect(session.beginPhase({ source: 'app', phase: 'frame-total' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'extract' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(
      session.recordSkip({ source: 'render', phase: 'bind-groups', reason: 'no-render' }).ok,
    ).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'record' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);

    const capture = finish(profiler);
    expect(capture.captureId).toBe(token.captureId);
    expect(capture.records.map((record) => record.frameId)).toEqual([1, 1, 1, 1]);
    const skip = capture.records.find((record) => record.kind === 'skip');
    expect(skip).toMatchObject({ phase: 'bind-groups', reason: 'no-render' });
    expect(skip && 'durationMicros' in skip).toBe(false);
  });

  it('retains direct Render-only frames with a new frame identity', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: RENDER_PHASE_CATALOG } });
    const session = start(profiler);

    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'record' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);

    const capture = finish(profiler);
    expect(capture.phaseCatalog.app).toEqual([]);
    expect(capture.phaseCatalog.render).toEqual(RENDER_PHASE_CATALOG);
    expect(capture.records[0]).toMatchObject({ source: 'render', frameId: 1, phase: 'record' });
  });
});
