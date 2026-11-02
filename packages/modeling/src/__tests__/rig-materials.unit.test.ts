import { PackageId } from '@forgeax/engine-pack/guid';
import { AssetGuid } from '@forgeax/engine-pack/source';
import type { MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

const PACKAGE = PackageId.parse('01900000-0000-7000-8000-0000000c0412');
if (!PACKAGE.ok) throw new Error('package id');
const packageId = PACKAGE.value;
const guid = (k: string) => AssetGuid.format(AssetGuid.derive(packageId, k));

function arm() {
  const m = model();
  m.box({ size: [0.2, 0.1, 0.1], center: [0, 0, 0], label: 'blk', material: 'paint' });
  m.box({ size: [0.1, 0.1, 0.1], center: [0, 0.2, 0], label: 'cap', material: 'steel' });
  m.box({ size: [0.2, 0.1, 0.1], center: [0.3, 0, 0], label: 'leaf', material: 'steel' });
  m.uv.project({ mode: 'box', scale: 0.1 });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'b', parent: 'root', position: [0.2, 0, 0], kind: 'revolute', axis: 'y' },
    ],
  });
  r.bindRigid(sel.inBox([-1, -1, -1], [0.15, 1, 1], { by: 'all' }), 'root', { part: 'base' });
  r.bindRigid(sel.inBox([0.15, -1, -1], [1, 1, 1], { by: 'all' }), 'b', { part: 'leaf' });
  return r;
}

const MATERIALS = { paint: 'material/arm-paint', steel: 'material/arm-steel' };

const bound = (scene: SceneAsset, entity: string) =>
  (scene.entities[entity]?.components.MeshRenderer as { materials: string[] }).materials;
const expected = (mesh: MeshAsset) =>
  mesh.materialSlots.map((s) => guid(MATERIALS[s.slotName as keyof typeof MATERIALS]));

describe('rig.finish binds Pack materials per mesh slot', () => {
  it('rigid form: every part entity wears its mesh slots in slot order', () => {
    const out = arm().finish({ key: 'arm', packageId, materials: MATERIALS });
    if (!out.ok) throw out.error;
    const scene = out.value['scene/arm'] as SceneAsset;
    for (const part of ['base', 'leaf']) {
      const mesh = out.value[`mesh/arm.${part}`] as MeshAsset;
      expect(bound(scene, `part.${part}`)).toEqual(expected(mesh));
    }
    const base = out.value['mesh/arm.base'] as MeshAsset;
    expect(base.materialSlots.map((s) => s.slotName).sort()).toEqual(['paint', 'steel']);
    expect(bound(scene, 'part.base')).toHaveLength(2);
    expect(bound(scene, 'part.leaf')).toEqual([guid('material/arm-steel')]);
  });

  it('skinned form: the skinned mesh entity wears every slot in slot order', () => {
    const out = arm().finish({ key: 'arm', packageId, form: 'skinned', materials: MATERIALS });
    if (!out.ok) throw out.error;
    const scene = out.value['scene/arm'] as SceneAsset;
    const mesh = out.value['mesh/arm'] as MeshAsset;
    expect(mesh.materialSlots).toHaveLength(2);
    expect(bound(scene, 'mesh')).toEqual(expected(mesh));
  });

  it('names the slots that have no material instead of exporting a short list', () => {
    const out = arm().finish({ key: 'arm', packageId, materials: { paint: 'material/arm-paint' } });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('model-invalid-argument');
      expect(out.error.detail).toMatchObject({ slots: ['steel'] });
    }
  });

  it('without a materials option the renderers keep an empty list', () => {
    const rigid = arm().finish({ key: 'arm', packageId });
    if (!rigid.ok) throw rigid.error;
    expect(bound(rigid.value['scene/arm'] as SceneAsset, 'part.base')).toEqual([]);
  });
});
