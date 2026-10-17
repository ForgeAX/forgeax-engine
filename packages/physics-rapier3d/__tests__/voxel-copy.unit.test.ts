import { beforeAll, expect, it } from 'vitest';
import R from '../pkg/rapier.mjs';

beforeAll(async () => { await R.init(); });
const size = {x: 1, y: 1, z: 1}, zero = {x: 0, y: 0, z: 0};
const occupied = (collider: any) => {
  collider.clearShapeCache(); const result = [];
  for (let i = 0, data = collider.shape.data; i < data.length; i += 3) result.push(`${data[i]}/${data[i + 1]}/${data[i + 2]}`);
  return result.sort();
};
it('copies voxel storage without mutating the published source, then survives source retirement', () => {
  const world = new R.World(zero);
  try {
    const original = world.createCollider(R.ColliderDesc.voxelRegions(new Int32Array([-9,0,0,9,1,1]), size));
    const before = occupied(original);
    const copy = world.createColliderFromVoxelEdits(R.ColliderDesc.ball(1).setEnabled(false).setDensity(0), original,
      new Int32Array([-8,0,0,0,0,0]), new Int32Array([9,0,0]));
    expect(occupied(original)).toEqual(before);
    const expected = [...before.filter(c => c !== '-8/0/0' && c !== '0/0/0'), '9/0/0'].sort();
    expect(occupied(copy)).toEqual(expected);
    expect(copy.isEnabled()).toBe(false); expect(copy.mass()).toBe(0);
    world.removeCollider(original, false); copy.setEnabled(true); world.step();
    expect(occupied(copy)).toEqual(expected);
    const restored = R.World.restoreSnapshot(world.takeSnapshot());
    try { expect(occupied(restored.getCollider(copy.handle))).toEqual(expected); } finally { restored.free(); }
  } finally { world.free(); }
});
it('rejects invalid, foreign and retired copy sources before publishing native allocations', () => {
  const world = new R.World(zero), other = new R.World(zero);
  try {
    const desc = () => R.ColliderDesc.voxelRegions(new Int32Array([0,0,0,1,1,1]), size);
    const source = world.createCollider(desc()), foreign = other.createCollider(desc()), empty = new Int32Array();
    expect(() => world.createColliderFromVoxelEdits(desc(), foreign, empty, empty)).toThrow();
    expect(() => world.createColliderFromVoxelEdits(desc(), source, new Int32Array([0]), empty)).toThrow();
    expect(world.colliders.len()).toBe(1); expect(occupied(source)).toEqual(['0/0/0']);
    world.removeCollider(source, false);
    expect(() => world.createColliderFromVoxelEdits(desc(), source, empty, empty)).toThrow();
    expect(world.colliders.len()).toBe(0);
  } finally { world.free(); other.free(); }
});

for (const x of [-2,1]) it(`deletes and refills the complete chunk at ${x} without corrupting a tiny BVH`, () => {
  const world = new R.World(zero);
  try {
    const source=world.createCollider(R.ColliderDesc.voxelRegions(new Int32Array([-2,0,-1,-1,1,0,1,0,-1,2,1,0]),size));
    const cells=occupied(source);
    const copy=world.createColliderFromVoxelEdits(R.ColliderDesc.ball(1).setDensity(0),source,new Int32Array([x,0,-1]),new Int32Array());
    expect(occupied(source)).toEqual(cells);expect(occupied(copy)).toEqual(cells.filter(c=>c!==`${x}/0/-1`));
    expect(source.setVoxels(new Int32Array([x,0,-1]),false)).toBe(1);
    expect(occupied(source)).toEqual(occupied(copy));
    expect(copy.setVoxels(new Int32Array([x,0,-1]),true)).toBe(1);expect(occupied(copy)).toEqual(cells);
    world.step();
  } finally {world.free();}
});
