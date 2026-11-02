import { expect, it } from 'vitest';
import { applyPoint, invertRigid } from '../affine';
import { extractFaces } from '../boolean';
import { exportMesh } from '../finish';
import { model } from '../model';
import { recipes } from '../recipes';
import { rig } from '../rig';
import { sel } from '../selectors';

it('part meshes export exactly like the whole session with the other faces removed', () => {
  const m = model();
  const h = recipes.hinge({
    length: 0.24,
    leafWidth: 0.06,
    thickness: 0.006,
    pin: 0.012,
    knuckles: 5,
    holes: 2,
    name: 'fh',
  });
  if (!h.ok) throw h.error;
  m.append(h.value.model, { tag: 'fh' });
  m.box({ size: [0.2, 0.1, 0.1], center: [0.3, 0, 0], label: 'blk', material: 'paint' });
  m.uv.project({ mode: 'box', scale: 0.1 });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      {
        name: 'b',
        parent: 'root',
        position: [0, 0, 0],
        kind: 'revolute',
        axis: 'y',
        rotation: { z: 30 },
      },
    ],
  });
  r.bindRigid(sel.all(), 'root', { part: 'base' });
  r.bindRigid(sel.tag('fh-b'), 'b', { part: 'leaf' });
  const parts = r._resolve().unwrap();
  for (const part of parts) {
    const mat = invertRigid(r.joints[part.joint]?.rest as number[]);
    const old = m.editMesh.clone();
    const keep = new Set(part.faces);
    for (const f of old.faces()) if (!keep.has(f)) old.removeFace(f);
    const a = old.compact().mesh;
    for (const v of a.vertices()) a.setPosition(v, ...applyPoint(mat, a.position(v)));
    const b = extractFaces(m.editMesh, part.faces).compact().mesh;
    for (const v of b.vertices()) b.setPosition(v, ...applyPoint(mat, b.position(v)));
    const ea = exportMesh(a, {});
    const eb = exportMesh(b, {});
    if (!ea.ok || !eb.ok) throw new Error('export');
    expect(Array.from(eb.value.mesh.indices as Uint16Array)).toEqual(
      Array.from(ea.value.mesh.indices as Uint16Array),
    );
    for (const k of Object.keys(ea.value.mesh.attributes))
      expect(
        Array.from((eb.value.mesh.attributes as Record<string, Float32Array>)[k] as Float32Array),
      ).toEqual(
        Array.from((ea.value.mesh.attributes as Record<string, Float32Array>)[k] as Float32Array),
      );
    expect(eb.value.mesh.materialSlots).toEqual(ea.value.mesh.materialSlots);
  }
});
