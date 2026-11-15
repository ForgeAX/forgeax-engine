import { describe, expect, it } from 'vitest';
import {
  computeWaterPontoonCoefficients,
  WaterBuoyancyCoefficientCache,
  type WaterPontoon,
} from '../buoyancy.js';
import type { Vec3 } from '../contracts.js';

const pontoon = (
  position: Vec3,
  enabled = true,
  anchor: WaterPontoon['anchor'] = 'socket',
): WaterPontoon => ({
  id: `p-${position.join('-')}`,
  radiusM: 1,
  enabled,
  centerM: [90, 80, 70],
  coefficientPositionM: position,
  anchor,
});
const solve = (positions: readonly Vec3[]) =>
  computeWaterPontoonCoefficients(
    positions.map((position) => pontoon(position)),
    [0, 0, 0],
  );

describe('source sprung fractions in meters', () => {
  it('rejects nonfinite N1 coefficient geometry and COM before invoking or reusing a source solve', () => {
    for (const [position, com, field] of [
      [[Number.NaN, 0, 0], [0, 0, 0], 'coefficient-position'],
      [[0, 0, 0], [Number.NaN, 0, 0], 'center-of-mass'],
    ] as const) {
      const points = [pontoon(position)];
      const expected = {
        ok: false,
        error: {
          detail: { kind: 'coefficient', reason: 'non-finite-input', field },
          coefficientSolve: {
            sourceSuccess: false,
            sourceStatus: 'not-invoked',
            branch: 'unselected',
          },
        },
      };
      expect(computeWaterPontoonCoefficients(points, com)).toMatchObject(expected);
      const cache = new WaterBuoyancyCoefficientCache();
      cache.resolve([pontoon([0, 0, 0])], [0, 0, 0], true).result.unwrap();
      expect(cache.resolve(points, com, true)).toMatchObject({
        enabledMask: 1,
        hit: false,
        result: expected,
      });
      expect(cache.resolve([pontoon([0, 0, 0])], [0, 0, 0], true)).toMatchObject({
        hit: true,
        result: { ok: true },
      });
    }
  });

  it('publishes the exact enabled input geometry and COM rules for successful and failed solves', () => {
    const relative = pontoon([-2, 4, 0], true, 'relative');
    const disabled = pontoon([9, 8, 7], false, 'socket');
    expect(
      computeWaterPontoonCoefficients([relative, disabled], [0.5, 1, 0], true).unwrap(),
    ).toMatchObject({
      sourceSuccess: true,
      centerOfMassM: [0.5, 1, 0],
      centerPontoonsOnCOM: true,
      branch: 'single',
      points: [
        {
          id: relative.id,
          enabled: true,
          anchor: 'relative',
          coefficientSpace: 'root-local',
          coefficientPositionM: [-2, 4, 0],
          massFramePositionM: [-3, 2, 0],
        },
        {
          id: disabled.id,
          enabled: false,
          anchor: 'socket',
          coefficientSpace: 'socket-parent-local',
          coefficientPositionM: [9, 8, 7],
          massFramePositionM: [8.5, 7, 7],
        },
      ],
    });
    expect(
      solve([
        [-1, 0, -1],
        [0, 0, 0],
        [1, 0, 1],
      ]),
    ).toMatchObject({
      ok: false,
      error: {
        coefficientSolve: {
          sourceSuccess: false,
          branch: 'general',
          centerOfMassM: [0, 0, 0],
          points: [
            { massFramePositionM: [-1, 0, -1] },
            { massFramePositionM: [0, 0, 0] },
            { massFramePositionM: [1, 0, 1] },
          ],
        },
      },
    });
  });
  it('retains one, four and sixteen support fractions and disabled array positions', () => {
    expect(solve([[4, 9, 8]]).unwrap()).toMatchObject({ coefficients: [1], diagnostics: [] });
    const four: Vec3[] = [
      [-1, 0, -1],
      [1, 0, -1],
      [-1, 0, 1],
      [1, 0, 1],
    ];
    expect(solve(four).unwrap()).toMatchObject({
      coefficients: [0.25, 0.25, 0.25, 0.25],
      diagnostics: [],
    });
    const sixteen: Vec3[] = [-3, -1, 1, 3].flatMap((x) =>
      [-3, -1, 1, 3].map((z) => [x, 0, z] as Vec3),
    );
    expect(solve(sixteen).unwrap()).toMatchObject({
      coefficients: Array(16).fill(1 / 16),
      diagnostics: [],
    });
    expect(
      computeWaterPontoonCoefficients(
        [pontoon([4, 0, 0]), pontoon([9, 0, 0], false)],
        [0, 0, 0],
      ).unwrap(),
    ).toMatchObject({ coefficients: [1, 0], diagnostics: [] });
  });

  it('stores N2 first fraction then subtracts that stored float for the second', () => {
    expect(
      solve([
        [-0.01, -700, 0],
        [0.02, 900, 0],
      ]).unwrap(),
    ).toMatchObject({ coefficients: [0.3333333432674408, 0.6666666269302368], diagnostics: [] });
    expect(
      solve([
        [-3e-10, 0, 0],
        [7e-10, 0, 0],
      ]).unwrap().coefficients,
    ).toEqual([Math.fround(0.3), Math.fround(1 - Math.fround(0.3))]);
  });

  it('uses planar length <= 1e-10 m for N2 coincidence, ignoring vertical separation', () => {
    for (const separation of [0, 1e-10]) {
      expect(
        solve([
          [0, -100, 0],
          [separation, 100, 0],
        ]).unwrap().coefficients,
      ).toEqual([0.5, 0.5]);
    }
    expect(
      solve([
        [0, 0, 0],
        [1.01e-10, 0, 0],
      ]).unwrap().coefficients,
    ).toEqual([0, 1]);
  });

  it('keeps source relative double-COM subtraction separate from socket and world force centers', () => {
    const points: Vec3[] = [
      [-2, 0, 0],
      [4, 0, 0],
    ];
    const relative = points.map((position) => pontoon(position, true, 'relative'));
    const sockets = points.map((position) => pontoon(position));
    expect(
      computeWaterPontoonCoefficients(relative, [0.5, 50, 0], true).unwrap().coefficients,
    ).toEqual([0.5, 0.5]);
    const first = Math.fround(2.5 / 6);
    expect(
      computeWaterPontoonCoefficients(sockets, [0.5, 50, 0], true).unwrap().coefficients,
    ).toEqual([first, Math.fround(1 - first)]);
    expect(
      computeWaterPontoonCoefficients(relative, [0.5, 50, 0], false).unwrap().coefficients,
    ).toEqual([first, Math.fround(1 - first)]);
  });

  it('takes the constant-Z branch first using per-coordinate 0.001 m alignment', () => {
    expect(
      solve([
        [-1, 0, 0],
        [0, 0, 0.001],
        [1, 0, -0.0009],
      ]).unwrap(),
    ).toMatchObject({ coefficients: Array(3).fill(Math.fround(1 / 3)), diagnostics: [] });
    expect(
      solve([
        [8, 0, -1],
        [8.0009, 0, 0],
        [7.9991, 0, 1],
      ]).unwrap(),
    ).toMatchObject({ coefficients: Array(3).fill(Math.fround(1 / 3)), diagnostics: [] });
  });

  it('retains the failed-axis lambda inputs, non-unit fraction sum and success diagnostic', () => {
    const output = solve([
      [0.0001, -4, 0],
      [0.0001, 9, 0],
      [0.0001, 80, 0],
    ]).unwrap();
    expect(output.coefficients).toEqual(Array(3).fill(Math.fround(1 / 3 - 0.0001)));
    expect(output.coefficients.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.9997, 6);
    expect(output.diagnostics).toEqual([
      { code: 'sprung-axis-singular', axis: 'x', determinantM2: 0, thresholdM2: 1e-14 },
    ]);
    const origin = solve([
      [0, -7, 0],
      [0, 0, 0],
      [0, 10, 0],
    ]).unwrap();
    expect(origin.coefficients).toEqual(Array(3).fill(Math.fround(1 / 3)));
    expect(origin.diagnostics).toEqual([
      { code: 'sprung-axis-singular', axis: 'x', determinantM2: 0, thresholdM2: 1e-14 },
    ]);
  });

  it('uses the SI squared determinant threshold rather than a coordinate or rank epsilon', () => {
    expect(
      solve([
        [-4e-8, 0, 0],
        [0, 0, 0],
        [4e-8, 0, 0],
      ]).unwrap().diagnostics,
    ).toEqual([
      {
        code: 'sprung-axis-singular',
        axis: 'x',
        determinantM2: expect.closeTo(9.6e-15, 25),
        thresholdM2: 1e-14,
      },
    ]);
    expect(
      solve([
        [-5e-8, 0, 0],
        [0, 0, 0],
        [5e-8, 0, 0],
      ]).unwrap().diagnostics,
    ).toEqual([]);
  });

  it('solves a general planar triangle and rejects singular or negative stored fractions', () => {
    expect(
      solve([
        [-1, 0, -1],
        [1, 0, -1],
        [0, 0, 1],
      ]).unwrap(),
    ).toMatchObject({ coefficients: [0.25, 0.25, 0.5], diagnostics: [] });
    expect(
      solve([
        [-1, 0, -1],
        [0, 0, 0],
        [1, 0, 1],
      ]),
    ).toMatchObject({ ok: false, error: { code: 'buoyancy-config-invalid' } });
    expect(
      solve([
        [1e-8, 0, 0],
        [1, 0, 0],
      ]),
    ).toMatchObject({ ok: false, error: { code: 'buoyancy-config-invalid' } });
    expect(
      solve([
        [2, 0, -1],
        [2, 0, 1],
        [3, 0, 0],
      ]),
    ).toMatchObject({ ok: false, error: { code: 'buoyancy-config-invalid' } });
    expect(solve([])).toMatchObject({ ok: false, error: { code: 'buoyancy-config-invalid' } });
  });
});
