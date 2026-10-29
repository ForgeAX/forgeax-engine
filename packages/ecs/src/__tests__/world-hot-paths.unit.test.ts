import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { BufferPool } from '../buffer-pool';
import { defineComponent } from '../component';
import { World } from '../world';
import { worldInternal } from '../world-internal';

const Pose = defineComponent('HotPathPose', { world: 'array<f32, 16>' });
const Flags = defineComponent('HotPathFlags', { bits: 'u32', on: 'bool', target: 'entity' });
const Materials = defineComponent('HotPathMaterials', { handles: 'array<u32>' });
const Residual = defineComponent('HotPathResidual', {}, { storage: 'sparse' });

describe('World hot paths', () => {
  it('writes plain scalar components with stored-value change detection', () => {
    const world = new World();
    const target = world.spawn().unwrap();
    const entity = world.spawn({ component: Flags, data: { bits: 1 } }).unwrap();
    const changed = world.query({ read: [Flags], changed: [Flags] }).unwrap();
    Array.from(changed);
    world.set(entity, Flags, { bits: 1, on: false, target: null }).unwrap();
    expect(Array.from(changed)).toEqual([]);
    world.set(entity, Flags, { on: true, target }).unwrap();
    expect(Array.from(changed, (row) => row.entity)).toEqual([entity]);
    expect(world.get(entity, Flags).unwrap()).toEqual({ bits: 1, on: true, target });
    const nan = world.set(entity, Flags, { bits: 2, on: false, target: null, extra: 1 } as never);
    expect(nan.ok).toBe(true);
    const rejected = world.set(entity, Flags, { bits: Number.NaN, on: true });
    expect(!rejected.ok && rejected.error.code).toBe('component-numeric-value-invalid');
    expect(world.get(entity, Flags).unwrap()).toEqual({ bits: 2, on: false, target: null });
  });

  it('memoizes spawn rosters independently of order and keeps duplicates canonical', () => {
    const world = new World();
    const a = world
      .spawn({ component: Flags, data: { bits: 1 } }, { component: Pose, data: {} })
      .unwrap();
    const b = world
      .spawn({ component: Pose, data: {} }, { component: Flags, data: { bits: 2 } })
      .unwrap();
    const archetypeOf = (entity: typeof a) => world[worldInternal].getEntityArchetype(entity);
    expect(archetypeOf(a)).toBe(archetypeOf(b));
    const single = world.spawn({ component: Pose, data: {} }).unwrap();
    expect(archetypeOf(single)).not.toBe(archetypeOf(a));
    expect(
      world
        .componentsOf(single)
        .unwrap()
        .map((component) => component.name),
    ).toEqual(['Entity', 'HotPathPose']);
  });

  it('flips sparse tags and churns entities through reused change-index storage', () => {
    const world = new World();
    const entities = Array.from({ length: 256 }, () =>
      world.spawn({ component: Flags, data: { bits: 1 } }).unwrap(),
    );
    const residual = world.query({ read: [Flags], with: [Residual] }).unwrap();
    const added = world.query({ read: [Flags], added: [Residual] }).unwrap();
    for (let round = 0; round < 4; round += 1) {
      for (const entity of entities)
        world.addComponent(entity, { component: Residual, data: {} }).unwrap();
      expect(Array.from(added).length).toBe(entities.length);
      expect(Array.from(residual).length).toBe(entities.length);
      for (const entity of entities) world.removeComponent(entity, Residual).unwrap();
      expect(Array.from(residual).length).toBe(0);
    }
    for (let index = 0; index < entities.length; index += 1) {
      world.despawn(entities[index] as (typeof entities)[number]).unwrap();
      entities[index] = world.spawn({ component: Flags, data: { bits: index } }).unwrap();
    }
    const changed = world.query({ read: [Flags], changed: [Flags] }).unwrap();
    expect(Array.from(changed).length).toBe(entities.length);
  });

  it('packs small managed arrays into shared chunk cells and moves them on growth', () => {
    const pool = new BufferPool();
    const a = pool.alloc(8).unwrap();
    const b = pool.alloc(8).unwrap();
    expect(a.view.buffer).toBe(b.view.buffer);
    expect(b.view.byteOffset - a.view.byteOffset).toBe(16);
    a.view.fill(5);
    const grown = pool.grow(a.id, 40).unwrap();
    // 40 bytes leave the 16-byte class: the bytes move to a 64-byte cell.
    expect(grown.buffer).not.toBe(a.view.buffer);
    expect([...grown.subarray(0, 8)]).toEqual(Array(8).fill(5));
    expect(pool.byteCapacity(a.id)).toBe(64);
    // The abandoned 16-byte cell is zeroed and reused by the next small slot.
    const c = pool.alloc(16).unwrap();
    expect(c.view.byteOffset).toBe(a.view.byteOffset);
    expect([...c.view]).toEqual(Array(16).fill(0));
    expect(b.view.every((byte) => byte === 0)).toBe(true);
    const world = new World();
    const entity = world.spawn({ component: Materials, data: { handles: [3, 4] } }).unwrap();
    world.set(entity, Materials, { handles: [1, 2, 3, 4, 5, 6, 7, 8] }).unwrap();
    expect(Array.from(world.get(entity, Materials).unwrap().handles)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('returns one shared success value for void results', () => {
    expect(ok(undefined)).toBe(ok(undefined));
    expect(Object.isFrozen(ok(undefined))).toBe(true);
    expect(ok(undefined).unwrap()).toBeUndefined();
  });
});
