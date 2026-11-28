import { describe, expect, it } from 'vitest';
import type { EditMesh } from '../../mesh';
import { model } from '../../model';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import * as exact from '../index';
import { quadrangulate } from '../quad';
import { tessellateSampled } from '../tessellate';
import type { Shape } from '../types';

/** Same Shape with its face roles replaced by index; undefined keeps the built role. */
function withRoles(shape: Shape, roles: readonly (string | undefined)[]): Shape {
  return {
    ...shape,
    faces: shape.faces.map((f, i) => ({ ...f, role: roles[i] ?? f.role })),
  };
}

function mustOk<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

interface MeshFace {
  /** Shape face that produced this mesh face. */
  readonly owner: number;
  readonly slot: number;
  readonly material: string;
  readonly role: string;
}

/** Per mesh face: its owning Shape face, material slot, material name and role name. */
function meshFaces(shape: Shape): { mesh: EditMesh; faces: MeshFace[] } {
  const sampled = mustOk(tessellateSampled(shape));
  const { mesh, owner } = sampled;
  const faces = mesh.faces().map((m) => {
    const slot = mesh.fMaterial[m] as number;
    return {
      owner: owner[m] as number,
      slot,
      material: mesh.materialNames[slot] as string,
      role: mesh.roleNames[mesh.fRole[m] as number] as string,
    };
  });
  return { mesh, faces };
}

function usedSlots(faces: readonly MeshFace[]): number[] {
  return [...new Set(faces.map((f) => f.slot))].sort((a, b) => a - b);
}

const FRAME_B = { o: [1, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const;

describe('B-brep role to material slot (X9)', () => {
  it('one slot per distinct role plus one shared default slot when unassigned faces exist', () => {
    const plate = mustOk(box({ size: [1, 2, 3], label: 'plate' }));
    const { mesh, faces } = meshFaces(withRoles(plate, ['a', 'a', 'b', 'b', 'c', '']));
    expect(usedSlots(faces)).toHaveLength(4);
    expect(new Set(faces.map((f) => f.material))).toEqual(new Set(['a', 'b', 'c', 'Default']));
    const defaults = faces.filter((f) => f.role === '');
    expect(defaults).toHaveLength(1);
    expect(defaults.every((f) => f.slot === 0 && f.material === 'Default')).toBe(true);
    expect(mesh.materialNames[0]).toBe('Default');

    const noDefault = meshFaces(withRoles(plate, ['a', 'a', 'b', 'b', 'c', 'c']));
    expect(usedSlots(noDefault.faces)).toHaveLength(3);
    expect(noDefault.faces.some((f) => f.material === 'Default')).toBe(false);
  });

  it('a non-planar trimmed face takes its role slot like a planar one', () => {
    const post = mustOk(cylinder({ radius: 0.5, height: 2, label: 'post' }));
    const firstPlane = post.faces.findIndex((f) => post.surfaces[f.surface]?.kind === 'plane');
    expect(firstPlane).toBeGreaterThanOrEqual(0);
    const roles = post.faces.map((f, i) => {
      if (i === firstPlane) return '';
      return post.surfaces[f.surface]?.kind === 'cylinder' ? 'wall' : 'cap';
    });
    const { faces } = meshFaces(withRoles(post, roles));
    expect(usedSlots(faces)).toHaveLength(3);
    expect(new Set(faces.map((f) => f.material))).toEqual(new Set(['wall', 'cap', 'Default']));
  });

  it('swapping the roles of two faces swaps their slots and nothing else (falsifier)', () => {
    const plate = mustOk(box({ size: [1, 2, 3], label: 'plate' }));
    // Faces 2 and 3 take roles that already occurred on faces 0 and 1, so first-occurrence order is unchanged.
    const before = meshFaces(withRoles(plate, ['A', 'B', 'A', 'B', 'C', 'D']));
    const after = meshFaces(withRoles(plate, ['A', 'B', 'B', 'A', 'C', 'D']));
    const slotOf = (r: ReturnType<typeof meshFaces>, f: number) =>
      r.faces.filter((x) => x.owner === f).map((x) => x.slot);
    const materialOf = (r: ReturnType<typeof meshFaces>, f: number) =>
      r.faces.filter((x) => x.owner === f).map((x) => x.material);
    expect(slotOf(before, 2)).toEqual([1]);
    expect(slotOf(before, 3)).toEqual([2]);
    expect(slotOf(after, 2)).toEqual([2]);
    expect(slotOf(after, 3)).toEqual([1]);
    expect(materialOf(after, 2)).toEqual(['B']);
    expect(materialOf(after, 3)).toEqual(['A']);
    for (const f of [0, 1, 4, 5]) {
      expect(slotOf(after, f), `face ${f}`).toEqual(slotOf(before, f));
      expect(materialOf(after, f), `face ${f}`).toEqual(materialOf(before, f));
    }
    expect(after.mesh.materialNames).toEqual(before.mesh.materialNames);
  });

  it('the same Shape gives the same slot order on every run', () => {
    const build = (): Shape =>
      withRoles(mustOk(cylinder({ radius: 0.5, height: 2, label: 'post' })), ['wall', 'cap', '']);
    expect(build().faces.length).toBeGreaterThanOrEqual(3);
    const first = meshFaces(build());
    const second = meshFaces(build());
    const again = meshFaces(build());
    expect(second.mesh.materialNames).toEqual(first.mesh.materialNames);
    expect(again.mesh.materialNames).toEqual(first.mesh.materialNames);
    expect(second.faces).toEqual(first.faces);
    expect(again.faces).toEqual(first.faces);
    // Order is first use in face order, with the default at index 0.
    expect(first.mesh.materialNames.slice(0, 3)).toEqual(['Default', 'wall', 'cap']);
  });

  it('roles survive a boolean union and keep their material names', () => {
    const body = mustOk(box({ size: [2, 2, 2], label: 'body', role: 'body' }));
    const boss = mustOk(box({ size: [1, 1, 3], frame: FRAME_B, label: 'boss', role: 'boss' }));
    const union = mustOk(booleanSolids(body, boss, 'union'));
    const roles = new Set(union.faces.map((f) => f.role));
    expect(roles).toEqual(new Set(['body', 'boss']));
    const { mesh, faces } = meshFaces(union);
    expect(mesh.roleNames).toContain('body');
    expect(mesh.roleNames).toContain('boss');
    expect(faces.every((f) => f.material === f.role)).toBe(true);
    expect(usedSlots(faces)).toHaveLength(2);
  });

  it('a Shape role named Default is rejected, because it would share the default slot', () => {
    const plate = mustOk(box({ size: [1, 1, 1], role: 'Default' }));
    const r = tessellateSampled(plate);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
    expect(r.error.detail).toMatchObject({ brep: 'brep-bad-argument' });
  });

  it('the quad path stamps the same slot per role, and rejects a role named Default', () => {
    const plate = mustOk(box({ size: [1, 2, 3], label: 'plate' }));
    const shape = withRoles(plate, ['a', 'a', 'b', 'b', 'c', '']);
    const { mesh, faceRanges } = mustOk(quadrangulate(shape, { size: 0.5 }));
    faceRanges.forEach(([from, to], f) => {
      const role = shape.faces[f]?.role ?? '';
      expect(to).toBeGreaterThan(from);
      for (let m = from; m < to; m++) {
        const slot = mesh.fMaterial[m] as number;
        expect(slot).toBe(mesh.fRole[m]);
        expect(mesh.materialNames[slot]).toBe(role === '' ? 'Default' : role);
      }
    });
    expect(mesh.materialNames).toEqual(['Default', 'a', 'b', 'c']);

    const reserved = quadrangulate(mustOk(box({ size: [1, 1, 1], role: 'Default' })), {
      size: 0.5,
    });
    expect(reserved.ok).toBe(false);
    if (reserved.ok) return;
    expect(reserved.error.detail).toMatchObject({ brep: 'brep-bad-argument' });
  });

  it('export: submeshes split by role and carry the role names as material slot names', () => {
    const m = model({ exact });
    m.brep.box('body', { size: [1, 1, 1], label: 'body', role: 'body' });
    m.brep.cylinder('post', {
      radius: 0.2,
      height: 1,
      frame: { o: [2, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      label: 'post',
      role: 'post',
    });
    m.brep.box('loose', {
      size: [0.5, 0.5, 0.5],
      frame: { o: [-2, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      label: 'loose',
    });
    for (const name of ['body', 'post', 'loose']) m.fromShape(name);
    const out = m.toMesh();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { mesh, sidecar } = out.value;
    const names = mesh.materialSlots.map((s) => s.slotName);
    expect(names).toEqual(['Default', 'body', 'post']);
    expect(mesh.submeshes).toHaveLength(3);
    let triangles = 0;
    for (const sub of mesh.submeshes) {
      const slotName = names[sub.materialSlot] as string;
      for (let i = sub.indexOffset; i < sub.indexOffset + sub.indexCount; i += 3) {
        triangles++;
        const f = sidecar.triangleFace[i / 3] as number;
        const role = sidecar.roleNames[sidecar.faceRole[f] as number] as string;
        expect(role === '' ? 'Default' : role).toBe(slotName);
      }
    }
    expect(triangles).toBeGreaterThan(0);
  });
});
