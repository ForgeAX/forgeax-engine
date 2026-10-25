import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { MaterialFrame } from '../material-dispatch';
import { MeshFrame } from '../mesh-frame';
import type { RowContent } from '../row-contents';
import { type ProjectedRows, RowProjection } from '../row-projection';
import { SceneSlots } from '../scene-slots';

const material = (red: number) =>
  new MaterialResource({
    passes: [],
    baseColor: vec3.create(red, 0, 0),
    metallic: 0,
    roughness: 1,
  });

function scene(count: number) {
  const a = material(1),
    b = material(0.5);
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const slots = new SceneSlots();
  const content = (handle: number, resource: MaterialResource): RowContent =>
    ({ assetHandle: handle, material: resource, materials: [resource] }) as unknown as RowContent;
  for (let entity = 0; entity < count; entity++)
    slots.write(entity, {
      worldId: 0,
      entityKey: entity,
      generation: 1,
      content: entity % 2 === 0 ? content(7, a) : content(8, b),
      pose: mat4.identity(mat4.create()),
    });
  const identity = {};
  let meshes = new MeshFrame().with(0, 7, mesh).with(0, 8, mesh);
  let materials = new MaterialFrame(undefined).with(a).with(b);
  const rows = (): ProjectedRows => ({ identity, slots: slots.capture(), meshes, materials });
  return {
    slots,
    rows,
    a,
    editMesh: (handle: number) => {
      meshes = meshes.with(0, handle, createBoxGeometry(2, 2, 2).unwrap());
    },
    editMaterial: (resource: MaterialResource) => {
      resource.adopt({ ...resource.snapshot, roughness: 0.25 });
      materials = materials.with(resource);
    },
  };
}

describe('RowProjection', () => {
  it('re-projects only the D changed rows of a steady scene', () => {
    const N = 4096;
    const s = scene(N);
    const projection = new RowProjection((slot) => slot.snapshot.transform.world[12]);
    const cold = projection.sync(s.rows());
    expect(cold.cold).toBe(true);
    expect(projection.visits).toBe(N);
    expect(projection.sync(s.rows()).changed).toEqual([]);
    expect(projection.visits).toBe(N);

    const D = 8;
    for (let index = 0; index < D; index++) {
      const pose = mat4.identity(mat4.create());
      pose[12] = index + 1;
      s.slots.writePose(index * 97, pose);
    }
    const frame = projection.sync(s.rows());
    expect(frame.cold).toBe(false);
    expect([...frame.changed].sort((a, b) => a - b)).toEqual(
      Array.from({ length: D }, (_, index) => index * 97),
    );
    expect(projection.visits - N).toBe(D);
    expect(projection.get(97)).toBe(2);
    expect(projection.size).toBe(N);
  });

  it('follows Mesh and Material evidence only to their reader rows', () => {
    const N = 1000;
    const s = scene(N);
    const projection = new RowProjection((slot) => slot.slot);
    projection.sync(s.rows());
    s.editMesh(8);
    expect(projection.sync(s.rows()).changed.length).toBe(N / 2);
    s.editMaterial(s.a);
    expect(projection.sync(s.rows()).changed.length).toBe(N / 2);
    expect(projection.visits).toBe(2 * N);
  });

  it('keeps reverse indices exact across rebinding, removal and slot reuse', () => {
    const N = 64;
    const s = scene(N);
    const projection = new RowProjection((slot) => slot.snapshot.material);
    projection.sync(s.rows());
    const b = s.slots.capture().slotAt(1)?.snapshot.material;
    if (b === undefined) throw new Error('missing material b');
    // Row 0 leaves material a for b: a later edit of a no longer reaches it.
    s.slots.write(0, {
      worldId: 0,
      entityKey: 0,
      generation: 1,
      content: { assetHandle: 8, material: b, materials: [b] } as unknown as RowContent,
      pose: mat4.identity(mat4.create()),
    });
    expect(projection.sync(s.rows()).changed).toEqual([0]);
    s.editMaterial(s.a);
    expect(projection.sync(s.rows()).changed.length).toBe(N / 2 - 1);
    // Removed rows leave every index; a reused slot reads only its new content.
    s.slots.remove(2);
    projection.sync(s.rows());
    s.editMaterial(s.a);
    expect(projection.sync(s.rows()).changed.length).toBe(N / 2 - 2);
    expect(projection.visits).toBe(N + 1 + (N / 2 - 1) + 1 + (N / 2 - 2));
  });

  it('removes left rows and admits entered rows', () => {
    const s = scene(16);
    const projection = new RowProjection((slot) => slot.entityKey);
    projection.sync(s.rows());
    s.slots.remove(3);
    expect(projection.sync(s.rows()).changed).toEqual([3]);
    expect(projection.get(3)).toBeUndefined();
    expect(projection.size).toBe(15);
  });

  it('recovers by clearing derived entries and re-projecting every source row', () => {
    const s = scene(64);
    const projection = new RowProjection((slot) => ({ entity: slot.entityKey }));
    projection.sync(s.rows());
    const before = [...projection.entries()].sort(([a], [b]) => a - b);
    projection.reset();
    expect(projection.size).toBe(0);
    const recovered = projection.sync(s.rows());
    expect(recovered.cold).toBe(true);
    expect([...projection.entries()].sort(([a], [b]) => a - b)).toEqual(before);
  });
});
