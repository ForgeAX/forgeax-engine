import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CLUSTER_GRID } from '../pipeline/standard-lighting/layout';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import {
  createStandardLocalLights,
  standardLocalLightEmitsNothing,
} from '../record/frame-lighting';
import type { PointLightSnapshot, SpotLightSnapshot } from '../render-system-extract';
import type { ViewLights } from '../world/render-lights';

function point(color: [number, number, number], invRangeSquared = 1 / 100): PointLightSnapshot {
  return {
    kind: 'point',
    position: vec3.create(0, 0, -4),
    color: vec3.create(...color),
    intensity: 1,
    invRangeSquared,
  } as PointLightSnapshot;
}

function spot(color: [number, number, number]): SpotLightSnapshot {
  return {
    kind: 'spot',
    position: vec3.create(0, 0, -2),
    direction: vec3.create(0, 0, -1),
    color: vec3.create(...color),
    intensity: 1,
    invRangeSquared: 1 / 100,
    cosInner: Math.cos(0.3),
    cosOuter: Math.cos(0.5),
    castShadow: false,
    shadowAtlasTile: -1,
  } as unknown as SpotLightSnapshot;
}

function roster(points: PointLightSnapshot[], spots: SpotLightSnapshot[] = []): ViewLights {
  return { point: points, spot: spots, rect: [], pointShadow: [] } as unknown as ViewLights;
}

function prepare(lights: ViewLights) {
  return prepareStandardLighting({
    directional: undefined,
    local: createStandardLocalLights(lights),
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: DEFAULT_CLUSTER_GRID,
    lightCount: 32,
    renderPath: 'forward',
  }).unwrap();
}

describe('Standard zero-radiance local lights', () => {
  it('classifies only exactly black or zero-reach lights as dark', () => {
    expect(standardLocalLightEmitsNothing('point', point([0, 0, 0]))).toBe(true);
    expect(standardLocalLightEmitsNothing('point', point([0, 0, 1e-30]))).toBe(false);
    expect(standardLocalLightEmitsNothing('point', point([1, 1, 1], 1e8))).toBe(true);
    expect(standardLocalLightEmitsNothing('point', point([1, 1, 1], 0))).toBe(false);
    expect(standardLocalLightEmitsNothing('point', point([Number.NaN, 0, 0]))).toBe(false);
    expect(standardLocalLightEmitsNothing('spot', spot([0, 0, 0]))).toBe(true);
  });

  it('keeps a dark light in its slot but gives it no cluster membership', () => {
    const lit = prepare(roster([point([1, 1, 1]), point([1, 1, 1])], [spot([1, 1, 1])]));
    const dark = prepare(roster([point([1, 1, 1]), point([0, 0, 0])], [spot([0, 0, 0])]));
    // Same slots, same light count: no layout or variant change.
    expect(dark.local).toHaveLength(3);
    expect(dark.membershipLightCount).toBe(lit.membershipLightCount);
    expect(dark.layout.grid).toEqual(lit.layout.grid);
    // Slots 1 and 2 are culled; slot 0 bins exactly as before.
    expect(dark.lightBounds[8 + 20]).toBe(-1);
    expect(dark.lightBounds[8 + 40]).toBe(-1);
    expect(Array.from(dark.lightBounds.slice(8, 14))).toEqual(
      Array.from(lit.lightBounds.slice(8, 14)),
    );
    const only = prepare(roster([point([1, 1, 1])]));
    expect(dark.membershipEntryCount).toBe(only.membershipEntryCount);
    expect(dark.membershipEntryCount).toBeLessThan(lit.membershipEntryCount);
  });
});
