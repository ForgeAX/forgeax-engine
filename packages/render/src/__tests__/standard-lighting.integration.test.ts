import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  prepareStandardLighting,
  type StandardLightFrame,
} from '../pipeline/standard-lighting/prepare';

function makeFrame(lightCount: 1 | 32 | 256, localCount: number): StandardLightFrame {
  const local = Array.from({ length: localCount }, (_, index) => ({
    kind: index % 2 === 0 ? ('point' as const) : ('spot' as const),
    shadowed: false,
    position: vec3.create((index % 4) - 1.5, 0, -4 - (index % 8)),
    range: 2,
  }));
  return {
    directional: {
      kind: 'directional',
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 2,
      contactShadowLength: 0,
    },
    local,
    view: mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]),
    projection: mat4.perspective(mat4.create(), Math.PI / 3, 1, 0.1, 100),
    near: 0.1,
    far: 100,
    grid: { x: 4, y: 3, z: 4 },
    lightCount,
    renderPath: 'forward',
  };
}

describe('Standard shared lighting derivation', () => {
  it.each([
    [1, 1],
    [32, 32],
    [256, 256],
  ] as const)('accepts the %i local-light budget without truncation', (lightCount, localCount) => {
    const result = prepareStandardLighting(makeFrame(lightCount, localCount));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.local.length).toBe(localCount);
    expect(result.value.membershipLightCount).toBe(localCount);
  });

  it('keeps DirectionalLight global and out of cluster membership', () => {
    const result = prepareStandardLighting(makeFrame(1, 1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.directional?.kind).toBe('directional');
    expect(result.value.membershipLightCount).toBe(1);
    expect(
      Array.from(result.value.lightIndexList.slice(0, result.value.membershipEntryCount)),
    ).not.toContain(1);
  });

  it('rejects local lights above the 256-light budget without truncation', () => {
    const result = prepareStandardLighting(makeFrame(256, 257));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'standard-light-budget-exceeded') return;
    expect(result.error.detail).toEqual({ actual: 257, budget: 256 });
  });
});
