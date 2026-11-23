import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import {
  captureMaterialSnapshot,
  MaterialResource,
  materialResource,
  ownedMaterialValues,
} from '../material-resource';
import { Materials } from '../materials';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import {
  defaultMaterialSnapshot,
  prepareMaterialSnapshot,
  resolveMaterialSnapshot,
  storeMaterialSnapshot,
} from '../render-system-extract';
import { projectFramePresentation } from '../render-system-presentation';

it('retains the detached programs already built by material preparation', () => {
  const assets = new AssetRegistry();
  const scope = worldRenderResources(new World());
  try {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const prepared = prepareMaterialSnapshot({
      handle: 1,
      material,
      world: scope,
      assets,
      programSelections: undefined,
    });
    const accepted = storeMaterialSnapshot(new Map(), 1, prepared, scope);
    expect(accepted.retry).toBeUndefined();
    expect(accepted.snapshot.passes).toBe(prepared.passes);
    expect(accepted.snapshot.materialProgramInputs).toBe(prepared.materialProgramInputs);
    expect(Object.isFrozen(accepted.snapshot.passes[0]?.program)).toBe(true);
  } finally {
    assets.dispose();
  }
});

it('retains program facts across managed value edits and refreshes them on a Pass change', () => {
  const assets = new AssetRegistry();
  const scope = worldRenderResources(new World({ assets }));
  try {
    const material = Materials.unlit([1, 1, 1, 1]);
    const handle = assets.create(material).unwrap();
    const cache = new Map();
    const read = () => resolveMaterialSnapshot(handle, scope, assets, undefined, cache);
    const first = read();
    const resource = materialResource(first);
    const pass = first.passes[0];
    if (resource === undefined || pass === undefined)
      throw new Error('expected a prepared material');
    const firstProgram = resource.programObservation(pass);

    assets.update(handle, { values: { baseColor: [0.5, 0.5, 1, 1] } }).unwrap();
    expect(read().passes).toBe(first.passes);

    assets.update(handle, { values: { baseColor: [0.25, 0.5, 1, 1] } }).unwrap();
    const enumerate = vi.spyOn(Object, 'keys');
    let edited: ReturnType<typeof read>;
    try {
      edited = read();
      expect(enumerate.mock.calls.some(([value]) => value === first.passes)).toBe(false);
      expect(enumerate.mock.calls.some(([value]) => value === pass.program)).toBe(false);
    } finally {
      enumerate.mockRestore();
    }
    expect(edited.passes).toBe(first.passes);
    expect(edited.materialProgramInputs).toBe(first.materialProgramInputs);
    expect(edited.materialContext).toBe(first.materialContext);
    expect(materialResource(edited)?.programObservation(pass)).toBe(firstProgram);
    expect([...edited.baseColor]).toEqual([0.25, 0.5, 1]);
    expect([...first.baseColor]).toEqual([1, 1, 1]);

    assets.replace(handle, Materials.standard({ baseColor: [1, 0, 0, 1] })).unwrap();
    const replacement = read();
    expect(replacement.passes).not.toBe(edited.passes);
    expect(replacement.materialShaderId).not.toBe(edited.materialShaderId);
    expect([...replacement.baseColor]).toEqual([1, 0, 0]);
  } finally {
    assets.dispose();
  }
});

it('publishes a detached fixed ownership fact without repeated metadata inspection', () => {
  const source = { ...defaultMaterialSnapshot() };
  const captured = captureMaterialSnapshot(source);
  expect(captured).not.toBe(source);
  expect(Object.isFrozen(captured)).toBe(true);
  const resource = new MaterialResource(captured);
  const inspect = vi.spyOn(Object, 'getOwnPropertyDescriptor');
  try {
    for (let phase = 0; phase < 32; phase++) expect(resource.ownsValues(captured)).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    inspect.mockRestore();
  }
  expect(source.immutableValues).toBeUndefined();
});

it('shares only fully frozen program facts across value-only captures', () => {
  const base = defaultMaterialSnapshot();
  const frozen = Object.freeze({ forward: 'shader/a' });
  const passes = Object.freeze([]) as typeof base.passes;
  const captured = captureMaterialSnapshot({ ...base, passes, materialProgramKeys: frozen });
  const updated = captureMaterialSnapshot({ ...captured, roughness: 0.2 });
  expect(updated.passes).toBe(passes);
  expect(updated.materialProgramKeys).toBe(frozen);

  const key = { forward: 'shader/b' };
  const borrowed = captureMaterialSnapshot({ ...base, passes, materialProgramKeys: key });
  key.forward = 'shader/c';
  expect(borrowed.passes).toBe(passes);
  expect(borrowed.materialProgramKeys?.forward).toBe('shader/b');
  expect(borrowed.materialProgramKeys).not.toBe(key);
});

it('keeps proxy inspection live even when its target was captured by the producer', () => {
  const captured = captureMaterialSnapshot(defaultMaterialSnapshot());
  const descriptor = vi.fn(Reflect.getOwnPropertyDescriptor);
  const { proxy, revoke } = Proxy.revocable<typeof captured>(captured, {
    getOwnPropertyDescriptor: descriptor,
  });
  expect(ownedMaterialValues(proxy)).toBe(true);
  expect(ownedMaterialValues(proxy)).toBe(true);
  expect(descriptor).toHaveBeenCalledTimes(2);
  revoke();
  expect(ownedMaterialValues(proxy)).toBe(false);
  expect(ownedMaterialValues(captured)).toBe(true);
});

it('does not retain mutable or accessor ownership claims from borrowed snapshots', () => {
  const borrowed = { ...defaultMaterialSnapshot(), immutableValues: true as const };
  expect(ownedMaterialValues(borrowed)).toBe(true);
  Reflect.deleteProperty(borrowed, 'immutableValues');
  expect(ownedMaterialValues(borrowed)).toBe(false);
  const getter = vi.fn(() => true);
  Object.defineProperty(borrowed, 'immutableValues', { get: getter });
  expect(ownedMaterialValues(borrowed)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});

it('moves the fixed value fact with adoption and never grants it to a copied snapshot', () => {
  const first = captureMaterialSnapshot(defaultMaterialSnapshot(1));
  const second = captureMaterialSnapshot(defaultMaterialSnapshot(2));
  const resource = new MaterialResource(first);
  expect(resource.ownsValues(first)).toBe(true);
  resource.adopt(second);
  expect(resource.ownsValues(first)).toBe(false);
  expect(resource.ownsValues(second)).toBe(true);
  const copied = { ...second };
  resource.adopt(copied);
  expect(resource.ownsValues(copied)).toBe(false);
  expect(resource.ownsValues(second)).toBe(false);
});

it('consumes the resource-owned value fact in actual frame presentation', () => {
  const scope = worldRenderResources(new World());
  const material = new MaterialResource(captureMaterialSnapshot(defaultMaterialSnapshot()));
  const inspect = vi.spyOn(Object, 'getOwnPropertyDescriptor');
  try {
    expect(
      projectFramePresentation({
        renderables: [],
        coveredBindings: [{ material }],
        preparedSourceScope: scope,
        internals: {} as RenderSystemInternals,
      }),
    ).toBe('ready');
    expect(inspect).not.toHaveBeenCalled();
  } finally {
    inspect.mockRestore();
  }
});

it('transfers fixed program values through exact-snapshot clones and accepted adoption', () => {
  const source = captureMaterialSnapshot(defaultMaterialSnapshot());
  const staged = new MaterialResource(source);
  const program = { ...source, materialParamSchema: [] };
  staged.adoptProgramSnapshot(program);
  expect(staged.ownsValues(program)).toBe(true);
  expect(staged.ownsValues(source)).toBe(false);
  const copiedOwner = new MaterialResource(program);
  expect(copiedOwner.ownsValues(program)).toBe(true);
  const accepted = new MaterialResource(defaultMaterialSnapshot());
  accepted.adopt(program);
  expect(accepted.ownsValues(program)).toBe(true);
  accepted.adopt({ ...program });
  expect(accepted.ownsValues(accepted.snapshot)).toBe(false);
  expect(copiedOwner.ownsValues(program)).toBe(true);
});

it('keeps a fixed snapshot proven when its latest resource adopts another snapshot', () => {
  const source = captureMaterialSnapshot(defaultMaterialSnapshot());
  const producer = new MaterialResource(source);
  const program = { ...source, materialParamSchema: [] };
  producer.adoptProgramSnapshot(program);
  const later = new MaterialResource(program);
  later.adopt({ ...program });
  expect(later.ownsValues(later.snapshot)).toBe(false);
  expect(producer.ownsValues(program)).toBe(true);
  const held = new MaterialResource(program);
  expect(held.ownsValues(program)).toBe(true);
});
