import { describe, expect, it } from 'vitest';
import { runProfilerCli } from '../cli.js';
import { buildProfileModel } from '../model.js';
import { createProfiler } from '../profiler.js';
import type { ProfileCapture } from '../types.js';

const TEST_PHASE_CATALOG = { app: ['frame-total'], render: ['extract'] } as const;

function createClock() {
  let micros = 0;
  return {
    nowMicros() {
      micros += 10;
      return micros;
    },
  };
}

function captureAfterFrames(frameCount: number): ProfileCapture {
  const profiler = createProfiler({ clock: createClock(), phaseCatalog: TEST_PHASE_CATALOG });
  const started = profiler.startCapture({ frameLimit: frameCount + 1, eventLimit: 4 });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.code);

  for (let frameId = 1; frameId <= frameCount; frameId += 1) {
    expect(started.value.beginFrame(frameId).ok).toBe(true);
    expect(started.value.beginPhase({ source: 'app', phase: 'frame-total' }).ok).toBe(true);
    expect(started.value.endPhase().ok).toBe(true);
    expect(started.value.beginPhase({ source: 'render', phase: 'extract' }).ok).toBe(true);
    expect(started.value.endPhase().ok).toBe(true);
    expect(started.value.endFrame().ok).toBe(true);
  }

  const finished = started.value.finish();
  expect(finished.ok).toBe(true);
  if (!finished.ok) throw new Error(finished.error.code);
  return finished.value;
}

describe('profiler overflow long-tail bounded evidence', () => {
  it('keeps nested ownership explicit without double-counting frame duration', () => {
    const profiler = createProfiler({
      clock: createClock(),
      phaseCatalog: { app: ['frame-total', 'frame-child'], render: [] },
    });
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 8 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value.beginFrame(1).ok).toBe(true);
    expect(started.value.beginPhase({ source: 'app', phase: 'frame-total' }).ok).toBe(true);
    expect(started.value.beginPhase({ source: 'app', phase: 'frame-child' }).ok).toBe(true);
    expect(started.value.endPhase().ok).toBe(true);
    expect(started.value.endPhase().ok).toBe(true);
    expect(started.value.endFrame().ok).toBe(true);

    const finished = started.value.finish();
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    const child = finished.value.records.find(
      (record) => record.kind === 'phase' && record.phase === 'frame-child',
    );
    expect(child).toMatchObject({ parentSource: 'app', parentPhase: 'frame-total' });

    const model = buildProfileModel(finished.value);
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.value.frames[0]?.durationMicros).toBe(30);
    expect(model.value.phases).toContainEqual(
      expect.objectContaining({
        phase: 'frame-child',
        parentPhase: 'frame-total',
        p95DurationMicros: 10,
      }),
    );

    const cli = runProfilerCli(
      ['phase', '--source', 'app', '--phase', 'frame-total'],
      JSON.stringify(finished.value),
    );
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      children: [
        expect.objectContaining({
          source: 'app',
          phase: 'frame-child',
          parentSource: 'app',
          parentPhase: 'frame-total',
        }),
      ],
    });
  });

  it('keeps record, model, and CLI storage bounded after a ten-times tail', () => {
    const overflowTriggerFrame = 3;
    const postOverflowFrames = 40;
    const capture = captureAfterFrames(overflowTriggerFrame + postOverflowFrames);

    expect(capture.completeness).toMatchObject({
      status: 'overflow',
      retainedEventCount: 4,
      firstAffectedFrameId: overflowTriggerFrame,
      lastAffectedFrameId: overflowTriggerFrame + postOverflowFrames,
    });
    expect(capture.records).toHaveLength(4);
    expect(JSON.stringify(capture).length).toBeLessThan(1600);

    const model = buildProfileModel(capture);
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    expect(model.value.summary.completeness).toEqual(capture.completeness);
    expect(model.value.completeness.status).toBe('overflow');

    const cli = runProfilerCli(['summary'], JSON.stringify(capture));
    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe('');
    expect(JSON.parse(cli.stdout)).toMatchObject({
      completeness: capture.completeness,
      frameCount: 2,
    });
  });

  it('does not turn an overflow prefix into a complete artifact', () => {
    const capture = captureAfterFrames(44);
    expect(capture.completeness.status).not.toBe('complete');
    expect(buildProfileModel(capture)).toMatchObject({
      ok: true,
      value: { summary: { completeness: { status: 'overflow' } } },
    });
  });
});
