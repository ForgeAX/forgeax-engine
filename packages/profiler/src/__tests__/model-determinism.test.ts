import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProfileModel } from '../model.js';

type CaptureFixture = Record<string, unknown>;

function readFixture(): CaptureFixture {
  return JSON.parse(
    readFileSync(new URL('./fixtures/profile-capture/model-input.json', import.meta.url), 'utf8'),
  ) as CaptureFixture;
}

function expectOk<T>(result: { ok: boolean; value?: T; error?: { code: string } }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error?.code ?? 'unexpected profiler error');
  return result.value as T;
}

describe('buildProfileModel determinism contract', () => {
  it('does not mutate input and returns deeply equal output on repeated calls', () => {
    const capture = readFixture();
    const before = JSON.stringify(capture);
    const first = expectOk(buildProfileModel(capture));
    const second = expectOk(buildProfileModel(capture));

    expect(second).toEqual(first);
    expect(JSON.stringify(capture)).toBe(before);
  });

  it('derives summary, frame, phase and nearest-rank p95 data', () => {
    const model = expectOk(buildProfileModel(readFixture()));

    expect(model.summary.captureId).toBe('capture-0010');
    expect(model.summary.completeness.status).toBe('overflow');
    expect(model.summary.frameRange).toEqual({ first: 1, last: 2 });
    expect(model.summary.frameCount).toBe(2);
    expect(model.summary.p95DurationMicros).toBe(50);
    expect(model.summary.frameDuration).toEqual({
      sampleCount: 2,
      totalDurationMicros: 60,
      p50DurationMicros: 10,
      p90DurationMicros: 50,
      p95DurationMicros: 50,
      p99DurationMicros: 50,
      maxDurationMicros: 50,
    });
    expect(model.frames).toHaveLength(2);
    expect(model.frames[0]?.frameId).toBe(1);
    expect(model.frames[0]?.phaseCount).toBe(2);
    expect(model.frames[0]?.durationMicros).toBe(50);
    expect(model.frames[0]?.unionDurationMicros).toBe(50);
    expect(model.frames[0]?.selfDurationMicros).toBe(50);
    expect(model.frames[1]?.selfDurationMicros).toBeNull();
    expect(model.phases).toEqual([
      {
        source: 'app',
        phase: 'input',
        count: 2,
        skipCount: 0,
        totalDurationMicros: 40,
        unionDurationMicros: 40,
        selfDurationMicros: null,
        callDuration: {
          sampleCount: 2,
          totalDurationMicros: 40,
          p50DurationMicros: 10,
          p90DurationMicros: 30,
          p95DurationMicros: 30,
          p99DurationMicros: 30,
          maxDurationMicros: 30,
        },
        frameDuration: {
          sampleCount: 2,
          totalDurationMicros: 40,
          p50DurationMicros: 10,
          p90DurationMicros: 30,
          p95DurationMicros: 30,
          p99DurationMicros: 30,
          maxDurationMicros: 30,
        },
        calledFrameCount: 2,
        p95DurationMicros: 30,
      },
      {
        source: 'app',
        phase: 'update',
        count: 1,
        skipCount: 0,
        totalDurationMicros: 20,
        unionDurationMicros: 20,
        selfDurationMicros: 20,
        callDuration: {
          sampleCount: 1,
          totalDurationMicros: 20,
          p50DurationMicros: 20,
          p90DurationMicros: 20,
          p95DurationMicros: 20,
          p99DurationMicros: 20,
          maxDurationMicros: 20,
        },
        frameDuration: {
          sampleCount: 2,
          totalDurationMicros: 20,
          p50DurationMicros: 0,
          p90DurationMicros: 20,
          p95DurationMicros: 20,
          p99DurationMicros: 20,
          maxDurationMicros: 20,
        },
        calledFrameCount: 1,
        p95DurationMicros: 20,
      },
      {
        source: 'render',
        phase: 'submit',
        count: 0,
        skipCount: 1,
        totalDurationMicros: 0,
        unionDurationMicros: 0,
        selfDurationMicros: null,
        callDuration: {
          sampleCount: 0,
          totalDurationMicros: 0,
          p50DurationMicros: null,
          p90DurationMicros: null,
          p95DurationMicros: null,
          p99DurationMicros: null,
          maxDurationMicros: null,
        },
        frameDuration: {
          sampleCount: 2,
          totalDurationMicros: 0,
          p50DurationMicros: 0,
          p90DurationMicros: 0,
          p95DurationMicros: 0,
          p99DurationMicros: 0,
          maxDurationMicros: 0,
        },
        calledFrameCount: 0,
        p95DurationMicros: null,
      },
    ]);
  });

  it('preserves partial and overflow completeness for empty and truncated captures', () => {
    const fixture = readFixture();
    const partial = {
      ...fixture,
      captureId: 'capture-0011',
      records: [],
      completeness: {
        status: 'partial',
        retainedEventCount: 0,
        droppedEventCount: 0,
        incompleteReason: 'stopped-before-frame',
      },
    };
    const model = expectOk(buildProfileModel(partial));

    expect(model.summary.completeness.status).toBe('partial');
    expect(model.summary.frameCount).toBe(0);
    expect(model.summary.frameRange).toBeNull();
    expect(model.summary.p95DurationMicros).toBeNull();
    expect(model.summary.completeness.incompleteReason).toBe('stopped-before-frame');
    expect(model.summary.completeness.droppedEventCount).toBe(0);
  });
});
