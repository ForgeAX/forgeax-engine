import { vec3 } from '@forgeax/engine-math';
import { assert, expect, it, vi } from 'vitest';
import { BatchTopology } from '../../gpu-driven/batch-topology';
import { GpuDrivenMaterialProgramProjection } from '../../gpu-driven/material-artifacts';
import { captureMaterialSnapshot, MaterialResource } from '../../material-resource';
import { getOpaqueResourceIdentity } from '../../opaque-resource-identity';
import { hasForwardShadowCoverage } from '../../pipeline/forward-shadow-admission';
import type {
  DispatchList,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../../render-system-extract';
import * as drawEntries from '../dispatch-entry';
import {
  appendGeneratedQueue,
  captureGeneratedQueueSource,
  culledViewDemand,
  dispatchPassWork,
  hasShadowPasses,
  MaterialDispatch,
  MaterialFrame,
  projectCapturedViewDispatch,
  someCapturedMaterialPass,
  visitCapturedCasterMaterials,
  visitCapturedPassRanks,
  writeCapturedCasterRanks,
} from '../material-dispatch';
import type { MeshFrame } from '../mesh-frame';
import { RenderScene } from '../render-scene';
import type { RenderSceneSlot } from '../render-scene-types';
import { type SceneSlotFrame, SceneSlots } from '../scene-slots';
import { setSceneRow } from './scene-row-writes';

const slotFrames = new WeakMap<readonly RenderSceneSlot[], SceneSlotFrame>();

it('keeps shared meshless Water source materials admitted for temporal rows', () => {
  const source = Object.freeze({
    root: 91,
    revision: 91,
    assets: Object.freeze([
      Object.freeze({
        handle: 91,
        revision: 91,
        source: Object.freeze({
          guid: '81368156-72a9-5d04-b028-552912245021',
          sourceKey: 'material/clear/lake',
        }),
      }),
    ]),
  });
  const water = new MaterialResource({
    ...material(91),
    surfaceModel: 'single-layer-water',
    sourceAssets: source,
    materialProgramKeys: { Forward: 'clear-lake-program' },
  });
  const pending = new MaterialResource(material(0));
  const scene = new RenderScene();
  scene.setTemporalTracking(true);
  const owner = new MaterialDispatch();
  for (const [entityKey, resource] of [
    [49, pending],
    [44, water],
    [50, water],
  ] as const) {
    const { assetHandle: _assetHandle, ...row } = slot(entityKey, resource).snapshot;
    const snapshot: RenderableSnapshot = {
      ...row,
      materialOverrides: [],
      waterMeshSource: {
        guid: `scene-entity:${entityKey}`,
        generation: 5,
        worldIdentity: 'shared-water-world',
        zoneGuid: 'zone',
        zoneGeneration: 1,
        targetFormat: 'rgba16float',
        materialStartIndex: 0,
        views: [],
      },
    };
    scene.apply([{ kind: 'update', entityKey, snapshot }]);
    const accepted = scene.slot(entityKey);
    if (accepted === undefined) throw new Error('Shared Water source row must be retained');
    owner.bind(accepted.slot, snapshot);
  }
  owner.prepare(scene.meshFrame());
  owner.query(scene.slotsSnapshot(), scene.meshFrame());
  const materials = owner.materials();
  const temporal = scene.materializeTemporal({ hits: 0, misses: 0 }, materials);
  expect(temporal.find((row) => row.entityKey === 44)?.temporal).toBeDefined();
  expect(materials.get(water)?.snapshot).toBe(water.snapshot);
  expect(materials.get(water)?.snapshot.sourceAssets).toBe(source);
  expect(materials.get(water)?.snapshot.materialProgramKeys).toEqual({
    Forward: 'clear-lake-program',
  });
  expect(materials.get(water)?.bindings).toBe(2);
  expect(materials.get(pending)?.snapshot).toBe(pending.snapshot);
  water.adopt({
    ...water.snapshot,
    sourceAssets: {
      ...source,
      revision: 92,
      assets: source.assets.map((asset) => ({ ...asset, revision: 92 })),
    },
  });
  owner.adopt(water);
  expect(owner.materials().get(water)?.snapshot.sourceAssets?.revision).toBe(92);
  expect(materials.get(water)?.snapshot.sourceAssets?.revision).toBe(91);
  for (const entityKey of [44, 50]) {
    const accepted = scene.slot(entityKey);
    if (accepted === undefined)
      throw new Error('Shared Water row must remain until its retirement');
    owner.remove(accepted.slot);
    scene.apply([{ kind: 'remove', entityKey }]);
    owner.query(scene.slotsSnapshot(), scene.meshFrame());
    expect(owner.materials().get(water)?.bindings).toBe(entityKey === 44 ? 1 : undefined);
  }
  expect(materials.get(water)?.snapshot.sourceAssets).toBe(source);
});

it('visits selected source versions during edits without probing unrelated owned materials', () => {
  const owner = new MaterialDispatch();
  const snapshot = (handle: number, revision?: number) =>
    captureMaterialSnapshot({
      ...material(handle),
      ...(revision === undefined ? {} : { sourceAssets: { root: handle, revision, assets: [] } }),
    });
  const rows = Array.from({ length: 96 }, (_, index) =>
    slot(index, new MaterialResource(snapshot(index + 1))),
  );
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  query(owner, slots);
  const [firstRow, secondRow] = rows;
  assert(firstRow && secondRow);
  const first = firstRow.snapshot.material;
  const second = secondRow.snapshot.material;
  const borrowed = material(2);
  second.adopt(borrowed);
  owner.adopt(second);
  for (let edit = 1; edit <= 12; edit++) {
    first.adopt(snapshot(1, edit));
    owner.adopt(first);
    // A caller-owned input can acquire or lose a source without re-adoption.
    Object.assign(borrowed, {
      sourceAssets: edit % 2 ? { root: 2, revision: 99, assets: [] } : undefined,
    });
    const lookup = vi.spyOn(MaterialFrame.prototype, 'get');
    const seen: number[] = [];
    try {
      owner.visitMaterialSources((source) => seen.push(source.revision));
      expect(seen.sort((a, b) => a - b)).toEqual(edit % 2 ? [edit, 99] : [edit]);
      expect(
        lookup.mock.calls.every(([resource]) => resource === first || resource === second),
      ).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  }
  owner.remove(firstRow.slot);
  const visit = vi.fn();
  owner.visitMaterialSources(visit);
  expect(visit).not.toHaveBeenCalled();
});

it('retains the selected Mesh source across hidden preparation, failed replacement and retirement', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const topology = new BatchTopology();
  const group = topology.createResidencyGroup();
  const owner = new MaterialDispatch();
  const sourced = (handle: number) =>
    new MaterialResource(
      captureMaterialSnapshot({
        ...material(handle),
        sourceAssets: { root: handle, revision: handle, assets: [] },
      }),
    );
  const initial = sourced(1),
    replacement = sourced(2),
    future = sourced(3);
  const row = slot(0, initial);
  const snapshot = {
    ...row.snapshot,
    residencyGroup: group,
    materialOverrides: [undefined, future],
  };
  const slots = fixedSlots([{ ...row, snapshot }]);
  const mesh = { ...createPrimitiveMesh('cube').unwrap(), materialSlots: [{ slotName: 'first' }] };
  let meshes = new MeshFrame().with(1, mesh, [initial]);
  const sources = () => {
    const seen: number[] = [];
    owner.visitMaterialSources((source) => seen.push(source.root));
    return seen;
  };
  owner.bind(0, snapshot);
  owner.prepare(meshes);
  owner.query(slots, meshes, undefined, topology.captureResidencySelection());
  expect(sources()).toEqual([3]);
  owner.queryResident(slots, topology.captureResidentSelection(), meshes);
  expect(sources()).toEqual([1]);
  meshes = meshes.with(1, mesh, [replacement]);
  owner.prepare(meshes);
  topology.setResidencyGroupActive(group, true);
  let fences = 0;
  expect(() =>
    owner.query(
      slots,
      meshes,
      () => {
        if (++fences === 2) throw new Error('superseded');
      },
      topology.captureResidencySelection(),
    ),
  ).toThrow('superseded');
  expect(sources()).toEqual([1]);
  owner.query(slots, meshes, undefined, topology.captureResidencySelection());
  expect(sources()).toEqual([2]);
  topology.setResidencyGroupActive(group, false);
  owner.query(slots, meshes, undefined, topology.captureResidencySelection());
  expect(sources()).toEqual([1]);
  owner.queryResident(slots, topology.captureResidentSelection(), meshes);
  expect(sources()).toEqual([2]);
  owner.remove(0);
  expect(sources()).toEqual([]);
});

it('publishes changing materials to the active frame before a resident view first requests them', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1));
  const row = slot(0, resource);
  owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots([row]);
  query(owner, slots);
  const first = owner.materials();
  const writes = vi.spyOn(MaterialFrame.prototype, 'withAccepted');
  try {
    for (let edit = 1; edit <= 60; edit++) {
      resource.adopt({ ...resource.snapshot, roughness: edit / 100 });
      owner.adopt(resource);
      expect(owner.materials().get(resource)?.snapshot).toBe(resource.snapshot);
    }
    expect(writes).toHaveBeenCalledTimes(60);
  } finally {
    writes.mockRestore();
  }
  const selection = new BatchTopology().captureResidentSelection();
  const resident = owner.queryResident(slots, selection);
  expect(resident.materials.get(resource)).toMatchObject({
    bindings: 1,
    snapshot: { roughness: 0.6 },
  });
  expect(resident.isCurrent()).toBe(true);
  resource.adopt({ ...resource.snapshot, roughness: 0.9 });
  owner.adopt(resource);
  expect(resident.isCurrent()).toBe(false);
  expect(owner.queryResident(slots, selection).materials.get(resource)?.snapshot).toBe(
    resource.snapshot,
  );
  expect(first.get(resource)?.snapshot.roughness).toBe(0.5);
  expect(resident.materials.get(resource)?.snapshot.roughness).toBe(0.6);
  owner.remove(row.slot);
  const empty = owner.queryResident(fixedSlots([]), selection);
  expect(empty.materials.get(resource)).toBeUndefined();
});

it('diffs retained shared roots across replacement, insertion, removal and skipped frames', () => {
  const resources = Array.from(
    { length: 256 },
    (_, index) => new MaterialResource(material(index)),
  );
  let first = new MaterialFrame(undefined);
  for (const resource of resources) first = first.with(resource);
  let next = first;
  const expected = new Map<MaterialResource, number | undefined>();
  for (const [index, resource] of resources.entries()) {
    if (index % 3 === 0) {
      next = next.without(resource);
      expected.set(resource, undefined);
    } else if (index % 5 === 0) {
      resource.adopt({ ...resource.snapshot, roughness: 0.8 });
      next = next.with(resource);
      expected.set(resource, 0.8);
    }
  }
  for (let i = 0; i < 30; i++) {
    const resource = new MaterialResource(material(1000 + i));
    next = next.with(resource);
    expected.set(resource, 0.5);
  }
  const seen = new Map<MaterialResource, number | undefined>();
  next.changesSince(first, (before, after) => {
    const resource = (after ?? before)?.resource;
    if (resource === undefined) throw new Error('change has no asset identity');
    expect(seen.has(resource)).toBe(false);
    expect(before).toBe(first.get(resource));
    expect(after).toBe(next.get(resource));
    seen.set(resource, after?.snapshot.roughness);
  });
  expect(seen).toEqual(expected);
  next.changesSince(next, () => {
    throw new Error('unchanged roots were enumerated');
  });
});

it('keeps sparse material addresses and wrapper identities independent across retained frames', () => {
  const empty = new MaterialFrame(undefined);
  const source = new MaterialResource(material(12));
  const alias = new Proxy(source, {});
  const far = new MaterialResource(material(13));
  let first = empty.with(source).with(alias);
  for (let i = 0; i < 48; i++) MaterialResource._frameAddress(new MaterialResource(material(i)));
  first = first.with(far);
  const former = first.get(source);
  const wrapped = first.get(alias);
  expect(wrapped?.resource).toBe(alias);
  expect(former?.resource).toBe(source);
  const left = first.without(source).without(far);
  const right = first.with(far, 9);
  expect(left.get(alias)).toBe(wrapped);
  expect(left.get(source)).toBeUndefined();
  expect(first.get(far)?.bindings).toBe(1);
  expect(right.get(far)?.bindings).toBe(9);
  expect(right.get(source)).toBe(former);
  const removed = new Set<MaterialResource>();
  empty.changesSince(first, (before, after) => {
    expect(after).toBeUndefined();
    if (before !== undefined) removed.add(before.resource);
  });
  expect(removed).toEqual(new Set([source, alias, far]));
});

it('issues changed material lanes once to multiple Pass readers and preserves skipped versions', () => {
  const owner = new MaterialDispatch();
  const resources = Array.from({ length: 80 }, (_, index) => new MaterialResource(material(index)));
  for (const resource of resources) owner.adopt(resource);
  const first = owner.materials();
  const edited = resources.filter((_, index) => index % 3 === 0);
  for (const roughness of [0.4, 0.8]) {
    for (const resource of edited) {
      resource.adopt({ ...resource.snapshot, roughness });
      owner.adopt(resource);
    }
  }
  const second = owner.materials();
  const expected = edited.map((resource) => [first.get(resource), second.get(resource)]);
  // Publication is complete. Neither reader should enter a tree, even for a dense edit.
  const root = Object.getOwnPropertyDescriptor(second, 'root');
  assert(root !== undefined);
  Object.defineProperty(second, 'root', {
    configurable: true,
    get() {
      throw new Error('Pass rediscovered issued material changes');
    },
  });
  try {
    for (let reader = 0; reader < 2; reader++) {
      const actual: unknown[] = [];
      second.changesSince(first, (before, after) => actual.push([before, after]));
      expect(actual).toEqual(expected);
    }
  } finally {
    Object.defineProperty(second, 'root', root);
  }
  const added = new MaterialResource(material(100));
  owner.adopt(added);
  const third = owner.materials();
  const changed: MaterialResource[] = [];
  third.changesSince(first, (_before, after) => {
    if (after !== undefined) changed.push(after.resource);
  });
  expect(changed).toEqual([...edited, added]);
  expect(owner.materials()).toBe(third);
});

it('addresses accepted material pages independently of geometry and Pass identities', () => {
  let frame = new MaterialFrame(undefined);
  const resources: MaterialResource[] = [];
  for (let index = 0; index < 64; index++) {
    for (let other = 0; other < 40; other++) getOpaqueResourceIdentity({});
    const resource = new MaterialResource(material(index));
    // Structural wrappers must still have their own material addresses.
    const accepted = index % 4 === 0 ? new Proxy(resource, {}) : resource;
    frame = frame.with(accepted);
    resources.push(accepted);
  }
  const addresses = resources.map((resource) => MaterialResource._frameAddress(resource));
  expect((addresses.at(-1) as number) - (addresses[0] as number)).toBe(resources.length - 1);
  for (const resource of resources) expect(frame.get(resource)?.resource).toBe(resource);
});

it('holds only occupied material blocks and preserves their ordered edits across sparse retirement', () => {
  const materialValue = material(1);
  const resources = Array.from({ length: 1024 }, () => new MaterialResource(materialValue));
  let initial = new MaterialFrame(undefined);
  const blocks = new Map<number, MaterialResource[]>();
  for (const resource of resources) {
    initial = initial.with(resource);
    const key = Math.floor(MaterialResource._frameAddress(resource) / 256);
    const group = blocks.get(key);
    if (group === undefined) blocks.set(key, [resource]);
    else group.push(resource);
  }
  const nodeCount = (frame: MaterialFrame) =>
    (frame as unknown as { root?: { size: number } }).root?.size ?? 0;
  expect(nodeCount(initial)).toBe(blocks.size);
  const retired = [...blocks.values()][1];
  const survivor = resources.at(-1);
  assert(retired !== undefined && survivor !== undefined);
  let next = initial;
  for (const resource of retired) next = next.without(resource);
  next = next.with(survivor, 3);
  expect(nodeCount(next)).toBe(blocks.size - 1);
  const changes = () => {
    const edited: MaterialResource[] = [];
    next.changesSince(initial, (before, after) => {
      assert(before !== undefined);
      expect(before).toBe(initial.get(before.resource));
      expect(after).toBe(next.get(before.resource));
      edited.push(before.resource);
    });
    return edited;
  };
  expect(changes()).toEqual([...retired, survivor]);
  next.publishChangesSince(initial);
  expect(changes()).toEqual([...retired, survivor]);
  expect(next.get(survivor)?.bindings).toBe(3);
  expect(initial.get(survivor)?.bindings).toBe(1);
  for (const resource of resources) next = next.without(resource);
  expect(nodeCount(next)).toBe(0);
  const first = retired[0];
  assert(first !== undefined);
  expect(initial.get(first)?.resource).toBe(first);
});

it('visits only copied tree paths for a local change among 10000 unrelated assets', () => {
  const resources = Array.from(
    { length: 10000 },
    (_, index) => new MaterialResource(material(index)),
  );
  let frame = new MaterialFrame(undefined);
  for (const resource of resources) frame = frame.with(resource);
  // Instrument reads of the actual tree, without substituting its diff algorithm.
  let reads = 0;
  type Tree = { left?: Tree | undefined; right?: Tree | undefined };
  const instrument = (tree: Tree | undefined): Tree | undefined => {
    if (tree === undefined) return undefined;
    tree.left = instrument(tree.left);
    tree.right = instrument(tree.right);
    return new Proxy(tree, {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  };
  const storage = frame as unknown as { root: Tree | undefined };
  storage.root = instrument(storage.root);
  const changed = resources[5000];
  if (changed === undefined) throw new Error('missing resource');
  changed.adopt({ ...changed.snapshot, roughness: 0.9 });
  const next = frame.with(changed);
  reads = 0;
  const seen: MaterialResource[] = [];
  next.changesSince(frame, (_before, after) => {
    if (after) seen.push(after.resource);
  });
  expect(seen).toEqual([changed]);
  expect(reads).toBeLessThan(1000);
});

it('orders complete and Direct work by source identity after slot recycling with distinct entity handles', () => {
  const shared = new MaterialResource(material(1));
  const rows = [slot(9, shared), slot(2, shared), slot(7, shared)].map((row, index) => {
    const entityKey = [2, 3, 1][index] as number;
    return { ...row, entityKey, snapshot: { ...row.snapshot, entityKey } };
  });
  const owner = new MaterialDispatch();
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = owner.materials();
  const complete = [...query(owner, fixedSlots(rows))];
  const draws = fixedSlots(rows).map((row, renderableIndex) => ({
    source: row.snapshot,
    renderableIndex,
  }));
  expect(frame.project(draws)).toEqual(complete);
  expect(complete.map((entry) => entry.renderableIndex)).toEqual([1, 2, 0]);
  owner.remove(9);
  owner.bind(9, slot(9, new MaterialResource(material(2))).snapshot);
  expect(frame.project([...draws].reverse())).toEqual(complete);
});

it('projects a retained frame after its slots are rebound and its live groups retire', () => {
  const owner = new MaterialDispatch();
  const first = new MaterialResource(material(1, 2000, true));
  const second = new MaterialResource(material(2, 2000, true));
  const rows = [slot(1, first), slot(2, second)];
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = owner.materials();
  const draws = rows.map((row, renderableIndex) => ({
    slot: row.slot,
    source: row.snapshot,
    renderableIndex,
  }));
  const expected = frame.project(draws);
  first.adopt(material(1, 3000));
  owner.adopt(first);
  owner.remove(2);
  owner.bind(1, slot(1, second).snapshot);
  expect(frame.project(draws)).toEqual(expected);
  expect(expected.map((entry) => entry.queue)).toEqual([2000, 2000, 2000, 2000]);
});

it('keeps independent pass ordering when two resources start from the same snapshot', () => {
  const shared = material(1, 2000, true);
  const resources = [new MaterialResource(shared), new MaterialResource(shared)];
  const owner = new MaterialDispatch();
  const rows = resources.map((resource, index) => slot(index, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const full = query(owner, fixedSlots(rows));
  const projected = owner.materials().project(
    rows.map((row, renderableIndex) => ({
      slot: row.slot,
      source: row.snapshot,
      renderableIndex,
    })),
  );
  expect(projected).toEqual([...full]);
  expect(projected).toHaveLength(4);
});

it('projects only requested direct rows and freezes their Passes before later adoption', () => {
  const resource = new MaterialResource(material(1, 2000, true));
  const unrelated = new MaterialResource(material(2));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 10_000 }, (_, index) => slot(index, unrelated));
  const direct = [slot(10_001, resource), slot(10_002, resource, false)];
  for (const row of [...rows, ...direct]) owner.bind(row.slot, row.snapshot);
  const frame = owner.materials();
  // A full frame can be captured without materializing its per-instance entries.
  const full = query(owner, fixedSlots([...rows, ...direct]));
  Object.defineProperty(full, Symbol.iterator, {
    value() {
      throw new Error('Full dispatch iterated');
    },
  });
  const projected = frame.project(
    direct.map((row, index) => ({
      slot: row.slot,
      source: row.snapshot,
      renderableIndex: index + 7,
    })),
  );
  expect(projected.map((entry) => [entry.tags.LightMode, entry.renderableIndex])).toEqual([
    ['Forward', 7],
    ['Forward', 8],
    ['ShadowCaster', 7],
  ]);
  resource.adopt(material(1, 3000));
  owner.adopt(resource);
  owner.remove(direct[0]?.slot ?? -1);
  expect(projected.map((entry) => entry.queue)).toEqual([2000, 2000, 2000]);
  expect(projected.map((entry) => entry.entityIndex)).toEqual([10_001, 10_002, 10_001]);
});

it('captures fixed shared versions and prepares programs without iterating bindings', () => {
  const original = material(1);
  const resource = new MaterialResource(original);
  const slots = Array.from({ length: 2048 }, (_, id) => slot(id, resource));
  const owner = new MaterialDispatch();
  for (const row of slots) owner.bind(row.slot, row.snapshot);
  const dispatch = query(owner, fixedSlots(slots));
  const guardedDispatch = new Proxy(dispatch, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) throw new Error('Program preparation enumerated bindings');
      return Reflect.get(target, key, receiver);
    },
  });
  const before = owner.materials();
  const projection = new GpuDrivenMaterialProgramProjection();
  const programs = projection.project(guardedDispatch, before);
  expect(programs.get(resource)?.snapshot).toBe(original);
  expect(programs.get(resource)?.forward[0]?.materialShaderId).toBe('forgeax::default-unlit');
  expect(projection.project(guardedDispatch, before)).toBe(programs);
  const next = { ...original, roughness: 0.9 };
  resource.adopt(next);
  owner.adopt(resource);
  expect(query(owner, fixedSlots(slots))).toBe(dispatch);
  const after = owner.materials();
  expect(after).not.toBe(before);
  const nextPrograms = projection.project(guardedDispatch, after);
  expect(nextPrograms.get(resource)?.snapshot).toBe(next);
  expect(programs.get(resource)?.snapshot.roughness).toBe(0.5);
  expect(before.get(resource)?.snapshot).toBe(original);
  expect(after.get(resource)?.snapshot).toBe(next);
});

it('publishes one shadow program roster for direct and GPU draws through parameter changes', () => {
  const snapshot = captureMaterialSnapshot(material(801, 2000, true));
  const resource = new MaterialResource(snapshot);
  const fixed = new MaterialFrame(undefined).with(resource);
  const first = fixed.get(resource);
  assert(first?.programs !== undefined);
  const gpu = new GpuDrivenMaterialProgramProjection().project([], fixed);
  expect(gpu.get(resource)).toBe(first.programs);
  expect(first.programs.shadow).toBe(gpu.get(resource)?.shadow);
  expect(first.programs.prepareShadow).toEqual(first.programs.shadow);
  const changed = fixed.with(resource, 8, captureMaterialSnapshot({ ...snapshot, roughness: 0.9 }));
  const second = changed.get(resource);
  assert(second?.programs !== undefined);
  expect(second.programs.snapshot.roughness).toBe(0.9);
  expect(second.programs.shadow).toBe(first.programs.shadow);
  expect(first.programs.snapshot.roughness).toBe(0.5);
  const removed = changed.with(resource, 1, captureMaterialSnapshot(material(801)));
  expect(removed.get(resource)?.programs?.shadow).toHaveLength(0);
  expect(hasShadowPasses(first)).toBe(true);
  const replaced = changed.withAccepted({ ...second, passes: [] });
  const replacement = replaced.get(resource);
  assert(replacement !== undefined);
  expect(hasShadowPasses(replacement)).toBe(false);
});

it('keeps an unassigned GPU material handle distinct from slot zero for equal passes', () => {
  const { materialHandle: _handle, ...unassigned } = material(0, 2000, true);
  const resource = new MaterialResource(captureMaterialSnapshot(unassigned));
  const initial = new MaterialFrame(undefined).with(resource);
  const assigned = initial.with(
    resource,
    1,
    captureMaterialSnapshot({ ...unassigned, materialHandle: 0 }),
  );
  const old = initial.get(resource)?.programs;
  const current = assigned.get(resource)?.programs;
  expect(old?.materialHandle).toBe(-1);
  expect(current?.materialHandle).toBe(0);
  expect(current?.shadow).toBe(old?.shadow);
});

it('reads the issuing numeric roster on every walk while material values change', () => {
  const resource = new MaterialResource(material(81));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 320 }, (_, index) => slot(index, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const frame = query(owner, slots);
  const consumed = [...frame];
  const reads = vi.spyOn(
    frame as unknown as { entry(pass: object, slot: number): unknown },
    'entry',
  );
  try {
    for (let change = 0; change < 3; change++) {
      resource.adopt({ ...resource.snapshot, roughness: (change + 1) / 4 });
      owner.adopt(resource);
      expect(query(owner, slots)).toBe(frame);
      const oneWalk: number[] = [];
      frame.forEach((entry) => {
        oneWalk.push(entry.entityIndex);
      });
      expect(oneWalk).toEqual(rows.map((row) => row.entityKey));
      expect(reads).toHaveBeenCalledTimes(frame.length);
      expect([...frame]).toEqual(consumed);
      expect(reads).toHaveBeenCalledTimes(frame.length * 2);
      expect(frame.slice(120, 140)).toEqual(consumed.slice(120, 140));
      reads.mockClear();
    }
  } finally {
    reads.mockRestore();
  }
});

it('seeks a changing multi-group Pass by rank across page boundaries and large entity identities', () => {
  const common = new MaterialResource(material(10, 1000));
  const extra = Array.from({ length: 5 }, (_, i) => new MaterialResource(material(11 + i, 3000)));
  const owner = new MaterialDispatch();
  const original = Array.from({ length: 1000 }, (_, i) => {
    const row = slot(i, common);
    const entityKey = 2 ** 42 + ((i * 499) % 1000) * 19;
    const companion = extra[i % extra.length] as MaterialResource;
    return {
      ...row,
      entityKey,
      snapshot: { ...row.snapshot, entityKey, materials: [common, companion] },
    };
  });
  for (const row of original) owner.bind(row.slot, row.snapshot);
  const current = [...original];
  const first = query(owner, fixedSlots(original));
  for (let round = 0; round < 3; round++) {
    const row = current[round * 31] as RenderSceneSlot;
    owner.remove(row.slot);
    current.splice(round * 31, 1);
    const frame = query(owner, fixedSlots([...current]));
    const ordered = current.map((value) => value.entityKey).sort((a, b) => a - b);
    for (const i of [0, 1, 17, 128, 511, ordered.length - 2]) {
      expect(frame.at(i)?.entityIndex).toBe(ordered[i]);
      const end = Math.min(i + 12, ordered.length);
      expect(frame.slice(i, end).map((entry) => entry.entityIndex)).toEqual(ordered.slice(i, end));
    }
    expect([...frame].slice(0, ordered.length).map((entry) => entry.entityIndex)).toEqual(ordered);
  }
  expect(first.slice(980, 1000).map((entry) => entry.entityIndex)).toEqual(
    original
      .map((row) => row.entityKey)
      .sort((a, b) => a - b)
      .slice(980),
  );
});

it('keeps complete nested walks independent when an outer forEach throws', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1, 2000, true));
  const rows = Array.from({ length: 8 }, (_, index) => slot(index, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = query(owner, fixedSlots(rows));
  const expected = Array.from({ length: frame.length }, (_, index) => frame.at(index));
  const failure = new Error('consumer stopped');
  expect(() =>
    frame.forEach((_entry, index) => {
      if (index === 2) throw failure;
    }),
  ).toThrow(failure);
  const afterFailure: unknown[] = [];
  frame.forEach((entry, index) => {
    expect(index).toBe(afterFailure.length);
    afterFailure.push(entry);
  });
  expect(afterFailure).toEqual(expected);
  const changed = { ...resource.snapshot, roughness: 0.7 };
  resource.adopt(changed);
  owner.adopt(resource);
  const current = query(owner, fixedSlots(rows));
  const nested: unknown[] = [];
  expect(() =>
    current.forEach((_entry, index) => {
      if (index !== 1) return;
      current.forEach((entry) => {
        nested.push(entry);
      });
      throw failure;
    }),
  ).toThrow(failure);
  expect(nested).toHaveLength(current.length);
  const subsequent: unknown[] = [];
  current.forEach((entry) => {
    subsequent.push(entry);
  });
  expect(subsequent).toEqual(nested);
  expect([...frame]).toEqual(expected);
});

it('observes one custom iterator lookup with its receiver and closes on callback failure', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1));
  const row = slot(1, resource);
  owner.bind(row.slot, row.snapshot);
  const frame = query(owner, fixedSlots([row]));
  const entry = frame.at(0);
  if (entry === undefined) throw new Error('missing custom iterator value');
  let reads = 0;
  let closed = 0;
  Object.defineProperty(frame, Symbol.iterator, {
    get() {
      reads++;
      return function* (this: typeof frame) {
        expect(this).toBe(frame);
        try {
          yield entry;
          yield entry;
        } finally {
          closed++;
        }
      };
    },
  });
  const failure = new Error('custom consumer stopped');
  expect(() =>
    frame.forEach(() => {
      throw failure;
    }),
  ).toThrow(failure);
  expect([reads, closed]).toEqual([1, 1]);
  const indices: number[] = [];
  frame.forEach((value, index) => {
    expect(value).toBe(entry);
    indices.push(index);
  });
  expect(indices).toEqual([0, 1]);
  expect([reads, closed]).toEqual([2, 2]);
});

it('retains hidden material versions and earlier frames after removal and rebinding', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1));
  const row = slot(1, resource);
  owner.bind(row.slot, { ...row.snapshot, authorVisible: false });
  const before = owner.materials();
  expect(query(owner, fixedSlots([row])).length).toBe(0);
  expect(before.get(resource)?.snapshot).toBe(resource.snapshot);
  owner.remove(row.slot);
  expect(owner.materials().get(resource)).toBeUndefined();
  resource.adopt(material(1, 3000));
  owner.bind(row.slot, row.snapshot);
  expect(owner.materials().get(resource)?.snapshot).toBe(resource.snapshot);
  expect(before.get(resource)?.passes[0]?.queue).toBe(2000);
});

it('judges current shadow coverage once per occupied material pass across changing membership', () => {
  const lit = new MaterialResource({
    ...material(1),
    materialProgramKeys: { Forward: 'forgeax::default-standard-pbr' },
  });
  const other = new MaterialResource(material(2));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 256 }, (_, index) => slot(index, lit));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  for (let frame = 0; frame < 6; frame++) {
    const index = frame >> 1;
    const changed = slot(index, frame % 2 === 0 ? other : lit);
    rows[index] = changed;
    owner.bind(index, changed.snapshot);
    const list = query(owner, fixedSlots(rows));
    const classify = vi.fn(() => false);
    expect(someCapturedMaterialPass(list, classify)).toBe(false);
    expect(classify).toHaveBeenCalledTimes(frame % 2 === 0 ? 2 : 1);
    expect(hasForwardShadowCoverage(list)).toBe(frame % 2 !== 0);
    expect(hasForwardShadowCoverage([...list])).toBe(frame % 2 !== 0);
  }
});

it('issues view ranks against captured bindings across partial rebinding and camera movement', () => {
  const resource = new MaterialResource(material(7, 2000, true));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 8 }, (_, id) => slot(id, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const capture = () => query(owner, fixedSlots([...rows]));
  type View = NonNullable<Parameters<typeof projectCapturedViewDispatch>[2]>;
  function view(sourceDispatch: DispatchList, start: number, previous?: View): View {
    const address = (rank: number, shadow: boolean) =>
      rank < start || (!shadow && rank === 5) ? -1 : rank - start;
    const dispatch = projectCapturedViewDispatch(sourceDispatch, address, previous);
    assert(dispatch);
    expect(dispatch.slice()).toEqual(
      sourceDispatch.flatMap((entry) => {
        const rank = address(entry.renderableIndex, entry.tags.LightMode === 'ShadowCaster');
        return rank < 0 ? [] : [{ ...entry, renderableIndex: rank }];
      }),
    );
    return { sourceDispatch, dispatch, rowCount: rows.length, projection: { address } };
  }
  const first = capture();
  const before = view(first, 2);
  const held = before.dispatch.map((draw) => ({ ...draw }));
  const moved = view(first, 3, before);
  const replacement = { ...slot(45, resource), slot: 3 };
  rows[3] = replacement;
  owner.bind(3, replacement.snapshot);
  const rebound = view(capture(), 3, moved);
  for (let i = 0; i < rebound.dispatch.length; i++) {
    const draw = rebound.dispatch.at(i);
    const prior = moved.dispatch.at(i);
    if (
      draw?.entityIndex === prior?.entityIndex &&
      draw?.renderableIndex === prior?.renderableIndex
    )
      expect(draw).toBe(prior);
    else expect(draw).not.toBe(prior);
  }
  expect(before.dispatch.slice()).toEqual(held);
  view(first, 4, before);
});

it('reads changing membership without issuing draws and holds only captured binding values', () => {
  const resource = new MaterialResource(captureMaterialSnapshot(material(19, 2000, true)));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 196 }, (_, id) => slot(id, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const source = query(owner, fixedSlots(rows));
  const issue = vi.spyOn(drawEntries, 'dispatchEntry');
  try {
    const view = projectCapturedViewDispatch(source, (rank) =>
      rank % 2 === 0 ? -1 : Math.floor(rank / 2),
    );
    assert(view);
    for (const lane of ['display', 'shadow'] as const) {
      const ranks: number[] = [];
      expect(visitCapturedPassRanks(view, lane, (rank) => ranks.push(rank))).toBe(true);
      expect(ranks).toEqual(Array.from({ length: 98 }, (_, i) => i));
    }
    expect(issue).not.toHaveBeenCalled();
    owner.bind(195, slot(204, resource).snapshot);
    query(owner, fixedSlots(rows));
    expect(view.at(-1)).toMatchObject({ entityIndex: 195, renderableIndex: 97, layer: 0 });
    expect(view.at(-1)).toBe(view.at(view.length - 1));
    expect(issue).toHaveBeenCalledTimes(1);
    const early = view[Symbol.iterator]();
    expect(early.next().value).toMatchObject({ entityIndex: 1, renderableIndex: 0 });
    early.return?.();
    expect(early.next().done).toBe(true);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(view.at(98)?.tags.LightMode).toBe('ShadowCaster');
  } finally {
    issue.mockRestore();
  }
});

it('classifies only occupied view ranges across moving visibility and preserves offscreen casters', () => {
  const lit = new MaterialResource(material(1, 2000, true));
  const other = new MaterialResource(material(2));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 48 }, (_, rank) => slot(rank, rank === 0 ? other : lit));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const list = query(owner, fixedSlots(rows));
  for (const visibleStart of [1, 0, 48]) {
    const output = projectCapturedViewDispatch(list, (rank, shadow) =>
      shadow || rank >= visibleStart ? rank : -1,
    );
    assert(output);
    const materials: MaterialResource[] = [];
    expect(
      someCapturedMaterialPass(output, (_pass, resource) => {
        materials.push(resource);
        return false;
      }),
    ).toBe(false);
    expect(materials.length).toBe(visibleStart === 0 ? 3 : visibleStart === 1 ? 2 : 1);
    expect(materials.includes(other)).toBe(visibleStart === 0);
    const casters: MaterialResource[] = [];
    expect(visitCapturedCasterMaterials(output, (r) => casters.push(r))).toBe(true);
    expect(casters).toEqual([lit]);
    expect(someCapturedMaterialPass(output, (_, r) => r === lit)).toBe(true);
    Object.defineProperty(output, Symbol.iterator, { value: function* () {} });
    expect(someCapturedMaterialPass(output, () => true)).toBeUndefined();
  }
});

it('publishes distinct visible programs and coverage for detached passes only', () => {
  const standard = 'forgeax::default-standard-pbr';
  const captured = (handle: number, shader: string) =>
    new MaterialResource(
      captureMaterialSnapshot({
        ...material(handle),
        materialProgramKeys: { Forward: shader },
      }),
    );
  const resources = [
    captured(1, standard),
    captured(2, standard),
    captured(3, 'other'),
    new MaterialResource(material(4)),
  ];
  const owner = new MaterialDispatch();
  const rows = resources.map((resource, rank) => slot(rank, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const list = query(owner, fixedSlots(rows));
  function view(count: number) {
    const output = projectCapturedViewDispatch(list, (rank) => (rank < count ? rank : -1));
    assert(output);
    return output;
  }
  const original = view(2);
  expect(culledViewDemand(original)).toEqual({ programs: new Set([standard]), shadow: 'covered' });
  const mixed = view(3);
  expect(culledViewDemand(mixed)).toEqual({
    programs: new Set([standard, 'other']),
    shadow: 'incompatible',
  });
  expect(culledViewDemand(view(4))).toBeUndefined();
  for (const output of [original, mixed, view(0), view(4)]) {
    for (const retainEmpty of [true, false]) {
      expect(hasForwardShadowCoverage(output, retainEmpty)).toBe(
        hasForwardShadowCoverage([...output], retainEmpty),
      );
    }
  }
  resources[0]?.adopt(material(1, 3000));
  expect(hasForwardShadowCoverage(original)).toBe(true);
  Object.defineProperty(original, Symbol.iterator, { value: function* () {} });
  expect(culledViewDemand(original)).toBeUndefined();
});

function material(handle: number, queue = 2000, shadow = false): MaterialSnapshot {
  return {
    materialHandle: handle,
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue },
      },
      ...(shadow
        ? [
            {
              name: 'ShadowCaster',
              program: { module: 'forgeax::default-shadow-caster' },
              renderState: { tags: { LightMode: 'ShadowCaster' }, queue: 2000 },
            },
          ]
        : []),
    ],
  };
}
function slot(id: number, resource: MaterialResource, caster = true): RenderSceneSlot {
  const snapshot: RenderableSnapshot = {
    entityKey: id,
    assetHandle: 1,
    material: resource,
    materials: [resource],
    materialBindingSources: ['renderer-override'],
    transform: { world: new Float32Array(16) },
    layer: id % 3,
    ...(caster ? {} : { shadowCaster: false as const }),
  };
  return { slot: id, generation: 1, version: 0, entityKey: id, snapshot };
}

it('dispatches an unread captured frame at its original entity and layer after the slot is reused', () => {
  const resource = new MaterialResource(material(23));
  const owner = new MaterialDispatch();
  const firstRow = slot(0, resource);
  const secondRow = { ...slot(14, resource), slot: 0 };
  owner.bind(0, firstRow.snapshot);
  const firstFrame = query(owner, fixedSlots([firstRow]));
  owner.remove(0);
  owner.bind(0, secondRow.snapshot);
  const secondFrame = query(owner, fixedSlots([secondRow]));
  expect(secondFrame.at(0)).toMatchObject({ entityIndex: 14, layer: 2, renderableIndex: 0 });
  expect(firstFrame.at(0)).toMatchObject({ entityIndex: 0, layer: 0, renderableIndex: 0 });
  expect([...secondFrame][0]).toMatchObject({ entityIndex: 14, layer: 2 });
});

it('projects display and caster membership across material groups and sparse slot revisions', () => {
  const shadow = new MaterialResource(material(1, 2000, true));
  const color = new MaterialResource(material(2));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 69 }, (_, address) => {
    const row = slot(1000 - address, shadow, address % 3 !== 0);
    return {
      ...row,
      slot: address,
      snapshot: {
        ...row.snapshot,
        materials: address % 2 === 0 ? [color, shadow] : [shadow],
      },
    };
  });
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const dense = query(owner, fixedSlots(rows));
  const sparseRows = rows.filter((row) => {
    if (row.slot % 5 !== 0) return true;
    owner.remove(row.slot);
    return false;
  });
  const sparse = query(owner, fixedSlots(sparseRows));
  for (const [dispatch, count] of [
    [sparse, sparseRows.length],
    [dense, rows.length],
  ] as const) {
    const words = new Uint32Array(Math.ceil(count / 32));
    expect(writeCapturedCasterRanks(dispatch, words, count - 1)).toBe(true);
    const actual = Array.from({ length: count }, (_, i) => i).filter(
      (i) => ((words[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0,
    );
    const expected = [...dispatch]
      .filter(
        (entry) => entry.tags.LightMode === 'ShadowCaster' && entry.renderableIndex < count - 1,
      )
      .map((entry) => entry.renderableIndex);
    expect(actual).toEqual([...new Set(expected)].sort((a, b) => a - b));
    expect(actual.length).toBeGreaterThan(30);
    const display = new Set<number>();
    expect(visitCapturedPassRanks(dispatch, 'display', (rank) => display.add(rank))).toBe(true);
    const displayed = [...dispatch]
      .filter((entry) => entry.tags.LightMode !== 'ShadowCaster')
      .map((entry) => entry.renderableIndex);
    expect(display).toEqual(new Set(displayed));
  }
  Object.defineProperty(sparse, Symbol.iterator, { value: dense[Symbol.iterator] });
  expect(writeCapturedCasterRanks(sparse, new Uint32Array(3), rows.length)).toBe(false);
});

it('projects display ranks without resolving shadow members and honors a replaced iterator', () => {
  const resource = new MaterialResource(material(1, 2000, true));
  const owner = new MaterialDispatch();
  const rows = [slot(3, resource), slot(47, resource, false), slot(99, resource)];
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const dispatch = query(owner, slots);
  const ranks = vi.spyOn(slots, 'indexOfSlot');
  try {
    const projected: number[] = [];
    expect(visitCapturedPassRanks(dispatch, 'display', (index) => projected.push(index))).toBe(
      true,
    );
    expect(ranks).toHaveBeenCalledTimes(rows.length);
    ranks.mockClear();
    const casters: number[] = [];
    expect(visitCapturedPassRanks(dispatch, 'shadow', (index) => casters.push(index))).toBe(true);
    expect(ranks).toHaveBeenCalledTimes(2);
    expect(casters.sort()).toEqual([0, 2]);
    const flat = [...dispatch].filter((entry) => entry.tags.LightMode !== 'ShadowCaster');
    expect(projected).toEqual(flat.map((entry) => entry.renderableIndex));
    ranks.mockClear();
    const reread: number[] = [];
    expect(visitCapturedPassRanks(dispatch, 'display', (index) => reread.push(index))).toBe(true);
    expect(reread).toEqual(projected);
    expect(ranks).not.toHaveBeenCalled();
    const accessor = vi.fn(() => flat[Symbol.iterator].bind(flat));
    Object.defineProperty(dispatch, Symbol.iterator, { get: accessor, configurable: true });
    expect(visitCapturedPassRanks(dispatch, 'display', () => {})).toBe(false);
    expect(accessor).not.toHaveBeenCalled();
  } finally {
    ranks.mockRestore();
  }
});

it('adopts shared Passes while retaining exact prior frames and participation', () => {
  const resource = new MaterialResource(material(1));
  const slots = Array.from({ length: 2048 }, (_, id) => slot(id, resource, id % 2 === 0));
  const owner = new MaterialDispatch();
  for (const row of slots) owner.bind(row.slot, row.snapshot);
  const first = query(owner, fixedSlots(slots));
  expect(first.length).toBe(2048);
  expect(first.at(100)?.queue).toBe(2000);
  expect(query(owner, fixedSlots(slots))).toBe(first);
  const revision = owner.revisionValue();
  resource.adopt(material(1, 3000, true));
  // Adoption is independent of a frame's slot array and its member data.
  owner.adopt(resource);
  expect(owner.revisionValue()).toBe(revision + 1);
  const next = query(owner, fixedSlots(slots));
  expect(next.length).toBe(3072);
  expect(next.slice(0, 3).map((entry) => entry.entityIndex)).toEqual([0, 2, 4]);
  expect(next.at(1023)?.tags.LightMode).toBe('ShadowCaster');
  expect(next.at(1024)?.tags.LightMode).toBe('Forward');
  expect(next.at(-1)?.entityIndex).toBe(2047);
  expect(next.at(-3073)).toBeUndefined();
  expect(next.at(3072)).toBeUndefined();
  expect(next.every((entry) => entry.renderableIndex === entry.entityIndex)).toBe(true);
  expect(first.length).toBe(2048);
  expect(first.every((entry) => entry.queue === 2000 && entry.tags.LightMode === 'Forward')).toBe(
    true,
  );
  const unchanged = query(owner, fixedSlots(slots));
  owner.adopt(resource);
  expect(query(owner, fixedSlots(slots))).toBe(unchanged);
  resource.adopt(material(1, 1000));
  owner.adopt(resource);
  const removed = query(owner, fixedSlots(slots));
  expect(removed.length).toBe(2048);
  expect(removed.every((entry) => entry.queue === 1000)).toBe(true);
  expect(next.length).toBe(3072);
  expect(next.at(0)?.tags.LightMode).toBe('ShadowCaster');
});

it('keeps group ordering, rank lookup and retired membership consistent through mixed edits', () => {
  const owner = new MaterialDispatch();
  const resources = Array.from(
    { length: 17 },
    (_, i) => new MaterialResource(material(i + 1, 1000 + i * 100)),
  );
  const rows = new Map<number, RenderSceneSlot>();
  const retained: { frame: ReturnType<MaterialDispatch['query']>; entries: string[] }[] = [];
  const key = (entry: { materialHandle: number; entityIndex: number; queue: number }) =>
    `${entry.materialHandle}:${entry.entityIndex}:${entry.queue}`;
  let state = 13;
  for (let step = 0; step < 700; step++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const id = state % 127;
    const resource = resources[(state >>> 8) % resources.length];
    if (resource === undefined) throw new Error('missing fixture material');
    if (step % 7 === 0) {
      owner.remove(id);
      rows.delete(id);
    } else if (step % 5 === 0) {
      resource.adopt(
        material(resource.snapshot.materialHandle ?? 0, 1000 + ((state >>> 16) % 21) * 100),
      );
      owner.adopt(resource);
    } else {
      const row = slot(id, resource);
      rows.set(id, row);
      owner.bind(id, row.snapshot);
    }
    const slots = [...rows.values()].sort((a, b) => a.slot - b.slot);
    const frame = query(owner, fixedSlots(slots));
    const entries = [...frame];
    expect(frame.length).toBe(slots.length);
    expect(entries.map((entry) => entry.entityIndex).sort((a, b) => a - b)).toEqual(
      slots.map((row) => row.entityKey),
    );
    const violations: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === undefined) throw new Error('missing dispatch');
      if (frame.at(i) !== entry) violations.push(`entry ${i}: rank identity`);
      if (slots[entry.renderableIndex]?.entityKey !== entry.entityIndex)
        violations.push(`entry ${i}: renderable identity`);
      if (
        entry.queue !==
        slots[entry.renderableIndex]?.snapshot.material.snapshot.passes[0]?.renderState?.queue
      )
        violations.push(`entry ${i}: material queue`);
      if (i > 0 && !(entry.queue >= (entries[i - 1]?.queue ?? 0)))
        violations.push(`entry ${i}: queue ordering`);
    }
    expect(violations, `mixed edit ${step}`).toEqual([]);
    if (step % 100 === 0) retained.push({ frame, entries: entries.map(key) });
  }
  for (const prior of retained) expect(prior.frame.map(key)).toEqual(prior.entries);
});

it('excludes hidden bindings without losing their later activation or stable frame addresses', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1, 3000, true));
  const visible = slot(2, resource),
    hidden = slot(7, resource);
  owner.bind(visible.slot, visible.snapshot);
  owner.bind(hidden.slot, { ...hidden.snapshot, authorVisible: false });
  const first = query(owner, fixedSlots([visible, hidden]));
  expect(first.length).toBe(2);
  owner.bind(hidden.slot, hidden.snapshot);
  const next = query(owner, fixedSlots([hidden, visible]));
  expect(next.length).toBe(4);
  expect(next.find((entry) => entry.entityIndex === 7)?.renderableIndex).toBe(1);
  expect(first.every((entry) => entry.renderableIndex === 0 && entry.entityIndex === 2)).toBe(true);
});

it('reads integer, fractional and bounded ranges with the same semantics as an array', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1, 2000, true));
  const slots = Array.from({ length: 11 }, (_, id) => slot(id, resource, id % 2 === 0));
  for (const row of slots) owner.bind(row.slot, row.snapshot);
  const frame = query(owner, fixedSlots(slots)),
    array = [...frame];
  const bounds = [Number.NaN, -Infinity, Infinity, -30, -1.8, -0.3, 0, 2.9, 10, 17, 40];
  for (const start of bounds) {
    expect(frame.at(start)).toBe(array.at(start));
    for (const end of bounds) expect(frame.slice(start, end)).toEqual(array.slice(start, end));
  }
});

it('compiles changed Mesh defaults and future override slots without touching member trees', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
  const { MeshFrame } = await import('../mesh-frame');
  const owner = new MaterialDispatch();
  const opaque = new MaterialResource(material(31));
  const transmission = new MaterialResource({
    ...material(32, 3000),
    materialShaderId: 'forgeax::default-standard-pbr',
    paramSnapshot: { transmission: 1, roughness: 0.5 },
  });
  const medium = new MaterialResource({
    ...material(33, 3100),
    surfaceModel: 'single-layer-medium',
  });
  const source = { ...BUILTIN_CUBE, materialSlots: [{ slotName: 'first' }] };
  let meshes = new MeshFrame().with(1, source, [opaque]);
  owner.adopt(opaque);
  const rows = Array.from({ length: 2048 }, (_, index) => ({
    ...slot(index, opaque),
    snapshot: { ...slot(index, opaque).snapshot, materialOverrides: [undefined, medium] },
  }));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const before = query(owner, fixedSlots(rows), meshes);
  const oldMaterials = owner.materials();
  const oldEntries = [...before];
  expect(before.length).toBe(rows.length);
  expect(oldMaterials.transmissionDemand.activeCount).toBe(0);
  expect(oldMaterials.hasMedium).toBe(false);
  // Trap any traversal of an entity tree while updating source/compiling Passes.
  const groups = (owner as unknown as { groups: Map<string, { members: object; casters: object }> })
    .groups;
  const restores: (() => void)[] = [];
  for (const group of groups.values())
    for (const tree of [group.members, group.casters]) {
      if (tree === undefined) continue;
      for (const key of ['left', 'right']) {
        const descriptor = Object.getOwnPropertyDescriptor(tree, key);
        if (descriptor === undefined) continue;
        Object.defineProperty(tree, key, {
          configurable: true,
          get() {
            throw new Error('member tree enumerated during adoption');
          },
        });
        restores.push(() => Object.defineProperty(tree, key, descriptor));
      }
    }
  owner.adopt(transmission);
  meshes = meshes.with(
    1,
    { ...source, materialSlots: [{ slotName: 'first' }, { slotName: 'second' }] },
    [transmission, opaque],
  );
  let after: ReturnType<MaterialDispatch['query']>;
  try {
    after = query(owner, fixedSlots(rows), meshes);
  } finally {
    for (const restore of restores.reverse()) restore();
  }
  expect(after.length).toBe(rows.length * 2);
  expect(owner.materials().transmissionDemand).toEqual({
    activeCount: rows.length,
    needsRoughMips: true,
  });
  expect(owner.materials().hasMedium).toBe(true);
  expect([...before]).toEqual(oldEntries);
  expect(oldMaterials.get(opaque)?.bindings).toBe(rows.length);
  expect(owner.materials().get(opaque)).toBeUndefined();
  expect(after.filter((entry) => entry.materialHandle === 33)).toHaveLength(rows.length);
  for (const row of rows) owner.remove(row.slot);
  owner.prepare(meshes);
  owner.query(fixedSlots([]), meshes);
  expect(owner.materials().get(transmission)).toBeUndefined();
  expect(owner.materials().get(medium)).toBeUndefined();
  expect(owner.materials().get(opaque)).toBeUndefined();
});

it('adopts values and Passes without visiting Mesh expressions and retains unrelated source plans', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
  const { MeshFrame } = await import('../mesh-frame');
  const owner = new MaterialDispatch();
  const shared = new MaterialResource(material(51));
  const next = new MaterialResource(material(52, 3200));
  let meshes = new MeshFrame();
  const rows = Array.from({ length: 1024 }, (_, index) => ({
    ...slot(index, shared),
    snapshot: { ...slot(index, shared).snapshot, assetHandle: index + 1, materialOverrides: [] },
  }));
  for (const row of rows) {
    meshes = meshes.with(row.snapshot.assetHandle, BUILTIN_CUBE, [shared]);
    owner.bind(row.slot, row.snapshot);
  }
  owner.adopt(shared);
  const before = query(owner, fixedSlots(rows), meshes);
  const groups = (owner as unknown as { groups: Map<string, unknown> }).groups;
  const iterate = groups.values;
  groups.values = () => {
    throw new Error('source adoption visited binding groups');
  };
  shared.adopt({ ...shared.snapshot, roughness: 0.9 });
  owner.adopt(shared);
  expect(query(owner, fixedSlots(rows), meshes)).toBe(before);
  shared.adopt(material(51, 3300));
  owner.adopt(shared);
  const changedPass = query(owner, fixedSlots(rows), meshes);
  groups.values = iterate;
  expect(changedPass.length).toBe(rows.length);
  expect(changedPass.at(0)?.queue).toBe(3300);
  owner.adopt(next);
  meshes = meshes.with(513, BUILTIN_CUBE, [next]);
  groups.values = () => {
    throw new Error('Mesh adoption visited binding groups');
  };
  let changedMesh: ReturnType<MaterialDispatch['query']>;
  try {
    owner.prepare(meshes);
    changedMesh = owner.query(fixedSlots(rows), meshes);
  } finally {
    groups.values = iterate;
  }
  expect(
    changedMesh.filter((entry) => entry.materialHandle === 52).map((entry) => entry.entityIndex),
  ).toEqual([512]);
  expect(changedMesh.filter((entry) => entry.materialHandle === 51)).toHaveLength(rows.length - 1);
  const expanded = [...changedMesh];
  for (const index of [0, 1, 20, 513, 1023]) expect(changedMesh.at(index)).toBe(expanded[index]);
  expect(changedMesh.slice(500, 520)).toEqual(expanded.slice(500, 520));
});

it('re-resolves only groups using a changed source handle and keeps failed Mesh variants private', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const geometry = createPrimitiveMesh('cube').unwrap();
  const raw = Array.from({ length: 64 }, (_, i) => new MaterialResource(material(i + 1)));
  const variants = raw.map((_, i) => new MaterialResource(material(101 + i)));
  const chosen = 31;
  const source = raw[chosen] as MaterialResource;
  const resolve = vi.fn((handle: number) => variants[handle - 1] as MaterialResource);
  const owner = new MaterialDispatch(resolve);
  let meshes = new MeshFrame();
  const rows = raw.map((resource, index) => {
    const base = slot(index, resource);
    const row = {
      ...base,
      snapshot: { ...base.snapshot, assetHandle: index + 1, materialOverrides: [resource] },
    };
    meshes = meshes.with(index + 1, geometry);
    owner.bind(row.slot, row.snapshot);
    return row;
  });
  const slots = fixedSlots(rows);
  const before = query(owner, slots, meshes);
  expect(before.at(chosen)?.materialHandle).toBe(101 + chosen);
  for (let tick = 0; tick < 60; tick++) {
    const next = material(300 + tick, 3200);
    if (tick % 2 === 0) variants[chosen] = new MaterialResource(next);
    else (variants[chosen] as MaterialResource).adopt(next);
    source.adopt(material(chosen + 1, 2500 + tick));
    owner.adopt(source);
    resolve.mockClear();
    let fences = 0;
    expect(() =>
      owner.query(slots, meshes, () => {
        if (++fences === 2) throw new Error('late variant change');
      }),
    ).toThrow('late variant change');
    expect(resolve.mock.calls.map(([handle]) => handle)).toEqual([chosen + 1]);
    resolve.mockClear();
    const frame = owner.query(slots, meshes);
    expect(resolve.mock.calls.map(([handle]) => handle)).toEqual([chosen + 1]);
    expect(frame.length).toBe(64);
    expect(frame.at(-1)?.materialHandle).toBe(300 + tick);
    expect(before.at(chosen)?.materialHandle).toBe(101 + chosen);
  }
  for (const row of rows) owner.remove(row.slot);
  expect(owner.query(fixedSlots([]), meshes).length).toBe(0);
});

it('retains an admitted default across replacing the last old Mesh binding', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();
  const { MeshFrame } = await import('../mesh-frame');
  const resource = new MaterialResource(material(71));
  const owner = new MaterialDispatch();
  const meshes = new MeshFrame()
    .with(1, BUILTIN_CUBE, [resource])
    .with(2, BUILTIN_CUBE, [resource]);
  const before = {
    ...slot(0, resource),
    snapshot: { ...slot(0, resource).snapshot, materialOverrides: [] },
  };
  owner.bind(0, before.snapshot);
  owner.adopt(resource);
  const old = query(owner, fixedSlots([before]), meshes);
  owner.adopt(resource); // The next Mesh source is admitted before the old entity binding retires.
  const next = { ...before, snapshot: { ...before.snapshot, assetHandle: 2 } };
  owner.bind(0, next.snapshot);
  expect(query(owner, fixedSlots([next]), meshes).length).toBe(1);
  expect(owner.materials().get(resource)?.bindings).toBe(1);
  expect(old.at(0)?.materialHandle).toBe(71);
  owner.remove(0);
  owner.prepare(meshes);
  owner.query(fixedSlots([]), meshes);
  expect(owner.materials().get(resource)).toBeUndefined();
});

// Native arrays describe cold fixture input; actual dispatch reads the retained owner.

/** One random-edit row: hidden, Mesh-expression, preparation (hidden or visible) or direct. */
function randomEditSnapshot(
  snapshot: RenderableSnapshot,
  kind: number,
  edit: number,
  resources: readonly MaterialResource[],
): RenderableSnapshot {
  if (kind === 0) return { ...snapshot, authorVisible: false };
  if (kind >= 5 && kind < 11) return snapshot;
  const meshRow = {
    ...snapshot,
    assetHandle: 1 + (kind % 2),
    materialOverrides: [undefined, resources[(kind * 3 + edit) % 9]],
  };
  // Preparation rows keep their effective Mesh-default materials accepted
  // even when hidden; toggling it must match a complete query too.
  if (kind === 11) return { ...meshRow, authorVisible: false, pipelinePreparation: [] };
  if (kind === 12) return { ...meshRow, pipelinePreparation: [] };
  return meshRow;
}
function fixedSlots(rows: readonly RenderSceneSlot[]): SceneSlotFrame {
  let frame = slotFrames.get(rows);
  if (frame === undefined) {
    const slots = new SceneSlots();
    for (const row of rows) setSceneRow(slots, row.slot, row);
    frame = slots.capture();
    slotFrames.set(rows, frame);
  }
  return frame;
}

/** Tests separate source adoption from the explicit real Pass query. */
function query(owner: MaterialDispatch, slots: SceneSlotFrame, meshes?: MeshFrame) {
  if (meshes !== undefined) owner.prepare(meshes);
  return owner.query(slots, meshes);
}

it('adopts one Mesh without reading its thousand override groups; only a real query expands them', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const mesh = createPrimitiveMesh('cube').unwrap();
  const first = new MaterialResource(material(81));
  const second = new MaterialResource(material(82, 3100));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    ...slot(index, first),
    snapshot: {
      ...slot(index, first).snapshot,
      materialOverrides: [undefined, new MaterialResource(material(1000 + index))],
    },
  }));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const initial = new MeshFrame().with(1, mesh, [first]);
  const old = query(owner, fixedSlots(rows), initial);
  const oldMaterials = owner.materials();
  const oldEntries = [...old];
  const changed = initial.with(1, mesh, [second]);
  const groups = (owner as unknown as { groups: Map<string, unknown> }).groups;
  expect(groups.size).toBe(1000);
  const iterate = groups.values;
  groups.values = () => {
    throw Error('source update expanded override groups');
  };
  try {
    owner.adopt(second);
    owner.prepare(changed);
  } finally {
    groups.values = iterate;
  }
  expect(() => owner.query(fixedSlots(rows), initial)).toThrow(/current adopted/);
  const current = owner.query(fixedSlots(rows), changed);
  expect(current.length).toBe(1000);
  expect(current.every((entry) => entry.materialHandle === 82 && entry.queue === 3100)).toBe(true);
  expect(owner.materials().get(second)?.bindings).toBe(1000);
  expect(oldMaterials.get(first)?.bindings).toBe(1000);
  expect([...old]).toEqual(oldEntries);
  const empty = fixedSlots([]);
  for (const row of rows) owner.remove(row.slot);
  expect(owner.materials().get(second)).toBeUndefined();
  expect((owner as unknown as { active: { queryRoot: unknown } }).active.queryRoot).toBeUndefined();
  expect([...old]).toEqual(oldEntries);
  expect(owner.query(empty, changed).length).toBe(0);
  expect(owner.materials().get(second)).toBeUndefined();
});

it('rejects reentrant source writes before publishing Pass work or derived binding memo', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const resource = new MaterialResource(material(91));
  let reenter = false;
  let calls = 0;
  const owner = new MaterialDispatch(() => {
    calls++;
    if (reenter) owner.bind(1, { ...row.snapshot, entityKey: 1 });
    return resource;
  });
  const row = {
    ...slot(0, resource),
    snapshot: { ...slot(0, resource).snapshot, materialOverrides: [] },
  };
  const mesh = {
    ...createPrimitiveMesh('cube').unwrap(),
    materialSlots: [
      {
        slotName: 'first',
        defaultMaterial: 91 as import('@forgeax/engine-types').AssetHandle<'material'>,
      },
    ],
  };
  const meshes = new MeshFrame().with(1, mesh, [resource]);
  owner.bind(0, row.snapshot);
  const old = query(owner, fixedSlots([row]), meshes);
  const before = [...old];
  const second = {
    ...slot(2, resource),
    snapshot: { ...slot(2, resource).snapshot, materialOverrides: [] },
  };
  owner.bind(2, second.snapshot);
  owner.prepare(meshes);
  reenter = true;
  expect(() => owner.query(fixedSlots([row, second]), meshes)).toThrow(/sources changed/);
  expect([...old]).toEqual(before);
  const failedCalls = calls;
  reenter = false;
  const current = owner.query(fixedSlots([row, second]), meshes);
  expect(calls).toBeGreaterThan(failedCalls);
  expect(current.length).toBe(2);
  expect(current.map((entry) => entry.entityIndex)).toEqual([0, 2]);
});

it('captures direct authored bindings at admission before a delayed Pass query', () => {
  const first = new MaterialResource(material(101));
  const second = new MaterialResource(material(102));
  const materials = [first];
  const row = { ...slot(0, first), snapshot: { ...slot(0, first).snapshot, materials } };
  const owner = new MaterialDispatch();
  owner.bind(0, row.snapshot);
  materials[0] = second;
  const frame = owner.query(fixedSlots([row]));
  expect(frame.map((entry) => entry.materialHandle)).toEqual([101]);
  expect(owner.materials().get(first)?.bindings).toBe(1);
  expect(owner.materials().get(second)).toBeUndefined();
  owner.bind(0, row.snapshot);
  expect(owner.query(fixedSlots([row])).map((entry) => entry.materialHandle)).toEqual([102]);
});

it('retains accepted Pass identity across atomic last-binding replacement and releases failed replacements', () => {
  const resource = new MaterialResource(material(111, 2000, true));
  const row = slot(0, resource);
  const owner = new MaterialDispatch();
  owner.bind(0, row.snapshot);
  const first = owner.query(fixedSlots([row]));
  const fixed = owner.materials();
  const passes = fixed.get(resource)?.passes;
  expect(passes).toHaveLength(2);
  for (let index = 0; index < 8; index++) {
    owner.bind(0, { ...row.snapshot, layer: index });
    owner.query(fixedSlots([row]));
    expect(owner.materials().get(resource)?.passes).toBe(passes);
  }
  resource.adopt({ ...resource.snapshot, roughness: 0.8 });
  owner.bind(0, row.snapshot);
  owner.query(fixedSlots([row]));
  expect(owner.materials().get(resource)?.passes).toBe(passes);
  expect(fixed.get(resource)?.snapshot.roughness).toBe(0.5);
  resource.adopt(material(111, 3000, true));
  owner.bind(0, row.snapshot);
  owner.query(fixedSlots([row]));
  expect(owner.materials().get(resource)?.passes).not.toBe(passes);
  const invalid = new Proxy(row.snapshot, {
    get(target, key, receiver) {
      if (key === 'materialOverrides') throw Error('invalid replacement source');
      return Reflect.get(target, key, receiver);
    },
  });
  expect(() => owner.bind(0, invalid)).toThrow(/invalid replacement source/);
  expect(owner.materials().get(resource)).toBeUndefined();
  expect((owner as unknown as { active: { queryRoot: unknown } }).active.queryRoot).toBeUndefined();
  expect(first.map((entry) => entry.queue)).toEqual([2000, 2000]);
});

it('keeps the query and dispatch list when a pose-only republication rebinds the same facts', () => {
  const resource = new MaterialResource(material(121, 2000, true));
  const row = slot(0, resource);
  const owner = new MaterialDispatch();
  owner.bind(0, row.snapshot);
  const slots = fixedSlots([row]);
  const first = owner.query(slots);
  const entries = [...first];
  owner.bind(0, { ...row.snapshot, transform: { world: new Float32Array(16) } });
  const posed = owner.query(slots);
  expect(posed).toBe(first);
  expect([...posed]).toEqual(entries);
  owner.bind(0, { ...row.snapshot, layer: 3 });
  const moved = owner.query(slots);
  expect(moved).not.toBe(first);
  expect([...moved].every((entry) => entry.layer === 3)).toBe(true);
});

it.each([
  false,
  true,
])('change-driven Pass queries match a complete query through random membership edits (resolver %s)', async (withResolver) => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const cube = createPrimitiveMesh('cube').unwrap();
  const resources = Array.from(
    { length: 9 },
    (_, i) => new MaterialResource(material(i + 1, 1000 + (i % 4) * 500, i % 2 === 0)),
  );
  const byHandle = new Map(
    resources.map((resource) => [resource.snapshot.materialHandle, resource]),
  );
  const resolver = withResolver
    ? (handle: number) => byHandle.get(handle) ?? (resources[0] as MaterialResource)
    : undefined;
  const incremental = new MaterialDispatch(resolver);
  const complete = new MaterialDispatch(resolver);
  const changeDriven = vi.spyOn(
    incremental as unknown as { queryIncrementally(): boolean },
    'queryIncrementally',
  );
  const twoSlots = { ...cube, materialSlots: [{ slotName: 'first' }, { slotName: 'second' }] };
  const meshes = new MeshFrame()
    .with(1, twoSlots, [resources[1] as MaterialResource, resources[2] as MaterialResource])
    .with(2, twoSlots, [resources[3] as MaterialResource, resources[4] as MaterialResource]);
  const meshDefaults = new Map([
    [1, resources[1]],
    [2, resources[3]],
  ]);
  // Effective resources of a row: direct, or its Mesh slot defaults and overrides.
  const uses = (snapshot: RenderableSnapshot, resource: MaterialResource) =>
    snapshot.materialOverrides === undefined
      ? snapshot.material === resource
      : snapshot.materialOverrides[1] === resource ||
        (!withResolver && meshDefaults.get(snapshot.assetHandle ?? 0) === resource);
  const rows = new Map<number, RenderSceneSlot>();
  const describe = (frame: ReturnType<MaterialDispatch['query']>) =>
    [...frame].map(
      (entry) =>
        `${entry.materialHandle}:${entry.entityIndex}:${entry.renderableIndex}:${entry.queue}:${entry.tags.LightMode}`,
    );
  let state = withResolver ? 11 : 7;
  for (let step = 0; step < 900; step++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const id = state % 211;
    const resource = resources[(state >>> 9) % resources.length];
    if (resource === undefined) throw new Error('missing fixture material');
    if (step % 61 === 0)
      // Retire every row of one material so its Passes and counts leave the frame.
      for (const [key, row] of [...rows])
        if (uses(row.snapshot, resource)) {
          for (const owner of [incremental, complete]) owner.remove(key);
          rows.delete(key);
        }
    const edits = 1 + ((state >>> 20) % 4);
    for (let edit = 0; edit < edits; edit++) {
      const target = (id + edit * 37) % 211;
      if ((state >>> 4) % 9 === 0) {
        for (const owner of [incremental, complete]) owner.remove(target);
        rows.delete(target);
      } else if (step % 97 === 0 && edit === 0) {
        resource.adopt(
          material(resource.snapshot.materialHandle ?? 0, 1000 + ((state >>> 16) % 5) * 250, true),
        );
        for (const owner of [incremental, complete]) owner.adopt(resource);
      } else {
        const row = slot(target, resource, (state >>> 12) % 3 !== 0);
        const snapshot = randomEditSnapshot(
          row.snapshot,
          (state >>> (14 + edit)) % 13,
          edit,
          resources,
        );
        rows.set(target, { ...row, snapshot });
        for (const owner of [incremental, complete]) owner.bind(target, snapshot);
      }
    }
    const slots = fixedSlots([...rows.values()].sort((a, b) => a.slot - b.slot));
    // The reference owner always rebuilds its complete projection.
    (complete as unknown as { invalidateQuery(): void }).invalidateQuery();
    const expected = query(complete, slots, meshes);
    const actual = query(incremental, slots, meshes);
    expect(describe(actual)).toEqual(describe(expected));
    for (const resource of resources)
      expect(incremental.materials().get(resource)?.bindings).toBe(
        complete.materials().get(resource)?.bindings,
      );
  }
  // Most queries follow membership-only edits and take the change-driven path.
  expect(
    changeDriven.mock.results.filter((result) => result.value === true).length,
  ).toBeGreaterThan(700);
});

it('retires individual observed lanes and shrinks sparse Pass pages across queries', () => {
  const common = new MaterialResource(material(31));
  const owner = new MaterialDispatch();
  const rows = Array.from({ length: 96 }, (_, i) => slot(i, common));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const first = owner.query(slots);
  const before = [0, 2, 31, 32, 63, 95].map((index) => first.at(index));
  const middle = owner.query(slots);
  expect(middle.at(0)).toBe(before[0]);
  expect(middle.at(31)).toBe(before[2]);
  expect(middle.at(63)).toBe(before[4]);
  const current = owner.query(slots);
  for (const [ordinal, index] of [0, 2, 31, 32, 63, 95].entries()) {
    const entry = current.at(index);
    expect(entry).toEqual(before[ordinal]);
    if (index === 0 || index === 31 || index === 63) expect(entry).toBe(before[ordinal]);
    else expect(entry).not.toBe(before[ordinal]);
  }
});

it('keeps dispatch entries only while consecutive queries read them; bindings own no entry objects', () => {
  const resource = new MaterialResource(material(131, 2000, true));
  const rows = Array.from({ length: 64 }, (_, id) => slot(id, resource));
  const owner = new MaterialDispatch();
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const cold = [...owner.query(slots)];
  expect(cold).toHaveLength(128);
  for (const entry of cold) Object.freeze(entry);
  // A consecutive reader shares the identities the previous query read.
  const warm = [...owner.query(slots)];
  expect(warm.every((entry, index) => entry === cold[index])).toBe(true);
  // A query nothing read drops the generation: a cold traversal is not resident.
  owner.query(slots);
  owner.query(slots);
  const later = [...owner.query(slots)];
  expect(later).toEqual(cold);
  expect(later.some((entry, index) => entry === cold[index])).toBe(false);
  // Binding facts are numeric columns; no per-binding object holds entries.
  const columns = (owner as unknown as { bindings: { groups: unknown[]; count: number } }).bindings;
  expect(columns.count).toBe(64);
  expect(new Set(columns.groups).size).toBe(1);
});

it('settles changed material groups without visiting unrelated group or work entries', () => {
  const owner = new MaterialDispatch();
  const materials = Array.from({ length: 1024 }, (_, i) => new MaterialResource(material(i + 1)));
  const rows = Array.from({ length: materials.length * 2 }, (_, i) =>
    slot(i, materials[i % materials.length] as MaterialResource),
  );
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const original = owner.query(slots);
  const active = (
    owner as unknown as {
      active: {
        queryWork: Map<MaterialResource, unknown>;
        groupResources: Map<object, unknown>;
      };
    }
  ).active;
  const work = active.queryWork,
    groups = active.groupResources;
  expect(work.size).toBe(materials.length);
  expect(groups.size).toBe(materials.length);
  const readWork = vi.spyOn(work, Symbol.iterator),
    readGroups = vi.spyOn(groups, Symbol.iterator);
  const untouched = work.get(materials[2] as MaterialResource);
  const first = materials[0] as MaterialResource,
    second = materials[1] as MaterialResource;
  try {
    for (let frame = 0; frame < 60; frame++) {
      const target = frame % 2 === 0 ? second : first;
      owner.bind(0, slot(0, target).snapshot);
      const before = work.get(first);
      let checks = 0;
      expect(() =>
        owner.query(slots, undefined, () => {
          if (++checks === 2) throw Error('changed source at the publication fence');
        }),
      ).toThrow('changed source at the publication fence');
      expect(work.get(first)).toBe(before);
      const now = owner.query(slots);
      expect(now.length).toBe(original.length);
      expect(owner.materials().get(first)?.bindings).toBe(target === first ? 2 : 1);
      expect(owner.materials().get(second)?.bindings).toBe(target === second ? 3 : 2);
      expect(active.queryWork.get(materials[2] as MaterialResource)).toBe(untouched);
    }
    expect(readWork).not.toHaveBeenCalled();
    expect(readGroups).not.toHaveBeenCalled();
    expect(active.queryWork).toBe(work);
    expect(active.groupResources).toBe(groups);
    expect(original.at(0)?.materialHandle).toBe(first.snapshot.materialHandle);
  } finally {
    readWork.mockRestore();
    readGroups.mockRestore();
  }
});

it('shares the caster set with members until a visible non-caster forks it, and rejoins after', () => {
  const resource = new MaterialResource(material(132, 2000, true));
  const owner = new MaterialDispatch();
  const casters = (rows: readonly RenderSceneSlot[]) =>
    [...owner.query(fixedSlots(rows))]
      .filter((entry) => entry.tags.LightMode === 'ShadowCaster')
      .map((entry) => entry.entityIndex);
  const groupOf = () =>
    (owner as unknown as { bindings: { groups: { members: unknown; ownCasters: unknown }[] } })
      .bindings.groups[0];
  const rows = [slot(0, resource), slot(1, resource), slot(2, resource)];
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  expect(groupOf()?.ownCasters).toBeUndefined();
  expect(casters(rows)).toEqual([0, 1, 2]);
  const quiet = slot(3, resource, false);
  owner.bind(quiet.slot, quiet.snapshot);
  const mixed = [...rows, quiet];
  expect(casters(mixed)).toEqual([0, 1, 2]);
  owner.remove(1);
  const fewer = [rows[0], rows[2], quiet] as RenderSceneSlot[];
  expect(casters(fewer)).toEqual([0, 2]);
  owner.remove(3);
  expect(groupOf()?.ownCasters).toBeUndefined();
  expect(casters([rows[0], rows[2]] as RenderSceneSlot[])).toEqual([0, 2]);
});

it('visits only occupied caster materials of the specified dispatch frame', () => {
  const cast = new MaterialResource(material(140, 2000, true));
  const quiet = new MaterialResource(material(141, 2000, true));
  const owner = new MaterialDispatch();
  const rows = [slot(0, cast), slot(1, cast, false), slot(2, quiet, false)];
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = query(owner, fixedSlots(rows));
  const visit = (list: DispatchList) => {
    const materials: MaterialResource[] = [];
    const captured = visitCapturedCasterMaterials(list, (material) => materials.push(material));
    return captured ? materials : undefined;
  };
  expect(visit(frame)).toEqual([cast]);
  expect(visit([...frame] as unknown as DispatchList)).toBeUndefined();
  const loud = slot(2, quiet);
  owner.bind(loud.slot, loud.snapshot);
  const next = query(owner, fixedSlots([rows[0], rows[1], loud] as RenderSceneSlot[]));
  expect(new Set(visit(next))).toEqual(new Set([cast, quiet]));
  expect(visit(frame)).toEqual([cast]);
});

it('bulk binding appends member pages instead of copying one roster page per member', () => {
  const resource = new MaterialResource(material(1, 2000, true));
  const rows = 8192;
  // Reverse order exercises the staged sort; every second row is a non-caster.
  const slots = Array.from({ length: rows }, (_, id) => slot(id, resource, id % 2 === 0));
  const owner = new MaterialDispatch();
  const Native = globalThis.Float64Array;
  let constructed = 0;
  class Counting extends Native {
    constructor(...args: unknown[]) {
      super(...(args as [number]));
      constructed++;
    }
  }
  globalThis.Float64Array = Counting as unknown as Float64ArrayConstructor;
  try {
    for (let index = rows - 1; index >= 0; index--) {
      const row = slots[index] as RenderSceneSlot;
      owner.bind(row.slot, row.snapshot);
    }
  } finally {
    globalThis.Float64Array = Native;
  }
  const frame = query(owner, fixedSlots(slots));
  expect(constructed).toBeLessThan(rows / 8);
  const forward = frame.filter((entry) => entry.tags.LightMode !== 'ShadowCaster');
  expect(forward.map((entry) => entry.entityIndex)).toEqual(slots.map((row) => row.entityKey));
  const casters = frame.filter((entry) => entry.tags.LightMode === 'ShadowCaster');
  expect(casters.map((entry) => entry.entityIndex)).toEqual(
    slots.filter((row) => row.slot % 2 === 0).map((row) => row.entityKey),
  );
});

it('admits the implicit default only when effective Mesh slots actually consume it', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const { defaultMeshMaterial } = await import('../mesh-materials');
  const owned = new MaterialResource({ ...material(201), immutableValues: true });
  const owner = new MaterialDispatch();
  const original = slot(0, owned);
  const row = {
    ...original,
    snapshot: { ...original.snapshot, materialOverrides: [owned] },
  };
  owner.bind(0, row.snapshot);
  const meshes = new MeshFrame().with(1, createPrimitiveMesh('cube').unwrap());
  const complete = query(owner, fixedSlots([row]), meshes);
  const captured = owner.materials();
  expect([...complete]).toHaveLength(1);
  expect(captured.get(owned)?.bindings).toBe(1);
  expect(captured.get(defaultMeshMaterial)).toBeUndefined();
  expect(captured.hasBorrowedValues).toBe(false);

  const fallback = { ...row, snapshot: { ...row.snapshot, materialOverrides: [] } };
  owner.bind(0, fallback.snapshot);
  const usedDefault = query(owner, fixedSlots([fallback]), meshes);
  expect(usedDefault.some((entry) => entry.materialHandle === 0)).toBe(true);
  expect(owner.materials().get(defaultMeshMaterial)?.bindings).toBe(1);
  expect(owner.materials().hasBorrowedValues).toBe(true);
  expect(captured.get(defaultMeshMaterial)).toBeUndefined();
  expect(captured.hasBorrowedValues).toBe(false);

  owner.bind(0, row.snapshot);
  query(owner, fixedSlots([row]), meshes);
  expect(owner.materials().get(defaultMeshMaterial)).toBeUndefined();
  expect(owner.materials().hasBorrowedValues).toBe(false);
});

it('captures actual owned Sprite folding demand, including zero-binding accepted entries', () => {
  const sprite = new MaterialResource({
    ...material(77),
    transparent: true,
    immutableValues: true,
    passes: [{ name: 'Forward', program: { module: 'forgeax::sprite' } }],
  });
  const empty = new MaterialFrame(undefined);
  const accepted = empty.with(sprite, 0);
  expect(empty.hasFoldableSprites).toBe(false);
  expect(accepted.hasFoldableSprites).toBe(true);
  expect(
    accepted.withAccepted(accepted.get(sprite) as NonNullable<ReturnType<MaterialFrame['get']>>, 4)
      .hasFoldableSprites,
  ).toBe(true);
  const opaque = accepted.with(sprite, 0, { ...sprite.snapshot, transparent: false });
  expect(opaque.hasFoldableSprites).toBe(false);
  expect(accepted.hasFoldableSprites).toBe(true);
  expect(accepted.without(sprite).hasFoldableSprites).toBe(false);
  const { immutableValues: _owned, ...borrowedSnapshot } = sprite.snapshot;
  const borrowed = accepted.with(sprite, 0, borrowedSnapshot);
  expect(borrowed.hasBorrowedValues).toBe(true);
  expect(borrowed.hasFoldableSprites).toBe(false);
});

it('reads a consumed work rank without starting another generator', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1));
  const rows = Array.from({ length: 64 }, (_, index) => slot(index, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = query(owner, fixedSlots(rows));
  const consumed = [...frame];
  const generator = (function* () {})();
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(generator));
  const next = vi.spyOn(prototype, 'next');
  try {
    for (let index = 0; index < frame.length; index++)
      expect(frame.at(index)).toBe(consumed[index]);
    expect(frame.at(-1)).toBe(consumed[consumed.length - 1]);
    expect(next).not.toHaveBeenCalled();
  } finally {
    next.mockRestore();
  }
});

it('walks consumed binding membership without a second generator result per member', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1));
  const rows = Array.from({ length: 64 }, (_, index) => slot(index, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const expected = [...query(owner, slots)].map((entry) => entry.entityIndex);
  const frame = query(owner, slots);
  const generator = (function* () {})();
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(generator));
  const next = vi.spyOn(prototype, 'next');
  let actual: number[], steps: number;
  try {
    actual = frame.flatMap((entry) => entry.entityIndex);
    steps = next.mock.calls.length;
  } finally {
    next.mockRestore();
  }
  expect(actual).toEqual(expected);
  // The public frame and fixed work tree still yield. Membership itself is a
  // private reused-result walk, independent of the number of members.
  expect(steps).toBeLessThanOrEqual(frame.length + 8);
});

it('keeps consumed member walks independent when another reader stops early', () => {
  const owner = new MaterialDispatch();
  const resource = new MaterialResource(material(1));
  const rows = Array.from({ length: 8 }, (_, index) => slot(index, resource));
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = query(owner, fixedSlots(rows));
  const expected = [...frame];
  const pass = dispatchPassWork(frame)?.work[Symbol.iterator]().next().value;
  if (pass === undefined) throw new Error('Expected actual Pass work');
  const first = pass.entries()[Symbol.iterator](),
    second = pass.entries()[Symbol.iterator]();
  expect(first.next().value).toBe(expected[0]);
  expect(first.next().value).toBe(expected[1]);
  expect(second.next().value).toBe(expected[0]);
  first.return?.();
  const remaining = [];
  for (let step = second.next(); !step.done; step = second.next()) remaining.push(step.value);
  expect(remaining).toEqual(expected.slice(1));
  expect([...pass.entries()]).toEqual(expected);
  expect(frame.slice(2, 5)).toEqual(expected.slice(2, 5));
});

it('keeps nested dispatch cursors independent and a closed partial walk cannot resume', () => {
  const resource = new MaterialResource(material(177, 2000, true));
  const rows = Array.from({ length: 8 }, (_, index) => slot(index, resource));
  const owner = new MaterialDispatch();
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const frame = owner.query(fixedSlots(rows));
  const partial = frame[Symbol.iterator]();
  const first = partial.next().value;
  expect(first).toBeDefined();
  const nested = [...frame];
  expect(nested).toHaveLength(16);
  expect(first).toBe(nested[0]);
  partial.return?.();
  expect(partial.next().done).toBe(true);
  expect([...frame]).toEqual(nested);
  const held = nested.map((entry) => ({ ...entry }));
  owner.query(fixedSlots(rows));
  owner.query(fixedSlots(rows));
  expect([...frame]).toEqual(held);
  expect(nested).toEqual(held);
});

it('does not publish a partial dispatch after a rank failure and recovers on the next walk', () => {
  const resource = new MaterialResource(material(178, 2000, true));
  const rows = Array.from({ length: 8 }, (_, index) => slot(index, resource));
  const owner = new MaterialDispatch();
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const slots = fixedSlots(rows);
  const frame = owner.query(slots);
  const original = slots.indexOfSlot.bind(slots);
  const rank = vi.spyOn(slots, 'indexOfSlot');
  let calls = 0;
  rank.mockImplementation((slot) => {
    if (++calls === 3) throw new Error('rank failed');
    return original(slot);
  });
  const cursor = frame[Symbol.iterator]();
  expect(cursor.next().done).toBe(false);
  expect(cursor.next().done).toBe(false);
  expect(() => cursor.next()).toThrow('rank failed');
  expect(cursor.next().done).toBe(true);
  rank.mockRestore();
  expect([...frame]).toHaveLength(16);
});

it('retains resolved culling materials and Passes across equal slots in a geometry revision', async () => {
  const { createPrimitiveMesh } = await import('@forgeax/engine-geometry');
  const { MeshFrame } = await import('../mesh-frame');
  const { cullingDisplacementRadius } = await import('../render-scene-snapshots');
  const raw = new MaterialResource(material(91)),
    resolved = new MaterialResource(material(91));
  const resolve = vi.fn(() => resolved);
  const owner = new MaterialDispatch(resolve);
  const base = slot(0, raw);
  const row = { ...base, snapshot: { ...base.snapshot, assetHandle: 1, materialOverrides: [raw] } };
  const rows = [row];
  const mesh = { ...createPrimitiveMesh('cube').unwrap(), materialSlots: [{ slotName: 'body' }] };
  const before = new MeshFrame().with(1, mesh);
  owner.bind(0, row.snapshot);
  owner.adopt(raw);
  const passes = query(owner, fixedSlots(rows), before);
  const calls = resolve.mock.calls.length;
  const next = before.with(1, {
    ...mesh,
    materialSlots: [{ slotName: 'body' }],
    aabb: new Float32Array([-2, -1, -1, 2, 1, 1]),
  });
  owner.prepare(next);
  expect(cullingDisplacementRadius(row.snapshot, next.get(1), owner.materials())).toBe(0);
  expect(query(owner, fixedSlots(rows), next)).toBe(passes);
  expect(resolve).toHaveBeenCalledTimes(calls);
});

it('inserts generated commands after equal queues without expanding the native material roster', () => {
  const owner = new MaterialDispatch();
  const rows = [1000, 3000, 4000].map((queue, rank) =>
    slot(rank, new MaterialResource(material(rank + 1, queue))),
  );
  for (const row of rows) owner.bind(row.slot, row.snapshot);
  const base = owner.query(fixedSlots(rows));
  const middle = base.at(1);
  assert(middle !== undefined);
  const generated = { ...middle, renderableIndex: 88 };
  const end = base.at(-1);
  const capture = captureGeneratedQueueSource(base);
  expect(capture).toBe(base);
  const merged = appendGeneratedQueue(capture, [generated]);
  const sequence = [...merged];
  expect(sequence.map((row) => row.queue)).toEqual([1000, 3000, 3000, 4000]);
  expect(sequence[2]).toBe(generated);
  for (let i = 0; i < sequence.length; i++) expect(merged.at(i)).toBe(sequence[i]);
  expect(merged.at(-1)).toBe(end);
  expect(merged.at(-5)).toBeUndefined();
  const borrowed = [generated, ...base];
  const fixed = captureGeneratedQueueSource(borrowed);
  borrowed.length = 0;
  expect([...appendGeneratedQueue(fixed, [])].map((row) => row.queue)).toEqual([
    1000, 3000, 3000, 4000,
  ]);
});
