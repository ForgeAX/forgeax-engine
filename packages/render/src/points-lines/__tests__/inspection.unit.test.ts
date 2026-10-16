import { describe, expect, it } from 'vitest';
import {
  PointsLinesBudgetExceededError,
  PointsLinesInvalidStyleError,
  PointsLinesMaterialUnsupportedError,
  PointsLinesPrepareFailedError,
  PointsLinesStyleUnsupportedError,
  PointsLinesTopologyMismatchError,
} from '../../errors/render';
import { inspectPointsLines, type PointsLinesInspection } from '../inspection';
import { createPointsLinesSnapshot } from '../snapshot';

function baseInput(): Parameters<typeof inspectPointsLines>[0] {
  return {
    snapshot: createPointsLinesSnapshot({
      worldId: 2,
      entityKey: 15,
      component: 'Lines',
      meshHandle: 5,
      meshGeneration: 3,
      materialHandle: 7,
      materialGeneration: 4,
      style: { kind: 'lines', width: 2 },
      layer: 1,
      visible: true,
      sourceBounds: new Float32Array([0, 0, 0, 1, 1, 0]),
      viewport: { width: 640, height: 480, dpr: 2 },
      projection: new Float32Array(16),
    }),
    topology: 'line-list',
    lane: 'pending',
    pointCount: 0,
    segmentCount: 2,
    sourceBytes: 64,
    derivedBytes: 48,
    cache: { hit: false, rebuilds: 1, evictions: 0 },
    drawCount: 1,
    uploadBytes: 48,
    lastKnownGood: true,
  };
}

describe('bounded Points/Lines inspection', () => {
  it('projects normal typed facts and a JSON-safe equivalent', () => {
    const inspection = inspectPointsLines(baseInput());

    expect(inspection).toEqual<PointsLinesInspection>({
      entityKey: 15,
      worldId: 2,
      component: 'Lines',
      meshHandle: 5,
      meshGeneration: 3,
      materialHandle: 7,
      materialGeneration: 4,
      style: { kind: 'lines', width: 2 },
      topology: 'line-list',
      lane: 'pending',
      pointCount: 0,
      segmentCount: 2,
      sourceBytes: 64,
      derivedBytes: 48,
      cache: { hit: false, rebuilds: 1, evictions: 0 },
      drawCount: 1,
      uploadBytes: 48,
      lastKnownGood: true,
    });
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection);
  });

  it('keeps refusal and recovery provenance bounded and typed', () => {
    const refusal = inspectPointsLines({
      ...baseInput(),
      lane: 'refused',
      lastKnownGood: false,
      drawCount: 0,
      uploadBytes: 0,
      refusal: {
        ...new PointsLinesPrepareFailedError({
          owner: 'test',
          generation: 3,
          stage: 'prepare',
          cause: 'test failure',
          lastKnownGood: false,
        }),
        generation: 3,
        lastKnownGood: false,
      },
    });
    const recovery = inspectPointsLines({
      ...baseInput(),
      lane: 'pending',
      cache: { hit: true, rebuilds: 2, evictions: 1 },
      lastKnownGood: true,
    });

    expect(refusal.refusal?.code).toBe('points-lines-prepare-failed');
    expect(refusal.drawCount).toBe(0);
    expect(recovery.cache).toEqual({ hit: true, rebuilds: 2, evictions: 1 });
    expect(JSON.stringify(refusal)).not.toContain('RHI');
  });

  it('preserves source detail for all six Points/Lines refusal paths', () => {
    const errors = [
      new PointsLinesInvalidStyleError({
        entity: 15,
        component: 'Lines',
        field: 'width',
        value: 0,
        expected: 'width > 0',
      }),
      new PointsLinesTopologyMismatchError({
        entity: 15,
        submesh: 0,
        expected: 'line-list',
        actual: 'triangle-list',
      }),
      new PointsLinesStyleUnsupportedError({
        lane: 'direct',
        field: 'shape',
        member: 'diamond',
        supported: ['square', 'circle'],
      }),
      new PointsLinesMaterialUnsupportedError({
        entity: 15,
        material: 'mat',
        pass: 'forward',
        module: 'test',
        reason: 'unsupported test material',
      }),
      new PointsLinesBudgetExceededError({
        lane: 'direct',
        requested: 9,
        limit: 8,
        unit: 'draws',
      }),
      new PointsLinesPrepareFailedError({
        owner: 'test',
        generation: 3,
        stage: 'prepare',
        cause: 'test failure',
        lastKnownGood: false,
      }),
    ];

    for (const error of errors) {
      const inspection = inspectPointsLines({
        ...baseInput(),
        lane: 'refused',
        drawCount: 0,
        uploadBytes: 0,
        lastKnownGood: false,
        refusal: {
          ...error,
          generation: 3,
          lastKnownGood: false,
        },
      });
      expect(inspection.refusal).toMatchObject({
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        detail: error.detail,
      });
      expect(JSON.parse(JSON.stringify(inspection)).refusal.detail).toEqual(error.detail);
    }
  });
});
