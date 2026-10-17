import { beforeAll, expect, it } from 'vitest';
import R from '../pkg/rapier.mjs';
import fixtures from './fixtures/voxel-contact.json';

beforeAll(async () => { await R.init(); });
const size = { x: 0.1, y: 0.1, z: 0.1 };
const zero = { x: 0, y: 0, z: 0 };
const identity = { x: 0, y: 0, z: 0, w: 1 };
function coordinates(regions: readonly (readonly number[])[]): Int32Array {
  const values: number[] = [];
  for (const r of regions) for (let z = r[2]!; z < r[5]!; z++)
    for (let y = r[1]!; y < r[4]!; y++) for (let x = r[0]!; x < r[3]!; x++) values.push(x, y, z);
  return Int32Array.from(values);
}
function occupied(shape: { data: ArrayLike<number> }): string[] {
  const cells = new Set<string>();
  for (let i = 0; i < shape.data.length; i += 3) cells.add(`${shape.data[i]},${shape.data[i + 1]},${shape.data[i + 2]}`);
  return [...cells].sort();
}

for (const fixture of fixtures) for (const compact of [false, true]) for (const locked of [false, true]) {
  it(`keeps solver references valid for ${fixture.id}, compact=${compact}, locked=${locked}`, () => {
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const regions = fixture.sourceRegions.map(r => r.map((v, i) => v - fixture.origin[i % 3]!));
    const descriptor = compact
      ? R.ColliderDesc.voxelRegions(Int32Array.from(regions.flat()), size)
      : R.ColliderDesc.voxels(coordinates(regions), size);
    descriptor.setTranslation(...fixture.origin.map(v => v / 10)).setMassProperties(0, zero, zero, identity);
    world.createCollider(descriptor);
    const bodyDescriptor = R.RigidBodyDesc.dynamic().setTranslation(...fixture.center).setCanSleep(false);
    if (locked) bodyDescriptor.enabledTranslations(false, true, false);
    const body = world.createRigidBody(bodyDescriptor);
    world.createCollider(R.ColliderDesc.ball(0.15), body);
    // Baseline traps on step 3, 37 or 43. A trap must fail, never be caught and continued.
    for (let step = 0; step < 240; step++) {
      world.step();
      expect(Object.values(body.translation()).every(Number.isFinite)).toBe(true);
    }
    world.free();
  });
}

it('builds the region union, preserves negative coordinates and applies atomic validated batches', () => {
  const world = new R.World(zero);
  const regions = [[-9, -1, -8, 3, 2, 5], [-2, -2, -3, 9, 1, 9], [8, 0, 8, 10, 2, 10]];
  const expected = occupied({ data: coordinates(regions) });
  const collider = world.createCollider(R.ColliderDesc.voxelRegions(Int32Array.from(regions.flat()), size));
  collider.clearShapeCache();
  expect(occupied(collider.shape)).toEqual(expected);
  const cuts = Int32Array.from([-9, -1, -8, -9, -1, -8, 9, 1, 9, 50, 50, 50]);
  expect(collider.setVoxels(cuts, false)).toBe(2);
  expect(occupied(collider.shape)).toEqual(expected.filter(key => !['-9,-1,-8', '9,1,9'].includes(key)));
  expect(() => collider.setVoxels(new Int32Array([0, 0, 0, 1]), false)).toThrow();
  expect(() => collider.setVoxels(new Int32Array([0, 0, 0, 2147483647, 0, 0]), false)).toThrow();
  expect(occupied(collider.shape)).toHaveLength(expected.length - 2);
  expect(collider.setVoxels(cuts.subarray(0, 9), true)).toBe(2);
  expect(occupied(collider.shape)).toEqual(expected);
  const restored = R.World.restoreSnapshot(world.takeSnapshot());
  expect(occupied(restored.getCollider(collider.handle).shape)).toEqual(expected);
  restored.free(); world.free();
});

it('rejects invalid compact regions without leaking the world or partially publishing a collider', () => {
  const world = new R.World(zero);
  for (const regions of [[0, 0, 0, 0, 1, 1], [2, 0, 0, 1, 1, 1], [0, 0, 0, 2147483647, 1, 1]]) {
    expect(() => world.createCollider(R.ColliderDesc.voxelRegions(Int32Array.from(regions), size))).toThrow();
  }
  expect(() => world.createCollider(R.ColliderDesc.voxelRegions(new Int32Array([0, 0, 0, 1, 1, 1]), zero))).toThrow();
  expect(world.colliders.len()).toBe(0);
  world.step(); world.free();
});

it('keeps dynamic empty/refill mass finite and updates collision after edits', () => {
  const world = new R.World(zero);
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic());
  const collider = world.createCollider(R.ColliderDesc.voxelRegions(new Int32Array([0, 0, 0, 2, 1, 1]), size).setDensity(1000), body);
  world.step();
  expect(body.mass()).toBeCloseTo(2, 4);
  expect(collider.setVoxels(new Int32Array([0, 0, 0]), false)).toBe(1);
  world.step();
  expect(body.mass()).toBeCloseTo(1, 4);
  expect(body.localCom().x).toBeCloseTo(0.15, 5);
  expect(collider.containsPoint({ x: 0.05, y: 0.05, z: 0.05 })).toBe(false);
  expect(collider.setVoxels(new Int32Array([1, 0, 0]), false)).toBe(1);
  world.step();
  expect(body.mass()).toBe(0);
  expect(Object.values(body.localCom()).every(Number.isFinite)).toBe(true);
  expect(collider.setVoxels(new Int32Array([-1, 0, 0]), true)).toBe(1);
  world.step();
  expect(body.mass()).toBeCloseTo(1, 4);
  expect(body.localCom().x).toBeCloseTo(-0.05, 5);
  world.free();
});

it('deduplicates XYZ inputs so deleting the final cell actually retires its chunk', () => {
  const world = new R.World(zero);
  const collider = world.createCollider(R.ColliderDesc.voxels(new Int32Array([0, 0, 0, 0, 0, 0]), size));
  expect(collider.setVoxels(new Int32Array([0, 0, 0]), false)).toBe(1);
  expect(occupied(collider.shape)).toEqual([]);
  expect(collider.setVoxels(new Int32Array([8, 0, 0]), true)).toBe(1);
  expect(occupied(collider.shape)).toEqual(['8,0,0']);
  world.step(); world.free();
});

it.each(['ball','capsule','cuboid','cylinder'] as const)('keeps %s contact stable while support is repeatedly edited and removed', kind => {
  const world=new R.World({x:0,y:-9.81,z:0});
  try {
    world.createCollider(R.ColliderDesc.cuboid(4,.1,4).setTranslation(0,-2.1,0));
    const floor=world.createCollider(R.ColliderDesc.voxelRegions(new Int32Array([-16,-2,-16,16,0,16]),size).setMassProperties(0,zero,zero,identity));
    const body=world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(.05,1,.05).setCanSleep(false).setCcdEnabled(true));
    const shape=kind==='ball'?R.ColliderDesc.ball(.15):kind==='capsule'?R.ColliderDesc.capsule(.2,.15):kind==='cylinder'?R.ColliderDesc.cylinder(.2,.15):R.ColliderDesc.cuboid(.15,.2,.15);
    world.createCollider(shape,body);
    for(let step=0;step<120;step++)world.step();
    expect(body.translation().y).toBeGreaterThan(.1);
    expect(body.translation().y).toBeLessThan(.4);
    for(let step=0;step<60;step++){
      const edits=Int32Array.from([8, -1, 8, -9, -1, -9]);
      expect(floor.setVoxels(edits,step%2!==0)).toBe(2);
      world.step();expect(Object.values(body.translation()).every(Number.isFinite)).toBe(true);
    }
    const hole=coordinates([[-6,-2,-6,6,0,6]]);
    expect(floor.setVoxels(hole,false)).toBe(288);
    for(let step=0;step<180;step++)world.step();
    expect(body.translation().y).toBeGreaterThan(-1.9);
    expect(body.translation().y).toBeLessThan(-1.5);
    expect(Object.values(body.linvel()).every(Number.isFinite)).toBe(true);
  } finally {world.free();}
});

it('stops a CCD projectile at a rotated thin voxel wall',()=>{
  const world=new R.World(zero);
  try {
    const angle=.37,q={x:0,y:Math.sin(angle/2),z:0,w:Math.cos(angle/2)};
    world.createCollider(R.ColliderDesc.voxelRegions(new Int32Array([-12,-12,0,12,12,1]),size).setRotation(q));
    const direction={x:Math.sin(angle),y:0,z:Math.cos(angle)};
    const body=world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(-direction.x*2,0,-direction.z*2).setLinvel(direction.x*300,0,direction.z*300).setCcdEnabled(true));
    world.createCollider(R.ColliderDesc.ball(.05).setRestitution(0),body);
    for(let i=0;i<10;i++)world.step();
    const p=body.translation();expect(Object.values(p).every(Number.isFinite)).toBe(true);
    expect(p.x*direction.x+p.z*direction.z).toBeLessThan(.1);
  } finally {world.free();}
});
