import { type MeshAsset, type PrimitiveTopology, withClipping } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  PointsLinesBudgetExceededError,
  PointsLinesInvalidStyleError,
  PointsLinesMaterialUnsupportedError,
  PointsLinesPrepareFailedError,
  PointsLinesStyleUnsupportedError,
  PointsLinesTopologyMismatchError,
} from '../../errors/render';
import { Materials } from '../../materials';
import { admitPointsLines, type PointsLinesAdmissionInput } from '../../points-lines/admission';

const unlitMaterial = Materials.unlit([1, 0.5, 0.25, 1]);

function mesh(topology: PrimitiveTopology, count = 4, indexed = false): MeshAsset {
  const vertices = new Float32Array(count * 3);
  return {
    kind: 'mesh',
    vertices,
    ...(indexed ? { indices: new Uint16Array(count) } : {}),
    attributes: { position: vertices },
    aabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indexed ? count : 0,
        vertexCount: count,
        topology,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'default' }],
  };
}

function pointsInput(
  overrides: Partial<PointsLinesAdmissionInput> = {},
): PointsLinesAdmissionInput {
  return {
    entity: 7,
    points: { sizePx: 4, shape: 0 },
    mesh: mesh('point-list', 3),
    material: unlitMaterial,
    ...overrides,
  };
}

function linesInput(overrides: Partial<PointsLinesAdmissionInput> = {}): PointsLinesAdmissionInput {
  return {
    entity: 8,
    lines: { width: 1 },
    mesh: mesh('line-list', 4),
    material: unlitMaterial,
    ...overrides,
  };
}

function expectRefusal(
  result: ReturnType<typeof admitPointsLines>,
  code: string,
  detail: Record<string, unknown>,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  if (!('detail' in result.error)) throw new Error('expected a detailed Points/Lines refusal');
  expect(result.error.code).toBe(code);
  expect(result.error.expected).toEqual(expect.any(String));
  expect(result.error.hint).toEqual(expect.any(String));
  expect(result.error.detail).toMatchObject(detail);
}

describe('Points and Lines admission', () => {
  it('refuses unsupported local clipping instead of silently dropping planes', () => {
    const result = admitPointsLines(
      pointsInput({ material: withClipping(unlitMaterial, { planes: [[1, 0, 0, 0]] }) }),
    );
    expectRefusal(result, 'points-lines-material-unsupported', {
      reason: expect.stringContaining('camera ClippingPlanes'),
    });
  });
  it('accepts indexed and non-indexed point and line-list geometry', () => {
    const indexedPoints = admitPointsLines(pointsInput({ mesh: mesh('point-list', 3, true) }));
    const nonIndexedLines = admitPointsLines(linesInput());

    expect(indexedPoints.ok).toBe(true);
    expect(nonIndexedLines.ok).toBe(true);
    if (indexedPoints.ok) expect(indexedPoints.value.pointCount).toBe(3);
    if (nonIndexedLines.ok) expect(nonIndexedLines.value.segmentCount).toBe(2);
  });

  it('rejects component conflicts and invalid numeric styles before topology', () => {
    const conflict = admitPointsLines(pointsInput({ lines: { width: 1 } }));
    const invalidSize = admitPointsLines(pointsInput({ points: { sizePx: Number.NaN, shape: 0 } }));
    const invalidWidth = admitPointsLines(linesInput({ lines: { width: 0 } }));

    expectRefusal(conflict, 'points-lines-invalid-style', {
      entity: 7,
      component: 'Points/Lines',
      field: 'components',
    });
    expectRefusal(invalidSize, 'points-lines-invalid-style', {
      entity: 7,
      component: 'Points',
      field: 'sizePx',
      value: Number.NaN,
    });
    expectRefusal(invalidWidth, 'points-lines-invalid-style', {
      entity: 8,
      component: 'Lines',
      field: 'width',
      value: 0,
    });
  });

  it('decodes line width units and caps, refusing unknown labels', () => {
    const admitted = admitPointsLines(linesInput({ lines: { width: 0.5, widthUnits: 1, cap: 1 } }));
    expect(admitted.ok && admitted.value).toMatchObject({
      width: 0.5,
      widthUnits: 'world',
      cap: 'round',
    });
    const defaults = admitPointsLines(linesInput());
    expect(defaults.ok && defaults.value).toMatchObject({ widthUnits: 'pixels', cap: 'butt' });
    expectRefusal(
      admitPointsLines(linesInput({ lines: { width: 1, widthUnits: 7 } })),
      'points-lines-invalid-style',
      { entity: 8, component: 'Lines', field: 'widthUnits', value: 7 },
    );
    expectRefusal(
      admitPointsLines(linesInput({ lines: { width: 1, cap: 3 } })),
      'points-lines-invalid-style',
      { entity: 8, component: 'Lines', field: 'cap', value: 3 },
    );
  });

  it('rejects unsupported topologies, odd line tails, and mixed candidates atomically', () => {
    const strip = admitPointsLines(linesInput({ mesh: mesh('line-strip', 1) }));
    const triangles = admitPointsLines(pointsInput({ mesh: mesh('triangle-list', 3) }));
    const odd = admitPointsLines(linesInput({ mesh: mesh('line-list', 3) }));
    const baseMixedMesh = mesh('line-list', 2);
    const mixedMesh: MeshAsset = {
      ...baseMixedMesh,
      submeshes: [
        ...baseMixedMesh.submeshes,
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 3,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
    };
    const mixed = admitPointsLines(linesInput({ mesh: mixedMesh }));

    expectRefusal(strip, 'points-lines-topology-mismatch', { actual: 'short strip' });
    expectRefusal(triangles, 'points-lines-topology-mismatch', {
      entity: 7,
      expected: 'point-list',
      actual: 'triangle-list',
      submesh: 0,
    });
    expectRefusal(odd, 'points-lines-topology-mismatch', {
      entity: 8,
      expected: 'line-list pairs',
      actual: 'line-list odd tail',
      submesh: 0,
    });
    expectRefusal(mixed, 'points-lines-topology-mismatch', {
      entity: 8,
      submesh: 1,
    });
  });

  it('rejects non-unlit materials and explicit resource budgets', () => {
    const lit = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const material = admitPointsLines(linesInput({ material: lit }));
    const budget = admitPointsLines(pointsInput({ limits: { maxPoints: 2 } }));

    expectRefusal(material, 'points-lines-material-unsupported', {
      entity: 8,
      pass: 'deferred',
      reason: expect.any(String),
    });
    expectRefusal(budget, 'points-lines-budget-exceeded', {
      lane: 'admission',
      requested: 3,
      limit: 2,
      unit: 'points',
    });
  });

  it('keeps every closed refusal detail constructible and code-correlated', () => {
    const errors = [
      new PointsLinesInvalidStyleError({
        entity: 1,
        component: 'Points',
        field: 'sizePx',
        value: -1,
        expected: 'finite sizePx > 0',
      }),
      new PointsLinesTopologyMismatchError({
        entity: 1,
        submesh: 0,
        expected: 'point-list',
        actual: 'triangle-list',
      }),
      new PointsLinesStyleUnsupportedError({
        lane: 'admission',
        field: 'topology',
        member: 'line-strip',
        supported: ['line-list'],
      }),
      new PointsLinesMaterialUnsupportedError({
        entity: 1,
        material: 'mat-1',
        pass: 'forward',
        module: 'forgeax_material::standard',
        reason: 'surface lighting is not supported',
      }),
      new PointsLinesBudgetExceededError({
        lane: 'admission',
        requested: 5,
        limit: 4,
        unit: 'points',
      }),
      new PointsLinesPrepareFailedError({
        owner: 'points-lines',
        generation: 2,
        stage: 'prepare',
        cause: 'candidate validation failed',
        lastKnownGood: false,
      }),
    ];

    for (const error of errors) {
      expect(error.code).toMatch(/^points-lines-/);
      expect(error.expected).toEqual(expect.any(String));
      expect(error.hint).toEqual(expect.any(String));
      expect(error.detail).toBeDefined();
    }
  });
});
