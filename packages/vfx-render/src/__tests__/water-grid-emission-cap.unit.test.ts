import { describe, expect, it } from 'vitest';
import { simulationDispatches } from '../feature/emitter-program';
import { waterGridEmissionData } from '../feature/runtime-uniform';

const waterGridEmission = {
  scanCellCapacity: 256,
  maxParticlesPerFrame: 0,
  minimumWaterDepthM: 0,
  minimumEmissionAmount: 0,
  globalEmissionMultiplier: 1,
  maximumEmissionPerCell: 1,
  criteria: {
    curvature: { range: [0, 1], multiplier: 1 },
    vorticity: { range: [0, 1], multiplier: 1 },
    flowSpeed: { range: [0, 1], multiplier: 1 },
    velocityOffsetDepthDifference: { range: [0, 1], multiplier: 1 },
  },
  depthRestrictionRangeM: [0, 10],
  speedRestrictionRangeMPerSec: [0, 10],
  particle: {
    normalSpeedMPerSec: 0,
    randomSpeedMPerSec: 0,
    accelerationMPerSec2: [0, 0, 0],
    lifetimeSeconds: 1,
    initialSizeRangeM: [0.1, 0.2],
    uniformSizeMultiplier: 1,
    alphaCurveSamples: Array<number>(108).fill(1),
    sizeCurveSamples: Array<number>(98).fill(1),
  },
} as const;

describe('Water-grid emission cap', () => {
  it('encodes a zero append cap while retaining the independent burst spawn dispatch', () => {
    const emission = waterGridEmission;
    const projected = waterGridEmissionData(emission);
    const words = new Uint32Array(projected.buffer, projected.byteOffset, 4);
    expect(words[1]).toBe(0);

    const dispatches = simulationDispatches(
      {
        emitter: { capacity: 256, reflection: { entryPoints: [] } },
        spawnCount: 1,
        waterGridEmission: emission,
      } as never,
      { stages: [] } as never,
    );
    expect(
      dispatches.find((dispatch) => dispatch.entryPoint === 'forgeax_vfx_spawn_main'),
    ).toMatchObject({ workgroups: [1] });
    expect(
      dispatches.some(
        (dispatch) => dispatch.entryPoint === 'forgeax_vfx_water_emission_append_main',
      ),
    ).toBe(true);
  });
});
