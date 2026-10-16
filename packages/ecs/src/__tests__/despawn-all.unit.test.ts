import { describe, expect, it } from 'vitest';

import { defineComponent, World } from '../index';

describe('World.despawnAll', () => {
  it('routes every live entity through normal despawn cleanup', () => {
    const Marker = defineComponent('DespawnAllMarker', { value: 'u32' });
    const world = new World();
    world.spawn({ component: Marker, data: { value: 1 } }).unwrap();
    world.spawn({ component: Marker, data: { value: 2 } }).unwrap();

    const result = world.despawnAll();

    expect(result.ok).toBe(true);
    expect(world.inspect().entityCount).toBe(0);
  });
});
