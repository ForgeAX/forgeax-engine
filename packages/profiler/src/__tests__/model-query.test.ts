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

describe('buildProfileModel query projection', () => {
  it('preserves capture identity, limits, completeness, and frame detail', () => {
    const model = expectOk(buildProfileModel(readFixture()));

    expect(model.summary).toMatchObject({
      schemaVersion: '1.0',
      captureId: 'capture-0010',
      timeUnit: 'microseconds',
      frameLimit: 2,
      eventLimit: 8,
      frameRange: { first: 1, last: 2 },
      completeness: {
        status: 'overflow',
        retainedEventCount: 4,
        droppedEventCount: 2,
        firstAffectedFrameId: 2,
        lastAffectedFrameId: 2,
      },
    });

    expect(model.frames).toHaveLength(2);
    expect(model.frames.find((frame) => frame.frameId === 2)).toMatchObject({
      frameId: 2,
      recordCount: 2,
      phaseCount: 1,
      skipCount: 1,
      durationMicros: 10,
    });
  });

  it('supports exact source and phase lookup without losing skip records', () => {
    const fixture = readFixture();
    const phaseCatalog = fixture.phaseCatalog as { app: string[]; render: string[] };
    const records = fixture.records as Array<Record<string, unknown>>;
    const model = expectOk(
      buildProfileModel({
        ...fixture,
        phaseCatalog: { ...phaseCatalog, render: [...phaseCatalog.render, 'input'] },
        records: [
          ...records,
          {
            kind: 'phase',
            source: 'render',
            frameId: 2,
            phase: 'input',
            startMicros: 2030,
            endMicros: 2045,
            durationMicros: 15,
          },
        ],
        completeness: {
          ...(fixture.completeness as Record<string, unknown>),
          retainedEventCount: 5,
        },
      }),
    );

    expect(
      model.phases.find((phase) => phase.source === 'render' && phase.phase === 'input'),
    ).toEqual({
      source: 'render',
      phase: 'input',
      count: 1,
      skipCount: 0,
      p95DurationMicros: 15,
    });
    expect(
      model.phases.find((phase) => phase.source === 'render' && phase.phase === 'submit'),
    ).toEqual({
      source: 'render',
      phase: 'submit',
      count: 0,
      skipCount: 1,
      p95DurationMicros: null,
    });
  });

  it('keeps empty partial captures queryable without inventing a frame', () => {
    const fixture = readFixture();
    const model = expectOk(
      buildProfileModel({
        ...fixture,
        captureId: 'capture-0011',
        records: [],
        completeness: {
          status: 'partial',
          retainedEventCount: 0,
          droppedEventCount: 0,
          incompleteReason: 'stopped-before-frame',
        },
      }),
    );

    expect(model.summary).toMatchObject({
      captureId: 'capture-0011',
      completeness: {
        status: 'partial',
        retainedEventCount: 0,
        droppedEventCount: 0,
        incompleteReason: 'stopped-before-frame',
      },
      frameRange: null,
      frameCount: 0,
      recordCount: 0,
      p95DurationMicros: null,
    });
    expect(model.frames).toEqual([]);
    expect(model.phases).toEqual([]);
  });
});
