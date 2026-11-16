import { describe, expect, it } from 'vitest';
import {
  buildWaterWaveUploadPlan,
  WATER_BODY_DATA_STRIDE_BYTES,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  type WaterWaveUploadBody,
} from '../waves.js';

const body: WaterWaveUploadBody = {
  worldId: 0,
  worldIdentity: 'bounds-world',
  bodyGuid: 'bounds-body',
  bodyGeneration: 4,
  zoneGeneration: 3,
  waveSet: {
    inputDigest: '0'.repeat(64),
    waves: [],
    depthMaskM: 0,
    maxWaveHeightM: 0,
    timeSource: 'scene-clock',
  },
  timeSeconds: 2,
  previousTimeSeconds: 1,
  baseHeightM: 6,
  tileOriginWorldXZ: [0, 0],
  tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
  heightSource: { kind: 'fixed', fixedHeightM: 6, fixedDepthM: 5, fixedVelocityXZ: [2, 3] },
  supportsWaves: false,
  usesFlatSurfaceHeight: true,
  meshEdgeOverlayEnabled: false,
};

describe('Water Body dynamic bounds upload', () => {
  it('appends source bounds after the existing fields and leaves an unbound row disabled', () => {
    const bounds = [13, -9, 32, 48] as const;
    const plan = buildWaterWaveUploadPlan([
      { ...body, dynamicBoundsCenterExtentXZ: bounds },
      { ...body, bodyGuid: 'unbound-body', zoneGeneration: 0 },
    ]).unwrap();
    expect(WATER_BODY_DATA_STRIDE_BYTES).toBe(128);
    expect(plan.bodyBuffer.byteLength).toBe(256);
    expect(plan.bodyData[0]?.dynamicBoundsCenterExtentXZ).toEqual(bounds);
    expect(plan.bodyData[1]).not.toHaveProperty('dynamicBoundsCenterExtentXZ');
    const view = new DataView(plan.bodyBuffer.buffer);
    expect([0, 4, 8, 12].map((offset) => view.getUint32(offset, true))).toEqual([0, 0, 4, 2]);
    expect([80, 84, 88, 92].map((offset) => view.getFloat32(offset, true))).toEqual([6, 5, 2, 3]);
    expect([96, 100, 104, 108].map((offset) => view.getUint32(offset, true))).toEqual([0, 0, 0, 0]);
    expect([112, 116, 120, 124].map((offset) => view.getFloat32(offset, true))).toEqual(bounds);
    expect(plan.bodyBuffer.slice(240, 256)).toEqual(new Uint8Array(16));
  });

  it.each(
    [
      [0, 0, 0, 16],
      [0, 0, 16, -1],
      [0, 0, Infinity, 16],
      [Number.MAX_VALUE, 0, 16, 16],
      [0, 0, 16],
      [0, 0, Number.MIN_VALUE, 16],
    ].map((bounds) => ({ bounds })),
  )('rejects malformed or unrepresentable source bounds $bounds', ({ bounds }) => {
    expect(
      buildWaterWaveUploadPlan([
        { ...body, dynamicBoundsCenterExtentXZ: bounds } as unknown as WaterWaveUploadBody,
      ]),
    ).toMatchObject({ ok: false, error: { code: 'invalid-source' } });
  });
});
