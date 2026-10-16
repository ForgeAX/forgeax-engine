import { describe, expect, it } from 'vitest';
import { componentId, defineComponent } from '../component';
import { createRenderReadLease, type RenderProjectionRequest } from '../projection/index';
import { World } from '../world';

const Position = defineComponent('RenderReadPosition', {
  x: 'f32',
  y: 'f32',
});

const request: RenderProjectionRequest = {
  components: [{ component: Position, fields: ['x', 'y'] }],
};

describe('RenderReadLease contract', () => {
  it('attaches, exposes a world generation, and reads continuous spans', () => {
    const world = new World();
    world.spawn({ component: Position, data: { x: 1, y: 2 } }).unwrap();
    const lease = createRenderReadLease(world);

    expect(lease.worldIdentity).toBe(world.identity);
    expect(lease.generation).toBeGreaterThan(0);
    const projection = lease.querySpans(request);
    expect(projection.generation).toBe(lease.generation);
    expect(projection.spans).toHaveLength(1);
    expect(projection.spans[0]?.fields.x).toEqual(new Float32Array([1]));
    expect(projection.spans[0]?.fields.y).toEqual(new Float32Array([2]));
  });

  it('publishes component changes from an explicit consumer version', () => {
    const world = new World();
    const entity = world.spawn({ component: Position, data: { x: 0, y: 0 } }).unwrap();
    const lease = createRenderReadLease(world);
    const version = lease.captureVersion();
    world.set(entity, Position, { x: 3 }).unwrap();
    const batch = lease.readChanges(version);

    expect(batch.version.mutationEpoch).toBeGreaterThan(version.mutationEpoch);
    expect(batch.world.changedComponentIds).toContain(componentId(Position));
  });

  it('publishes current structure versions independently of intervening operation count', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const version = lease.captureVersion();

    for (let index = 0; index < 65537; index += 1) {
      const entity = world.spawn({ component: Position, data: { x: index, y: 0 } }).unwrap();
      world.despawn(entity).unwrap();
    }

    const batch = lease.readChanges(version);
    expect(batch.version.structureEpoch).toBeGreaterThan(version.structureEpoch);
  });

  it('detaches idempotently and rejects reads after dispose', () => {
    const lease = createRenderReadLease(new World());
    lease.dispose();
    lease.dispose();

    expect(() => lease.captureVersion()).toThrow(/disposed/i);
    expect(() => lease.querySpans(request)).toThrow(/disposed/i);
  });

  it('distinguishes leases from renderer-owned projections', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    const projection = lease.querySpans(request);

    expect(projection).not.toBe(lease);
    expect(Object.keys(projection)).toEqual(['generation', 'spans']);
  });
});
