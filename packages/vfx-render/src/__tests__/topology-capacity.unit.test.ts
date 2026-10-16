import { describe, expect, it } from 'vitest';
import {
  createTopologyResourcePlan,
  topologyCapacitySnapshot,
} from '../feature/particle-resources.js';

describe('topology capacity and degeneracy contract', () => {
  it('reports ribbon overflow without changing its topology identity', () => {
    const plan = createTopologyResourcePlan({
      kind: 'ribbon',
      material: 'vfx',
      stripKey: 'alive-index',
      capacity: 2,
    });

    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(topologyCapacitySnapshot(plan.value, { requested: 3, produced: 2 })).toEqual({
        topology: 'ribbon',
        capacity: 2,
        produced: 2,
        dropped: 1,
        overflow: 1,
        degenerate: 0,
      });
    }
  });

  it('distinguishes a broken trail and a degenerate beam from overflow', () => {
    const trail = createTopologyResourcePlan({
      kind: 'trail',
      material: 'vfx',
      historyLength: 4,
      capacity: 8,
    });
    const beam = createTopologyResourcePlan({
      kind: 'beam',
      material: 'vfx',
      endpointField: 'velocity',
      capacity: 8,
    });

    expect(
      trail.ok &&
        topologyCapacitySnapshot(trail.value, { requested: 1, produced: 0, degenerate: 1 }),
    ).toMatchObject({
      topology: 'trail',
      degenerate: 1,
      overflow: 0,
    });
    expect(
      beam.ok && topologyCapacitySnapshot(beam.value, { requested: 1, produced: 0, degenerate: 1 }),
    ).toMatchObject({
      topology: 'beam',
      degenerate: 1,
      overflow: 0,
    });
  });
});
