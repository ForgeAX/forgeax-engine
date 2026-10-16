import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { getDerivedWriter } from '@forgeax/engine-ecs/internal';
import { describe, expect, it } from 'vitest';
import { GlobalTransform, Transform } from '../index';

describe('C flat propagation derived writer contract', () => {
  it('writes a contiguous GlobalTransform range while keeping authored local values separate', () => {
    const world = new World();
    const entities: EntityHandle[] = [];
    for (let index = 0; index < 4; index += 1) {
      entities.push(world.spawn({ component: Transform, data: { pos: [index, 0, 0] } }).unwrap());
    }
    const first = entities[0];
    const second = entities[1];
    const third = entities[2];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('expected fixture entities');
    }
    const query = world.query({ read: [Transform], write: [GlobalTransform] }).unwrap();
    const writer = getDerivedWriter(query, GlobalTransform).unwrap();
    const result = writer.writeRange(
      0,
      0,
      1,
      2,
      (binding, _base, start, count) => {
        expect(count).toBe(2);
        binding.write.world[(start + 0) * 16 + 12] = 101;
        binding.write.world[(start + 1) * 16 + 12] = 102;
      },
      undefined,
    );
    expect(result.ok).toBe(true);
    expect(world.get(first, Transform).unwrap().pos[0]).toBe(0);
    expect(world.get(second, Transform).unwrap().pos[0]).toBe(1);
    expect(world.get(second, GlobalTransform).unwrap().world[12]).toBe(101);
    expect(world.get(third, GlobalTransform).unwrap().world[12]).toBe(102);
  });
});
