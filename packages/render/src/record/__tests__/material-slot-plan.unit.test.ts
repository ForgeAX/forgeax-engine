import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import {
  capturedGpuMaterialLayout,
  captureGpuMaterialBindings,
} from '../../gpu-driven/captured-material-bindings';
import { MaterialResource } from '../../material-resource';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { DispatchList, MaterialSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../../scene/material-dispatch';
import {
  buildDispatchPlan,
  buildMaterialSlotPlan,
  findRenderablePrefixForSlotCapacity,
  materialSlotCountForPrefix,
} from '../frame';
import type { ValidatedRenderable } from '../frame-snapshot';

function material(): MaterialResource {
  return new MaterialResource({
    materialShaderId: 'forgeax::default-unlit',
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 1,
    passes: [],
  } satisfies MaterialSnapshot);
}
function row(
  index: number,
  resource = material(),
): ValidatedRenderable & { world: RenderResourceScope } {
  return {
    source: {
      worldId: 0,
      entityKey: index,
      material: resource,
      materials: [resource],
      transform: { world: new Float32Array(16) },
      materialBindingSources: [],
    },
    world: { identity: `scope-${index}` } as RenderResourceScope,
    mesh: {} as ValidatedRenderable['mesh'],
    renderableIndex: index,
    meshSlot: index,
    renderState: undefined,
    stencilReference: undefined,
  };
}
function ceiling(meshSlotCount: number, materialSlotCount = meshSlotCount) {
  return {
    growMeshSsbo: () => ({
      ok: false,
      code: 'mesh-ssbo-ceiling-reached',
      degradedTo: { meshSlotCount, materialSlotCount },
    }),
    meshSsboState: { meshSlotCount, materialSlotCount },
  } as never;
}

it('consumes producer material slots while keeping values and World scopes specific to each frame', () => {
  const a = material();
  const b = material();
  const sources = [
    { batch: { binding: { material: a, worldId: 1 } }, materialBindingClass: 'probe:2' },
    { batch: { binding: { material: a, worldId: 0 } }, materialBindingClass: 'probe:2' },
    { batch: { binding: { material: b, worldId: 0 } }, materialBindingClass: '' },
    { batch: { binding: { material: a, worldId: 0 } }, materialBindingClass: '' },
  ];
  const bindings = captureGpuMaterialBindings(sources as never);
  const layout = capturedGpuMaterialLayout(bindings);
  expect(capturedGpuMaterialLayout(Object.freeze([...bindings]))).toBeUndefined();
  // A prepared descriptor may later be replaced or edited; the capture owns its facts.
  const firstSource = sources[0] as (typeof sources)[number];
  firstSource.batch.binding.worldId = 0;
  const oldScope = row(0).world;
  const nextScope = row(1).world;
  let worlds = [oldScope, oldScope];
  let frame = new MaterialFrame(undefined).with(a).with(b);
  const before = frame.get(a)?.snapshot;
  const prepare = () =>
    buildDispatchPlan(ceiling(0, 3), [], [], [], [], undefined, false, {
      bindings,
      worlds,
      frame,
    });
  const first = prepare();
  const repeated = prepare();
  expect(layout?.layout?.unique).toHaveLength(3);
  expect(first.materialBindingSlots).toBe(layout?.layout?.slots);
  expect(repeated.materialBindingSlots).toBe(first.materialBindingSlots);
  expect(first.materialBindings.map((binding) => binding.resourceClass)).toEqual([
    'probe:2',
    '',
    '',
  ]);
  frame = frame.with(a, 1, { ...a.snapshot, roughness: 0.125 });
  worlds = [oldScope, nextScope];
  const next = prepare();
  expect(next.materialBindings[0]?.world).toBe(nextScope);
  expect(next.materialBindings[2]?.world).toBe(oldScope);
  expect(next.materialSlots[0]?.roughness).toBe(0.125);
  expect(first.materialSlots[0]).toBe(before);
  expect(first.materialBindings[0]?.world).toBe(oldScope);
  expect(next.materialBindings).not.toBe(first.materialBindings);
  expect(next.materialSlots).not.toBe(first.materialSlots);
  expect(() => prepare()).not.toThrow();
  worlds = [oldScope];
  expect(prepare).toThrow('the asset scope for every shared material');
  worlds = [oldScope, nextScope];
  expect(prepare().materialBindingSlots).toBe(first.materialBindingSlots);

  // Mixed CPU demand keeps the ordinary merged slot order and must not edit the capture.
  const mixed = buildDispatchPlan(ceiling(1, 4), [row(0, b)], [], [], [], undefined, false, {
    bindings,
    worlds,
    frame,
  });
  expect(mixed.materialBindingSlots.get(b)?.get('')).toBe(0);
  expect(mixed.materialBindingSlots.get(a)?.get('probe:2')).toBe(1);
  expect(layout?.layout?.slots.get(b)?.get('')).toBe(1);
  expect(prepare().materialBindingSlots).toBe(first.materialBindingSlots);
});

describe('material slot identity and scope', () => {
  it('bounds singleton slot vectors by actual bindings while observing every owner', () => {
    const a = material();
    const owners: number[] = [];
    const groups = Array.from({ length: 10000 }, () => [a]);
    const plan = buildMaterialSlotPlan(groups, (_material, owner) => {
      owners.push(owner);
      return owner % 2 === 0 ? '' : 'probe:1';
    });
    expect(owners).toEqual(Array.from({ length: groups.length }, (_, index) => index));
    expect(plan.slots).toEqual([a, a]);
    expect(plan.slotOwners).toEqual([0, 1]);
    expect(new Set(plan.slotIndices).size).toBe(2);
    expect(plan.slotIndices.every((slots, owner) => slots[0] === owner % 2)).toBe(true);
  });

  it('interns identities and resource classes independently of draw count', () => {
    const a = material();
    const b = material();
    expect(
      buildMaterialSlotPlan([[a, b], [a], [a]], (_, owner) => (owner === 1 ? 'probe:1' : '')),
    ).toEqual({
      slotIndices: [[0, 1], [2], [0]],
      slots: [a, b, a],
      slotOwners: [0, 0, 1],
      resourceClasses: ['', '', 'probe:1'],
    });
    expect(buildMaterialSlotPlan([[material()], [material()]]).slots).toHaveLength(2);
  });

  it('preserves sparse authored material slots', () => {
    const a = material();
    const slots: MaterialResource[] = [a];
    slots[2] = a;
    const groups: MaterialResource[][] = [slots];
    groups[2] = [a];
    const plan = buildMaterialSlotPlan(groups);
    expect(plan.slots).toEqual([a]);
    expect(plan.slotIndices[0]?.[2]).toBe(0);
    expect(1 in plan.slotIndices).toBe(false);
    expect(1 in (plan.slotIndices[0] ?? [])).toBe(false);
  });

  it('observes singleton accessors and retains custom array mapping', () => {
    const a = material();
    const reads = vi.fn(() => a);
    const ordinary = [a];
    Object.defineProperty(ordinary, 0, { get: reads });
    const custom = [a];
    const map = vi.spyOn(custom, 'map');
    const sparse: MaterialResource[] = new Array(1);
    const plan = buildMaterialSlotPlan([ordinary, [a], custom, sparse]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(map).toHaveBeenCalledTimes(1);
    expect(plan.slotIndices[0]).toBe(plan.slotIndices[1]);
    expect(Object.isFrozen(plan.slotIndices[0])).toBe(true);
    expect(plan.slotIndices[2]).toEqual([0]);
    expect(plan.slotIndices[3]).toHaveLength(1);
    expect(0 in (plan.slotIndices[3] ?? [])).toBe(false);
  });

  it('keeps material resource scope without retaining its representative mesh row', () => {
    const rows = [row(0), row(1)];
    const plan = buildDispatchPlan(ceiling(8), rows, [], []);
    expect(plan.materialBindings).toEqual(
      rows.map((entry) => ({
        material: entry.source.material,
        resourceClass: '',
        world: entry.world,
        entityKey: entry.source.entityKey,
      })),
    );
    expect(plan.materialSlots).toEqual(rows.map((entry) => entry.source.material.snapshot));
    expect(plan.materialBindings.some((binding) => 'source' in binding || 'mesh' in binding)).toBe(
      false,
    );
  });

  it('splits a shared material only for a distinct probe resource class', () => {
    const resource = material();
    const rows = [row(0, resource), row(1, resource), row(2, resource)];
    const plan = buildDispatchPlan(
      ceiling(8),
      rows,
      [],
      [],
      [],
      new Map([
        ['0:0', 'probe:0'],
        ['0:1', 'probe:1'],
        ['0:2', 'probe:0'],
      ]),
    );
    expect(plan.materialSlotIndices).toEqual([[0], [1], [0]]);
    expect(plan.materialBindings.map((binding) => binding.resourceClass)).toEqual([
      'probe:0',
      'probe:1',
    ]);
  });
});

describe('independent geometry and material capacity', () => {
  it('truncates only at complete material prefixes', () => {
    const indices = [[0], [1, 2, 3], [0, 4], [5, 6, 7, 8]];
    expect(findRenderablePrefixForSlotCapacity(indices, 3)).toBe(1);
    expect(findRenderablePrefixForSlotCapacity(indices, 5)).toBe(3);
    expect(materialSlotCountForPrefix(indices, 3)).toBe(5);
  });

  it('bounds offscreen shadows when the main view is empty', () => {
    const shadows = [row(0), row(1), row(2)];
    const plan = buildDispatchPlan(ceiling(2), [], [], [], shadows);
    expect(plan.validatedOrdered).toEqual([]);
    expect(plan.shadowValidatedOrdered).toEqual(shadows.slice(0, 2));
    expect(plan.materialSlots).toHaveLength(2);
  });

  it('reserves main rows before independent shadow transforms', () => {
    const main = [row(0), row(1)];
    const shadows = [row(2), row(3)];
    const plan = buildDispatchPlan(ceiling(3), main, [], [], shadows);
    expect(plan.validatedOrdered).toEqual(main);
    expect(plan.shadowValidatedOrdered).toEqual(shadows.slice(0, 1));
  });

  it('does not use shared material capacity as instance capacity', () => {
    const resource = material();
    const rows = Array.from({ length: 4 }, (_, index) => row(index, resource));
    const plan = buildDispatchPlan(ceiling(3, 1), rows.slice(0, 2), [], [], rows);
    expect(plan.validatedOrdered).toEqual(rows.slice(0, 2));
    expect(plan.shadowValidatedOrdered.map((entry) => entry.source)).toEqual([rows[0]?.source]);
    expect(plan.shadowValidatedOrdered[0]?.meshSlot).toBe(2);
    expect(plan.materialSlotIndices).toEqual([[0], [0], [0]]);
    expect(plan.materialSlotCount).toBe(1);
  });

  it('bounds material capacity when geometry capacity has room', () => {
    const main = row(0);
    const shadows = [row(1), row(2)];
    const plan = buildDispatchPlan(ceiling(16, 2), [main], [], [], shadows);
    expect(plan.shadowValidatedOrdered).toEqual(shadows.slice(0, 1));
    expect(plan.materialSlotIndices).toEqual([[0], [1]]);
    expect(plan.materialBindings.map((binding) => binding.entityKey)).toEqual([0, 1]);
  });

  it('retains GPU shadow material addresses after main geometry truncation', () => {
    const main = [row(0), row(1), row(2)];
    const shadow = row(3);
    const plan = buildDispatchPlan(ceiling(2, 4), main, [], [], [shadow], undefined, true);
    expect(plan.validatedOrdered).toEqual(main.slice(0, 2));
    expect(plan.shadowValidatedOrdered).toEqual([]);
    expect(plan.materialSlotIndices).toEqual([[0], [1], [3]]);
    expect(plan.materialSlots[3]).toBe(shadow.source.material.snapshot);
    expect(plan.materialBindings[3]?.world).toBe(shadow.world);
  });
});

describe('shared GPU materials without CPU geometry', () => {
  const unreadableDispatch = {
    get length(): never {
      throw new Error('full instance dispatch accessed');
    },
    [Symbol.iterator](): never {
      throw new Error('full instance dispatch iterated');
    },
  } as unknown as DispatchList;

  it('prepares fixed versions and sparse resource scopes without any instance reads', () => {
    const a = material();
    const b = material();
    const accepted = a.snapshot;
    const frame = new MaterialFrame(undefined).with(a).with(b);
    a.adopt({ ...a.snapshot, roughness: 0.125 });
    const worlds = [row(0).world, row(1).world];
    const bindings = [
      { material: a, worldId: 1, resourceClass: 'probe:23' },
      { material: a, worldId: 1, resourceClass: 'probe:23' },
      { material: a, worldId: 1, resourceClass: 'probe:41' },
      { material: b, worldId: 0, resourceClass: '' },
    ];
    const plan = buildDispatchPlan(
      ceiling(0, 3),
      [],
      unreadableDispatch,
      [],
      [],
      undefined,
      false,
      { bindings, worlds, frame },
    );
    expect(plan.validatedOrdered).toEqual([]);
    expect(plan.materialSlotIndices).toEqual([]);
    expect(plan.materialSlots).toEqual([accepted, accepted, b.snapshot]);
    expect(plan.materialSlots[0]).toBe(accepted);
    expect(plan.materialSlots[0]?.roughness).toBe(1);
    expect(plan.materialBindings).toEqual([
      { material: a, world: worlds[1], resourceClass: 'probe:23' },
      { material: a, world: worlds[1], resourceClass: 'probe:41' },
      { material: b, world: worlds[0], resourceClass: '' },
    ]);
  });

  it('shares a direct binding with GPU demand and retains GPU slots on geometry truncation', () => {
    const a = material();
    const b = material();
    const direct = row(0, a);
    const plan = buildDispatchPlan(ceiling(0, 2), [direct], [], [], [], undefined, false, {
      bindings: [a, b].map((material) => ({ material, worldId: 0, resourceClass: '' })),
      worlds: [direct.world],
      frame: new MaterialFrame(undefined).with(a).with(b),
    });
    expect(plan.validatedOrdered).toEqual([]);
    expect(plan.materialSlots).toEqual([a.snapshot, b.snapshot]);
    expect(plan.materialSlotCount).toBe(2);
  });

  it('shares one numeric slot across independent probe binding classes', () => {
    const a = material();
    const plan = buildDispatchPlan(
      ceiling(0, 1),
      [],
      unreadableDispatch,
      [],
      [],
      undefined,
      false,
      {
        bindings: ['', 'probe:2'].map((resourceClass) => ({
          material: a,
          worldId: 0,
          resourceClass,
        })),
        worlds: [row(0).world],
        frame: new MaterialFrame(undefined).with(a),
      },
    );
    expect(plan.materialBindings).toHaveLength(2);
  });

  it('identifies the source of an unfixed direct material without borrowing live values', () => {
    const resource = material();
    const direct = row(73, resource);
    expect(() =>
      buildDispatchPlan(ceiling(8), [direct], [], [], [], undefined, false, {
        bindings: [],
        worlds: [direct.world],
        frame: new MaterialFrame(undefined),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'rhi-descriptor-invalid',
        detail: expect.objectContaining({
          error: expect.objectContaining({
            detail: expect.objectContaining({
              worldId: 0,
              entityKey: 73,
              primaryMaterial: true,
              materialIdentity: expect.any(Number),
              materialFrameIdentity: expect.any(Number),
            }),
          }),
        }),
      }),
    );
  });

  it('rejects an unfixed shared material instead of borrowing its current value', () => {
    expect(() =>
      buildDispatchPlan(ceiling(0, 1), [], unreadableDispatch, [], [], undefined, false, {
        bindings: [{ material: material(), worldId: 0, resourceClass: '' }],
        worlds: [row(0).world],
        frame: new MaterialFrame(undefined),
      }),
    ).toThrow('a fixed material version for every prepared binding');
  });
});

it('prepares current GPU tables while keeping material edits, scopes and older recordings independent', () => {
  const a = material();
  const before = a.snapshot;
  let frame = new MaterialFrame(undefined).with(a);
  const worlds = [row(0).world];
  const bindings = Object.freeze([Object.freeze({ material: a, worldId: 0, resourceClass: '' })]);
  const runtime = ceiling(0, 2);
  const prepare = () =>
    buildDispatchPlan(runtime, [], [], [], [], undefined, false, { bindings, worlds, frame });
  const first = prepare();
  const repeated = prepare();
  expect(repeated.materialSlots).toEqual(first.materialSlots);
  expect(repeated.materialSlots).not.toBe(first.materialSlots);
  expect(repeated.materialBindings).toEqual(first.materialBindings);
  expect(repeated.materialBindings).not.toBe(first.materialBindings);
  expect(repeated.materialBindingSlots).toEqual(first.materialBindingSlots);
  expect(first.materialBindingSlots.get(a)?.get('')).toBe(0);
  a.adopt({ ...before, roughness: 0.125 });
  frame = frame.with(a);
  const edited = prepare();
  expect(edited.materialSlots[0]).toBe(a.snapshot);
  expect(first.materialSlots[0]).toBe(before);
  const previousWorld = worlds[0];
  worlds[0] = row(1).world;
  const moved = prepare();
  expect(moved.materialBindings[0]?.world).toBe(worlds[0]);
  expect(first.materialBindings[0]?.world).toBe(previousWorld);
  expect(moved.materialBindings).not.toBe(edited.materialBindings);
});

it('observes mutable members even in a frozen borrowed GPU binding array', () => {
  const a = material();
  const frame = new MaterialFrame(undefined).with(a);
  const worlds = [row(0).world, row(1).world];
  const binding = { material: a, worldId: 0, resourceClass: '' };
  const bindings = Object.freeze([binding]);
  const runtime = ceiling(0, 2);
  const prepare = () =>
    buildDispatchPlan(runtime, [], [], [], [], undefined, false, { bindings, worlds, frame });
  const first = prepare();
  binding.worldId = 1;
  binding.resourceClass = 'probe:2';
  const next = prepare();
  expect(next.materialBindings[0]?.world).toBe(worlds[1]);
  expect(next.materialBindingSlots.get(a)?.get('probe:2')).toBe(0);
  expect(next.materialBindingSlots.get(a)?.has('')).toBe(false);
  expect(first.materialBindings[0]?.world).toBe(worlds[0]);
});
