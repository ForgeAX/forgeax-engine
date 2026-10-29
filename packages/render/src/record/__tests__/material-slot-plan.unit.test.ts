import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
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

describe('material slot identity and scope', () => {
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
