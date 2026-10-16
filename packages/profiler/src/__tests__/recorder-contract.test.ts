import { describe, expect, it } from 'vitest';
import { createProfiler } from '../profiler.js';

const TEST_PHASE_CATALOG = { app: ['frame-total'], render: ['record'] } as const;

function createClock() {
  let current = 1000;
  return {
    nowMicros() {
      current += 10;
      return current;
    },
  };
}

function expectOk<T>(result: { ok: boolean; value?: T; error?: { code: string } }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error?.code ?? 'unexpected profiler error');
  return result.value as T;
}

describe('bounded profiler recorder contract', () => {
  it('rejects invalid limits before entering an active capture', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });

    for (const limits of [
      { frameLimit: 0, eventLimit: 1 },
      { frameLimit: 1, eventLimit: 0 },
      { frameLimit: -1, eventLimit: 1 },
      { frameLimit: 1.5, eventLimit: 1 },
      { frameLimit: Number.POSITIVE_INFINITY, eventLimit: 1 },
    ]) {
      const result = profiler.startCapture(limits);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('capture-boundary-invalid');
    }
    expect(profiler.activeCaptureId()).toBeUndefined();
  });

  it('keeps one active capture and reports its identity on conflict', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 2, eventLimit: 4 }));
    const second = profiler.startCapture({ frameLimit: 2, eventLimit: 4 });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('capture-already-active');
      if (second.error.code === 'capture-already-active') {
        expect(second.error.detail.captureId).toBe(session.captureId);
      }
    }
    expect(profiler.activeCaptureId()).toBe(session.captureId);
  });

  it('pairs open phases and preserves a complete bounded artifact', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase({ source: 'app', phase: 'frame-total' }));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());

    expect(artifact.completeness.status).toBe('complete');
    expect(artifact.records).toHaveLength(1);
    expect(artifact.records[0]?.kind).toBe('phase');
  });

  it('defers capture event object materialization until finish', () => {
    const allocationReport = { profilerEventObjectAllocations: 0 };
    const profiler = createProfiler({
      clock: createClock(),
      phaseCatalog: TEST_PHASE_CATALOG,
      allocationReport,
    });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase({ source: 'app', phase: 'frame-total' }));
    expectOk(session.endPhase());
    expect(allocationReport.profilerEventObjectAllocations).toBe(0);
    expectOk(session.endFrame());
    expectOk(session.finish());
    expect(allocationReport.profilerEventObjectAllocations).toBe(1);
  });

  it('accepts a phase catalog registered after capture starts', () => {
    const profiler = createProfiler({ clock: createClock() });
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(profiler.registerPhaseCatalog('app', TEST_PHASE_CATALOG.app));
    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase('app', 'frame-total'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());

    expect(artifact.records).toHaveLength(1);
    expect(artifact.records[0]?.kind).toBe('phase');
  });

  it('releases a phase catalog lease without mutating a finished capture', () => {
    const profiler = createProfiler({ clock: createClock() });
    const release = expectOk(profiler.registerPhaseCatalog('app', TEST_PHASE_CATALOG.app));
    const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 2 }));

    expectOk(session.beginFrame(1));
    expectOk(session.beginPhase('app', 'frame-total'));
    expectOk(session.endPhase());
    expectOk(session.endFrame());
    const artifact = expectOk(session.finish());
    release();
    release();

    expect(profiler.phaseCatalog.app).toEqual([]);
    expect(artifact.phaseCatalog.app).toEqual(TEST_PHASE_CATALOG.app);
    expect(profiler.registerPhaseCatalog('app', TEST_PHASE_CATALOG.app).ok).toBe(true);
  });

  it('stops record growth after event overflow while retaining scalar accounting', () => {
    const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
    const session = expectOk(profiler.startCapture({ frameLimit: 20, eventLimit: 2 }));

    for (let frameId = 1; frameId <= 20; frameId += 1) {
      expectOk(session.beginFrame(frameId));
      expectOk(session.recordSkip({ source: 'render', phase: 'record', reason: 'no-render' }));
      expectOk(session.endFrame());
    }
    const artifact = expectOk(session.finish());

    expect(artifact.completeness.status).toBe('overflow');
    expect(artifact.records.length).toBe(2);
    expect(artifact.completeness.retainedEventCount).toBe(2);
    expect(artifact.completeness.droppedEventCount).toBeGreaterThan(0);
    expect(artifact.completeness.firstAffectedFrameId).toBe(3);
    expect(artifact.completeness.lastAffectedFrameId).toBe(20);
  });

  it('returns partial structured errors for a sink Result.err and a sink throw', () => {
    const sinks = [
      { write: () => ({ ok: false as const, error: { code: 'profile-sink-failed' as const } }) },
      {
        write: () => {
          throw new Error('sink unavailable');
        },
      },
    ];

    for (const sink of sinks) {
      const profiler = createProfiler({ clock: createClock(), sink });
      const session = expectOk(profiler.startCapture({ frameLimit: 1, eventLimit: 1 }));
      const result = session.finish();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('profile-sink-failed');
        expect(result.error.expected).toContain('partial');
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
    }
  });
});
