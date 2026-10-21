import { expect, it, vi } from 'vitest';
import type { DispatchEntry } from '../../render-system-extract';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { COLOR_PASS_SELECTOR, FORWARD_PASS_SELECTOR } from '../../systems/pass-selector';
import type { ValidatedRenderable } from '../frame-snapshot';
import {
  createMainPassMaterialSelectionOwner,
  matchedMaterialsForRecordMode,
  selectMainPassDispatch,
} from '../main-pass';
import { filterDispatchBySelector } from '../shadow-pass';

it('shares fixed dispatch selections across graph passes and observes a fresh record', () => {
  let reads = 0;
  let lightMode = 'Forward';
  const dispatch = Array.from({ length: 4096 }, (_, renderableIndex) => ({
    renderableIndex,
    tags: {
      get LightMode() {
        reads++;
        return lightMode;
      },
    },
  })) as unknown as DispatchEntry[];
  const input = { dispatch, validatedOrdered: [], materialSlots: [], materialSlotIndices: [] };
  const c = { ...input, mainPassMaterialSelection: createMainPassMaterialSelectionOwner(input) };
  const selected = selectMainPassDispatch(c, FORWARD_PASS_SELECTOR);
  for (let pass = 0; pass < 4; pass++)
    expect(selectMainPassDispatch(c, FORWARD_PASS_SELECTOR)).toBe(selected);
  expect(reads).toBe(dispatch.length);
  expect(selected).toEqual(dispatch);
  expect(selectMainPassDispatch(c, COLOR_PASS_SELECTOR)).toEqual(dispatch);
  expect(reads).toBe(dispatch.length * 2);
  lightMode = 'Deferred';
  c.mainPassMaterialSelection = createMainPassMaterialSelectionOwner(input);
  expect(selectMainPassDispatch(c, FORWARD_PASS_SELECTOR)).toEqual([]);
  expect(selectMainPassDispatch(c, COLOR_PASS_SELECTOR)).toEqual(dispatch);
});

it('preserves custom selector observations and borrowed roster overrides', () => {
  let reads = 0;
  const dispatch = [
    {
      tags: {
        get LightMode() {
          reads++;
          return 'Forward';
        },
      },
    },
  ] as unknown as DispatchEntry[];
  const input = { dispatch, validatedOrdered: [], materialSlots: [], materialSlotIndices: [] };
  const c = { ...input, mainPassMaterialSelection: createMainPassMaterialSelectionOwner(input) };
  const custom = { LightMode: ['Forward'] };
  for (let pass = 0; pass < 3; pass++)
    expect(selectMainPassDispatch(c, custom)).toEqual(filterDispatchBySelector(dispatch, custom));
  expect(reads).toBe(6);
  const override = { ...c, dispatch: [...dispatch] };
  expect(selectMainPassDispatch(override, FORWARD_PASS_SELECTOR)).toEqual(dispatch);
  expect(selectMainPassDispatch(override, FORWARD_PASS_SELECTOR)).toEqual(dispatch);
  expect(reads).toBe(8);
});

it('selects all material lanes without projecting temporary handle arrays', async () => {
  const entry = { renderableIndex: 0 } as ValidatedRenderable;
  const opaque = defaultMaterialSnapshot(7);
  const materials = [
    opaque,
    { ...opaque, materialHandle: 9, transparent: true },
    {
      ...opaque,
      materialHandle: 11,
      materialShaderId: 'forgeax::default-standard-pbr',
      paramSnapshot: { transmission: 1 },
    },
    { ...opaque, materialHandle: 13, surfaceModel: 'single-layer-medium' as const },
    { ...opaque, materialHandle: 16 },
    { ...opaque, materialHandle: undefined },
  ];
  const projection = vi.spyOn(materials, 'map').mockImplementation(() => {
    throw new Error('material handle projection allocates a temporary array');
  });
  const c = {
    dispatch: [],
    validatedOrdered: [entry],
    materialSlots: materials,
    materialSlotIndices: [[0, 1, 2, 3, 4, 5]],
  };
  const dispatch = new Map([[entry.renderableIndex, new Set([9, 11, 99])]]);
  const selected = (
    mode: Parameters<typeof matchedMaterialsForRecordMode>[2],
    matched: Parameters<typeof matchedMaterialsForRecordMode>[1] = null,
  ) => [...(matchedMaterialsForRecordMode(c, matched, mode)?.get(entry.renderableIndex) ?? [])];
  try {
    expect(matchedMaterialsForRecordMode(c, dispatch, undefined)).toBe(dispatch);
    expect(selected('opaque')).toEqual([7, 16, 0]);
    expect(selected('transparent')).toEqual([9]);
    expect(selected('oit-accumulate')).toEqual([9]);
    expect(selected('oit-residual')).toEqual([9]);
    expect(selected('transmission')).toEqual([]);
    expect(selected('transmission', dispatch)).toEqual([11]);
    expect(selected('opaque', dispatch)).toEqual([]);
    expect(selected('single-layer-medium-nearest-layer', dispatch)).toEqual([13]);
    expect(selected('single-layer-medium-color')).toEqual([13]);
    expect(projection).not.toHaveBeenCalled();
  } finally {
    projection.mockRestore();
  }
});
