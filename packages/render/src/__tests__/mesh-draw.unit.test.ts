import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { expect, it } from 'vitest';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { meshDrawSnapshot } from '../scene/mesh-draw';
import { MeshFrame } from '../scene/mesh-frame';
import { captureMaterialOverrides } from '../scene/mesh-materials';

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
