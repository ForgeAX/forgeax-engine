import { World } from '@forgeax/engine-ecs';
import { expect, it, vi } from 'vitest';
import {
  captureMaterialSnapshot,
  MaterialResource,
  ownedMaterialValues,
} from '../material-resource';
import { worldRenderResources } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { projectFramePresentation } from '../render-system-presentation';

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
        coveredBindings: [{ worldId: 0, material }],
        preparedWorlds: [scope],
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
