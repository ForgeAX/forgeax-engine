import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedVolumetricFog } from '../../render-system-extract';
import type { VolumeBounds } from '../../volume/component';
import { volumetricFogForView } from '../volume-view';

const camera = {
  position: new Float32Array([0, 0, 0]),
  world: mat4.identity(mat4.create()),
  fov: Math.PI / 2,
  aspect: 1,
  near: 0.1,
  far: 10,
  projection: 'perspective',
  orthoLeft: -1,
  orthoRight: 1,
  orthoTop: 1,
  orthoBottom: -1,
  antialias: 'none',
} as unknown as CameraSnapshot;
const fog = (bounds: VolumeBounds): ExtractedVolumetricFog => ({
  status: 'available',
  fog: { bounds } as NonNullable<ExtractedVolumetricFog['fog']>,
});
const front = fog({ min: [-0.2, -0.2, -2], max: [0.2, 0.2, -1] });
const side = fog({ min: [10, -1, -2], max: [11, 1, -1] });
const project = (value: ExtractedVolumetricFog | undefined, view = camera) =>
  volumetricFogForView(value, view, 1000, 1000);

describe('validated local fog view gate', () => {
  it('omits only an entirely offscreen set and preserves mixed-member ordering and optics', () => {
    expect(project(side)).toBeUndefined();
    const bothOutside = { ...side, additional: [fog({ min: [-11, -1, -2], max: [-10, 1, -1] })] };
    expect(project(bothOutside)).toBeUndefined();
    const mixed = { ...side, additional: [front] };
    expect(project(mixed)).toBe(mixed);
    expect(project(front)).toBe(front);
  });
  it('retains camera-inside, plane-contact and TAA edge volumes', () => {
    const inside = fog({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(project(inside)).toBe(inside);
    const contact = fog({ min: [2, -0.1, -2], max: [2.1, 0.1, -1.9] });
    expect(project(contact)).toBe(contact);
    const jitterEdge = fog({ min: [2.001, -0.1, -2], max: [2.002, 0.1, -1.999] });
    expect(project(jitterEdge, { ...camera, antialias: 'taa' })).toBe(jitterEdge);
    const unknownExtent = { ...camera, antialias: 'taa', view: {} } as CameraSnapshot;
    expect(project(side, unknownExtent)).toBe(side);
  });
  it('keeps volumes past camera far because background rays use authored maxDistance', () => {
    const distant = fog({ min: [-1, -1, -101], max: [1, 1, -100] });
    expect(project(distant)).toBe(distant);
  });
  it('handles behind-eye, orthographic and opposing views independently', () => {
    const behind = fog({ min: [-0.1, -0.1, 1], max: [0.1, 0.1, 2] });
    expect(project(behind)).toBeUndefined();
    expect(project(behind, { ...camera, projection: 'orthographic' })).toBeUndefined();
    expect(project(front, { ...camera, projection: 'orthographic' })).toBe(front);
    const reversed = mat4.identity(mat4.create());
    reversed[0] = -1;
    reversed[10] = -1;
    const reverse = { ...camera, world: reversed };
    expect(project(behind, reverse)).toBe(behind);
    expect(project(front, reverse)).toBeUndefined();
  });
  it('does not hide degraded, incomplete, invalid or unknown projection facts', () => {
    const degraded = { status: 'degraded' } as const;
    expect(project(degraded)).toBe(degraded);
    const incomplete = { status: 'available' } as const;
    expect(project(incomplete)).toBe(incomplete);
    const invalid = fog({ min: [10, 0, 0], max: [9, 1, 1] });
    expect(project(invalid)).toBe(invalid);
    expect(volumetricFogForView(side, camera, 0, 0)).toBe(side);
    expect(project(undefined)).toBeUndefined();
  });
});
