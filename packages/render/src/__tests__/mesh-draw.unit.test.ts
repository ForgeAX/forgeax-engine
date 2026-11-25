import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { assert, expect, it, vi } from 'vitest';
import { GpuSceneSourceRows } from '../gpu-scene-source-rows';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { setSceneRow } from '../scene/__tests__/scene-row-writes';
import { MaterialDispatch } from '../scene/material-dispatch';
import {
  meshDrawSnapshot,
  SceneDrawSlot,
  slotDrawMaterials,
  slotDrawSnapshot,
} from '../scene/mesh-draw';
import { MeshFrame } from '../scene/mesh-frame';
import {
  captureMaterialOverrides,
  effectiveMeshMaterials,
  type MeshMaterialBindingWrite,
  prepareMeshMaterialBindings,
  retainMeshMaterialBindings,
} from '../scene/mesh-materials';
import { createTemporalSnapshot } from '../scene/render-scene-snapshots';
import { SceneSlots } from '../scene/scene-slots';
import { StableRangeAllocator } from '../stable-range-allocator';

function fixture() {
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const material = new MaterialResource(defaultMaterialSnapshot());
  const source: RenderableSnapshot = {
    entityKey: 1,
    assetHandle: 7,
    transform: { world: mat4.identity(mat4.create()) },
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    materialOverrides: captureMaterialOverrides([material]),
    gpuDrivenDraws: [],
  };
  return { mesh, material, source, frame: new MeshFrame().with(7, mesh) };
}

function writeSlot(slots: SceneSlots, at: number, source: RenderableSnapshot) {
  const slot = setSceneRow(slots, at, {
    generation: 1,
    entityKey: source.entityKey,
    snapshot: source,
  });
  assert(slot);
  return slot;
}

it('resolves every edited binding against one layout and keeps the fixed provenance column', () => {
  const f = resolvedFixture();
  const base = f.meshes.get(7);
  assert(base);
  const slot = base.materialSlots[0];
  assert(slot);
  let layoutReads = 0;
  const mesh = {
    ...base,
    get layout() {
      layoutReads++;
      return base.layout;
    },
    materialSlots: Array.from({ length: 32 }, () => slot),
    materials: Array.from({ length: 32 }, () => f.first),
  };
  const first = effectiveMeshMaterials(f.source, mesh);
  const replacement = new MaterialResource(defaultMaterialSnapshot(46));
  const pending: MeshMaterialBindingWrite[] = [];
  let calls = 0;
  const next = prepareMeshMaterialBindings(
    f.source,
    mesh,
    'mesh',
    (_handle, _geometry, color) => {
      expect(color).toBe(false);
      return calls++ === 23 ? replacement : first.material;
    },
    pending,
  );
  expect(calls).toBe(32);
  expect(layoutReads).toBeLessThanOrEqual(1);
  expect(next.materialBindingSources).toBe(first.materialBindingSources);
  expect(next.materials).not.toBe(first.materials);
  expect(next.materials[23]).toBe(replacement);
  expect(first.materials[23]).toBe(first.material);
  expect(effectiveMeshMaterials(f.source, mesh)).toBe(first);
  for (const write of pending) write.contexts[write.geometry] = write.value;
  expect(effectiveMeshMaterials(f.source, mesh)).toBe(next);
});

it('keeps material values when a borrowed binding changes only their source', () => {
  const f = resolvedFixture();
  const mesh = f.meshes.get(7);
  assert(mesh);
  const overrides: MaterialResource[] = [];
  const source = { ...f.source, materialOverrides: overrides };
  const first = effectiveMeshMaterials(source, mesh);
  overrides[0] = f.first;
  const pending: MeshMaterialBindingWrite[] = [];
  const next = prepareMeshMaterialBindings(source, mesh, 'mesh', () => f.first, pending);
  expect(next.materials).toBe(first.materials);
  expect(next.materialBindingSources).toEqual(['renderer-override']);
  expect(first.materialBindingSources).toEqual(['mesh-default']);
  expect(effectiveMeshMaterials(source, mesh)).toBe(first);
  expect(pending).toHaveLength(1);
});

it('joins extracted GPU materials in row order with linear handle reads and first-match ownership', () => {
  const f = fixture();
  const base = f.frame.get(7);
  assert(base);
  const materials = Array.from(
    { length: 32 },
    (_, i) => new MaterialResource(defaultMaterialSnapshot(100 + i)),
  );
  const primary = new MaterialResource(defaultMaterialSnapshot(107));
  const duplicate = new MaterialResource(defaultMaterialSnapshot(113));
  const ordered = [duplicate, ...materials];
  const mesh = {
    ...base,
    materialSlots: materials
      .map((material, index) => ({
        slotName: String(index),
        defaultMaterial: material.snapshot
          .materialHandle as import('@forgeax/engine-types').AssetHandle<'material'>,
      }))
      .reverse(),
  };
  const source = { ...f.source, material: primary, materials: ordered, materialOverrides: [] };
  const range = new StableRangeAllocator();
  const fixed = new GpuSceneSourceRows(
    [{ slot: 1, generation: 0, entityKey: source.entityKey, snapshot: source }],
    { primitive: range, instance: range, transform: range },
    {
      material: () => {
        throw new Error('unexpected material allocation');
      },
      mesh: () => {
        throw new Error('unexpected mesh allocation');
      },
    },
    false,
  );
  const reads = vi.spyOn(MaterialResource.prototype, 'snapshot', 'get');
  try {
    Array.from(
      fixed.prepareBindings(
        () => mesh,
        () => true,
      ),
    );
    const count = reads.mock.calls.length;
    const expected = materials.slice().reverse();
    expected[31 - 7] = primary;
    expected[31 - 13] = duplicate;
    expect(fixed.snapshots[0]?.materials).toEqual(expected);
    expect(count).toBeLessThanOrEqual(materials.length * 3 + 4);
  } finally {
    reads.mockRestore();
  }
});

it('preserves instance fields and projects current shared Mesh facts', () => {
  const f = fixture();
  const mark = Symbol('instance');
  let reads = 0;
  const source = Object.freeze({
    ...f.source,
    [mark]: 'retained',
    localAabb: new Float32Array([-9, -9, -9, 9, 9, 9]),
    lods: [],
    lodHysteresis: 0.25,
    get layer() {
      reads++;
      return 3;
    },
  });
  const result = meshDrawSnapshot(source, f.frame);
  const projectionReads = reads;
  expect(projectionReads).toBe(1);
  expect(result).not.toBe(source);
  expect(result.transform).toBe(source.transform);
  expect(result.entityKey).toBe(source.entityKey);
  expect(result.layer).toBe(3);
  expect(Reflect.get(result, mark)).toBe('retained');
  expect(result.localAabb).toBe(f.frame.get(7)?.bounds);
  expect(Object.hasOwn(result, 'lods')).toBe(false);
  expect(Object.hasOwn(result, 'lodHysteresis')).toBe(false);
  expect(result.gpuDrivenDraws).toHaveLength(f.mesh.submeshes.length);
  expect(result.material).toBe(f.material);
  expect(source.lods).toEqual([]);
  expect(source.lodHysteresis).toBe(0.25);
  expect([...source.localAabb]).toEqual([-9, -9, -9, 9, 9, 9]);
  const before = reads;
  const next = meshDrawSnapshot(source, f.frame);
  expect(reads).toBe(before + projectionReads);
  expect(next).toEqual(result);
});

it('omits stale optional metadata when the shared Mesh has none', () => {
  const f = fixture();
  const { aabb: _bounds, ...mesh } = f.mesh;
  const frame = new MeshFrame().with(7, mesh);
  const source = Object.freeze({
    ...f.source,
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    lods: [],
    lodHysteresis: 0,
  });
  const result = meshDrawSnapshot(source, frame);
  for (const key of ['localAabb', 'lods', 'lodHysteresis']) {
    expect(Object.hasOwn(result, key)).toBe(false);
    expect(Object.hasOwn(source, key)).toBe(true);
  }
});

it('projects current borrowed rows when their producer reuses one object for different draws', () => {
  const f = fixture();
  const row = { ...f.source, layer: 0 };
  const held = meshDrawSnapshot(row, f.frame);
  for (let frame = 1; frame <= 60; frame++) {
    row.entityKey = frame + 100;
    row.layer = frame % 8;
    const draw = meshDrawSnapshot(row, f.frame);
    expect(draw.entityKey).toBe(frame + 100);
    expect(draw.layer).toBe(frame % 8);
    expect(draw.materials).toBe(held.materials);
  }
  expect(held.entityKey).toBe(f.source.entityKey);
  expect(held.layer).toBe(0);
});

it('keeps optional fields absent when neither source nor shared Mesh supplies them', () => {
  const f = fixture();
  const { aabb: _bounds, ...mesh } = f.mesh;
  const result = meshDrawSnapshot(f.source, new MeshFrame().with(7, mesh));
  for (const key of ['localAabb', 'lods', 'lodHysteresis'])
    expect(Object.hasOwn(result, key)).toBe(false);
});

it('uses the selected Mesh version and preserves old projections after replacement', () => {
  const f = fixture();
  const parsed = AssetGuid.parse('019d0000-0000-7000-8000-000000000007');
  if (!parsed.ok) throw new Error('invalid fixture guid');
  const guid = parsed.value;
  const source = Object.freeze({ ...f.source, lods: [], lodHysteresis: 0.2 });
  const before = meshDrawSnapshot(source, f.frame);
  const mesh = { ...f.mesh, lods: [{ mesh: guid, screenCoverage: 0.5 }], lodHysteresis: 0.1 };
  const frame = f.frame.with(7, mesh);
  const after = meshDrawSnapshot(source, frame);
  expect(after).not.toBe(before);
  expect(after.lods).toBe(frame.get(7)?.lods);
  expect(after.lodHysteresis).toBe(0.1);
  expect(Object.hasOwn(before, 'lods')).toBe(false);
  expect(Object.hasOwn(before, 'lodHysteresis')).toBe(false);
  expect(meshDrawSnapshot(source, f.frame)).toEqual(before);
  expect(meshDrawSnapshot(source, frame.with(8, f.mesh))).toEqual(after);
});

it('keeps instance identity separate while sharing material and geometry projections', () => {
  const f = fixture();
  const other = { ...f.source, entityKey: 2, transform: { world: mat4.create() } };
  const a = meshDrawSnapshot(f.source, f.frame);
  const b = meshDrawSnapshot(other, f.frame);
  expect(a).not.toBe(b);
  expect(a.entityKey).toBe(1);
  expect(b.entityKey).toBe(2);
  expect(a.transform).toBe(f.source.transform);
  expect(b.transform).toBe(other.transform);
  expect(a.materials).toBe(b.materials);
  expect(a.gpuDrivenDraws).toBe(b.gpuDrivenDraws);
  expect(meshDrawSnapshot(f.source, f.frame).materials).toBe(a.materials);
  expect(meshDrawSnapshot(other, f.frame).materials).toBe(b.materials);
});

it('keeps distinct instance material overrides separate on the same Mesh', () => {
  const f = fixture();
  const material = new MaterialResource(defaultMaterialSnapshot());
  const other = {
    ...f.source,
    entityKey: 2,
    materialOverrides: captureMaterialOverrides([material]),
  };
  const a = meshDrawSnapshot(f.source, f.frame);
  const b = meshDrawSnapshot(other, f.frame);
  expect(a.material).toBe(f.material);
  expect(b.material).toBe(material);
  expect(a.materials).not.toBe(b.materials);
  expect(a.gpuDrivenDraws).not.toBe(b.gpuDrivenDraws);
  expect(meshDrawSnapshot(f.source, f.frame).materials).toBe(a.materials);
  expect(meshDrawSnapshot(other, f.frame).materials).toBe(b.materials);
});

it('returns the original source when no Mesh or authored override projection is needed', () => {
  const f = fixture();
  expect(meshDrawSnapshot(f.source, new MeshFrame())).toBe(f.source);
  const { materialOverrides: _overrides, ...source } = f.source;
  expect(meshDrawSnapshot(source, f.frame)).toBe(source);
});

function resolvedFixture() {
  const f = fixture();
  const handle = 11 as import('@forgeax/engine-types').AssetHandle<'material'>;
  const first = new MaterialResource({ ...defaultMaterialSnapshot(), materialHandle: handle });
  let resolved = first;
  const owner = new MaterialDispatch(() => resolved);
  const source = {
    ...f.source,
    material: first,
    materials: [first],
    materialOverrides: captureMaterialOverrides([]),
  };
  const meshes = new MeshFrame().with(
    7,
    { ...f.mesh, materialSlots: [{ slotName: 'body', defaultMaterial: handle }] },
    [first],
  );
  const slots = new SceneSlots();
  const bind = (slot: number) => {
    const snapshot = slot === 0 ? source : { ...source, entityKey: slot + 1 };
    owner.bind(slot, snapshot);
    setSceneRow(slots, slot, {
      slot,
      generation: 1,
      entityKey: snapshot.entityKey,
      snapshot,
    });
  };
  const query = (validate?: () => void) => {
    owner.prepare(meshes);
    return owner.query(slots.capture(), meshes, validate);
  };
  bind(0);
  query();
  return {
    source,
    draw() {
      const slot = slots.get(0);
      assert(slot);
      return slotDrawSnapshot(slot, meshes);
    },
    mesh: f.mesh,
    meshes,
    owner,
    first,
    bind,
    query,
    replace() {
      resolved = new MaterialResource({ ...first.snapshot, roughness: 0.8 });
      return resolved;
    },
  };
}

it('refreshes an issued draw when Pass admission replaces a material behind the same Mesh handle', () => {
  const f = resolvedFixture();
  const before = f.draw();
  const previousMaterials = f.owner.materials();
  const previousDispatch = f.query();
  const previousEntries = [...previousDispatch];
  const replacement = f.replace();
  f.bind(1);
  f.query();
  const materials = f.owner.materials();
  expect(materials.get(f.first)).toBeUndefined();
  expect(materials.get(replacement)?.bindings).toBe(2);
  const after = f.draw();
  expect(materials.get(after.material)).toBeDefined();
  expect(after.material).toBe(replacement);
  expect(after).not.toBe(before);
  expect(f.draw()).toBe(after);
  expect(before.material).toBe(f.first);
  expect(previousMaterials.get(before.material)?.snapshot).toBe(f.first.snapshot);
  expect(previousMaterials.get(replacement)).toBeUndefined();
  expect([...previousDispatch]).toEqual(previousEntries);
});

it('retains an issued draw through quiet and membership-only Pass queries with unchanged materials', () => {
  const f = resolvedFixture();
  const before = f.draw();
  f.query();
  expect(f.draw()).toBe(before);
  f.bind(1);
  f.query();
  expect(f.draw()).toBe(before);
  f.owner.remove(1);
  f.query();
  expect(f.draw()).toBe(before);
});

it('keeps rejected material query writes out of issued draws until a successful retry', () => {
  const f = resolvedFixture();
  const before = f.draw();
  const previousMaterials = f.owner.materials();
  const replacement = f.replace();
  f.bind(1);
  let validations = 0;
  expect(() =>
    f.query(() => {
      if (++validations === 2) throw new Error('fixture source fence changed');
    }),
  ).toThrow('fixture source fence changed');
  expect(f.owner.materials()).toBe(previousMaterials);
  expect(f.draw()).toBe(before);
  f.query();
  const after = f.draw();
  expect(after.material).toBe(replacement);
  expect(f.owner.materials().get(after.material)).toBeDefined();
  expect(before.material).toBe(f.first);
});

it('keeps a hidden pipeline preparation draw in the accepted material frame after visible members retire', () => {
  const f = resolvedFixture();
  const prepared = { ...f.source, entityKey: 2, authorVisible: false, pipelinePreparation: [] };
  const slots = new SceneSlots();
  setSceneRow(slots, 1, { slot: 1, generation: 1, entityKey: 2, snapshot: prepared });
  f.owner.bind(1, prepared);
  f.owner.remove(0);
  f.owner.query(slots.capture(), f.meshes);
  const draw = meshDrawSnapshot(prepared, f.meshes);
  expect(f.owner.materials().get(draw.material)).toBeDefined();
  expect([...f.owner.query(slots.capture(), f.meshes)]).toHaveLength(0);
});

it('admits initially hidden preparation materials without visible or shadow work', () => {
  const f = resolvedFixture();
  const owner = new MaterialDispatch(() => f.first);
  const source = { ...f.source, authorVisible: false, pipelinePreparation: [] };
  const slots = new SceneSlots();
  setSceneRow(slots, 0, { slot: 0, generation: 1, entityKey: 1, snapshot: source });
  owner.bind(0, source);
  owner.prepare(f.meshes);
  const dispatch = owner.query(slots.capture(), f.meshes);
  const accepted = owner.materials();
  expect(accepted.get(meshDrawSnapshot(source, f.meshes).material)?.bindings).toBe(0);
  expect([...dispatch]).toEqual([]);
  expect(owner.query(slots.capture(), f.meshes)).toBe(dispatch);
  expect(owner.materials()).toBe(accepted);
});

it('updates hidden preparation membership when only preparation intent changes', () => {
  const f = resolvedFixture();
  const owner = new MaterialDispatch(() => f.first);
  const hidden = { ...f.source, authorVisible: false };
  const slots = new SceneSlots();
  const query = (source: RenderableSnapshot) => {
    setSceneRow(slots, 0, { slot: 0, generation: 1, entityKey: 1, snapshot: source });
    owner.bind(0, source);
    owner.prepare(f.meshes);
    expect([...owner.query(slots.capture(), f.meshes)]).toEqual([]);
    return owner.materials();
  };
  expect(query(hidden).get(f.first)).toBeUndefined();
  const retained = query({ ...hidden, pipelinePreparation: [] });
  expect(retained.get(f.first)?.bindings).toBe(0);
  expect(query(hidden).get(f.first)).toBeUndefined();
  expect(retained.get(f.first)?.bindings).toBe(0);
});

it('retains shared hidden preparation materials until the last preparation retires', () => {
  const f = resolvedFixture();
  const owner = new MaterialDispatch(() => f.first);
  const slots = new SceneSlots();
  for (let slot = 0; slot < 2; slot++) {
    const source = {
      ...f.source,
      entityKey: slot + 1,
      authorVisible: false,
      pipelinePreparation: [],
    };
    setSceneRow(slots, slot, {
      slot,
      generation: 1,
      entityKey: slot + 1,
      snapshot: source,
    });
    owner.bind(slot, source);
  }
  owner.prepare(f.meshes);
  owner.query(slots.capture(), f.meshes);
  const retained = owner.materials();
  expect(retained.get(f.first)?.bindings).toBe(0);
  owner.remove(0);
  owner.prepare(f.meshes);
  owner.query(slots.capture(), f.meshes);
  expect(owner.materials().get(f.first)?.bindings).toBe(0);
  owner.adopt(f.first);
  owner.prepare(f.meshes);
  expect(owner.materials().get(f.first)?.bindings).toBe(0);
  owner.remove(1);
  owner.query(slots.capture(), f.meshes);
  expect(owner.materials().get(f.first)).toBeUndefined();
  expect(retained.get(f.first)?.bindings).toBe(0);
});

it('keeps a hidden Mesh default accepted after its last unrelated authored override is released', () => {
  const f = resolvedFixture();
  const owner = new MaterialDispatch(() => f.first);
  const prepared = { ...f.source, authorVisible: false, pipelinePreparation: [] };
  const held = {
    ...f.source,
    entityKey: 2,
    authorVisible: false,
    materialOverrides: captureMaterialOverrides([f.first]),
  };
  const slots = new SceneSlots();
  setSceneRow(slots, 0, { slot: 0, generation: 1, entityKey: 1, snapshot: prepared });
  owner.bind(0, prepared);
  owner.bind(1, held);
  owner.prepare(f.meshes);
  expect(owner.query(slots.capture(), f.meshes).length).toBe(0);
  const retained = owner.materials();
  expect(retained.get(f.first)?.bindings).toBe(0);
  owner.remove(1);
  owner.prepare(f.meshes);
  expect(owner.query(slots.capture(), f.meshes).length).toBe(0);
  expect(owner.materials().get(meshDrawSnapshot(prepared, f.meshes).material)?.bindings).toBe(0);
  owner.remove(0);
  owner.query(slots.capture(), f.meshes);
  expect(owner.materials().get(f.first)).toBeUndefined();
  expect(retained.get(f.first)?.bindings).toBe(0);
});

it('keeps a captured scene slot draw valid across unrelated scene publications and geometry replacement', () => {
  const f = fixture();
  const slots = new SceneSlots();
  setSceneRow(slots, 0, { generation: 1, entityKey: 1, snapshot: f.source });
  const row = slots.get(0);
  if (row === undefined) throw new Error('Missing admitted row');
  const first = slotDrawSnapshot(row, f.frame);
  expect(meshDrawSnapshot(row.snapshot, f.frame, row)).toBe(first);
  expect(meshDrawSnapshot(first, f.frame, row)).toBe(first);
  const overlay = meshDrawSnapshot({ ...row.snapshot, layer: 13 }, f.frame, row);
  expect(overlay.layer).toBe(13);
  expect(overlay).not.toBe(first);
  for (let i = 0; i < 4; i++) {
    meshDrawSnapshot({ ...f.source, entityKey: 2 }, f.frame);
  }
  expect(slotDrawSnapshot(row, f.frame)).toBe(first);
  const replacement = f.frame.with(7, createBoxGeometry(3, 3, 3).unwrap());
  const changed = slotDrawSnapshot(row, replacement);
  expect(changed).not.toBe(first);
  expect(changed.localAabb).not.toEqual(first.localAabb);
  expect(first.transform).toBe(changed.transform);
});

it('binds shared draw contents once per mesh frame across changing poses and fenced writes', () => {
  const f = resolvedFixture();
  const slots = new SceneSlots();
  const mesh = f.meshes.get(7);
  assert(mesh);
  const lookup = vi.spyOn(f.meshes, 'get');
  const { entityKey, transform, ...content } = f.source;
  const pose = transform.world.slice();
  for (let i = 0; i < 8; i++)
    slots.write(i, { entityKey: entityKey + i, generation: 1, content, pose });
  const draw = (i: number) => {
    pose[12] = i;
    return slotDrawSnapshot(slots.writePose(i % 8, pose), f.meshes);
  };
  const first = draw(0);
  const pending: MeshMaterialBindingWrite[] = [];
  const replacement = new MaterialResource(defaultMaterialSnapshot(47));
  prepareMeshMaterialBindings(f.source, mesh, 'mesh', () => replacement, pending);
  expect(draw(1).material).toBe(first.material);
  for (const write of pending) write.contexts[write.geometry] = write.value;
  for (let i = 0; i < 64; i++) {
    const current = draw(i);
    expect(current.material).toBe(replacement);
    expect(current.transform.world[12]).toBe(i);
    const slot = slots.get(i % 8);
    assert(slot);
    expect(slotDrawMaterials(slot, f.meshes).materials).toBe(current.materials);
  }
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(first.material).toBe(f.first);
  const row = slots.get(5);
  assert(row);
  const removed = f.meshes.without(7);
  expect(slotDrawSnapshot(row, removed)).toBe(row.snapshot);
  expect(slotDrawSnapshot(row, f.meshes).material).toBe(replacement);
});

it('reads issued draws without re-registering their instances each frame', () => {
  const f = fixture();
  const slots = new SceneSlots();
  const sources = Array.from({ length: 128 }, (_, entityKey) =>
    writeSlot(slots, entityKey, { ...f.source, entityKey }),
  );
  const held = sources.map((source) => slotDrawSnapshot(source, f.frame));
  const set = WeakMap.prototype.set;
  const get = WeakMap.prototype.get;
  let reads = 0;
  let writes = 0;
  WeakMap.prototype.get = function (key: object) {
    reads++;
    return get.call(this, key);
  };
  WeakMap.prototype.set = function (key: object, value: unknown) {
    writes++;
    return set.call(this, key, value);
  };
  let current: RenderableSnapshot[];
  try {
    current = sources.map((source) => slotDrawSnapshot(source, f.frame));
  } finally {
    WeakMap.prototype.set = set;
    WeakMap.prototype.get = get;
  }
  expect(current.every((draw, index) => draw === held[index])).toBe(true);
  expect(writes).toBeLessThanOrEqual(4);
  expect(reads).toBeLessThanOrEqual(sources.length * 2 + 4);
});

it('releases removed draw rows while retained observations survive and reused addresses issue fresh draws', () => {
  const f = fixture();
  const slots = new SceneSlots();
  const held = Array.from({ length: 128 }, (_, entityKey) =>
    slotDrawSnapshot(writeSlot(slots, entityKey, { ...f.source, entityKey }), f.frame),
  );
  const first = slots.get(0);
  assert(first);
  for (let address = 1; address < 128; address++) slots.remove(address);
  expect(slots.get(127)).toBeUndefined();
  expect(slotDrawSnapshot(first, f.frame)).toBe(held[0]);
  const replacement = writeSlot(slots, 127, { ...f.source, entityKey: 300 });
  expect(slotDrawSnapshot(replacement, f.frame)).not.toBe(held[127]);
  expect(held[127]?.entityKey).toBe(127);
  expect(slotDrawSnapshot(replacement, f.frame).entityKey).toBe(300);
});

it('amortizes sparse source replacement without retaining an ever-growing table', () => {
  const f = fixture();
  const slots = new SceneSlots();
  const sources = Array.from({ length: 64 }, (_, entityKey) =>
    writeSlot(slots, entityKey, { ...f.source, entityKey }),
  );
  const held = sources.map((source) => slotDrawSnapshot(source, f.frame));
  const set = WeakMap.prototype.set;
  let writes = 0;
  const frames = 400;
  WeakMap.prototype.set = function (key: object, value: unknown) {
    writes++;
    return set.call(this, key, value);
  };
  try {
    for (let frame = 0; frame < frames; frame++) {
      sources[0] = writeSlot(slots, 0, { ...f.source, entityKey: frame + 64 });
      for (const source of sources) slotDrawSnapshot(source, f.frame);
    }
  } finally {
    WeakMap.prototype.set = set;
  }
  expect(writes).toBeLessThanOrEqual(frames * 4 + sources.length);
  expect(slotDrawSnapshot(sources[1] as SceneDrawSlot, f.frame)).toBe(held[1]);
  expect(held[0]?.entityKey).toBe(0);
  expect(slotDrawSnapshot(sources[0] as SceneDrawSlot, f.frame).entityKey).toBe(frames + 63);
});

it('updates an already-read Mesh binding address when a bounds-only version adopts its table', () => {
  const f = resolvedFixture();
  const mesh = f.meshes.get(7);
  assert(mesh);
  const previous = meshDrawSnapshot(f.source, f.meshes);
  const next = f.meshes.with(
    7,
    {
      ...f.mesh,
      aabb: new Float32Array([-2, -2, -2, 2, 2, 2]),
      materialSlots: mesh.materialSlots,
    },
    mesh.materials,
  );
  const nextMesh = next.get(7);
  assert(nextMesh);
  const slot = writeSlot(new SceneSlots(), 0, f.source);
  const ownedBefore = slotDrawSnapshot(slot, next);
  const held = meshDrawSnapshot(f.source, next);
  expect(held.material).toBe(f.first);
  expect(held.materials).not.toBe(previous.materials);
  retainMeshMaterialBindings(mesh, nextMesh);
  const adopted = meshDrawSnapshot(f.source, next);
  const ownedAfter = slotDrawSnapshot(slot, next);
  expect(ownedBefore.materials).toBe(held.materials);
  expect(ownedAfter.materials).toBe(previous.materials);
  expect(adopted.materials).toBe(previous.materials);
  expect(adopted).not.toBe(held);
  expect(held.material).toBe(f.first);
  expect(held.localAabb).toBe(nextMesh.bounds);
});

it('reads live fenced material contexts without caching their values or repeating raw source reads', () => {
  const f = resolvedFixture();
  const mesh = f.meshes.get(7);
  assert(mesh);
  const skin = new MaterialResource(defaultMaterialSnapshot(45));
  const replacement = new MaterialResource(defaultMaterialSnapshot(46));
  const pending: MeshMaterialBindingWrite[] = [];
  prepareMeshMaterialBindings(f.source, mesh, 'skinned', () => skin, pending);
  for (const write of pending) write.contexts[write.geometry] = write.value;
  pending.length = 0;
  let reads = 0;
  const source = {
    ...f.source,
    get materialOverrides() {
      reads++;
      return f.source.materialOverrides;
    },
  };
  expect(effectiveMeshMaterials(source, mesh, 'mesh').material).toBe(f.first);
  expect(effectiveMeshMaterials(source, mesh, 'skinned').material).toBe(skin);
  expect(reads).toBe(2);
  prepareMeshMaterialBindings(f.source, mesh, 'mesh', () => replacement, pending);
  expect(effectiveMeshMaterials(source, mesh, 'mesh').material).toBe(f.first);
  for (const write of pending) write.contexts[write.geometry] = write.value;
  expect(effectiveMeshMaterials(source, mesh, 'mesh').material).toBe(replacement);
  expect(effectiveMeshMaterials(source, mesh, 'skinned').material).toBe(skin);
  expect(reads).toBe(5);
});

it('reads changed poses and mesh draws without expanding authored fields until a public slot asks', () => {
  const f = fixture();
  const slots = new SceneSlots();
  setSceneRow(slots, 0, { generation: 1, entityKey: 1, snapshot: f.source });
  const authored = vi.spyOn(SceneDrawSlot.prototype, 'authoredSnapshot');
  try {
    const held = slots.capture().slotAt(0);
    assert(held);
    const pose = new Float32Array(f.source.transform.world);
    const first = slotDrawSnapshot(held, f.frame);
    let previous = held;
    for (let tick = 1; tick <= 100; tick++) {
      pose[12] = tick;
      const current = slots.writePose(0, pose);
      const draw = slotDrawSnapshot(current, f.frame);
      expect(draw.transform.world[12]).toBe(tick);
      const temporal = createTemporalSnapshot(current, previous, true, false);
      expect(temporal.motionValid).toBe(true);
      expect(temporal.previousTransform.world[12]).toBe(tick - 1);
      previous = current;
      slots.capture();
    }
    expect(authored).not.toHaveBeenCalled();
    expect(first.transform.world[12]).toBe(0);
    expect(Object.keys(held)).toEqual(
      expect.arrayContaining(['slot', 'entityKey', 'generation', 'version', 'snapshot']),
    );
    const publicRow = { ...held };
    expect(authored).toHaveBeenCalledTimes(1);
    expect(publicRow.snapshot).toBe(held.snapshot);
    expect(publicRow.snapshot.transform).toBe(first.transform);
    expect(publicRow.snapshot.materialOverrides).toBe(f.source.materialOverrides);
  } finally {
    authored.mockRestore();
  }
});
