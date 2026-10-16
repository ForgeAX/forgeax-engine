import { describe, expect, it } from 'vitest';
import { GPU_SCENE_SCHEMAS } from '../gpu-scene-schema';
import { buildGpuLodRows, encodeGpuLodRows, GPU_LOD_ROW_LAYOUT } from '../scene/visibility/gpu-lod';

describe('GPU LOD row schema', () => {
  it('projects absolute coverage and stable draw-template ranges into rows', () => {
    const rows = buildGpuLodRows({
      generation: 7,
      hysteresis: 0.1,
      ranges: [
        { firstIndex: 0, indexCount: 120, baseVertex: 0 },
        { firstIndex: 120, indexCount: 60, baseVertex: 0 },
        { firstIndex: 180, indexCount: 24, baseVertex: 0 },
      ],
      coverages: [1, 0.5, 0.2],
      ready: [true, true, false],
    });

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      generation: 7,
      level: 1,
      screenCoverage: 0.5,
      firstIndex: 120,
      indexCount: 60,
      ready: true,
    });
    expect(rows[2]?.ready).toBe(false);
    expect(GPU_SCENE_SCHEMAS.lod.fields.map((field) => field.name)).toEqual([
      'generation',
      'level',
      'firstIndex',
      'indexCount',
      'baseVertex',
      'screenCoverage',
      'hysteresis',
      'ready',
    ]);
    expect(GPU_LOD_ROW_LAYOUT.stride).toBe(32);
  });

  it('encodes the same bytes for CPU and GPU consumers', () => {
    const rows = buildGpuLodRows({
      generation: 3,
      hysteresis: 0.05,
      ranges: [
        { firstIndex: 0, indexCount: 36, baseVertex: -2 },
        { firstIndex: 36, indexCount: 12, baseVertex: -2 },
      ],
      coverages: [1, 0.25],
      ready: [true, true],
    });
    const bytes = encodeGpuLodRows(rows);
    expect(bytes.byteLength).toBe(GPU_LOD_ROW_LAYOUT.stride * rows.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(3);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getInt32(16, true)).toBe(-2);
    expect(view.getFloat32(20, true)).toBe(1);
    expect(view.getUint32(GPU_LOD_ROW_LAYOUT.stride + 28, true)).toBe(1);
  });
});
