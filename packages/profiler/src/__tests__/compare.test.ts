import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareProfileCaptures } from '../compare.js';

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/cli/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

function capture(variant: 'left' | 'right'): Record<string, unknown> {
  const right = variant === 'right';
  return {
    schemaVersion: '1.0',
    captureId: right ? 'capture-0002' : 'capture-0001',
    timeUnit: 'microseconds',
    frameLimit: 4,
    eventLimit: 16,
    phaseCatalog: {
      app: ['input', 'update'],
      render: right ? ['submit', 'gpu'] : ['submit'],
    },
    records: right
      ? [
          {
            kind: 'phase',
            source: 'app',
            frameId: 1,
            phase: 'input',
            startMicros: 1,
            endMicros: 16,
            durationMicros: 15,
          },
          {
            kind: 'phase',
            source: 'app',
            frameId: 1,
            phase: 'update',
            parentSource: 'app',
            parentPhase: 'input',
            startMicros: 16,
            endMicros: 41,
            durationMicros: 25,
          },
          {
            kind: 'phase',
            source: 'render',
            frameId: 1,
            phase: 'submit',
            startMicros: 41,
            endMicros: 46,
            durationMicros: 5,
          },
          {
            kind: 'phase',
            source: 'render',
            frameId: 2,
            phase: 'gpu',
            startMicros: 50,
            endMicros: 90,
            durationMicros: 40,
          },
        ]
      : [
          {
            kind: 'phase',
            source: 'app',
            frameId: 1,
            phase: 'input',
            startMicros: 1,
            endMicros: 11,
            durationMicros: 10,
          },
          {
            kind: 'phase',
            source: 'app',
            frameId: 1,
            phase: 'update',
            parentSource: 'app',
            parentPhase: 'input',
            startMicros: 11,
            endMicros: 31,
            durationMicros: 20,
          },
          { kind: 'skip', source: 'render', frameId: 1, phase: 'submit', reason: 'not recorded' },
        ],
    completeness: right
      ? {
          status: 'overflow',
          retainedEventCount: 4,
          droppedEventCount: 2,
          firstAffectedFrameId: 2,
          lastAffectedFrameId: 2,
        }
      : { status: 'complete', retainedEventCount: 3, droppedEventCount: 0 },
  };
}

describe('ProfileCapture comparison', () => {
  it('preserves both summaries and compares a union of full phase identities', () => {
    const result = compareProfileCaptures(capture('left'), capture('right'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.left).toMatchObject({
      summary: {
        captureId: 'capture-0001',
        frameCount: 1,
        recordCount: 3,
        phaseCount: 2,
        skipCount: 1,
      },
      completeness: { status: 'complete', retainedEventCount: 3, droppedEventCount: 0 },
    });
    expect(result.value.right).toMatchObject({
      summary: { captureId: 'capture-0002' },
      completeness: {
        status: 'overflow',
        retainedEventCount: 4,
        droppedEventCount: 2,
        firstAffectedFrameId: 2,
        lastAffectedFrameId: 2,
      },
    });

    const update = result.value.phases.find((phase) => phase.identity.phase === 'update');
    expect(update).toEqual({
      identity: { source: 'app', phase: 'update', parentSource: 'app', parentPhase: 'input' },
      left: { count: 1, skipCount: 0, p95DurationMicros: 20 },
      right: { count: 1, skipCount: 0, p95DurationMicros: 25 },
      delta: { count: 0, skipCount: 0, p95DurationMicros: 5 },
    });

    const submit = result.value.phases.find(
      (phase) => phase.identity.source === 'render' && phase.identity.phase === 'submit',
    );
    expect(submit).toEqual({
      identity: { source: 'render', phase: 'submit' },
      left: { count: 0, skipCount: 1, p95DurationMicros: null },
      right: { count: 1, skipCount: 0, p95DurationMicros: 5 },
      delta: { count: 1, skipCount: -1 },
    });

    const gpu = result.value.phases.find((phase) => phase.identity.phase === 'gpu');
    expect(gpu).toEqual({
      identity: { source: 'render', phase: 'gpu' },
      right: { count: 1, skipCount: 0, p95DurationMicros: 40 },
    });
  });

  it('keeps invalid input attributable to its side', () => {
    const left = compareProfileCaptures({ schemaVersion: '9.0' }, capture('right'));
    expect(left).toEqual({
      ok: false,
      error: {
        code: 'profile-artifact-incompatible',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: {
          path: '/schemaVersion',
          message: expect.any(String),
          side: 'left',
        },
      },
    });

    const right = compareProfileCaptures(capture('left'), { schemaVersion: '9.0' });
    expect(right).toMatchObject({ ok: false, error: { detail: { side: 'right' } } });
  });

  it('does not mutate either artifact and produces stable ordering', () => {
    const left = capture('left');
    const right = capture('right');
    const beforeLeft = JSON.stringify(left);
    const beforeRight = JSON.stringify(right);
    const first = compareProfileCaptures(left, right);
    const second = compareProfileCaptures(left, right);

    expect(first).toEqual(second);
    expect(JSON.stringify(left)).toBe(beforeLeft);
    expect(JSON.stringify(right)).toBe(beforeRight);
  });

  it('keeps an unavailable p95 unavailable instead of manufacturing a delta', () => {
    const result = compareProfileCaptures(
      readFixture('valid-capture.json'),
      readFixture('partial-capture.json'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const input = result.value.phases.find(
      (phase) => phase.identity.source === 'app' && phase.identity.phase === 'input',
    );
    expect(input?.left?.p95DurationMicros).toBe(10);
    expect(input?.right?.p95DurationMicros).toBe(15);
    expect(input?.delta?.p95DurationMicros).toBe(5);
    const update = result.value.phases.find(
      (phase) => phase.identity.source === 'app' && phase.identity.phase === 'update',
    );
    expect(update?.left?.p95DurationMicros).toBe(30);
    expect(update?.right).toBeUndefined();
    expect(update?.delta).toBeUndefined();
  });

  it('does not merge equal phase names that have different parent identities', () => {
    const right = capture('right');
    const rootUpdate = (right.records as Array<Record<string, unknown>>).map((record) => {
      if (record.phase !== 'update') return record;
      const { parentSource: _parentSource, parentPhase: _parentPhase, ...withoutParent } = record;
      return withoutParent;
    });
    const result = compareProfileCaptures(capture('left'), { ...right, records: rootUpdate });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    const updates = result.value.phases.filter((phase) => phase.identity.phase === 'update');
    expect(updates).toHaveLength(2);
    expect(updates.map((phase) => phase.identity.parentPhase)).toEqual(['input', undefined]);
    expect(updates[0]?.delta).toBeUndefined();
    expect(updates[1]?.delta).toBeUndefined();
  });
});
