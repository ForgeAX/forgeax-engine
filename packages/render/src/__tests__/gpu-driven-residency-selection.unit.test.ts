import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { expect, it, vi } from 'vitest';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { BatchSources, MemberCandidates } from '../gpu-driven/batch-members';
import { BatchTopology, type SubmissionPlan } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { materialBindingLayout } from '../gpu-driven/fixed-task-plan';
import { MeshBatchProjection } from '../gpu-driven/mesh-batches';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { RenderSystemInternals } from '../record/render-context';
import { gpuDrivenMeshesForFrame } from '../record/resident-meshes';
import type { RenderableSnapshot } from '../render-system-extract';
import { TreeFrame } from '../scene/frame-tree-list';
import { MeshFrame } from '../scene/mesh-frame';
import { RenderScene } from '../scene/render-scene';
import { ResidualRoster } from '../scene/residual-roster';
import { receiptRow } from './gpu-draw-selection-fixture';

function fixture(overrides = false, instances = 1) {
  const original = receiptRow().source;
  const instanceData =
    instances === 1
      ? {}
      : {
          instances: {
            transforms: new Float32Array(instances * 16),
            instanceCount: instances,
            cacheKey: 1,
            archVersion: 0,
          },
        };
  const topology = new BatchTopology();
  const firstGroup = topology.createResidencyGroup();
  const secondGroup = topology.createResidencyGroup();
  const sources: RenderableSnapshot[] = [undefined, firstGroup, secondGroup].map(
    (residencyGroup, index) => ({
      ...original,
      ...instanceData,
      entityKey: index + 1,
      ...(residencyGroup === undefined ? {} : { residencyGroup }),
      ...(overrides ? { materialOverrides: [original.material] } : {}),
    }),
  );
  const scene = new RenderScene();
  topology.apply(
    scene.apply(
      sources.map((snapshot) => ({
        kind: 'update' as const,
        entityKey: snapshot.entityKey,
        snapshot,
      })),
    ),
  );
  const query = () => topology.query(topology.sourcePlan(), undefined).active;
  return { original, sources, scene, topology, query, firstGroup, secondGroup };
}

it('separates member publications from ordered material bindings in resident and selected windows', () => {
  const f = fixture(false, 64);
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  const source = f.topology.sourcePlan();
  const projection = new MeshBatchProjection();
  const first = projection.query(source, undefined);
  const before = source.resident?.sourceGroups;
  const selected = source.sourceGroups;
  const batch = selected?.at(0);
  if (!before || !selected || !batch || !MemberCandidates.is(batch.candidates))
    throw new Error('Expected captured member windows');
  if (!source.resident) throw new Error('Expected resident plan');
  const resident = before.withMembers(batch.batchId, batch.candidates, batch.contentEpoch + 1);
  const active = selected.withPublished(resident, batch.batchId);
  const next = projection.query(
    {
      ...source,
      batches: active,
      sourceGroups: active,
      resident: { ...source.resident, batches: resident, sourceGroups: resident },
    },
    undefined,
  );
  for (const kind of ['active', 'resident'] as const) {
    expect(next[kind].batches).not.toBe(first[kind].batches);
    const layout = materialBindingLayout(first[kind].batches);
    expect(layout).toBeDefined();
    expect(materialBindingLayout(next[kind].batches)).toBe(layout);
  }
  const getMeshGpuHandles = vi.fn(() => ({ contentEpoch: 1 }) as MeshGpuHandles);
  const internals = { gpuStore: { getMeshGpuHandles } } as unknown as RenderSystemInternals;
  const scope = {} as RenderResourceScope;
  gpuDrivenMeshesForFrame(internals, scope, { plan: first.active }, 'resident-only');
  const walk = vi.spyOn(TreeFrame.prototype, Symbol.iterator);
  getMeshGpuHandles.mockClear();
  try {
    gpuDrivenMeshesForFrame(internals, scope, { plan: next.active }, 'resident-only');
    expect(walk).not.toHaveBeenCalled();
    expect(getMeshGpuHandles).toHaveBeenCalled();
  } finally {
    walk.mockRestore();
  }
  f.topology.setResidencyGroupActive(f.secondGroup, true);
  const all = projection.query(f.topology.sourcePlan(), undefined);
  expect(materialBindingLayout(all.active.batches)).not.toBe(
    materialBindingLayout(next.active.batches),
  );
});

it.each([
  false,
  true,
])('splits shared Mesh/material membership across residency partitions (overrides=%s)', (overrides) => {
  const f = fixture(overrides);
  const resident = f.topology.residentSourcePlan();
  expect(resident.batches.length).toBe(3);
  expect(resident.candidateCount).toBe(3);
  const inactive = f.topology.sourcePlan();
  expect(inactive.resident).toBe(resident);
  expect(inactive.candidateCount).toBe(1);
  expect(
    [...(inactive.sourceGroups ?? [])].every((batch) => batch.key.residencyGroup === undefined),
  ).toBe(true);
  expect(f.query().batches.length).toBe(2); // Two authored submeshes, one ordinary member.
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  const active = f.query();
  expect(active.batches.length).toBe(4);
  expect(new Set(active.batches.map((batch) => batch.key.residencyGroup))).toEqual(
    new Set([undefined, f.firstGroup.id]),
  );
  expect(f.topology.residentSourcePlan()).toBe(resident);
  f.topology.setResidencyGroupActive(f.secondGroup, true);
  expect(f.topology.sourcePlan()).toBe(resident);
  expect(f.query().batches.length).toBe(6);
});

it('retains actual execution windows and candidate roots through repeated off/on selection', () => {
  const f = fixture(false, 4096);
  const source = f.topology.residentSourcePlan();
  const resident = f.topology.query(source, undefined).active;
  const before = f.topology.inspect();
  const scan = vi.spyOn(MemberCandidates.prototype, Symbol.iterator);
  try {
    for (let cycle = 0; cycle < 12; cycle++) {
      f.topology.setResidencyGroupActive(f.firstGroup, true);
      const active = f.query();
      for (const batch of active.batches)
        expect(resident.batches.some((retained) => retained === batch)).toBe(true);
      f.topology.setResidencyGroupActive(f.firstGroup, false);
      const stopped = f.query();
      expect(stopped.batches.every((batch) => batch.key.residencyGroup === undefined)).toBe(true);
      expect(stopped.visibleCapacity).toBe(resident.visibleCapacity);
      expect(f.topology.query(source, undefined).active).toBe(resident);
    }
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
  }
  const after = f.topology.inspect();
  expect(after.candidateAdds).toBe(before.candidateAdds);
  expect(after.candidateRemoves).toBe(before.candidateRemoves);
  expect(after.windowRelocations).toBe(before.windowRelocations);
  expect(after.windowCompactions).toBe(before.windowCompactions);
});

it('retains the active execution roster while dormant physical windows change', () => {
  const f = fixture(false, 64);
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  const before = f.query();
  const dormant = f.topology.createResidencyGroup();
  f.topology.apply(
    f.scene.apply([
      {
        kind: 'update',
        entityKey: 4,
        snapshot: { ...f.original, entityKey: 4, residencyGroup: dormant },
      },
      { kind: 'remove', entityKey: 3 },
    ]),
  );
  const changed = f.topology.query(f.topology.sourcePlan(), undefined);
  expect(changed.resident.batches.some((batch) => batch.key.residencyGroup === dormant.id)).toBe(
    true,
  );
  expect(changed.active.batches).toBe(before.batches);
  expect(changed.active.visibleCapacity).toBe(changed.resident.visibleCapacity);

  f.topology.setResidencyGroupActive(dormant, true);
  f.topology.setResidencyGroupActive(f.firstGroup, false);
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 2 }]));
  const switched = f.query();
  expect(new Set(switched.batches.map((batch) => batch.key.residencyGroup))).toEqual(
    new Set([undefined, dormant.id]),
  );
});

it('publishes active source membership to CPU residual selection rather than resurrecting inactive rows', () => {
  const f = fixture();
  const residual = new ResidualRoster();
  const emptyGpu = GpuDrawSelection.fixed([]);
  const read = () =>
    [...residual.sync(f.topology.sourcePlan(), f.topology.unbatchedSlots, emptyGpu)].map(
      (slot) => f.scene.slotAt(slot)?.entityKey,
    );
  expect(read()).toEqual([1]);
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  expect(read()).toEqual([1, 2]);
  f.topology.setResidencyGroupActive(f.firstGroup, false);
  expect(read()).toEqual([1]);
});

it('preserves authored hidden membership independently of the group intent', () => {
  const f = fixture();
  const original = f.sources[1];
  if (original === undefined) throw new Error('missing source');
  f.topology.apply(
    f.scene.apply([
      { kind: 'update', entityKey: 2, snapshot: { ...original, authorVisible: false } },
    ]),
  );
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  expect(f.query().batches.every((batch) => batch.key.residencyGroup !== f.firstGroup.id)).toBe(
    true,
  );
  f.topology.apply(f.scene.apply([{ kind: 'update', entityKey: 2, snapshot: original }]));
  expect(f.query().batches.some((batch) => batch.key.residencyGroup === f.firstGroup.id)).toBe(
    true,
  );
});

it('rejoins an inactive Mesh edit without deleting another group or reassigning its windows', () => {
  const f = fixture();
  const mesh = createPrimitiveMesh('cube').unwrap();
  const first = new MeshFrame().with(f.original.assetHandle as number, mesh);
  const resident = f.topology.query(f.topology.residentSourcePlan(), first).active;
  const ordinary = resident.batches.filter((batch) => batch.key.residencyGroup === undefined);
  const edited = first.with(f.original.assetHandle as number, {
    ...mesh,
    aabb: new Float32Array([-2, -2, -2, 2, 2, 2]),
  });
  const active = f.topology.query(f.topology.sourcePlan(), edited).active;
  expect(active.batches.length).toBe(ordinary.length);
  expect(
    active.batches.map((batch) => [
      batch.batchId,
      batch.generation,
      batch.visibleBase,
      batch.indirectOffset,
    ]),
  ).toEqual(
    ordinary.map((batch) => [
      batch.batchId,
      batch.generation,
      batch.visibleBase,
      batch.indirectOffset,
    ]),
  );
  const nextResident = f.topology.query(f.topology.residentSourcePlan(), edited).active;
  f.topology.setResidencyGroupActive(f.secondGroup, true);
  const enabled = f.topology.query(f.topology.sourcePlan(), edited).active;
  expect(enabled.batches.filter((batch) => batch.key.residencyGroup === f.secondGroup.id)).toEqual(
    nextResident.batches.filter((batch) => batch.key.residencyGroup === f.secondGroup.id),
  );
});

it('selects by source contribution after execution IDs are recycled and multiple submeshes expand', () => {
  const f = fixture();
  f.topology.query(f.topology.residentSourcePlan(), undefined).active;
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 1 }]));
  f.query();
  const replacement = {
    ...f.original,
    entityKey: 10,
    residencyGroup: f.topology.createResidencyGroup(),
  };
  f.topology.apply(f.scene.apply([{ kind: 'update', entityKey: 10, snapshot: replacement }]));
  const resident = f.topology.query(f.topology.residentSourcePlan(), undefined).active;
  f.topology.setResidencyGroupActive(f.secondGroup, true);
  const selected = f.query();
  expect(selected.batches.length).toBe(2);
  expect(selected.batches.every((batch) => batch.key.residencyGroup === f.secondGroup.id)).toBe(
    true,
  );
  for (const batch of selected.batches) {
    expect(resident.batches.some((retained) => retained === batch)).toBe(true);
    expect([...(batch.members ?? [])].map((member) => member.entityKey)).toEqual([3]);
  }
});

it('rejects a forged copied source and nested resident baseline before altering its windows', () => {
  const f = fixture();
  const windows = new MeshBatchProjection();
  const resident = f.topology.residentSourcePlan();
  const baseline = windows.query(resident, undefined).active;
  const batch = resident.batches.at(0);
  if (batch === undefined) throw new Error('missing source batch');
  const forged = new BatchSources().with({ ...batch });
  const copied: SubmissionPlan = { ...resident, batches: forged, sourceGroups: forged, resident };
  expect(() => windows.query(copied, undefined).active).toThrow('exact resident source batch');
  expect(() => windows.query({ ...copied, resident: copied }, undefined).active).toThrow(
    'one resident source baseline',
  );
  expect(windows.query(resident, undefined).active).toBe(baseline);
});

it('rejects a previously accepted selection whose resident source changed underneath it', () => {
  const f = fixture();
  const windows = new MeshBatchProjection();
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  const before = f.topology.sourcePlan();
  expect(windows.query(before, undefined).active.batches).toHaveLength(4);
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 2 }]));
  const resident = f.topology.residentSourcePlan();
  expect(() => windows.query({ ...before, resident }, undefined)).toThrow('exact resident');
  expect(windows.query(f.topology.sourcePlan(), undefined).active.batches).toHaveLength(2);
});

it('closes every group on a rebuilt baseline and keeps ordinary queries unchanged', () => {
  const f = fixture();
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  expect(f.query().batches.length).toBe(4);
  expect(() => f.topology.rebuild(f.scene.slotsSnapshot())).toThrow('foreign or retired');
  expect(() => f.topology.setResidencyGroupActive(f.firstGroup, true)).toThrow();
  const plain = new RenderScene();
  plain.reset([f.original]);
  const topology = new BatchTopology();
  topology.rebuild(plain.slotsSnapshot());
  expect(topology.sourcePlan().resident).toBeUndefined();
  expect(topology.query(topology.sourcePlan(), undefined).active).toBe(
    topology.query(topology.sourcePlan(), undefined).active,
  );
});

it('rejects foreign, forged and retired capabilities and never reuses a group identity', () => {
  const f = fixture();
  const foreign = new BatchTopology().createResidencyGroup();
  expect(foreign.id).toBe(f.firstGroup.id);
  expect(() => f.topology.setResidencyGroupActive(foreign, true)).toThrow('foreign or retired');
  expect(() => f.topology.setResidencyGroupActive({ ...f.firstGroup }, true)).toThrow(
    'foreign or retired',
  );
  expect(() => f.topology.retireResidencyGroup(f.firstGroup)).toThrow('still owns Scene rows');
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 2 }]));
  f.topology.retireResidencyGroup(f.firstGroup);
  expect(() => f.topology.setResidencyGroupActive(f.firstGroup, true)).toThrow(
    'foreign or retired',
  );
  const replacement = f.topology.createResidencyGroup();
  expect(replacement.id).toBeGreaterThan(f.secondGroup.id);
  f.topology.apply(
    f.scene.apply([
      {
        kind: 'update',
        entityKey: 20,
        snapshot: { ...f.original, entityKey: 20, residencyGroup: replacement },
      },
    ]),
  );
  expect(f.query().batches.every((batch) => batch.key.residencyGroup === undefined)).toBe(true);
});

it.each([
  'other',
  'ordinary',
  'attach',
] as const)('refuses changing a live row partition to %s', (change) => {
  const f = fixture();
  f.topology.setResidencyGroupActive(f.secondGroup, true);
  const entity = change === 'attach' ? 1 : 2;
  const snapshot = {
    ...f.original,
    entityKey: entity,
    ...(change === 'ordinary' ? {} : { residencyGroup: f.secondGroup }),
  };
  const before = f.topology.residentSourcePlan();
  const delta = f.scene.apply([{ kind: 'update', entityKey: entity, snapshot }]);
  expect(() => f.topology.apply(delta)).toThrow('cannot change within a Scene row lifetime');
  expect(before.candidateCount).toBe(3);
  expect(() => f.topology.sourcePlan()).toThrow('cannot change');
});

it('gates ineligible CPU residual rows and retains their claims until real Scene removal', () => {
  const f = fixture();
  const source = f.sources[1];
  if (source === undefined) throw new Error('missing source');
  const { gpuDrivenDraws: _unused, ...ineligible } = source;
  f.topology.apply(f.scene.apply([{ kind: 'update', entityKey: 2, snapshot: ineligible }]));
  const slot = f.scene.slot(2)?.slot;
  if (slot === undefined) throw new Error('missing row');
  const residual = new ResidualRoster();
  const read = () =>
    residual.sync(f.topology.sourcePlan(), f.topology.unbatchedSlots, GpuDrawSelection.fixed([]));
  expect(f.topology.residentUnbatchedSlots.has(slot)).toBe(true);
  expect(f.topology.unbatchedSlots.has(slot)).toBe(false);
  expect(read().has(slot)).toBe(false);
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  expect(read().has(slot)).toBe(true);
  f.topology.setResidencyGroupActive(f.firstGroup, false);
  expect(read().has(slot)).toBe(false);
  const residency = Reflect.get(f.topology, 'residency');
  expect(Reflect.get(residency, 'unbatched')).toBeDefined();
  expect(() => f.topology.retireResidencyGroup(f.firstGroup)).toThrow('still owns Scene rows');
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 2 }]));
  expect(Reflect.get(residency, 'unbatched')).toBeUndefined();
  expect(() => f.topology.retireResidencyGroup(f.firstGroup)).not.toThrow();
});

it('counts hidden/zero-instance claims without pretending they are raster members', () => {
  const f = fixture();
  const original = f.sources[1];
  if (original === undefined) throw new Error('missing source');
  f.topology.apply(
    f.scene.apply([
      { kind: 'update', entityKey: 2, snapshot: { ...original, authorVisible: false } },
    ]),
  );
  expect(() => f.topology.retireResidencyGroup(f.firstGroup)).toThrow('still owns Scene rows');
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 2 }]));
  f.topology.retireResidencyGroup(f.firstGroup);
  const token = f.topology.createResidencyGroup();
  f.topology.apply(
    f.scene.apply([
      {
        kind: 'update',
        entityKey: 4,
        snapshot: {
          ...f.original,
          entityKey: 4,
          residencyGroup: token,
          instances: {
            transforms: new Float32Array(),
            instanceCount: 0,
            cacheKey: 0,
            archVersion: 0,
          },
        },
      },
    ]),
  );
  expect(() => f.topology.retireResidencyGroup(token)).toThrow('still owns Scene rows');
  f.topology.apply(f.scene.apply([{ kind: 'remove', entityKey: 4 }]));
  f.topology.retireResidencyGroup(token);
});

it('releases obsolete selection roots after the last group retires without needing a later staged group', () => {
  const f = fixture(false, 1024);
  const windows = new MeshBatchProjection();
  f.topology.setResidencyGroupActive(f.firstGroup, true);
  windows.query(f.topology.sourcePlan(), undefined).active;
  expect(Reflect.get(windows, 'selection')).toBeDefined();
  expect(Reflect.get(f.topology, 'executionPlan')).toBeDefined();
  f.topology.apply(
    f.scene.apply([
      { kind: 'remove', entityKey: 2 },
      { kind: 'remove', entityKey: 3 },
    ]),
  );
  expect(Reflect.get(f.topology, 'executionPlan')).toBeUndefined();
  f.topology.retireResidencyGroup(f.firstGroup);
  f.topology.retireResidencyGroup(f.secondGroup);
  const ordinary = f.topology.sourcePlan();
  const current = windows.query(ordinary, undefined).active;
  expect(current.batches.every((batch) => batch.key.residencyGroup === undefined)).toBe(true);
  expect(Reflect.get(windows, 'selection')).toBeUndefined();
  expect(Reflect.get(f.topology, 'executionPlan')).toBeUndefined();
});

it('prepares only the active world and the requested closed group without opening execution', () => {
  const f = fixture();
  const ordinary = f.topology.sourcePlan();
  const resident = f.topology.residentSourcePlan();
  const prospective = f.topology.preparationSourcePlan(f.firstGroup);
  expect(prospective.resident).toBe(resident);
  expect(prospective.candidateCount).toBe(2);
  expect(new Set(prospective.batches.map((batch) => batch.key.residencyGroup))).toEqual(
    new Set([undefined, f.firstGroup.id]),
  );
  expect(f.topology.sourcePlan()).toBe(ordinary);
  expect(f.topology.captureResidencySelection().includes(f.firstGroup)).toBe(false);
  expect(f.topology.captureResidencySelection().includes(f.secondGroup)).toBe(false);
  const prepared = f.topology.query(prospective, undefined).active;
  expect(prepared.batches.length).toBe(4);
  expect(f.query().batches.length).toBe(2);
  f.topology.setResidencyGroupActive(f.secondGroup, true);
  expect(f.topology.preparationSourcePlan(f.firstGroup)).toBe(resident);
  expect(f.query().batches.every((batch) => batch.key.residencyGroup !== f.firstGroup.id)).toBe(
    true,
  );
});

it('changes one group without walking resident batches or rebuilding their source bindings', () => {
  const f = fixture(false, 1024);
  const resident = f.topology.residentSourcePlan();
  const opened = resident.batches.find((batch) => batch.key.residencyGroup === f.firstGroup.id);
  const stillHidden = resident.batches.find(
    (batch) => batch.key.residencyGroup === f.secondGroup.id,
  );
  expect(opened).toBeDefined();
  expect(stillHidden).toBeDefined();
  const walk = vi.spyOn(BatchSources.prototype, Symbol.iterator);
  try {
    f.topology.setResidencyGroupActive(f.firstGroup, true);
    const selected = f.topology.sourcePlan().sourceGroups;
    const prospective = f.topology.preparationSourcePlan(f.secondGroup);
    expect(prospective).toBe(resident);
    expect(opened === undefined ? undefined : selected?.get(opened.batchId)).toBe(opened);
    expect(
      stillHidden === undefined ? undefined : selected?.get(stillHidden.batchId),
    ).toBeUndefined();
    f.topology.setResidencyGroupActive(f.firstGroup, false);
    expect(f.topology.sourcePlan().candidateCount).toBe(1024);
    expect(walk).not.toHaveBeenCalled();
  } finally {
    walk.mockRestore();
  }
});

it('joins only the changed group windows when selecting prepared physical executions', () => {
  const f = fixture(false, 1024);
  const before = f.topology.query(f.topology.sourcePlan(), undefined);
  const ordinary = before.active.batches.at(0);
  const authored = before.resident.batches.find(
    (batch) => batch.key.residencyGroup === f.firstGroup.id,
  );
  const scan = vi.spyOn(TreeFrame.prototype, 'filter');
  const validate = vi.spyOn(BatchSources.prototype, Symbol.iterator);
  try {
    f.topology.setResidencyGroupActive(f.firstGroup, true);
    const shown = f.topology.query(f.topology.sourcePlan(), undefined);
    expect(shown.resident).toBe(before.resident);
    expect(shown.active.batches.at(0)).toBe(ordinary);
    expect(shown.active.batches.at(2)).toBe(authored);
    expect(shown.active.candidateCount).toBe(before.active.candidateCount * 2);
    f.topology.setResidencyGroupActive(f.firstGroup, false);
    const hidden = f.topology.query(f.topology.sourcePlan(), undefined);
    expect(hidden.active.batches.at(0)).toBe(ordinary);
    expect(hidden.active.batches.length).toBe(before.active.batches.length);
    expect(scan).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
    validate.mockRestore();
  }
});

it('rejects foreign and retired preparation groups before changing ordinary selection', () => {
  const f = fixture();
  const ordinary = f.topology.sourcePlan();
  const foreign = new BatchTopology().createResidencyGroup();
  expect(() => f.topology.preparationSourcePlan(foreign)).toThrow(
    'Preparation requires a live owned residency group',
  );
  expect(f.topology.sourcePlan()).toBe(ordinary);
  const retired = f.topology.createResidencyGroup();
  f.topology.retireResidencyGroup(retired);
  const afterRetirement = f.topology.sourcePlan();
  expect(() => f.topology.preparationSourcePlan(retired)).toThrow(
    'Preparation requires a live owned residency group',
  );
  expect(f.topology.sourcePlan()).toBe(afterRetirement);
});
