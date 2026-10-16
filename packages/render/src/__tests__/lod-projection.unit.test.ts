import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { parse, validate } from '../../../naga/src/index';
import {
  LOD_VIEW_CONSTANTS_BYTES,
  lodHeightScale,
  writeLodViewConstants,
} from '../gpu-driven/lod-projection.wgsl';
import { projectedHeight } from '../scene/visibility/lod-selector';
import { LOD_PROJECTION_HARNESS_WGSL } from './lod-projection-harness';

describe('LOD projection WGSL kernels', () => {
  it('validate with Naga inside the parity harness', async () => {
    const parsed = await parse(LOD_PROJECTION_HARNESS_WGSL);
    if (!parsed.ok) throw parsed.error;
    const validated = await validate(parsed.value);
    if (!validated.ok) throw validated.error;
    expect(validated.ok).toBe(true);
  });

  it('derive the host height scale from the CPU projected-height formula', () => {
    const base = { position: vec3.create(), orthoTop: 3, orthoBottom: -1 } as const;
    const perspective = { ...base, projection: 'perspective', fov: 0.9 } as const;
    expect((2 * 0.5 * lodHeightScale(perspective)) / 7).toBeCloseTo(
      projectedHeight({ radius: 0.5, depth: 7, projection: 'perspective', fov: 0.9 }),
      12,
    );
    const orthographic = { ...base, projection: 'orthographic', fov: 0 } as const;
    expect(2 * 0.5 * lodHeightScale(orthographic)).toBeCloseTo(
      projectedHeight({ radius: 0.5, depth: 7, projection: 'orthographic', orthoHeight: 4 }),
      12,
    );
    expect(lodHeightScale({ ...perspective, fov: 0 })).toBe(0);
    expect(lodHeightScale({ ...orthographic, orthoTop: -1 })).toBe(0);
  });

  it('write the LodViewConstants row the kernel reads', () => {
    const view = new DataView(new ArrayBuffer(LOD_VIEW_CONSTANTS_BYTES + 4));
    writeLodViewConstants(view, 4, {
      position: vec3.create(1, 2, 3),
      projection: 'orthographic',
      fov: 1,
      orthoTop: 1,
      orthoBottom: -1,
    });
    expect([1, 2, 3].map((_, axis) => view.getFloat32(4 + axis * 4, true))).toEqual([1, 2, 3]);
    expect(view.getUint32(16, true)).toBe(1);
    expect(view.getFloat32(20, true)).toBe(0.5);
  });
});
