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

function modelFor(
  records: Array<Record<string, unknown>>,
  completeness: Record<string, unknown> = {
    status: 'complete',
    retainedEventCount: records.length,
    droppedEventCount: 0,
  },
  orderEvidence: 'unspecified' | 'recorder-closure' = 'unspecified',
) {
  const phaseCatalog: Record<string, string[]> = { app: [], render: [] };
  const phaseNames = (source: 'app' | 'render'): string[] => {
    const names = phaseCatalog[source];
    if (names === undefined) throw new Error('Missing profile phase catalog source');
    return names;
  };
  for (const record of records) {
    const source = record.source as 'app' | 'render';
    const names = phaseNames(source);
    if (typeof record.phase === 'string' && !names.includes(record.phase)) names.push(record.phase);
    const parentSource = (record.parentSource ?? source) as 'app' | 'render';
    const parentNames = phaseNames(parentSource);
    if (typeof record.parentPhase === 'string' && !parentNames.includes(record.parentPhase))
      parentNames.push(record.parentPhase);
  }
  const lastFrame = Math.max(1, ...records.map((record) => record.frameId as number));
  return expectOk(
    buildProfileModel(
      {
        schemaVersion: '1.0',
        captureId: 'capture-0014',
        timeUnit: 'microseconds',
        frameLimit: lastFrame,
        eventLimit: Math.max(1, records.length + Number(completeness.droppedEventCount ?? 0)),
        phaseCatalog,
        records,
        completeness: { retainedEventCount: records.length, droppedEventCount: 0, ...completeness },
      },
      { orderEvidence },
    ),
  );
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
      unionDurationMicros: 10,
      selfDurationMicros: null,
    });
    expect(model.summary.frameDuration).toMatchObject({
      sampleCount: 2,
      totalDurationMicros: 60,
      p50DurationMicros: 10,
      p95DurationMicros: 50,
      maxDurationMicros: 50,
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
      totalDurationMicros: 15,
      unionDurationMicros: 15,
      selfDurationMicros: null,
      callDuration: {
        sampleCount: 1,
        totalDurationMicros: 15,
        p50DurationMicros: 15,
        p90DurationMicros: 15,
        p95DurationMicros: 15,
        p99DurationMicros: 15,
        maxDurationMicros: 15,
      },
      frameDuration: {
        sampleCount: 2,
        totalDurationMicros: 15,
        p50DurationMicros: 0,
        p90DurationMicros: 15,
        p95DurationMicros: 15,
        p99DurationMicros: 15,
        maxDurationMicros: 15,
      },
      calledFrameCount: 1,
      p95DurationMicros: 15,
    });
    expect(
      model.phases.find((phase) => phase.source === 'render' && phase.phase === 'submit'),
    ).toEqual({
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

  it('pairs child-first invocations with repeated equal-tick parents by explicit identity', () => {
    const model = expectOk(
      buildProfileModel(
        {
          schemaVersion: '1.0',
          captureId: 'capture-0012',
          timeUnit: 'microseconds',
          frameLimit: 1,
          eventLimit: 4,
          phaseCatalog: { app: ['update', 'invoke'], render: [] },
          records: [
            {
              kind: 'phase',
              source: 'app',
              frameId: 1,
              phase: 'invoke',
              parentSource: 'app',
              parentPhase: 'update',
              startMicros: 10,
              endMicros: 10,
              durationMicros: 0,
            },
            {
              kind: 'phase',
              source: 'app',
              frameId: 1,
              phase: 'update',
              startMicros: 10,
              endMicros: 10,
              durationMicros: 0,
            },
            {
              kind: 'phase',
              source: 'app',
              frameId: 1,
              phase: 'invoke',
              parentSource: 'app',
              parentPhase: 'update',
              startMicros: 10,
              endMicros: 10,
              durationMicros: 0,
            },
            {
              kind: 'phase',
              source: 'app',
              frameId: 1,
              phase: 'update',
              startMicros: 10,
              endMicros: 10,
              durationMicros: 0,
            },
          ],
          completeness: { status: 'complete', retainedEventCount: 4, droppedEventCount: 0 },
        },
        { orderEvidence: 'recorder-closure' },
      ),
    );

    expect(
      model.invocations.map(({ recordIndex, parentRecordIndex, selfDurationMicros }) => ({
        recordIndex,
        parentRecordIndex,
        selfDurationMicros,
      })),
    ).toEqual([
      { recordIndex: 0, parentRecordIndex: 1, selfDurationMicros: 0 },
      { recordIndex: 1, parentRecordIndex: undefined, selfDurationMicros: 0 },
      { recordIndex: 2, parentRecordIndex: 3, selfDurationMicros: 0 },
      { recordIndex: 3, parentRecordIndex: undefined, selfDurationMicros: 0 },
    ]);
  });

  it('does not report full self time for orphaned or incomplete invocations', () => {
    const fixture = readFixture();
    const records = [
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'input',
        parentSource: 'app',
        parentPhase: 'update',
        startMicros: 0,
        endMicros: 20,
        durationMicros: 20,
      },
    ];
    const model = expectOk(
      buildProfileModel({
        ...fixture,
        captureId: 'capture-0013',
        phaseCatalog: { app: ['input', 'update'], render: ['submit'] },
        frameLimit: 1,
        eventLimit: 1,
        records,
        completeness: { status: 'complete', retainedEventCount: 1, droppedEventCount: 0 },
      }),
    );
    expect(model.invocations[0]?.selfDurationMicros).toBeNull();
  });

  it('associates unambiguous parent-first v1 rows across skipped records without changing indices', () => {
    const model = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'root',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
      { kind: 'skip', source: 'app', frameId: 1, phase: 'deferred', reason: 'not-ready' },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'child',
        parentPhase: 'root',
        startMicros: 2,
        endMicros: 4,
        durationMicros: 2,
      },
    ]);

    expect(
      model.invocations.map(({ recordIndex, parentRecordIndex, selfDurationMicros }) => ({
        recordIndex,
        parentRecordIndex,
        selfDurationMicros,
      })),
    ).toEqual([
      { recordIndex: 0, parentRecordIndex: undefined, selfDurationMicros: 8 },
      { recordIndex: 2, parentRecordIndex: 0, selfDurationMicros: 2 },
    ]);
    expect(model.frames[0]).toMatchObject({
      recordCount: 3,
      phaseCount: 2,
      skipCount: 1,
      durationMicros: 10,
      unionDurationMicros: 10,
      selfDurationMicros: 10,
    });
  });

  it('keeps parent matching linear for recorder order and reports nonzero nested self and unions', () => {
    const model = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'inner',
        parentPhase: 'child',
        startMicros: 4,
        endMicros: 6,
        durationMicros: 2,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'child',
        parentPhase: 'root',
        startMicros: 2,
        endMicros: 10,
        durationMicros: 8,
      },
      { kind: 'skip', source: 'app', frameId: 1, phase: 'deferred', reason: 'not-ready' },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'sibling',
        parentPhase: 'root',
        startMicros: 12,
        endMicros: 17,
        durationMicros: 5,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'root',
        startMicros: 0,
        endMicros: 20,
        durationMicros: 20,
      },
    ]);

    expect(
      model.invocations.map(({ recordIndex, parentRecordIndex, selfDurationMicros }) => ({
        recordIndex,
        parentRecordIndex,
        selfDurationMicros,
      })),
    ).toEqual([
      { recordIndex: 0, parentRecordIndex: 1, selfDurationMicros: 2 },
      { recordIndex: 1, parentRecordIndex: 4, selfDurationMicros: 6 },
      { recordIndex: 3, parentRecordIndex: 4, selfDurationMicros: 5 },
      { recordIndex: 4, parentRecordIndex: undefined, selfDurationMicros: 7 },
    ]);
    expect(model.frames[0]).toMatchObject({
      recordCount: 5,
      phaseCount: 4,
      skipCount: 1,
      durationMicros: 20,
      unionDurationMicros: 20,
      selfDurationMicros: 20,
    });
  });

  it('ignores skip records between child and parent on the recorder-closure path', () => {
    const model = modelFor(
      [
        {
          kind: 'phase',
          source: 'app',
          frameId: 1,
          phase: 'child',
          parentPhase: 'root',
          startMicros: 2,
          endMicros: 4,
          durationMicros: 2,
        },
        { kind: 'skip', source: 'app', frameId: 1, phase: 'deferred', reason: 'not-ready' },
        {
          kind: 'phase',
          source: 'app',
          frameId: 1,
          phase: 'root',
          startMicros: 0,
          endMicros: 10,
          durationMicros: 10,
        },
      ],
      undefined,
      'recorder-closure',
    );

    expect(
      model.invocations.map(({ recordIndex, parentRecordIndex }) => ({
        recordIndex,
        parentRecordIndex,
      })),
    ).toEqual([
      { recordIndex: 0, parentRecordIndex: 2 },
      { recordIndex: 2, parentRecordIndex: undefined },
    ]);
  });

  it('matches A→B→A chains across sources and omitted same-source parentSource', () => {
    const model = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'inner-a',
        parentSource: 'render',
        parentPhase: 'bridge-b',
        startMicros: 4,
        endMicros: 8,
        durationMicros: 4,
      },
      {
        kind: 'phase',
        source: 'render',
        frameId: 1,
        phase: 'bridge-b',
        parentSource: 'app',
        parentPhase: 'outer-a',
        startMicros: 2,
        endMicros: 18,
        durationMicros: 16,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'outer-a',
        startMicros: 0,
        endMicros: 20,
        durationMicros: 20,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'same-source-child',
        parentPhase: 'outer-a',
        startMicros: 9,
        endMicros: 11,
        durationMicros: 2,
      },
    ]);

    expect(
      model.invocations.map(({ recordIndex, parentRecordIndex }) => ({
        recordIndex,
        parentRecordIndex,
      })),
    ).toEqual([
      { recordIndex: 0, parentRecordIndex: 1 },
      { recordIndex: 1, parentRecordIndex: 2 },
      { recordIndex: 2, parentRecordIndex: undefined },
      { recordIndex: 3, parentRecordIndex: 2 },
    ]);
  });

  it('leaves genuinely ambiguous parent-first links nullable', () => {
    const model = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'root',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'root',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'child',
        parentPhase: 'root',
        startMicros: 2,
        endMicros: 4,
        durationMicros: 2,
      },
    ]);

    expect(model.invocations[2]?.parentRecordIndex).toBeUndefined();
    expect(model.invocations.every((invocation) => invocation.selfDurationMicros === null)).toBe(
      true,
    );
  });

  it('does not accept greedy mixed-order edges that create equal-span cycles', () => {
    const rooted = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'a',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'b',
        parentPhase: 'a',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'a',
        parentPhase: 'b',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
    ]);
    expect(rooted.invocations.map(({ parentRecordIndex }) => parentRecordIndex)).toEqual([
      undefined,
      undefined,
      1,
    ]);
    expect(rooted.invocations.every((invocation) => invocation.selfDurationMicros === null)).toBe(
      true,
    );

    const cyclic = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'a',
        parentPhase: 'b',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'b',
        parentPhase: 'a',
        startMicros: 0,
        endMicros: 10,
        durationMicros: 10,
      },
    ]);
    expect(cyclic.invocations.map(({ parentRecordIndex }) => parentRecordIndex)).toEqual([
      undefined,
      undefined,
    ]);
    expect(cyclic.invocations.every((invocation) => invocation.selfDurationMicros === null)).toBe(
      true,
    );
  });

  it('chooses a unique innermost parent among nested same-identity intervals', () => {
    const model = modelFor([
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'a',
        startMicros: 0,
        endMicros: 20,
        durationMicros: 20,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'b',
        parentPhase: 'a',
        startMicros: 2,
        endMicros: 18,
        durationMicros: 16,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'a',
        parentPhase: 'b',
        startMicros: 4,
        endMicros: 16,
        durationMicros: 12,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'c',
        parentPhase: 'a',
        startMicros: 5,
        endMicros: 6,
        durationMicros: 1,
      },
    ]);

    expect(
      model.invocations.map(({ parentRecordIndex, selfDurationMicros }) => ({
        parentRecordIndex,
        selfDurationMicros,
      })),
    ).toEqual([
      { parentRecordIndex: undefined, selfDurationMicros: 4 },
      { parentRecordIndex: 0, selfDurationMicros: 4 },
      { parentRecordIndex: 1, selfDurationMicros: 11 },
      { parentRecordIndex: 2, selfDurationMicros: 1 },
    ]);
    expect(model.frames[0]?.selfDurationMicros).toBe(20);
  });

  it('keeps retained partial and overflow records while withholding affected self time', () => {
    const records = [
      {
        kind: 'phase',
        source: 'app',
        frameId: 1,
        phase: 'root',
        startMicros: 0,
        endMicros: 5,
        durationMicros: 5,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 2,
        phase: 'child',
        parentPhase: 'root',
        startMicros: 11,
        endMicros: 13,
        durationMicros: 2,
      },
      {
        kind: 'phase',
        source: 'app',
        frameId: 2,
        phase: 'root',
        startMicros: 10,
        endMicros: 15,
        durationMicros: 5,
      },
    ];
    const overflow = modelFor(records, {
      status: 'overflow',
      droppedEventCount: 1,
      firstAffectedFrameId: 2,
      lastAffectedFrameId: 2,
    });
    expect(overflow.invocations.map((invocation) => invocation.selfDurationMicros)).toEqual([
      5,
      null,
      null,
    ]);
    expect(overflow.summary.recordCount).toBe(3);
    expect(overflow.summary.completeness.status).toBe('overflow');

    const partial = modelFor(records, {
      status: 'partial',
      incompleteReason: 'stopped-before-frame',
    });
    expect(partial.invocations.map((invocation) => invocation.selfDurationMicros)).toEqual([
      null,
      null,
      null,
    ]);
    expect(partial.summary.recordCount).toBe(3);
    expect(partial.summary.completeness.status).toBe('partial');
  });
});
