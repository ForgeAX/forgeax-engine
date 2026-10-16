import { createProfiler, type ProfileFrameToken } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import {
  type DrawOwnerOptions,
  RENDER_PHASE_CATALOG,
  RENDER_RECORD_PHASE_CATALOG,
  type RenderPhase,
} from '../render-contract';

const RENDER_PHASES: readonly RenderPhase[] = [
  'extract',
  'bind-groups',
  'features',
  'sort',
  'record',
  'submission/presentation',
  'submission/finish',
  'submission/submit',
  ...RENDER_RECORD_PHASE_CATALOG,
];

function startSession(profiler: ReturnType<typeof createProfiler>) {
  const result = profiler.startCapture({ frameLimit: 1, eventLimit: 16 });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('Render profiler token and skip contract', () => {
  it('exposes owner phases and accepts an App frame token', () => {
    expect(RENDER_PHASE_CATALOG).toEqual(RENDER_PHASES);
    const token: ProfileFrameToken = {
      captureId: 'capture-0001',
      frameId: 3,
    };
    const options: DrawOwnerOptions = {
      cameraOwner: 0,
      resourceOwner: 0,
      profileFrame: token,
    };
    expect(options).toMatchObject({ profileFrame: token });
  });

  it('records Render duration and skip facts without fabricating skip duration', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: RENDER_PHASE_CATALOG } });
    const session = startSession(profiler);
    expect(session.beginFrame(1).ok).toBe(true);
    for (const phase of ['extract', 'features', 'sort', 'record'] as const) {
      expect(session.beginPhase({ source: 'render', phase }).ok).toBe(true);
      expect(session.endPhase().ok).toBe(true);
    }
    expect(
      session.recordSkip({
        source: 'render',
        phase: 'bind-groups',
        reason: 'camera-unavailable',
      }).ok,
    ).toBe(true);
    expect(session.endFrame().ok).toBe(true);
    const result = session.finish();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const skip = result.value.records.find(
      (record) => record.kind === 'skip' && record.phase === 'bind-groups',
    );
    expect(skip).toMatchObject({ kind: 'skip', reason: 'camera-unavailable' });
    expect(skip && 'durationMicros' in skip).toBe(false);
  });

  it('supports a direct Render-only frame when no App token is supplied', () => {
    const profiler = createProfiler({ phaseCatalog: { app: [], render: RENDER_PHASE_CATALOG } });
    const session = startSession(profiler);
    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase({ source: 'render', phase: 'record' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);
    const result = session.finish();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.records[0]).toMatchObject({ source: 'render', frameId: 1 });
  });
});
