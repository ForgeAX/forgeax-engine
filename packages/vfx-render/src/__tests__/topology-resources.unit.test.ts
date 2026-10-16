import { describe, expect, it } from 'vitest';
import { createTopologyResourcePlan } from '../feature/particle-resources.js';

describe('independent topology resources', () => {
  it.each([
    ['ribbon', { kind: 'ribbon', material: 'vfx', stripKey: 'alive-index', capacity: 4 }],
    ['trail', { kind: 'trail', material: 'vfx', historyLength: 3, capacity: 5 }],
    ['beam', { kind: 'beam', material: 'vfx', endpointField: 'velocity', capacity: 2 }],
  ])('allocates a distinct %s vertex/index/indirect plan', (_kind, renderer) => {
    const result = createTopologyResourcePlan(renderer);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.vertexBytes).toBeGreaterThan(0);
      expect(result.value.indexBytes).toBe(0);
      expect(result.value.indirectBytes).toBeGreaterThan(0);
      expect(result.value.resourceKey).not.toMatch(/billboard|mesh|particle/);
    }
  });

  it('rejects topology field names that the managed WGSL shell cannot execute', () => {
    expect(
      createTopologyResourcePlan({ kind: 'ribbon', stripKey: 'custom', capacity: 4 }),
    ).toMatchObject({ ok: false, error: { detail: { path: 'renderer.stripKey' } } });
    expect(
      createTopologyResourcePlan({ kind: 'beam', endpointField: 'custom', capacity: 4 }),
    ).toMatchObject({ ok: false, error: { detail: { path: 'renderer.endpointField' } } });
  });
});
