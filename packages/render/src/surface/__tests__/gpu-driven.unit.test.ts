import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { admitSingleLayerMediumSubmission } from '../gpu-driven.js';

const abi: MaterialProgramAbi = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { addressUnitBytes: 16, byteLength: 416, fields: [] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  alphaMask: { cutoff: '', source: '' },
  reflection: {
    layoutIdentity: 'material-program/test',
    resourceSlots: [],
    vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  },
  receiptIdentity: 'material-program/test',
  generation: 3,
  surface: {
    model: 'single-layer-medium',
    module: 'game::water_surface',
    inputAbi: 'SingleLayerMediumSurfaceInput',
    outputAbi: 'SingleLayerMediumSurfaceData',
    passes: ['nearest-layer', 'color'],
  },
};

const ready = {
  abi,
  caps: { compute: true, storageBuffer: true, indirectDrawing: true },
  sceneIndexReady: true,
  resourcesReady: true,
  dynamicInputReady: true,
  deviceGeneration: 3,
  preparedDeviceGeneration: 3,
};

describe('single-layer Surface GPU-driven admission', () => {
  it('admits nearest-layer and color to the same GPU-driven lane', () => {
    const result = admitSingleLayerMediumSubmission(ready);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lane).toBe('gpu-driven');
    expect(result.value.passes).toMatchObject([
      {
        pass: 'nearest-layer',
        lane: 'gpu-driven',
      },
      {
        pass: 'color',
        lane: 'gpu-driven',
      },
    ]);
  });

  it('uses the same two pass members on a capability fallback and names the reason', () => {
    const result = admitSingleLayerMediumSubmission({
      ...ready,
      caps: { compute: false, storageBuffer: true, indirectDrawing: true },
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        lane: 'direct',
        passes: [
          { pass: 'nearest-layer', lane: 'direct', reason: 'compute' },
          { pass: 'color', lane: 'direct', reason: 'compute' },
        ],
      },
    });
  });

  it('blocks missing publication and stale prepared generations', () => {
    const { surface: _surface, ...abiWithoutSurface } = abi;
    expect(admitSingleLayerMediumSubmission({ ...ready, abi: abiWithoutSurface })).toMatchObject({
      ok: false,
      error: { code: 'surface-abi-missing', owner: 'surface-producer' },
    });
    expect(
      admitSingleLayerMediumSubmission({ ...ready, preparedDeviceGeneration: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'surface-generation-stale', owner: 'render-generation' },
    });
  });
});
