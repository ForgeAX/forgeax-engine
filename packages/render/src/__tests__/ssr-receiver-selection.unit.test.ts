import { assert, describe, expect, it } from 'vitest';
import { MaterialResource } from '../material-resource';
import {
  createMainPassMaterialSelectionOwner,
  hasSsrSceneInputs,
  selectMainPassMaterials,
} from '../record/main-pass';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type MaterialSnapshot,
} from '../render-system-extract';
import { MaterialDispatch } from '../scene/material-dispatch';

import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
} from '../systems/pass-selector';

type SelectionContext = Parameters<typeof selectMainPassMaterials>[0] &
  Pick<Parameters<typeof hasSsrSceneInputs>[0], 'materialFrame' | 'renderables'>;

function material(handle: number, options: Partial<MaterialSnapshot> = {}): MaterialSnapshot {
  return { ...defaultMaterialSnapshot(handle), materialShaderId: `cooked:${handle}`, ...options };
}

function row(
  index: number,
  materials: readonly MaterialSnapshot[],
): SelectionContext['validatedOrdered'][number] {
  const first = materials[0];
  assert(first);
  return {
    renderableIndex: index,
    source: {
      material: new MaterialResource(first),
      materials: materials.map((value) => new MaterialResource(value)),
    },
  } as unknown as SelectionContext['validatedOrdered'][number];
}

function pass(index: number, handle: number, lightMode: string): DispatchEntry {
  return {
    entityIndex: index,
    materialHandle: handle,
    renderableIndex: index,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: lightMode },
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
  };
}

function context(
  materials: readonly MaterialSnapshot[],
  dispatch: readonly DispatchEntry[],
): SelectionContext {
  return prepare([row(0, materials)], dispatch);
}

function prepare(
  validatedOrdered: SelectionContext['validatedOrdered'],
  dispatch: SelectionContext['dispatch'],
): SelectionContext {
  let materialFrame = new MaterialDispatch().materials();
  const materialSlots: MaterialSnapshot[] = [];
  const materialSlotIndices = validatedOrdered.map((row) => {
    materialFrame = materialFrame.with(row.source.material);
    return row.source.materials.map((resource) => {
      materialFrame = materialFrame.with(resource);
      materialSlots.push(resource.snapshot);
      return materialSlots.length - 1;
    });
  });
  return {
    validatedOrdered,
    renderables: validatedOrdered.map((row) => row.source),
    dispatch,
    materialSlots,
    materialSlotIndices,
    materialFrame,
  };
}

function countSetAllocations<T>(run: () => T): { value: T; allocations: number } {
  const original = globalThis.Set;
  let allocations = 0;
  globalThis.Set = new Proxy(original, {
    construct(target, args, newTarget) {
      allocations++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const value = run();
    return { value, allocations };
  } finally {
    globalThis.Set = original;
  }
}

describe('main-pass material selection allocation', () => {
  it('creates no result sets for rejected renderables', () => {
    const c = prepare(
      Array.from({ length: 512 }, (_, i) => row(i, [material(i, { transparent: true })])),
      [],
    );
    const { value, allocations } = countSetAllocations(() =>
      selectMainPassMaterials(c, undefined, 'opaque'),
    );
    expect(value?.size).toBe(0);
    expect(allocations).toBe(0);
  });

  it('uses no native hash sets for selected singleton lanes through dispatch and mode selection', () => {
    const c = prepare(
      Array.from({ length: 512 }, (_, i) => row(i, [material(i)])),
      Array.from({ length: 512 }, (_, i) => pass(i, i, 'Forward')),
    );
    const { value, allocations } = countSetAllocations(() =>
      selectMainPassMaterials(c, { LightMode: ['Forward'] }, 'opaque'),
    );
    expect(value?.size).toBe(512);
    expect([...(value?.get(511) ?? [])]).toEqual([511]);
    expect(allocations).toBe(0);
  });

  it('fully observes borrowed material getters on every singleton selection and retry', () => {
    let transparent = false;
    let failure = false;
    let reads = 0;
    const borrowed = material(1);
    Object.defineProperty(borrowed, 'transparent', {
      get() {
        reads++;
        if (failure) throw new Error('borrowed material unavailable');
        return transparent;
      },
    });
    const c = context([material(2), borrowed], [pass(0, 1, 'Forward')]);
    const select = () => selectMainPassMaterials(c, { LightMode: ['Forward'] }, 'opaque');
    const first = select();
    expect([...(first?.get(0) ?? [])]).toEqual([1]);
    transparent = true;
    expect(select()?.size).toBe(0);
    failure = true;
    expect(select).toThrow('borrowed material unavailable');
    failure = false;
    transparent = false;
    const retry = select();
    expect([...(retry?.get(0) ?? [])]).toEqual([1]);
    expect(retry?.get(0)).not.toBe(first?.get(0));
    expect(reads).toBe(4);
  });
});

describe('SSR receiver selection', () => {
  it('admits a cooked opaque Deferred receiver by its selected handle, not the representative material', () => {
    const c = context(
      [material(1), material(2, { deferredPass: true })],
      [pass(0, 1, 'Forward'), pass(0, 2, 'Deferred')],
    );
    expect([
      ...(selectMainPassMaterials(c, { LightMode: ['Deferred'] }, 'opaque')?.get(0) ?? []),
    ]).toEqual([2]);
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(true);
  });

  it('ignores later blended and medium submeshes while retaining the opaque receiver', () => {
    const c = context(
      [
        material(1, { transparent: true }),
        material(2, { deferredPass: true }),
        material(3, { surfaceModel: 'single-layer-medium' }),
        material(4, {
          materialShaderId: 'forgeax::default-standard-pbr',
          paramSnapshot: { transmission: 0.5 },
          transparent: true,
        }),
      ],
      [pass(0, 1, 'Forward'), pass(0, 2, 'Deferred'), pass(0, 3, 'Forward'), pass(0, 4, 'Forward')],
    );
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(true);
    expect([
      ...(selectMainPassMaterials(c, { LightMode: ['Forward'] }, 'transparent')?.get(0) ?? []),
    ]).toEqual([1]);
    expect([
      ...(selectMainPassMaterials(c, undefined, 'single-layer-medium-color')?.get(0) ?? []),
    ]).toEqual([3]);
    expect([
      ...(selectMainPassMaterials(c, { LightMode: ['Forward'] }, 'transmission')?.get(0) ?? []),
    ]).toEqual([4]);
    expect(selectMainPassMaterials(c, undefined, 'transmission')?.size).toBe(0);
  });

  it('does not let a qualified first submesh hide an illegal selected writer', () => {
    const c = context(
      [material(1, { deferredPass: true }), material(2)],
      [pass(0, 1, 'Deferred'), pass(0, 2, 'Deferred')],
    );
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(false);
  });

  it('fails closed when a selected handle has no resolved material snapshot', () => {
    const c = context([material(1, { deferredPass: true })], [pass(0, 99, 'Deferred')]);
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(false);
  });

  it('requires at least one receiver across the selected renderables', () => {
    const c = prepare(
      [row(0, [material(1, { transparent: true })]), row(1, [material(2, { deferredPass: true })])],
      [pass(0, 1, 'Forward'), pass(1, 2, 'Deferred')],
    );
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(true);
    expect(hasSsrSceneInputs(prepare([], []), 'deferred')).toBe(false);
  });

  it.each([
    material(1),
    material(1, { transparent: true, deferredPass: true }),
    material(1, { surfaceModel: 'single-layer-medium', deferredPass: true }),
  ])('declines all-forward, all-transparent and all-medium selections', (only) => {
    const mode = only.deferredPass === true ? 'Deferred' : 'Forward';
    expect(hasSsrSceneInputs(context([only], [pass(0, 1, mode)]), 'deferred')).toBe(false);
  });

  it('keeps the original strict forward output qualification', () => {
    const canonical = material(1, { materialShaderId: 'forgeax::default-standard-pbr' });
    expect(hasSsrSceneInputs(context([canonical], [pass(0, 1, 'Forward')]), 'forward')).toBe(true);
    expect(
      hasSsrSceneInputs(
        context([material(1, { deferredPass: true })], [pass(0, 1, 'Deferred')]),
        'forward',
      ),
    ).toBe(false);
    expect(
      hasSsrSceneInputs(
        prepare(
          [row(0, [canonical]), row(1, [material(2, { transparent: true })])],
          [pass(0, 1, 'Forward'), pass(1, 2, 'Forward')],
        ),
        'forward',
      ),
    ).toBe(false);
    expect(hasSsrSceneInputs(prepare([], []), 'forward')).toBe(false);
  });
});

describe('record-owned material selections', () => {
  const select = (c: SelectionContext, mode: 'opaque' | 'transparent' = 'opaque') =>
    selectMainPassMaterials(c, FORWARD_PASS_SELECTOR, mode);

  it('shares stock lane membership and the same graph predicate/record result within one frame', () => {
    const c = context(
      [material(1), material(2, { transparent: true })],
      [pass(0, 1, 'Forward'), pass(0, 2, 'Forward'), pass(0, 1, 'Deferred')],
    );
    Object.assign(c, { mainPassMaterialSelection: createMainPassMaterialSelectionOwner(c) });
    const first = select(c);
    expect([...(first?.get(0) ?? [])]).toEqual([1]);
    expect(select(c)).toBe(first);
    expect([...(select(c, 'transparent')?.get(0) ?? [])]).toEqual([2]);
    expect(select(c, 'transparent')).toBe(select(c, 'transparent'));
    expect(
      selectMainPassMaterials(c, COLOR_PASS_SELECTOR, 'opaque', DEFERRED_PASS_SELECTOR)?.size,
    ).toBe(0);
    expect(selectMainPassMaterials(c, undefined, undefined)).toBeNull();
  });

  it('rebuilds the next frame, even when the producer reuses its arrays', () => {
    const borrowed = material(1);
    const c = context([borrowed], [pass(0, 1, 'Forward')]);
    Object.assign(c, { mainPassMaterialSelection: createMainPassMaterialSelectionOwner(c) });
    expect(select(c)?.size).toBe(1);
    Object.assign(borrowed, { transparent: true });
    Object.assign(c, { mainPassMaterialSelection: createMainPassMaterialSelectionOwner(c) });
    expect(select(c)?.size).toBe(0);
    expect(select(c, 'transparent')?.size).toBe(1);
  });

  it('preserves borrowed selector reads, changes, failures, and recovery', () => {
    const c = context([material(1)], [pass(0, 1, 'Forward')]);
    Object.assign(c, { mainPassMaterialSelection: createMainPassMaterialSelectionOwner(c) });
    let mode = 'Forward',
      reads = 0,
      fail = false;
    const selector = {
      get LightMode() {
        reads++;
        if (fail) throw new Error('selector failed');
        return [mode];
      },
    };
    const run = () => selectMainPassMaterials(c, selector, 'opaque');
    expect(run()?.size).toBe(1);
    mode = 'Deferred';
    expect(run()?.size).toBe(0);
    fail = true;
    expect(run).toThrow('selector failed');
    fail = false;
    mode = 'Forward';
    expect(run()?.size).toBe(1);
    expect(reads).toBe(4);
  });

  it('keeps capture roster and dispatch overrides outside the captured selection', () => {
    const c = context([material(1)], [pass(0, 1, 'Forward')]);
    Object.assign(c, { mainPassMaterialSelection: createMainPassMaterialSelectionOwner(c) });
    expect(select(c)?.size).toBe(1);
    const otherMaterial = material(1, { transparent: true });
    const otherRows = {
      ...prepare([row(0, [otherMaterial])], c.dispatch),
      mainPassMaterialSelection: createMainPassMaterialSelectionOwner(c),
    };
    expect(select(otherRows)?.size).toBe(0);
    Object.assign(otherMaterial, { transparent: false });
    expect(select(otherRows)?.size).toBe(1);
    const dispatch = [pass(0, 1, 'Deferred')];
    const otherDispatch = { ...c, dispatch };
    expect(select(otherDispatch)?.size).toBe(0);
    dispatch[0] = pass(0, 1, 'Forward');
    expect(select(otherDispatch)?.size).toBe(1);
    expect(select(c)?.size).toBe(1);
  });
});
