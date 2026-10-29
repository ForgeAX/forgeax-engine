import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { expect, it } from 'vitest';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { setSceneRow } from '../scene/__tests__/scene-row-writes';
import { MaterialDispatch } from '../scene/material-dispatch';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import { MeshFrame } from '../scene/mesh-frame';
import { captureMaterialOverrides } from '../scene/mesh-materials';
import { SceneSlots } from '../scene/scene-slots';

function fixture() {
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const material = new MaterialResource(defaultMaterialSnapshot());
  const source: RenderableSnapshot = {
    entityKey: 1,
    worldId: 0,
    assetHandle: 7,
    transform: { world: mat4.identity(mat4.create()) },
    material,
    materials: [material],
    materialBindingSources: ['renderer-override'],
    materialOverrides: captureMaterialOverrides([material]),
    gpuDrivenDraws: [],
  };
  return { mesh, material, source, frame: new MeshFrame().with(0, 7, mesh) };
}

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
  expect(result.localAabb).toBe(f.frame.get(0, 7)?.bounds);
  expect(Object.hasOwn(result, 'lods')).toBe(false);
  expect(Object.hasOwn(result, 'lodHysteresis')).toBe(false);
  expect(result.gpuDrivenDraws).toHaveLength(f.mesh.submeshes.length);
  expect(result.material).toBe(f.material);
  expect(source.lods).toEqual([]);
  expect(source.lodHysteresis).toBe(0.25);
  expect([...source.localAabb]).toEqual([-9, -9, -9, 9, 9, 9]);
  const beforeCachedRead = reads;
  const cached = meshDrawSnapshot(source, f.frame);
  expect(reads).toBe(beforeCachedRead);
  expect(cached).toBe(result);
});

it('omits stale optional metadata when the shared Mesh has none', () => {
  const f = fixture();
  const { aabb: _bounds, ...mesh } = f.mesh;
  const frame = new MeshFrame().with(0, 7, mesh);
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

it('keeps optional fields absent when neither source nor shared Mesh supplies them', () => {
  const f = fixture();
  const { aabb: _bounds, ...mesh } = f.mesh;
  const result = meshDrawSnapshot(f.source, new MeshFrame().with(0, 7, mesh));
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
  const frame = f.frame.with(0, 7, mesh);
  const after = meshDrawSnapshot(source, frame);
  expect(after).not.toBe(before);
  expect(after.lods).toBe(frame.get(0, 7)?.lods);
  expect(after.lodHysteresis).toBe(0.1);
  expect(Object.hasOwn(before, 'lods')).toBe(false);
  expect(Object.hasOwn(before, 'lodHysteresis')).toBe(false);
  expect(meshDrawSnapshot(source, f.frame)).toBe(before);
  expect(meshDrawSnapshot(source, frame.with(0, 8, f.mesh))).toBe(after);
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
  expect(meshDrawSnapshot(f.source, f.frame)).toBe(a);
  expect(meshDrawSnapshot(other, f.frame)).toBe(b);
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
  expect(meshDrawSnapshot(f.source, f.frame)).toBe(a);
  expect(meshDrawSnapshot(other, f.frame)).toBe(b);
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
    0,
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
      worldId: 0,
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

it('refreshes a cached draw when Pass admission replaces a material behind the same Mesh handle', () => {
  const f = resolvedFixture();
  const before = meshDrawSnapshot(f.source, f.meshes);
  const previousMaterials = f.owner.materials();
  const previousDispatch = f.query();
  const previousEntries = [...previousDispatch];
  const replacement = f.replace();
  f.bind(1);
  f.query();
  const materials = f.owner.materials();
  expect(materials.get(f.first)).toBeUndefined();
  expect(materials.get(replacement)?.bindings).toBe(2);
  const after = meshDrawSnapshot(f.source, f.meshes);
  expect(materials.get(after.material)).toBeDefined();
  expect(after.material).toBe(replacement);
  expect(after).not.toBe(before);
  expect(meshDrawSnapshot(f.source, f.meshes)).toBe(after);
  expect(before.material).toBe(f.first);
  expect(previousMaterials.get(before.material)?.snapshot).toBe(f.first.snapshot);
  expect(previousMaterials.get(replacement)).toBeUndefined();
  expect([...previousDispatch]).toEqual(previousEntries);
});

it('retains a cached draw through quiet and membership-only Pass queries with unchanged materials', () => {
  const f = resolvedFixture();
  const before = meshDrawSnapshot(f.source, f.meshes);
  f.query();
  expect(meshDrawSnapshot(f.source, f.meshes)).toBe(before);
  f.bind(1);
  f.query();
  expect(meshDrawSnapshot(f.source, f.meshes)).toBe(before);
  f.owner.remove(1);
  f.query();
  expect(meshDrawSnapshot(f.source, f.meshes)).toBe(before);
});

it('keeps rejected material query writes out of the draw cache until a successful retry', () => {
  const f = resolvedFixture();
  const before = meshDrawSnapshot(f.source, f.meshes);
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
  expect(meshDrawSnapshot(f.source, f.meshes)).toBe(before);
  f.query();
  const after = meshDrawSnapshot(f.source, f.meshes);
  expect(after.material).toBe(replacement);
  expect(f.owner.materials().get(after.material)).toBeDefined();
  expect(before.material).toBe(f.first);
});

it('keeps a hidden pipeline preparation draw in the accepted material frame after visible members retire', () => {
  const f = resolvedFixture();
  const prepared = { ...f.source, entityKey: 2, authorVisible: false, pipelinePreparation: [] };
  const slots = new SceneSlots();
  setSceneRow(slots, 1, { slot: 1, generation: 1, worldId: 0, entityKey: 2, snapshot: prepared });
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
  setSceneRow(slots, 0, { slot: 0, generation: 1, worldId: 0, entityKey: 1, snapshot: source });
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
    setSceneRow(slots, 0, { slot: 0, generation: 1, worldId: 0, entityKey: 1, snapshot: source });
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
      worldId: 0,
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
  setSceneRow(slots, 0, { slot: 0, generation: 1, worldId: 0, entityKey: 1, snapshot: prepared });
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
