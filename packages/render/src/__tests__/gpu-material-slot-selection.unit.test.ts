import { expect, it } from 'vitest';
import { selectGpuMaterialSlots } from '../record/main-pass';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../render-system-extract';

function material(
  modes: readonly string[],
  fields: Partial<MaterialSnapshot> = {},
): MaterialSnapshot {
  return {
    ...defaultMaterialSnapshot(1),
    passes: modes.map((mode) => ({
      name: mode,
      program: { module: 'game::material' },
      renderState: { tags: { LightMode: mode } },
    })),
    ...fields,
  };
}

it('selects shared slots by accepted Passes, including exclusion and medium routing', () => {
  const slots = [
    material(['Forward']),
    material(['Forward', 'Deferred']),
    material(['Forward'], { transparent: true }),
    material(['Medium'], { surfaceModel: 'single-layer-medium' }),
    material(['ShadowCaster']),
  ];
  const forward = { LightMode: ['Forward'] };
  const deferred = { LightMode: ['Deferred'] };
  expect(selectGpuMaterialSlots(slots, undefined, undefined)).toBeUndefined();
  expect(selectGpuMaterialSlots(slots, forward, 'opaque')).toEqual(new Set([0, 1]));
  expect(selectGpuMaterialSlots(slots, forward, 'opaque', deferred)).toEqual(new Set([0]));
  expect(selectGpuMaterialSlots(slots, forward, 'transparent')).toEqual(new Set([2]));
  expect(selectGpuMaterialSlots(slots, forward, 'single-layer-medium-color')).toEqual(new Set([3]));
  expect(selectGpuMaterialSlots(slots, deferred, undefined)).toEqual(new Set([1]));
  // A retained snapshot keeps its selected Passes after the next publication changes them.
  const next = [...slots];
  next[0] = material(['ShadowCaster']);
  expect(selectGpuMaterialSlots(next, forward, 'opaque')).toEqual(new Set([1]));
  expect(selectGpuMaterialSlots(slots, forward, 'opaque')).toEqual(new Set([0, 1]));
});
